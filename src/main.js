// main.js
// Welcome to the Jungle jobs scraper - pure HTTP + HTML anchors (no Playwright, no Algolia, no __NEXT_DATA__).

import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';
import { gotScraping } from 'got-scraping';

// ---------- Helpers ----------

const toAbs = (href, base = 'https://www.welcometothejungle.com') => {
    try {
        return new URL(href, base).href;
    } catch {
        return null;
    }
};

const toSlugId = (url) => {
    try {
        const u = new URL(url);
        const parts = u.pathname.split('/').filter(Boolean);
        const last = parts[parts.length - 1] || '';
        // Expect a trailing slug like "job-title-12345" or UUID-ish id.
        const match =
            last.match(/([a-f0-9]{8,})$/i)?.[1] ||
            last.match(/(\d{4,})$/)?.[1] ||
            last ||
            null;
        return match;
    } catch {
        return null;
    }
};

const cleanText = (htmlOrText) => {
    if (!htmlOrText) return '';
    // If it's HTML, strip tags; if it's text, cheerio will just wrap it.
    const $ = cheerioLoad(String(htmlOrText));
    $('script, style, noscript, iframe').remove();
    return $.root().text().replace(/\s+/g, ' ').trim();
};

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Safari/605.1.15',
    'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:118.0) Gecko/20100101 Firefox/118.0',
];
const pickUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

// You might extend these later, but for now keep them very simple:
const normalizeContract = (val) =>
    typeof val === 'string' && val.trim() ? val.trim().toLowerCase() : null;
const normalizeRemote = (val) =>
    typeof val === 'string' && val.trim() ? val.trim().toLowerCase() : null;

const parseJobFromJsonLd = ($, currentUrl) => {
    let bestNode = null;
    $('script[type="application/ld+json"]').each((_, el) => {
        const raw = $(el).contents().text();
        if (!raw) return;
        try {
            const parsed = JSON.parse(raw);
            const nodes = Array.isArray(parsed) ? parsed : [parsed];
            for (const node of nodes) {
                if (!node || typeof node !== 'object') continue;
                const type = node['@type'] || node.type || node['@context'];
                if (
                    (Array.isArray(type) && type.includes('JobPosting')) ||
                    type === 'JobPosting'
                ) {
                    bestNode = node;
                    return false; // break out
                }
            }
        } catch {
            // ignore malformed JSON-LD blocks
        }
    });

    if (!bestNode) return null;

    const jobLocation = Array.isArray(bestNode.jobLocation)
        ? bestNode.jobLocation[0]
        : bestNode.jobLocation;
    const address = jobLocation?.address || {};
    const remoteType = bestNode.jobLocationType || bestNode.jobLocation?.jobLocationType;
    const employmentType = bestNode.employmentType;

    return {
        job_id: bestNode.identifier?.value || bestNode.identifier || toSlugId(currentUrl),
        title: bestNode.title || bestNode.name || null,
        company: bestNode.hiringOrganization?.name || null,
        location:
            address.addressLocality ||
            address.addressRegion ||
            address.addressCountry ||
            null,
        contract_type: Array.isArray(employmentType) ? employmentType.join(', ') : employmentType,
        remote:
            typeof remoteType === 'string'
                ? remoteType
                : remoteType?.toString?.() || null,
        description_html: bestNode.description || null,
        description_text: cleanText(bestNode.description || ''),
        date_posted: bestNode.datePosted || null,
        valid_through: bestNode.validThrough || null,
        salary:
            bestNode.baseSalary?.value?.value ||
            bestNode.baseSalary?.value?.minValue ||
            null,
        url: bestNode.url || currentUrl,
    };
};

const parseJobFromHtml = ($, currentUrl) => {
    const canonical = $('link[rel="canonical"]').attr('href') || currentUrl;
    const title =
        cleanText($('[data-testid="job-title"], h1').first().text()) ||
        cleanText($('meta[property="og:title"]').attr('content') || '');
    const company =
        cleanText(
            $('[data-testid="job-company"], [data-testid="job-header-company"], .job-header__company')
                .first()
                .text(),
        ) || null;
    const location =
        cleanText(
            $('[data-testid="job-location"], .job-location, [data-testid="job-header-location"]')
                .first()
                .text(),
        ) || null;
    const contract_type =
        cleanText(
            $('[data-testid="job-contract"], .job-contract, [data-testid="job-header-contract"]')
                .first()
                .text(),
        ) || null;
    const remote =
        cleanText(
            $('[data-testid="job-remote"], .job-remote, [data-remote], .remote')
                .first()
                .text(),
        ) || null;
    const description_html =
        $('[data-testid="job-description"], .job-description, article').first().html() ||
        null;
    const description_text = cleanText(description_html || '');

    return {
        job_id: toSlugId(canonical),
        title: title || null,
        company: company || null,
        location: location || null,
        contract_type: contract_type || null,
        remote: remote || null,
        description_html,
        description_text,
        url: canonical,
    };
};

// ---------- Main actor ----------

await Actor.main(async () => {
    const input = (await Actor.getInput()) || {};

    const {
        keyword = '',
        // ISO country code (e.g. "FR", "US") - can be blank.
        location = '',
        contract_type = [],
        remote = [],
        results_wanted: RESULTS_WANTED_RAW = 50,
        max_pages: MAX_PAGES_RAW = 10,
        proxyConfiguration,
        maxConcurrency = 4,
        mode = 'auto', // 'auto' | 'api' | 'html'
        language = 'en',
    } = input;

    log.info('Actor input', {
        keyword,
        location,
        contract_type,
        remote,
        RESULTS_WANTED_RAW,
        MAX_PAGES_RAW,
        maxConcurrency,
        mode,
        language,
    });

    const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW)
        ? Math.max(1, +RESULTS_WANTED_RAW)
        : 50;
    const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW)
        ? Math.max(1, +MAX_PAGES_RAW)
        : 10;

    if (location && location.length > 3) {
        log.warning(
            `location="${location}" looks like a name, not an ISO country code (e.g. "FR"). ` +
                'This may not match the site’s filters that expect country codes.',
        );
    }

    const proxyConf = proxyConfiguration
        ? await Actor.createProxyConfiguration({ ...proxyConfiguration })
        : undefined;

    const ALGOLIA_APP_ID = 'CSEKHVMS53';
    const ALGOLIA_API_KEY = '4bd8f6215d0cc52b26430765769e65a0';
    const ALGOLIA_INDEX_PREFIX = 'wttj_jobs_production';

    const buildAlgoliaIndexName = () => `${ALGOLIA_INDEX_PREFIX}_${(language || 'en').trim()}`;

    const buildAlgoliaFilters = () => {
        const filters = [];
        if (location) filters.push(`offices.country_code:"${location.toUpperCase()}"`);

        if (Array.isArray(contract_type) && contract_type.length) {
            const ors = contract_type
                .filter(Boolean)
                .map((ct) => `contract_type:"${ct.toLowerCase()}"`);
            if (ors.length) filters.push(`(${ors.join(' OR ')})`);
        }

        if (Array.isArray(remote) && remote.length) {
            const ors = remote
                .filter(Boolean)
                .map((r) => `remote:"${r.toLowerCase()}"`);
            if (ors.length) filters.push(`(${ors.join(' OR ')})`);
        }

        return filters.join(' AND ');
    };

    const fetchAlgoliaPage = async ({ page }) => {
        const body = {
            params: new URLSearchParams({
                query: keyword,
                hitsPerPage: '30',
                page: String(page),
                clickAnalytics: 'false',
                maxValuesPerFacet: '99',
                attributesToRetrieve: [
                    '*',
                    '-has_benefits',
                    '-has_contract_duration',
                    '-has_education_level',
                    '-has_experience_level_minimum',
                    '-has_remote',
                    '-has_salary_yearly_minimum',
                    '-organization.description',
                    '-organization_score',
                    '-profile',
                    '-rank_group_1',
                    '-rank_group_2',
                    '-rank_group_3',
                    '-source_stage',
                ].join(','),
                facets: ['*'].join(','),
            }).toString(),
        };

        const filters = buildAlgoliaFilters();
        if (filters) {
            body.params += `&filters=${encodeURIComponent(filters)}`;
        }

        const indexName = buildAlgoliaIndexName();
        const url = `https://${ALGOLIA_APP_ID}-dsn.algolia.net/1/indexes/${indexName}/query`;

        const res = await gotScraping({
            url,
            method: 'POST',
            proxyUrl: proxyConf ? proxyConf.newUrl() : undefined,
            headers: {
                'Content-Type': 'application/json',
                'X-Algolia-Application-Id': ALGOLIA_APP_ID,
                'X-Algolia-API-Key': ALGOLIA_API_KEY,
                Origin: 'https://www.welcometothejungle.com',
                Referer: 'https://www.welcometothejungle.com/en/jobs',
                'User-Agent': pickUA(),
            },
            body: JSON.stringify(body),
            responseType: 'json',
        });

        if (!res.body || typeof res.body !== 'object') {
            throw new Error(`Algolia response invalid for page ${page}`);
        }
        return res.body;
    };

    const seenIds = new Set();
    const seenUrls = new Set();
    const enqueuedDetail = new Set();
    let saved = 0;

    const pushJob = async (job) => {
        if (job.job_id && seenIds.has(job.job_id)) return false;
        if (job.url && seenUrls.has(job.url)) return false;
        if (job.job_id) seenIds.add(job.job_id);
        if (job.url) seenUrls.add(job.url);
        await Dataset.pushData(job);
        saved++;
        return true;
    };

    const buildSearchUrl = (page = 1) => {
        const u = new URL('https://www.welcometothejungle.com/en/jobs');
        if (keyword) u.searchParams.set('query', keyword);
        if (location) {
            u.searchParams.set('refinementList[offices.country_code][]', location.toUpperCase());
        }
        if (Array.isArray(remote)) {
            remote.forEach((r) => {
                if (r) u.searchParams.append('refinementList[remote][]', r);
            });
        }
        if (Array.isArray(contract_type)) {
            contract_type.forEach((ct) => {
                if (ct) u.searchParams.append('refinementList[contract_type][]', ct);
            });
        }
        u.searchParams.set('page', String(page));
        return u.href;
    };

    const hitToJob = (hit, page) => {
        const orgSlug = hit?.organization?.slug;
        const jobSlug = hit?.slug;
        const lang = (hit?.language || language || 'en').slice(0, 5);
        const url =
            orgSlug && jobSlug
                ? `https://www.welcometothejungle.com/${lang}/companies/${orgSlug}/jobs/${jobSlug}`
                : null;
        const locationObj = Array.isArray(hit?.offices) ? hit.offices[0] : null;

        return {
            job_id: hit.objectID || hit.reference || hit.slug || toSlugId(url),
            title: hit.name || null,
            company: hit.organization?.name || null,
            location:
                locationObj?.city ||
                locationObj?.country ||
                locationObj?.state ||
                locationObj?.country_code ||
                null,
            contract_type: normalizeContract(hit.contract_type) || null,
            remote: normalizeRemote(hit.remote) || null,
            description_text: cleanText(hit.summary || ''),
            description_html: null,
            published_at: hit.published_at || hit.published_at_date || null,
            salary_min: hit.salary_minimum || hit.salary_yearly_minimum || null,
            salary_max: hit.salary_maximum || null,
            salary_currency: hit.salary_currency || null,
            url,
            _source: 'api',
            _page: page,
            _fetched_at: new Date().toISOString(),
        };
    };

    const runAlgoliaMode = async () => {
        let page = 0;
        let totalPages = 1;
        log.info(`Algolia mode: index=${buildAlgoliaIndexName()}, filters="${buildAlgoliaFilters()}"`);

        while (page < totalPages && saved < RESULTS_WANTED) {
            let res;
            try {
                res = await fetchAlgoliaPage({ page });
            } catch (err) {
                log.warning(`Algolia request failed on page ${page}: ${err.message}`);
                break;
            }
            const hits = Array.isArray(res.hits) ? res.hits : [];
            totalPages = Number.isFinite(res.nbPages) ? res.nbPages : totalPages;

            if (!hits.length) {
                log.warning(`Algolia page ${page} returned 0 hits`);
                break;
            }

            for (const hit of hits) {
                if (saved >= RESULTS_WANTED) break;
                const job = hitToJob(hit, page + 1);
                const stored = await pushJob(job);
                if (stored) {
                    log.info(
                        `Saved job ${saved}/${RESULTS_WANTED} from API: ${job.title || job.url}`,
                    );
                }
            }

            page += 1;
        }

        return saved;
    };

    const extractInlineHits = (html) => {
        if (!html) return [];
        // Look for JSON blocks containing "hits":[...]
        const hitMatches = [];
        const regex = /\"hits\"\s*:\s*\[(.*?)\]/gs;
        let m;
        while ((m = regex.exec(html)) !== null) {
            hitMatches.push(m[0]);
            if (hitMatches.length > 2) break;
        }
        const hits = [];
        for (const block of hitMatches) {
            try {
                // Wrap into object to parse.
                const obj = JSON.parse(`{${block}}`);
                if (Array.isArray(obj.hits)) {
                    hits.push(...obj.hits);
                }
            } catch {
                // ignore parse errors
            }
        }
        return hits;
    };

    const crawler = new CheerioCrawler({
        proxyConfiguration: proxyConf,
        maxConcurrency,
        maxRequestRetries: 2,
        useSessionPool: true,
        requestHandlerTimeoutSecs: 60,
        preNavigationHooks: [
            async ({ request }) => {
                request.headers = {
                    ...(request.headers || {}),
                    'User-Agent': pickUA(),
                    'Accept-Language': 'en-US,en;q=0.9',
                    Referer: 'https://www.welcometothejungle.com/',
                    'Cache-Control': 'no-cache',
                    Pragma: 'no-cache',
                };
            },
        ],
        async requestHandler({ $, request, enqueueLinks, log: crawlerLog }) {
            const label = request.userData?.label || 'LIST';
            const pageNo = request.userData?.pageNo || 1;

            // ---------------- LIST HANDLER ----------------
            if (label === 'LIST') {
                crawlerLog.info(`Processing LIST page ${pageNo}: ${request.url}`);

                const jobAnchors = [];
                $('a[href]').each((_, el) => {
                    const $el = $(el);
                    const href = $el.attr('href') || '';
                    const text = cleanText($el.text());
                    const dataTestId = ($el.attr('data-testid') || '').toLowerCase();

                    const isJobHref =
                        /\/jobs?\//i.test(href) ||
                        /\/job-/.test(href) ||
                        /\/en\/companies\/.+\/jobs\/.+/i.test(href) ||
                        dataTestId.includes('job-card') ||
                        dataTestId.includes('search-card') ||
                        dataTestId.includes('job-link');

                    const isNavOrFooter =
                        ['home', 'find a job', 'find a company', 'media'].includes(
                            text.toLowerCase(),
                        ) ||
                        text.toLowerCase().includes('help center') ||
                        text.toLowerCase().includes('about us') ||
                        text.toLowerCase().includes('pricing');

                    if (!isJobHref || !text || isNavOrFooter) return;

                    const abs = toAbs(href);
                    if (!abs) return;

                    jobAnchors.push({
                        url: abs,
                        title: text,
                    });
                });

                crawlerLog.info(
                    `List discovery: found ${jobAnchors.length} candidate job links on page ${pageNo}`,
                );

                if (!jobAnchors.length) {
                    const inlineHits = extractInlineHits($.html());
                    if (inlineHits.length) {
                        crawlerLog.info(
                            `No anchors, but found ${inlineHits.length} inline hits on page ${pageNo} - pushing directly.`,
                        );
                        for (const hit of inlineHits) {
                            if (saved >= RESULTS_WANTED) break;
                            const job = { ...hitToJob(hit, pageNo), _source: 'inline-json' };
                            const stored = await pushJob(job);
                            if (stored) {
                                crawlerLog.info(
                                    `Saved job ${saved}/${RESULTS_WANTED} from inline JSON: ${
                                        job.title || job.url
                                    }`,
                                );
                            }
                        }
                    } else {
                        crawlerLog.warning(
                            `No job anchors detected on page ${pageNo} and no inline hits. HTML snippet:\n` +
                                $.html().slice(0, 800),
                        );
                    }
                } else {
                    crawlerLog.debug(
                        `Sample job anchors on page ${pageNo}: ${jobAnchors
                            .slice(0, 5)
                            .map((j) => `${j.title} -> ${j.url}`)
                            .join(' | ')}`,
                    );
                }

                const remaining = RESULTS_WANTED - saved;
                if (remaining <= 0) {
                    crawlerLog.info(
                        `Reached RESULTS_WANTED=${RESULTS_WANTED}, skipping further LIST processing.`,
                    );
                    return;
                }

                const detailUrls = [];
                for (const job of jobAnchors) {
                    if (enqueuedDetail.has(job.url)) continue;
                    enqueuedDetail.add(job.url);
                    detailUrls.push(job.url);
                }

                if (detailUrls.length) {
                    await enqueueLinks({
                        urls: detailUrls,
                        userData: { label: 'DETAIL', fromPage: pageNo },
                    });
                    crawlerLog.info(
                        `Enqueued ${detailUrls.length} job detail URLs from page ${pageNo}`,
                    );
                }

                // ---------- Pagination ----------

                if (saved < RESULTS_WANTED && pageNo < MAX_PAGES) {
                    const nextUrl = buildSearchUrl(pageNo + 1);
                    await enqueueLinks({
                        urls: [nextUrl],
                        userData: { label: 'LIST', pageNo: pageNo + 1 },
                    });
                    crawlerLog.info(
                        `Enqueued next LIST page ${pageNo + 1} (${nextUrl}) - saved=${saved}`,
                    );
                } else {
                    crawlerLog.info(
                        `Stopping pagination. saved=${saved}, pageNo=${pageNo}, MAX_PAGES=${MAX_PAGES}`,
                    );
                }
                return;
            }

            // ---------------- DETAIL HANDLER ----------------
            if (label === 'DETAIL') {
                if (saved >= RESULTS_WANTED) {
                    crawlerLog.info(
                        `Already reached RESULTS_WANTED=${RESULTS_WANTED}, skipping detail ${request.url}`,
                    );
                    return;
                }

                const fromPage = request.userData?.fromPage;
                const jsonLdJob = parseJobFromJsonLd($, request.url);
                const fallbackJob = parseJobFromHtml($, request.url);
                const job = {
                    ...(fallbackJob || {}),
                    ...(jsonLdJob || {}),
                    url: jsonLdJob?.url || fallbackJob?.url || request.url,
                    job_id:
                        jsonLdJob?.job_id ||
                        fallbackJob?.job_id ||
                        toSlugId(request.url),
                    _source: jsonLdJob ? 'json-ld' : 'html',
                    _page: fromPage ?? null,
                    _fetched_at: new Date().toISOString(),
                };

                if (!job.title && !job.description_text) {
                    crawlerLog.warning(
                        `Detail parse yielded empty job for ${request.url}. Snippet:\n${$.html().slice(
                            0,
                            800,
                        )}`,
                    );
                    return;
                }

                const stored = await pushJob(job);
                if (stored) {
                    crawlerLog.info(
                        `Saved job ${saved}/${RESULTS_WANTED} (${job._source}) from detail: ${job.title || job.url}`,
                    );
                } else {
                    crawlerLog.debug(`Skipped duplicate job detail: ${job.url}`);
                }
                return;
            }
        },
    });

    const startUrl = buildSearchUrl(1);
    log.info(`Starting actor with mode=${mode}. First URL: ${startUrl}`);

    let apiSaved = 0;
    if (mode === 'auto' || mode === 'api') {
        try {
            apiSaved = await runAlgoliaMode();
            log.info(`API branch saved ${apiSaved} items`);
        } catch (err) {
            log.warning(`API branch failed: ${err.message}`);
        }
    }

    if ((mode === 'auto' && apiSaved < RESULTS_WANTED) || mode === 'html') {
        await crawler.run([{ url: startUrl, userData: { label: 'LIST', pageNo: 1 } }]);
    }

    if (saved === 0) {
        // Keep this guard to tell you clearly when nothing was scraped.
        throw new Error(
            `Run completed but produced 0 jobs. ` +
                `Inputs={keyword:"${keyword}", location:"${location}", contract_type:${JSON.stringify(
                    contract_type,
                )}, remote:${JSON.stringify(remote)}}. ` +
                `Mode=${mode} - API and HTML branches both returned 0. Check API filters, ` +
                `or update HTML selectors / allowlist.`,
        );
    }

    await Actor.pushData({
        _summary: true,
        saved,
        mode,
        keyword,
        location,
    });

    log.info(`Finished. Saved ${saved} jobs`);
});
