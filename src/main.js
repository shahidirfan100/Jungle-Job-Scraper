// main.js
// Welcome to the Jungle jobs scraper - using __INITIAL_DATA__ JSON extraction + HTML fallback

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
    const $ = cheerioLoad(String(htmlOrText));
    $('script, style, noscript, iframe').remove();
    return $.root().text().replace(/\\s+/g, ' ').trim();
};

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Safari/605.1.15',
    'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:118.0) Gecko/20100101 Firefox/118.0',
];
const pickUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

const normalizeContract = (val) =>
    typeof val === 'string' && val.trim() ? val.trim().toLowerCase() : null;
const normalizeRemote = (val) =>
    typeof val === 'string' && val.trim() ? val.trim().toLowerCase() : null;

// ---------- JSON Data Extraction from __INITIAL_DATA__ ----------

const extractInitialData = (html) => {
    if (!html) return null;

    // Try multiple patterns to find __INITIAL_DATA__
    // Pattern 1: window.__INITIAL_DATA__ = "{ escaped JSON }"
    let match = html.match(/window\.__INITIAL_DATA__\s*=\s*"((?:[^"\\]|\\.)*)"/s);

    if (!match) {
        // Pattern 2: Try matching until newline
        match = html.match(/window\.__INITIAL_DATA__\s*=\s*"(.+?)"\s*\n/s);
    }

    if (!match) {
        log.warning('No __INITIAL_DATA__ found in HTML');
        return null;
    }

    try {
        let jsonStr = match[1];
        log.info(`Found __INITIAL_DATA__, length: ${jsonStr.length} chars`);

        // The data is escaped - unescape it
        jsonStr = jsonStr
            .replace(/\\u002F/g, '/')
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\');

        const parsed = JSON.parse(jsonStr);
        log.info(`Parsed __INITIAL_DATA__ successfully, has ${parsed.queries?.length || 0} queries`);
        return parsed;
    } catch (err) {
        log.warning(`Failed to parse __INITIAL_DATA__: ${err.message}`);
        log.debug(`First 200 chars of data: ${match[1]?.substring(0, 200)}`);
        return null;
    }
};

const extractJobsFromInitialData = (initialData, language = 'en') => {
    if (!initialData) {
        log.warning('No initialData provided');
        return [];
    }

    const jobs = [];

    // Check for queries array
    if (initialData.queries && Array.isArray(initialData.queries)) {
        log.info(`Processing ${initialData.queries.length} queries from __INITIAL_DATA__`);

        for (const query of initialData.queries) {
            const state = query?.state;
            if (!state || !state.data) continue;

            const data = state.data;

            // Handle direct hits array (most common for job searches)
            if (data.hits && Array.isArray(data.hits)) {
                log.info(`Found ${data.hits.length} hits in query`);
                jobs.push(...data.hits);
            }

            // Handle case where data itself is an array of jobs
            if (Array.isArray(data)) {
                for (const item of data) {
                    if (item && item.slug && item.organization) {
                        jobs.push(item);
                    }
                }
            }
        }
    }

    log.info(`Total jobs extracted from __INITIAL_DATA__: ${jobs.length}`);
    return jobs;
};

// ---------- Job Parsing ----------

const hitToJob = (hit, page, language = 'en') => {
    const orgSlug = hit?.organization?.slug;
    const jobSlug = hit?.slug;
    const lang = (hit?.language || language || 'en').slice(0, 5);
    const url =
        orgSlug && jobSlug
            ? `https://www.welcometothejungle.com/${lang}/companies/${orgSlug}/jobs/${jobSlug}`
            : null;

    const locationObj = Array.isArray(hit?.offices) ? hit.offices[0] : null;

    return {
        job_id: hit.objectID || hit.reference || hit.wk_reference || hit.slug || toSlugId(url),
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
        sectors: hit.sectors?.map(s => s.name).join(', ') || null,
        benefits: Array.isArray(hit.benefits) ? hit.benefits.join(', ') : null,
        url,
        _source: 'initial-data',
        _page: page,
        _fetched_at: new Date().toISOString(),
    };
};

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
                    return false;
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
        location = '',
        contract_type = [],
        remote = [],
        results_wanted: RESULTS_WANTED_RAW = 50,
        max_pages: MAX_PAGES_RAW = 10,
        proxyConfiguration,
        maxConcurrency = 4,
        mode = 'auto', // 'auto' | 'json' | 'html'
        language = 'en',
        collectDetails = false,
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
        collectDetails,
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
            'This may not match the site\'s filters that expect country codes.',
        );
    }

    const proxyConf = proxyConfiguration
        ? await Actor.createProxyConfiguration({ ...proxyConfiguration })
        : undefined;

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
        const u = new URL(`https://www.welcometothejungle.com/${language}/jobs`);
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

    // ---------- Fetch page and extract JSON data ----------

    const fetchPageAndExtractJobs = async (pageNo) => {
        const url = buildSearchUrl(pageNo);
        log.info(`Fetching page ${pageNo}: ${url}`);

        try {
            const response = await gotScraping({
                url,
                proxyUrl: proxyConf ? proxyConf.newUrl() : undefined,
                headers: {
                    'User-Agent': pickUA(),
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache',
                },
                timeout: { request: 30000 },
                retry: { limit: 2 },
            });

            const html = response.body;

            if (!html || html.length < 1000) {
                log.warning(`Page ${pageNo} returned very short response (${html?.length || 0} bytes)`);
                return [];
            }

            // Extract __INITIAL_DATA__
            const initialData = extractInitialData(html);
            if (!initialData) {
                log.warning(`No __INITIAL_DATA__ found on page ${pageNo}`);
                return [];
            }

            const hits = extractJobsFromInitialData(initialData, language);
            log.info(`Page ${pageNo}: extracted ${hits.length} job hits from __INITIAL_DATA__`);

            return hits;
        } catch (err) {
            log.warning(`Failed to fetch page ${pageNo}: ${err.message}`);
            return [];
        }
    };

    // ---------- Run JSON extraction mode ----------

    const runJsonMode = async () => {
        log.info('Running JSON extraction mode');

        for (let pageNo = 1; pageNo <= MAX_PAGES && saved < RESULTS_WANTED; pageNo++) {
            const hits = await fetchPageAndExtractJobs(pageNo);

            if (hits.length === 0) {
                log.info(`No more jobs found on page ${pageNo}, stopping pagination`);
                break;
            }

            for (const hit of hits) {
                if (saved >= RESULTS_WANTED) break;

                const job = hitToJob(hit, pageNo, language);

                // Skip if no valid URL
                if (!job.url) {
                    log.debug(`Skipping job without URL: ${job.title}`);
                    continue;
                }

                const stored = await pushJob(job);
                if (stored) {
                    log.info(`Saved job ${saved}/${RESULTS_WANTED}: ${job.title} at ${job.company}`);
                }
            }

            // Small delay between pages to be polite
            if (pageNo < MAX_PAGES && saved < RESULTS_WANTED) {
                await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
            }
        }

        return saved;
    };

    // ---------- Cheerio Crawler for HTML fallback and detail pages ----------

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

            // ---------------- LIST HANDLER (HTML fallback) ----------------
            if (label === 'LIST') {
                crawlerLog.info(`Processing LIST page ${pageNo}: ${request.url}`);

                // First try to extract from __INITIAL_DATA__
                const html = $.html();
                const initialData = extractInitialData(html);

                if (initialData) {
                    const hits = extractJobsFromInitialData(initialData, language);
                    crawlerLog.info(`Found ${hits.length} jobs in __INITIAL_DATA__`);

                    for (const hit of hits) {
                        if (saved >= RESULTS_WANTED) break;
                        const job = hitToJob(hit, pageNo, language);
                        if (job.url) {
                            const stored = await pushJob(job);
                            if (stored) {
                                crawlerLog.info(`Saved job ${saved}/${RESULTS_WANTED}: ${job.title}`);
                            }
                        }
                    }
                }

                // Pagination
                if (saved < RESULTS_WANTED && pageNo < MAX_PAGES) {
                    const nextUrl = buildSearchUrl(pageNo + 1);
                    await enqueueLinks({
                        urls: [nextUrl],
                        userData: { label: 'LIST', pageNo: pageNo + 1 },
                    });
                    crawlerLog.info(`Enqueued next LIST page ${pageNo + 1}`);
                }
                return;
            }

            // ---------------- DETAIL HANDLER ----------------
            if (label === 'DETAIL') {
                if (saved >= RESULTS_WANTED) {
                    crawlerLog.info(`Already reached RESULTS_WANTED=${RESULTS_WANTED}, skipping detail`);
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
                    crawlerLog.warning(`Detail parse yielded empty job for ${request.url}`);
                    return;
                }

                const stored = await pushJob(job);
                if (stored) {
                    crawlerLog.info(`Saved job ${saved}/${RESULTS_WANTED} from detail: ${job.title}`);
                }
                return;
            }
        },
    });

    // ---------- Start scraping ----------

    const startUrl = buildSearchUrl(1);
    log.info(`Starting actor with mode=${mode}. First URL: ${startUrl}`);

    let jsonSaved = 0;

    // Priority 1: JSON extraction mode
    if (mode === 'auto' || mode === 'json') {
        try {
            jsonSaved = await runJsonMode();
            log.info(`JSON mode saved ${jsonSaved} items`);
        } catch (err) {
            log.warning(`JSON mode failed: ${err.message}`);
        }
    }

    // Priority 2: HTML fallback if JSON didn't get enough results
    if ((mode === 'auto' && jsonSaved < RESULTS_WANTED) || mode === 'html') {
        log.info('Running HTML fallback mode via Cheerio crawler');
        await crawler.run([{ url: startUrl, userData: { label: 'LIST', pageNo: 1 } }]);
    }

    if (saved === 0) {
        throw new Error(
            `Run completed but produced 0 jobs. ` +
            `Inputs={keyword:"${keyword}", location:"${location}", contract_type:${JSON.stringify(
                contract_type,
            )}, remote:${JSON.stringify(remote)}}. ` +
            `Mode=${mode} - Both JSON and HTML modes returned 0. Check if the website structure has changed.`,
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
