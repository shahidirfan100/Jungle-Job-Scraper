// Welcome to the Jungle jobs scraper - Algolia JSON API + HTML fallback (production-ready)
import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';
import { gotScraping } from 'got-scraping';

// ----------------- Shared helpers -----------------

const toAbs = (href, base = 'https://www.welcometothejungle.com') => {
    try {
        return new URL(href, base).href;
    } catch {
        return null;
    }
};

const cleanText = (html) => {
    if (!html) return '';
    const $ = cheerioLoad(html);
    $('script, style, noscript, iframe').remove();
    return $.root().text().replace(/\s+/g, ' ').trim();
};

function extractFromJsonLd($) {
    const scripts = $('script[type="application/ld+json"]');
    for (let i = 0; i < scripts.length; i++) {
        try {
            const parsed = JSON.parse($(scripts[i]).html() || '');
            const arr = Array.isArray(parsed) ? parsed : [parsed];
            for (const e of arr) {
                if (!e) continue;
                const t = e['@type'] || e.type;
                if (t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'))) {
                    return {
                        title: e.title || e.name || null,
                        company: e.hiringOrganization?.name || null,
                        date_posted: e.datePosted || null,
                        description_html: e.description || null,
                        location:
                            (e.jobLocation &&
                                e.jobLocation.address &&
                                (e.jobLocation.address.addressLocality ||
                                    e.jobLocation.address.addressRegion)) ||
                            null,
                        salary: e.baseSalary?.value?.value || e.baseSalary?.value || null,
                        job_id: e.identifier?.value || e.identifier || null,
                    };
                }
            }
        } catch {
            // ignore parsing errors
        }
    }
    return null;
}

const extractJobsFromNextData = (raw) => {
    const jobs = [];
    const queue = [raw];
    const seen = new Set();
    while (queue.length) {
        const cur = queue.shift();
        if (!cur || typeof cur !== 'object') continue;
        if (seen.has(cur)) continue;
        seen.add(cur);
        if (Array.isArray(cur)) {
            for (const e of cur) queue.push(e);
            continue;
        }
        const keys = Object.keys(cur);
        const hasSlug = 'slug' in cur;
        const hasOrg = 'organization_slug' in cur || 'organization' in cur;
        if (hasSlug && hasOrg) jobs.push(cur);
        for (const k of keys) queue.push(cur[k]);
    }
    return jobs;
};

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Safari/605.1.15',
    'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:118.0) Gecko/20100101 Firefox/118.0',
];
const pickUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

// ----------------- Main actor -----------------

await Actor.main(async () => {
    const input = (await Actor.getInput()) || {};
    const {
        keyword = '',
        // IMPORTANT: This is ISO country code (e.g. "FR", "US"), NOT a free text city
        location = '',
        contract_type = [],
        remote = [],
        results_wanted: RESULTS_WANTED_RAW = 100,
        max_pages: MAX_PAGES_RAW = 20,
        collectDetails = true,
        proxyConfiguration,
        useAlgoliaAPI = true,
        // optional override; if user doesn't have a key we fall back to the built-in one
        algoliaApiKey,
    } = input;

    // Log input once for debugging / transparency
    log.info('Actor input', {
        keyword,
        location,
        contract_type,
        remote,
        RESULTS_WANTED_RAW,
        MAX_PAGES_RAW,
        collectDetails,
        useAlgoliaAPI,
        hasUserAlgoliaKey: Boolean(algoliaApiKey),
    });

    const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW) ? Math.max(1, +RESULTS_WANTED_RAW) : 100;
    const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 20;

    if (location && location.length > 3) {
        log.warning(
            `location="${location}" looks like a name, not an ISO country code (e.g. "FR"). ` +
                'This may reduce Algolia results; HTML fallback will still try to find jobs.',
        );
    }

    const proxyConf = proxyConfiguration ? await Actor.createProxyConfiguration({ ...proxyConfiguration }) : undefined;
    const seenIds = new Set();
    const seenUrls = new Set();
    let saved = 0;

    // ----------------- Algolia constants (built-in key, user override optional) -----------------

    const ALGOLIA_APP_ID = 'CSEKHVMS53';
    const ALGOLIA_API_KEY = algoliaApiKey || '4bd8f6215d0cc52b26430765769e65a0';
    const ALGOLIA_INDEX = 'wttj_jobs_production_en';

    if (useAlgoliaAPI && !ALGOLIA_API_KEY) {
        throw new Error('useAlgoliaAPI is true but no ALGOLIA_API_KEY is available.');
    }

    const buildFacetFilters = () => {
        const facets = [];
        if (location && location.trim()) facets.push([`offices.country_code:${location.toUpperCase()}`]);
        if (Array.isArray(contract_type) && contract_type.length)
            facets.push(contract_type.map((ct) => `contract_type:${ct}`));
        if (Array.isArray(remote) && remote.length) facets.push(remote.map((r) => `remote:${r}`));
        return facets;
    };

    const buildAlgoliaRequest = (query, page = 0) => {
        const params = new URLSearchParams({
            query: query || '',
            page: String(page),
            hitsPerPage: '20',
            analytics: 'false',
            clickAnalytics: 'false',
            attributesToRetrieve: [
                'name',
                'slug',
                'organization_name',
                'organization_slug',
                'offices',
                'office',
                'contract_type',
                'remote',
                'salary',
                'published_at',
                'description',
                'objectID',
            ].join(','),
            filters: 'archived:false',
            facetFilters: JSON.stringify(buildFacetFilters()),
        });

        return {
            requests: [
                {
                    indexName: ALGOLIA_INDEX,
                    params: params.toString(),
                },
            ],
        };
    };

    async function searchAlgoliaJobs(query, page = 0) {
        const headers = {
            'X-Algolia-Application-Id': ALGOLIA_APP_ID,
            'X-Algolia-API-Key': ALGOLIA_API_KEY,
            'X-Algolia-Agent': 'Algolia for JavaScript (4.x); Apify Actor',
            'Content-Type': 'application/json',
            'User-Agent': pickUA(),
            'Accept-Language': 'en-US,en;q=0.9',
            Referer: 'https://www.welcometothejungle.com/',
        };

        const body = buildAlgoliaRequest(query, page);
        const proxyUrl = proxyConf ? await proxyConf.newUrl() : undefined;

        const response = await gotScraping({
            url: `https://${ALGOLIA_APP_ID}-dsn.algolia.net/1/indexes/*/queries`,
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            throwHttpErrors: false,
            responseType: 'json',
            proxyUrl,
        });

        const hitsLen = (response.body?.results?.[0]?.hits || []).length;
        log.info(`Algolia status ${response.statusCode} page ${page} hits ${hitsLen}`);

        if (response.statusCode !== 200) {
            const message = response.body?.message || response.body?.error || '';
            throw new Error(`Algolia API returned ${response.statusCode} ${response.statusMessage || ''} ${message}`);
        }

        const result = response.body?.results?.[0];
        if (!result) throw new Error('Algolia response missing results[0]');
        return result;
    }

    const normalizeContract = (value) =>
        typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
    const normalizeRemote = (value) =>
        typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;

    const pushJob = async (job) => {
        if (job.job_id && seenIds.has(job.job_id)) return false;
        if (job.url && seenUrls.has(job.url)) return false;
        if (job.job_id) seenIds.add(job.job_id);
        if (job.url) seenUrls.add(job.url);
        await Dataset.pushData(job);
        saved++;
        return true;
    };

    const enrichDetails = async (jobData) => {
        if (!collectDetails || !jobData.url) return jobData;
        try {
            const response = await gotScraping({
                url: jobData.url,
                proxyUrl: proxyConf ? await proxyConf.newUrl() : undefined,
                headers: { 'User-Agent': pickUA() },
            });
            const $detail = cheerioLoad(response.body);
            const jsonLd = extractFromJsonLd($detail);
            if (jsonLd) {
                jobData.description_html = jsonLd.description_html || jobData.description_html;
                jobData.description_text = cleanText(jsonLd.description_html || jobData.description_text || '');
                jobData.title = jobData.title || jsonLd.title;
                jobData.company = jobData.company || jsonLd.company;
                jobData.location = jobData.location || jsonLd.location;
                jobData.salary = jobData.salary || jsonLd.salary;
                jobData.job_id = jobData.job_id || jsonLd.job_id;
            }
            const descContainer = $detail(
                '[data-testid="job-description"], .job-description, [class*="description"]',
            ).first();
            if (descContainer.length) {
                jobData.description_html = jobData.description_html || descContainer.html();
                jobData.description_text = jobData.description_text || cleanText(descContainer.html());
            }
            return jobData;
        } catch (err) {
            log.warning(`Detail fetch failed for ${jobData.url}: ${err.message}`);
            return jobData;
        }
    };

    // ----------------- Primary: Algolia JSON API -----------------

    if (useAlgoliaAPI) {
        log.info('Using Algolia API as primary source');
        let currentPage = 0;
        let hasMore = true;
        try {
            while (saved < RESULTS_WANTED && currentPage < MAX_PAGES && hasMore) {
                const result = await searchAlgoliaJobs(keyword, currentPage);
                const hits = result.hits || [];
                log.info(
                    `Algolia page ${currentPage} returned ${hits.length} hits (nbHits ${
                        result.nbHits ?? 'n/a'
                    })`,
                );
                if (!hits.length) {
                    log.warning(
                        `Algolia returned 0 hits at page ${currentPage}; facetFilters=${JSON.stringify(
                            buildFacetFilters(),
                        )}`,
                    );
                    hasMore = false;
                    break;
                }

                for (const job of hits) {
                    if (saved >= RESULTS_WANTED) break;

                    const jobUrl = toAbs(`/en/companies/${job.organization_slug}/jobs/${job.slug}`);
                    const item = {
                        title: job.name || null,
                        company: job.organization_name || null,
                        company_slug: job.organization_slug || null,
                        location:
                            job.office?.name ||
                            job.offices?.map((o) => o.name).filter(Boolean).join(', ') ||
                            'Remote',
                        country:
                            job.office?.country_name ||
                            job.offices?.map((o) => o.country_name).filter(Boolean)[0] ||
                            null,
                        contract_type: normalizeContract(job.contract_type),
                        remote: normalizeRemote(job.remote),
                        salary: job.salary || null,
                        date_posted: job.published_at || null,
                        description_text: job.description ? cleanText(job.description) : null,
                        url: jobUrl,
                        job_id: job.objectID || null,
                        _source: 'algolia',
                    };

                    const enriched = await enrichDetails(item);
                    await pushJob(enriched);
                }

                currentPage++;
                hasMore = currentPage < result.nbPages;
            }
        } catch (err) {
            log.warning(`Algolia flow failed: ${err.message}. Falling back to HTML crawler.`);
        }

        log.info(`Algolia phase finished with saved=${saved}`);
    }

    // ----------------- Fallback: HTML parsing / JSON-LD / __NEXT_DATA__ -----------------

    const buildSearchUrl = (page = 1) => {
        const u = new URL('https://www.welcometothejungle.com/en/jobs');
        if (keyword) u.searchParams.set('query', keyword);
        if (location) u.searchParams.set('refinementList[offices.country_code][]', location.toUpperCase());
        if (Array.isArray(remote) && remote.length)
            remote.forEach((r) => u.searchParams.append('refinementList[remote][]', r));
        if (Array.isArray(contract_type) && contract_type.length)
            contract_type.forEach((ct) => u.searchParams.append('refinementList[contract_type][]', ct));
        u.searchParams.set('page', String(page));
        return u.href;
    };

    const crawler = new CheerioCrawler({
        proxyConfiguration: proxyConf,
        maxRequestRetries: 3,
        useSessionPool: true,
        maxConcurrency: 4,
        requestHandlerTimeoutSecs: 90,
        preNavigationHooks: [
            async ({ request, session }) => {
                request.headers = {
                    ...(request.headers || {}),
                    'User-Agent': pickUA(),
                    'Accept-Language': 'en-US,en;q=0.9',
                    Referer: 'https://www.welcometothejungle.com/',
                };
                if (session?.id) request.headers['X-Session-Id'] = session.id;
            },
        ],
        async requestHandler({ request, $, enqueueLinks, log: crawlerLog }) {
            const label = request.userData?.label || 'LIST';
            const pageNo = request.userData?.pageNo || 1;

            if (label === 'LIST') {
                crawlerLog.info(`Processing search page ${pageNo}`);

                const jobLinks = [];
                $('a[href*="/jobs/"]').each((_, el) => {
                    const href = $(el).attr('href');
                    if (href && /\/companies\/[^/]+\/jobs\/[^/]+/.test(href)) {
                        const fullUrl = toAbs(href);
                        if (fullUrl && !jobLinks.includes(fullUrl)) jobLinks.push(fullUrl);
                    }
                });
                crawlerLog.info(`Found ${jobLinks.length} job links on page ${pageNo}`);

                // If no links found, attempt to parse embedded Next.js data for jobs
                if (jobLinks.length === 0) {
                    const nextDataScript =
                        $('script#__NEXT_DATA__').first().html() ||
                        $('script[id="__NEXT_DATA__"]').first().html();
                    if (nextDataScript) {
                        try {
                            const parsed = JSON.parse(nextDataScript);
                            const candidateJobs = extractJobsFromNextData(parsed);
                            crawlerLog.info(
                                `Next data heuristic found ${candidateJobs.length} job candidates on page ${pageNo}`,
                            );
                            const remaining = RESULTS_WANTED - saved;
                            for (const job of candidateJobs.slice(
                                0,
                                Math.max(0, remaining),
                            )) {
                                const url =
                                    job.slug && job.organization_slug
                                        ? toAbs(
                                              `/en/companies/${job.organization_slug}/jobs/${job.slug}`,
                                          )
                                        : null;
                                const item = {
                                    title: job.name || job.title || null,
                                    company:
                                        job.organization_name ||
                                        job.company ||
                                        job.organization?.name ||
                                        null,
                                    company_slug:
                                        job.organization_slug ||
                                        job.organization?.slug ||
                                        null,
                                    location:
                                        job.office?.name ||
                                        job.offices
                                            ?.map((o) => o.name)
                                            .filter(Boolean)
                                            .join(', ') ||
                                        job.location ||
                                        null,
                                    country:
                                        job.office?.country_name ||
                                        job.offices
                                            ?.map((o) => o.country_name)
                                            .filter(Boolean)[0] ||
                                        null,
                                    contract_type: normalizeContract(job.contract_type),
                                    remote: normalizeRemote(job.remote),
                                    salary: job.salary || null,
                                    date_posted: job.published_at || job.date_posted || null,
                                    description_text: job.description
                                        ? cleanText(job.description)
                                        : null,
                                    url,
                                    job_id: job.objectID || job.id || null,
                                    _source: 'next-data',
                                };
                                await pushJob(item);
                            }
                        } catch (err) {
                            crawlerLog.warning(
                                `Failed to parse __NEXT_DATA__: ${err.message}`,
                            );
                        }
                    }
                }

                if (collectDetails && jobLinks.length) {
                    const remaining = RESULTS_WANTED - saved;
                    const toEnqueue = jobLinks.slice(0, Math.max(0, remaining));
                    if (toEnqueue.length) {
                        crawlerLog.info(
                            `Enqueuing ${toEnqueue.length} DETAIL URLs from page ${pageNo}`,
                        );
                        await enqueueLinks({
                            urls: toEnqueue,
                            userData: { label: 'DETAIL' },
                        });
                    }
                } else if (jobLinks.length) {
                    const remaining = RESULTS_WANTED - saved;
                    const toPush = jobLinks.slice(0, Math.max(0, remaining));
                    for (const url of toPush) {
                        await pushJob({ url, _source: 'html-list' });
                    }
                }

                if (saved < RESULTS_WANTED && pageNo < MAX_PAGES) {
                    const nextUrl = buildSearchUrl(pageNo + 1);
                    await enqueueLinks({
                        urls: [nextUrl],
                        userData: { label: 'LIST', pageNo: pageNo + 1 },
                    });
                }
                return;
            }

            if (label === 'DETAIL') {
                if (saved >= RESULTS_WANTED) return;
                try {
                    const json = extractFromJsonLd($) || {};
                    const desc = $(
                        '[data-testid="job-description"], .job-description, [class*="description"]',
                    ).first();
                    const contractType = $(
                        '[data-testid="contract-type"], [class*="contract"]',
                    )
                        .first()
                        .text()
                        .trim() || null;
                    const remoteInfo = $(
                        '[data-testid="remote-info"], [class*="remote"]',
                    )
                        .first()
                        .text()
                        .trim() || null;

                    const item = {
                        title:
                            json.title ||
                            $('h1').first().text().trim() ||
                            $('[data-testid="job-title"], [class*="job-title"]')
                                .first()
                                .text()
                                .trim() ||
                            null,
                        company:
                            json.company ||
                            $('[data-testid="company-name"], [class*="company-name"]')
                                .first()
                                .text()
                                .trim() ||
                            null,
                        location:
                            json.location ||
                            $('[data-testid="job-location"], [class*="location"]')
                                .first()
                                .text()
                                .trim() ||
                            null,
                        contract_type: normalizeContract(contractType),
                        remote: normalizeRemote(remoteInfo),
                        salary: json.salary || null,
                        date_posted: json.date_posted || null,
                        description_html:
                            json.description_html ||
                            (desc.length ? String(desc.html()).trim() : null),
                        description_text: json.description_html
                            ? cleanText(json.description_html)
                            : desc.length
                            ? cleanText(desc.html())
                            : null,
                        url: request.url,
                        job_id: json.job_id || null,
                        _source: 'html-detail',
                    };

                    const stored = await pushJob(item);
                    if (stored)
                        crawlerLog.info(
                            `Saved job ${saved}/${RESULTS_WANTED}: ${
                                item.title || 'Untitled'
                            }`,
                        );
                } catch (err) {
                    crawlerLog.error(
                        `DETAIL ${request.url} failed: ${err.message}`,
                    );
                }
            }
        },
    });

    if (saved < RESULTS_WANTED) {
        log.info('Starting HTML fallback');
        const startUrl = buildSearchUrl(1);
        await crawler.run([{ url: startUrl, userData: { label: 'LIST', pageNo: 1 } }]);
    }

    if (saved === 0) {
        throw new Error(
            `Run completed but produced 0 jobs. ` +
                `Inputs={keyword:"${keyword}", location:"${location}", contract_type:${JSON.stringify(
                    contract_type,
                )}, remote:${JSON.stringify(remote)}}. ` +
                `Mode=${useAlgoliaAPI ? 'algolia+html' : 'html'} — check filters or potential blocking (403/429).`,
        );
    }

    await Actor.pushData({
        _summary: true,
        saved,
        mode: useAlgoliaAPI ? 'algolia+html' : 'html',
        keyword,
        location,
        usedAlgolia: useAlgoliaAPI,
        usedHtmlFallback: saved > 0,
    });

    log.info(`Finished. Saved ${saved} jobs`);
});
