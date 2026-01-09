// main.js
// Production-grade Welcome to the Jungle scraper with API-first + HTML/Playwright fallbacks

import { Actor, log } from 'apify';
import { PlaywrightCrawler, Dataset } from 'crawlee';
import { load } from 'cheerio';

// ---------- Constants ----------
// Fallback credentials (used if dynamic extraction fails)
let ALGOLIA_APP_ID = 'CSEKHVMS53';
let ALGOLIA_API_KEY = '4bd8f6215d0cc52b26430765769e65a0';
const DEFAULT_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

// ---------- Dynamic Credential Extraction ----------
const extractAlgoliaCredentials = async (language = 'en') => {
    try {
        const url = `https://www.welcometothejungle.com/${language}/jobs`;
        log.info('Extracting Algolia credentials from website...');

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        const res = await fetch(url, {
            headers: {
                'user-agent': DEFAULT_UA,
                'accept': 'text/html,application/xhtml+xml',
                'accept-language': `${language},en;q=0.9`,
            },
            signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }

        const html = await res.text();

        // Extract from window.env = {...} in script tag
        // Pattern: "ALGOLIA_APPLICATION_ID":"CSEKHVMS53"
        const appIdMatch = html.match(/"ALGOLIA_APPLICATION_ID"\s*:\s*"([^"]+)"/);
        const apiKeyMatch = html.match(/"ALGOLIA_API_KEY_CLIENT"\s*:\s*"([^"]+)"/);

        if (appIdMatch && apiKeyMatch) {
            const extractedAppId = appIdMatch[1];
            const extractedApiKey = apiKeyMatch[1];

            // Validate extracted values (app ID should be ~10 chars, API key ~32 chars)
            if (extractedAppId.length >= 8 && extractedApiKey.length >= 20) {
                log.info('Successfully extracted Algolia credentials', {
                    appId: extractedAppId,
                    apiKeyPrefix: extractedApiKey.slice(0, 8) + '...',
                });
                return { appId: extractedAppId, apiKey: extractedApiKey };
            }
        }

        log.warning('Could not extract Algolia credentials from HTML, using fallback values');
        return null;
    } catch (err) {
        log.warning(`Credential extraction failed: ${err.message}, using fallback values`);
        return null;
    }
};

// ---------- Helpers ----------
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const toSlugId = (urlOrId) => {
    if (!urlOrId) return null;
    try {
        if (!urlOrId.startsWith('http')) return urlOrId;
        const u = new URL(urlOrId);
        const parts = u.pathname.split('/').filter(Boolean);
        const last = parts[parts.length - 1] || '';
        return (
            last.match(/([a-f0-9-]{8,})$/i)?.[1] ||
            last.match(/(\d{4,})$/)?.[1] ||
            last ||
            null
        );
    } catch {
        return null;
    }
};

const buildAlgoliaFilter = ({ location, contract_type, remote }) => {
    const filters = [];
    if (location) filters.push(`offices.country_code:${location.toUpperCase()}`);

    if (Array.isArray(contract_type) && contract_type.length) {
        const clause = contract_type
            .filter(Boolean)
            .map((ct) => `contract_type:${ct}`)
            .join(' OR ');
        if (clause) filters.push(`(${clause})`);
    }

    if (Array.isArray(remote) && remote.length) {
        const clause = remote
            .filter(Boolean)
            .map((r) => `remote:${r}`)
            .join(' OR ');
        if (clause) filters.push(`(${clause})`);
    }

    return filters.join(' AND ');
};

const salaryToString = (hit) => {
    if (!hit?.salary_currency) return null;
    const min = hit.salary_minimum || hit.salary_yearly_minimum;
    const max = hit.salary_maximum || hit.salary_yearly_maximum;
    if (!min && !max) return null;
    if (min && max) return `${min}-${max} ${hit.salary_currency}`;
    return `${min || max} ${hit.salary_currency}`;
};

const mapAlgoliaHitToJob = (hit, language) => {
    const office = hit.offices?.[0] || {};
    const companySlug = hit.organization?.slug;
    const slug = hit.slug || hit.reference || hit.objectID;
    const url = companySlug
        ? `https://www.welcometothejungle.com/${language}/companies/${companySlug}/jobs/${slug}`
        : `https://www.welcometothejungle.com/${language}/jobs/${slug}`;

    const locationParts = [office.city, office.state, office.country].filter(Boolean);

    return {
        job_id: toSlugId(hit.objectID || hit.reference || slug),
        title: hit.name || null,
        company: hit.organization?.name || null,
        company_slug: companySlug || null,
        location: locationParts.join(', ') || null,
        country: office.country || null,
        contract_type: hit.contract_type || null,
        remote: hit.remote || null,
        salary: salaryToString(hit),
        date_posted: hit.published_at || hit.published_at_date || null,
        url,
        tags: hit.sectors?.map((s) => s.name).filter(Boolean) || [],
        _source: 'algolia',
        _fetched_at: new Date().toISOString(),
    };
};

const fetchAlgoliaPage = async ({ keyword, filters, page, hitsPerPage, language, retries = 3 }) => {
    const params = new URLSearchParams();
    if (keyword) params.set('query', keyword);
    params.set('hitsPerPage', hitsPerPage);
    params.set('page', page);
    params.set('clickAnalytics', 'false');
    params.set('attributesToRetrieve', '*');
    params.set('getRankingInfo', 'false');
    params.set('facets', '[]');
    if (filters) params.set('filters', filters);

    let lastError = null;

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            // Create AbortController for timeout
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout

            const res = await fetch(
                `https://${ALGOLIA_APP_ID}-dsn.algolia.net/1/indexes/wttj_jobs_production_${language}/query`,
                {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        'accept': 'application/json',
                        'user-agent': DEFAULT_UA,
                        'x-algolia-application-id': ALGOLIA_APP_ID,
                        'x-algolia-api-key': ALGOLIA_API_KEY,
                        'origin': 'https://www.welcometothejungle.com',
                        'referer': 'https://www.welcometothejungle.com/',
                    },
                    body: JSON.stringify({ params: params.toString() }),
                    signal: controller.signal,
                },
            );

            clearTimeout(timeoutId);

            if (!res.ok) {
                const text = await res.text().catch(() => res.statusText);
                throw new Error(`Algolia ${res.status}: ${text?.slice(0, 200)}`);
            }

            const data = await res.json();

            // Validate response has expected structure
            if (!data || typeof data.nbPages === 'undefined') {
                throw new Error('Invalid Algolia response structure');
            }

            return data;
        } catch (err) {
            lastError = err;
            const isAbort = err.name === 'AbortError';
            const isNetwork = err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.message.includes('fetch');

            log.warning(`Algolia API attempt ${attempt}/${retries} failed: ${isAbort ? 'Timeout' : err.message}`);

            if (attempt < retries && (isAbort || isNetwork || err.message.includes('5'))) {
                // Retry on timeout, network errors, or 5xx errors
                await delay(1000 * attempt); // Exponential backoff
                continue;
            }
            break;
        }
    }

    throw lastError || new Error('Algolia API failed after all retries');
};

const fetchJobDetail = async (url, language) => {
    try {
        const res = await fetch(url, {
            headers: {
                'user-agent': DEFAULT_UA,
                'accept-language': `${language},en;q=0.9`,
            },
        });
        if (!res.ok) {
            return {};
        }

        const html = await res.text();
        const $ = load(html);

        const ldBlocks = [];
        $('script[type="application/ld+json"]').each((_, el) => {
            const txt = $(el).text();
            if (!txt) return;
            try {
                const json = JSON.parse(txt.trim());
                if (Array.isArray(json)) {
                    ldBlocks.push(...json);
                } else {
                    ldBlocks.push(json);
                }
            } catch {
                /* ignore malformed JSON-LD */
            }
        });

        const jobLd =
            ldBlocks.find((b) => b['@type'] === 'JobPosting') ||
            ldBlocks.find((b) => Array.isArray(b['@type']) && b['@type'].includes('JobPosting'));

        if (!jobLd) return {};

        const descriptionHtml = jobLd.description || null;
        const descriptionText = descriptionHtml ? load(descriptionHtml).text().trim() : null;

        return {
            description_html: descriptionHtml,
            description_text: descriptionText,
            date_posted: jobLd.datePosted || jobLd.datePublished || jobLd.validThrough || null,
            employment_type: jobLd.employmentType || null,
        };
    } catch (err) {
        log.debug(`Detail fetch failed for ${url}: ${err.message}`);
        return {};
    }
};

const buildSearchUrl = ({ language, keyword, location, remote, contract_type, page }) => {
    const u = new URL(`https://www.welcometothejungle.com/${language}/jobs`);
    if (keyword) u.searchParams.set('query', keyword);
    if (location) u.searchParams.set('refinementList[offices.country_code][]', location.toUpperCase());
    if (Array.isArray(remote)) remote.filter(Boolean).forEach((r) => u.searchParams.append('refinementList[remote][]', r));
    if (Array.isArray(contract_type))
        contract_type.filter(Boolean).forEach((ct) => u.searchParams.append('refinementList[contract_type][]', ct));
    u.searchParams.set('page', String(page));
    return u.href;
};

// ---------- Main actor ----------

await Actor.main(async () => {
    const input = (await Actor.getInput()) || {};

    // Get language early for credential extraction
    const language = input.language || 'en';

    // Dynamically extract Algolia credentials (in case they change)
    const extractedCreds = await extractAlgoliaCredentials(language);
    if (extractedCreds) {
        ALGOLIA_APP_ID = extractedCreds.appId;
        ALGOLIA_API_KEY = extractedCreds.apiKey;
    } else {
        log.info('Using fallback Algolia credentials');
    }

    // Add graceful shutdown handler for migrations/timeouts
    let shouldExit = false;
    const gracefulShutdown = () => {
        log.warning('Received termination signal - preparing graceful shutdown');
        shouldExit = true;
    };
    Actor.on('migrating', gracefulShutdown);
    Actor.on('aborting', gracefulShutdown);
    process.on('SIGINT', gracefulShutdown);
    process.on('SIGTERM', gracefulShutdown);

    const {
        keyword = '',
        location = '',
        contract_type = [],
        remote = [],
        results_wanted: RESULTS_WANTED_RAW = 20,
        max_pages: MAX_PAGES_RAW = 5,
        proxyConfiguration,
        maxConcurrency = 5,
        // language already extracted above for credential fetching
        collectDetails = false,
        mode = 'auto', // auto | json | html
    } = input;

    const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW) ? Math.max(1, +RESULTS_WANTED_RAW) : 100;
    const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 20;

    log.info('Actor input', {
        keyword,
        location,
        RESULTS_WANTED,
        MAX_PAGES,
        language,
        mode,
        collectDetails,
    });

    const proxyConf = proxyConfiguration
        ? await Actor.createProxyConfiguration({ ...proxyConfiguration })
        : undefined;

    // Load previous state if resuming from migration
    const state = await Actor.getValue('STATE') || {};
    const seenIds = new Set(state.seenIds || []);
    let saved = state.saved || 0;
    let detailsEnriched = state.detailsEnriched || 0;
    const sourceStats = state.sourceStats || { algolia: 0, html: 0 };

    // Periodic state saving for migration support
    let lastStateSave = Date.now();
    const saveState = async () => {
        await Actor.setValue('STATE', {
            seenIds: Array.from(seenIds),
            saved,
            detailsEnriched,
            sourceStats,
            lastUpdate: new Date().toISOString()
        });
        lastStateSave = Date.now();
    };

    const pushJob = async (job) => {
        if (!job) return false;
        const id = job.job_id || job.url;
        if (id && seenIds.has(id)) return false;
        if (id) seenIds.add(id);
        await Dataset.pushData(job);
        saved++;

        // Save state every 10 jobs or every 30 seconds for migration support
        if (saved % 10 === 0 || (Date.now() - lastStateSave) > 30000) {
            await saveState();
        }

        return true;
    };

    // ---------- 1) Try Algolia API (fast path) ----------
    if (mode === 'auto' || mode === 'json') {
        try {
            const filters = buildAlgoliaFilter({ location, contract_type, remote });
            const hitsPerPage = 50;
            let page = 0;
            let totalPages = 1;

            while (saved < RESULTS_WANTED && page < totalPages && !shouldExit) {
                const algolia = await fetchAlgoliaPage({
                    keyword,
                    filters,
                    page,
                    hitsPerPage,
                    language,
                });

                totalPages = Math.min(MAX_PAGES, algolia.nbPages ?? totalPages);
                const hits = algolia.hits || [];

                for (const hit of hits) {
                    if (saved >= RESULTS_WANTED || shouldExit) break;
                    let job = mapAlgoliaHitToJob(hit, language);

                    if (collectDetails && job.url) {
                        const detail = await fetchJobDetail(job.url, language);
                        if (Object.keys(detail).length) {
                            job = { ...job, ...detail };
                            detailsEnriched++;
                        }
                    }

                    const stored = await pushJob(job);
                    if (stored) sourceStats.algolia++;
                }

                if (hits.length === 0 || shouldExit) break;
                page += 1;
                await saveState();
            }

            // If we reached target, no need for HTML fallback
            if (saved >= RESULTS_WANTED) {
                log.info(`Target of ${RESULTS_WANTED} jobs reached via Algolia API`);
            }
        } catch (err) {
            log.warning(`Algolia path failed, will try HTML fallback: ${err.message}`);
        }
    }

    // ---------- 2) HTML/Playwright fallback ----------
    const needsHtml = saved < RESULTS_WANTED && (mode === 'auto' || mode === 'html') && !shouldExit;

    if (needsHtml) {
        const crawler = new PlaywrightCrawler({
            proxyConfiguration: proxyConf,
            maxConcurrency,
            useSessionPool: true,
            requestHandlerTimeoutSecs: 60,
            navigationTimeoutSecs: 45,
            headless: true,
            maxRequestRetries: 2,
            launchContext: {
                launchOptions: {
                    args: [
                        '--disable-blink-features=AutomationControlled',
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                    ],
                    viewport: { width: 1280, height: 800 },
                },
            },
            preNavigationHooks: [
                async ({ page }) => {
                    await page.setExtraHTTPHeaders({
                        'user-agent': DEFAULT_UA,
                        'accept-language': `${language},en;q=0.9`,
                    });
                    await page.addInitScript(() => {
                        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                    });
                    await page.route('**/*.{png,jpg,jpeg,gif,svg,webp,ico,woff,woff2,ttf}', (route) => route.abort());
                    await page.route('**/analytics**', (route) => route.abort());
                    await page.route('**/tracking**', (route) => route.abort());
                },
            ],
            async requestHandler({ page, request, log: crawlerLog, crawler }) {
                const { pageNo } = request.userData;
                crawlerLog.info(`Processing page ${pageNo}: ${request.url}`);

                await page.waitForLoadState('domcontentloaded');
                await delay(800);

                try {
                    await page.waitForSelector(
                        'li[data-testid="search-results-list-item"], ol[data-testid="search-results"] li, a[href*="/jobs/"]',
                        { timeout: 15000 },
                    );
                } catch {
                    const screenshot = await page.screenshot({ type: 'png' });
                    await Actor.setValue(`page-${pageNo}-screenshot`, screenshot, { contentType: 'image/png' });
                }

                await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                await delay(500);

                let jobCards = await page.$$('li[data-testid="search-results-list-item"]');
                if (jobCards.length === 0) jobCards = await page.$$('ol[data-testid="search-results"] > li');
                if (jobCards.length === 0) jobCards = await page.$$('a[href*="/jobs/"]');

                crawlerLog.info(`Found ${jobCards.length} potential job cards on page ${pageNo}`);

                for (const card of jobCards) {
                    if (saved >= RESULTS_WANTED || shouldExit) break;
                    try {
                        const jobData = await card.evaluate((el) => {
                            const anchor =
                                el.querySelector('a[href*="/jobs/"]') ||
                                (el.closest ? el.closest('a[href*="/jobs/"]') : null) ||
                                el.querySelector('a');
                            const titleEl = el.querySelector('h4, h3, [class*="Title"], [class*="title"]');
                            const companyEl = el.querySelector('span[class*="Organization"], [class*="Company"], [class*="company"]');
                            const locationEl = el.querySelector('span[class*="Region"], [class*="Location"], [class*="location"]');
                            const contractEl = el.querySelector('[class*="contract"], [class*="Contract"]');
                            const remoteEl = el.querySelector('[class*="remote"], [class*="Remote"]');
                            const tags = Array.from(
                                el.querySelectorAll('li, span[class*="Tag"], span[class*="badge"]'),
                            )
                                .map((t) => t.innerText?.trim())
                                .filter((t) => t && t.length < 60);
                            return {
                                url: anchor?.href || null,
                                title: titleEl?.innerText?.trim() || anchor?.innerText?.split('\n')[0]?.trim(),
                                company: companyEl?.innerText?.trim() || null,
                                location: locationEl?.innerText?.trim() || null,
                                contract_type: contractEl?.innerText?.trim() || null,
                                remote: remoteEl?.innerText?.trim() || null,
                                tags: Array.from(new Set(tags)),
                            };
                        });

                        if (!jobData?.url || !jobData.url.includes('/jobs/')) continue;
                        let job = {
                            job_id: toSlugId(jobData.url),
                            ...jobData,
                            _page: pageNo,
                            _source: 'html',
                            _fetched_at: new Date().toISOString(),
                        };

                        if (collectDetails) {
                            const detail = await fetchJobDetail(job.url, language);
                            if (Object.keys(detail).length) {
                                job = { ...job, ...detail };
                                detailsEnriched++;
                            }
                        }

                        const stored = await pushJob(job);
                        if (stored) sourceStats.html++;
                    } catch (err) {
                        crawlerLog.warning(`Card extract failed: ${err.message}`);
                    }
                }

                // Save state after each page
                await saveState();

                if (saved < RESULTS_WANTED && pageNo < MAX_PAGES && !shouldExit) {
                    const nextUrl = buildSearchUrl({
                        language,
                        keyword,
                        location,
                        remote,
                        contract_type,
                        page: pageNo + 1,
                    });
                    await crawler.addRequests([{ url: nextUrl, userData: { pageNo: pageNo + 1 } }]);
                    crawlerLog.info(`Enqueued page ${pageNo + 1}`);
                } else if (saved >= RESULTS_WANTED) {
                    crawlerLog.info(`Target reached: ${saved}/${RESULTS_WANTED} jobs`);
                } else if (shouldExit) {
                    crawlerLog.warning('Graceful shutdown in progress');
                }
            },
            failedRequestHandler({ request, log: crawlerLog }, error) {
                crawlerLog.error(`Request failed: ${request.url}`, { error: error.message });
            },
        });

        const startUrl = buildSearchUrl({ language, keyword, location, remote, contract_type, page: 1 });
        log.info(`Starting Playwright fallback. First URL: ${startUrl}`);

        await crawler.run([
            {
                url: startUrl,
                userData: { pageNo: 1 },
            },
        ]);
    }

    // ---------- Final state save and summary ----------
    await saveState();

    const summary = {
        totalJobs: saved,
        targetJobs: RESULTS_WANTED,
        targetReached: saved >= RESULTS_WANTED,
        keyword,
        location,
        mode,
        sourceAlgolia: sourceStats.algolia,
        sourceHtml: sourceStats.html,
        detailsEnriched,
        gracefulShutdown: shouldExit,
        completedAt: new Date().toISOString()
    };

    // Store summary in key-value store (not dataset)
    await Actor.setValue('OUTPUT', summary);

    log.info('Actor finished', summary);

    // Exit with appropriate status
    if (saved === 0) {
        throw new Error('No jobs were scraped. Please check your input parameters.');
    }

    if (saved < RESULTS_WANTED && !shouldExit) {
        log.warning(`Only ${saved}/${RESULTS_WANTED} jobs scraped. Consider adjusting search parameters or increasing timeout.`);
    }
});
