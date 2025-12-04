// main.js
// Welcome to the Jungle jobs scraper - using Playwright for robust dynamic scraping

import { Actor, log } from 'apify';
import { PlaywrightCrawler, Dataset } from 'crawlee';

// ---------- Helpers ----------

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
        language = 'en',
        collectDetails = false,
    } = input;

    const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW)
        ? Math.max(1, +RESULTS_WANTED_RAW)
        : 50;
    const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW)
        ? Math.max(1, +MAX_PAGES_RAW)
        : 10;

    log.info('Actor input', {
        keyword,
        location,
        RESULTS_WANTED,
        MAX_PAGES,
        language
    });

    const proxyConf = proxyConfiguration
        ? await Actor.createProxyConfiguration({ ...proxyConfiguration })
        : undefined;

    const seenIds = new Set();
    let saved = 0;

    const pushJob = async (job) => {
        if (job.job_id && seenIds.has(job.job_id)) return false;
        if (job.job_id) seenIds.add(job.job_id);
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

    const crawler = new PlaywrightCrawler({
        proxyConfiguration: proxyConf,
        maxConcurrency,
        useSessionPool: true,
        requestHandlerTimeoutSecs: 60,
        // Headless mode is faster, but sometimes headful is needed for strict anti-bot
        headless: true,

        async requestHandler({ page, request, log: crawlerLog }) {
            const { pageNo } = request.userData;
            crawlerLog.info(`Processing page ${pageNo}: ${request.url}`);

            // Wait for job cards to load
            try {
                // Wait for either job cards or "no results" message
                await page.waitForSelector('ol[data-testid="search-results"], li[data-testid="search-results-list-item"], div[data-testid="search-results-empty"]', { timeout: 30000 });
            } catch (err) {
                crawlerLog.warning(`Timeout waiting for content on page ${pageNo}`);
                // Snapshot for debugging
                await Dataset.pushData({ error: 'Timeout', url: request.url, html: await page.content() });
                return;
            }

            // Check for no results
            const noResults = await page.$('div[data-testid="search-results-empty"]');
            if (noResults) {
                crawlerLog.info(`No results found on page ${pageNo}`);
                return;
            }

            // Extract jobs from DOM
            const jobCards = await page.$$('li[data-testid="search-results-list-item"]');
            crawlerLog.info(`Found ${jobCards.length} job cards on page ${pageNo}`);

            if (jobCards.length === 0) {
                // Fallback selector check
                const articles = await page.$$('article');
                crawlerLog.info(`Fallback: Found ${articles.length} articles`);
            }

            for (const card of jobCards) {
                if (saved >= RESULTS_WANTED) break;

                try {
                    const jobData = await card.evaluate((el) => {
                        const anchor = el.querySelector('a');
                        const titleEl = el.querySelector('h4, h3, [class*="Title"]');
                        const companyEl = el.querySelector('span[class*="Organization"], [class*="Company"]');
                        const locationEl = el.querySelector('span[class*="Region"], [class*="Location"]');
                        // Contract type often in a specific badge or list
                        const tags = Array.from(el.querySelectorAll('li, span[class*="Tag"]')).map(t => t.innerText);

                        return {
                            title: titleEl?.innerText?.trim(),
                            company: companyEl?.innerText?.trim(),
                            location: locationEl?.innerText?.trim(),
                            url: anchor ? anchor.href : null,
                            tags: tags
                        };
                    });

                    if (jobData.url) {
                        const job = {
                            job_id: toSlugId(jobData.url),
                            title: jobData.title,
                            company: jobData.company,
                            location: jobData.location,
                            url: jobData.url,
                            tags: jobData.tags,
                            _page: pageNo,
                            _fetched_at: new Date().toISOString()
                        };

                        const stored = await pushJob(job);
                        if (stored) {
                            crawlerLog.info(`Saved job ${saved}/${RESULTS_WANTED}: ${job.title}`);
                        }
                    }
                } catch (err) {
                    crawlerLog.warning(`Error extracting job card: ${err.message}`);
                }
            }

            // Pagination
            if (saved < RESULTS_WANTED && jobCards.length > 0 && pageNo < MAX_PAGES) {
                const nextUrl = buildSearchUrl(pageNo + 1);
                await crawler.addRequests([{
                    url: nextUrl,
                    userData: { pageNo: pageNo + 1 }
                }]);
                crawlerLog.info(`Enqueued next page ${pageNo + 1}`);
            }
        },
    });

    const startUrl = buildSearchUrl(1);
    log.info(`Starting Playwright scraper. First URL: ${startUrl}`);

    await crawler.run([{
        url: startUrl,
        userData: { pageNo: 1 }
    }]);

    await Actor.pushData({
        _summary: true,
        saved,
        keyword,
        location,
    });

    log.info(`Finished. Saved ${saved} jobs`);
});
