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

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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
        maxConcurrency = 3,
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
        requestHandlerTimeoutSecs: 90,
        navigationTimeoutSecs: 60,
        headless: true,
        
        launchContext: {
            launchOptions: {
                args: [
                    '--disable-blink-features=AutomationControlled',
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                ],
            },
        },

        preNavigationHooks: [
            async ({ page }) => {
                // Block unnecessary resources for faster loading
                await page.route('**/*.{png,jpg,jpeg,gif,svg,webp,ico,woff,woff2,ttf}', (route) => route.abort());
                await page.route('**/analytics**', (route) => route.abort());
                await page.route('**/tracking**', (route) => route.abort());
                await page.route('**/gtm**', (route) => route.abort());
                await page.route('**/google-analytics**', (route) => route.abort());
            },
        ],

        async requestHandler({ page, request, log: crawlerLog }) {
            const { pageNo } = request.userData;
            crawlerLog.info(`Processing page ${pageNo}: ${request.url}`);

            // Wait for page to stabilize
            await delay(2000);

            // Wait for job cards to load with multiple fallback selectors
            try {
                await page.waitForSelector(
                    'ol[data-testid="search-results"] li, ' +
                    'li[data-testid="search-results-list-item"], ' +
                    'div[data-testid="search-results-empty"], ' +
                    '[class*="SearchResults"] li, ' +
                    'article[class*="job"]',
                    { timeout: 45000 }
                );
            } catch (err) {
                crawlerLog.warning(`Timeout waiting for content on page ${pageNo}, trying alternative approach...`);
                
                // Take screenshot for debugging
                const screenshot = await page.screenshot({ type: 'png' });
                await Actor.setValue(`page-${pageNo}-screenshot`, screenshot, { contentType: 'image/png' });
                
                // Try scrolling to trigger lazy loading
                await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                await delay(3000);
            }

            // Check for no results
            const noResults = await page.$('div[data-testid="search-results-empty"], [class*="empty"], [class*="no-results"]');
            if (noResults) {
                const noResultsText = await noResults.textContent();
                crawlerLog.info(`No results found on page ${pageNo}: ${noResultsText}`);
                return;
            }

            // Extract jobs using multiple selector strategies
            let jobCards = await page.$$('li[data-testid="search-results-list-item"]');
            
            if (jobCards.length === 0) {
                crawlerLog.info('Primary selector failed, trying fallback selectors...');
                jobCards = await page.$$('ol[data-testid="search-results"] > li');
            }
            
            if (jobCards.length === 0) {
                jobCards = await page.$$('[class*="SearchResults"] li[class*="Item"]');
            }

            if (jobCards.length === 0) {
                // Try to extract from page content directly
                jobCards = await page.$$('a[href*="/jobs/"]');
                crawlerLog.info(`Found ${jobCards.length} job links via href matching`);
            }

            crawlerLog.info(`Found ${jobCards.length} job cards on page ${pageNo}`);

            // If still no cards, try extracting job URLs from page
            if (jobCards.length === 0) {
                const jobUrls = await page.evaluate(() => {
                    const links = Array.from(document.querySelectorAll('a[href*="/companies/"][href*="/jobs/"]'));
                    return links.map(a => ({
                        url: a.href,
                        title: a.querySelector('h4, h3, [class*="title"]')?.innerText?.trim() || a.innerText?.trim()?.split('\n')[0],
                    })).filter(j => j.url && j.title);
                });

                crawlerLog.info(`Extracted ${jobUrls.length} jobs via URL pattern matching`);
                
                for (const jobUrl of jobUrls) {
                    if (saved >= RESULTS_WANTED) break;
                    const job = {
                        job_id: toSlugId(jobUrl.url),
                        title: jobUrl.title,
                        url: jobUrl.url,
                        _page: pageNo,
                        _fetched_at: new Date().toISOString()
                    };
                    await pushJob(job);
                }
            } else {
                for (const card of jobCards) {
                    if (saved >= RESULTS_WANTED) break;

                    try {
                        const jobData = await card.evaluate((el) => {
                            const anchor = el.querySelector('a[href*="/jobs/"]') || el.closest('a[href*="/jobs/"]') || el.querySelector('a');
                            const titleEl = el.querySelector('h4, h3, [class*="Title"], [class*="title"]');
                            const companyEl = el.querySelector('span[class*="Organization"], [class*="Company"], [class*="company"]');
                            const locationEl = el.querySelector('span[class*="Region"], [class*="Location"], [class*="location"]');
                            const contractEl = el.querySelector('[class*="contract"], [class*="Contract"]');
                            const remoteEl = el.querySelector('[class*="remote"], [class*="Remote"]');
                            
                            // Get all text content as tags
                            const tags = Array.from(el.querySelectorAll('li, span[class*="Tag"], span[class*="badge"]'))
                                .map(t => t.innerText?.trim())
                                .filter(t => t && t.length < 50);

                            return {
                                title: titleEl?.innerText?.trim() || anchor?.innerText?.split('\n')[0]?.trim(),
                                company: companyEl?.innerText?.trim(),
                                location: locationEl?.innerText?.trim(),
                                contract_type: contractEl?.innerText?.trim(),
                                remote: remoteEl?.innerText?.trim(),
                                url: anchor ? anchor.href : null,
                                tags: [...new Set(tags)]
                            };
                        });

                        if (jobData.url && jobData.url.includes('/jobs/')) {
                            const job = {
                                job_id: toSlugId(jobData.url),
                                title: jobData.title || 'Unknown Title',
                                company: jobData.company || null,
                                location: jobData.location || null,
                                contract_type: jobData.contract_type || null,
                                remote: jobData.remote || null,
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
            }

            // Pagination - only if we need more results
            if (saved < RESULTS_WANTED && pageNo < MAX_PAGES) {
                // Check if there are more pages by looking for next page link
                const hasNextPage = await page.$('a[aria-label*="next"], a[aria-label*="Next"], button[aria-label*="next"], [class*="pagination"] a');
                
                if (hasNextPage || jobCards.length > 0) {
                    const nextUrl = buildSearchUrl(pageNo + 1);
                    await crawler.addRequests([{
                        url: nextUrl,
                        userData: { pageNo: pageNo + 1 }
                    }]);
                    crawlerLog.info(`Enqueued next page ${pageNo + 1}`);
                } else {
                    crawlerLog.info('No more pages available');
                }
            }
        },

        failedRequestHandler({ request, log: crawlerLog }, error) {
            crawlerLog.error(`Request failed: ${request.url}`, { error: error.message });
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
