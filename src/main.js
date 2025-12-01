// Welcome to the Jungle jobs scraper - Algolia API + HTML fallback
import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';
import { gotScraping } from 'got-scraping';

// Single-entrypoint main
await Actor.init();

async function main() {
    try {
        const input = (await Actor.getInput()) || {};
        const {
            keyword = '', 
            location = '', 
            contract_type = [], 
            remote = [], 
            results_wanted: RESULTS_WANTED_RAW = 100,
            max_pages: MAX_PAGES_RAW = 20, 
            collectDetails = true, 
            proxyConfiguration,
            useAlgoliaAPI = true,
        } = input;

        const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW) ? Math.max(1, +RESULTS_WANTED_RAW) : Number.MAX_SAFE_INTEGER;
        const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 20;

        const toAbs = (href, base = 'https://www.welcometothejungle.com') => {
            try { return new URL(href, base).href; } catch { return null; }
        };

        const cleanText = (html) => {
            if (!html) return '';
            const $ = cheerioLoad(html);
            $('script, style, noscript, iframe').remove();
            return $.root().text().replace(/\s+/g, ' ').trim();
        };

        const proxyConf = proxyConfiguration ? await Actor.createProxyConfiguration({ ...proxyConfiguration }) : undefined;

        // Algolia configuration for Welcome to the Jungle
        const ALGOLIA_APP_ID = 'CSEKHVMS53';
        const ALGOLIA_API_KEY = '4bd8f6215d0cc52b26430765769e65a0';
        const ALGOLIA_INDEX = 'wttj_jobs_production_en';
        
        async function searchAlgoliaJobs(query, page = 0, filters = {}) {
            const searchParams = {
                query: query || '',
                page: page,
                hitsPerPage: 20,
                facetFilters: [],
            };

            // Add location filter if specified
            if (location && location.trim()) {
                searchParams.facetFilters.push(`offices.country_code:${location.toUpperCase()}`);
            }

            // Add contract type filters
            if (Array.isArray(contract_type) && contract_type.length > 0) {
                contract_type.forEach(ct => {
                    searchParams.facetFilters.push(`contract_type:${ct}`);
                });
            }

            // Add remote filters
            if (Array.isArray(remote) && remote.length > 0) {
                remote.forEach(r => {
                    searchParams.facetFilters.push(`remote:${r}`);
                });
            }

            try {
                const response = await gotScraping({
                    url: `https://${ALGOLIA_APP_ID}-dsn.algolia.net/1/indexes/${ALGOLIA_INDEX}/query`,
                    method: 'POST',
                    headers: {
                        'X-Algolia-Application-Id': ALGOLIA_APP_ID,
                        'X-Algolia-API-Key': ALGOLIA_API_KEY,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(searchParams),
                    responseType: 'json',
                    proxyUrl: proxyConf ? await proxyConf.newUrl() : undefined,
                });

                return response.body;
            } catch (error) {
                log.error(`Algolia API error: ${error.message}`);
                return null;
            }
        }

        let saved = 0;

        // Process jobs using Algolia API (primary method)
        if (useAlgoliaAPI) {
            log.info('Using Algolia API to fetch jobs...');
            let currentPage = 0;
            let hasMore = true;

            while (saved < RESULTS_WANTED && currentPage < MAX_PAGES && hasMore) {
                const algoliaResponse = await searchAlgoliaJobs(keyword, currentPage);
                
                if (!algoliaResponse || !algoliaResponse.hits || algoliaResponse.hits.length === 0) {
                    log.info('No more jobs found from Algolia API');
                    hasMore = false;
                    break;
                }

                const jobs = algoliaResponse.hits;
                log.info(`Page ${currentPage + 1}: Found ${jobs.length} jobs from Algolia`);

                for (const job of jobs) {
                    if (saved >= RESULTS_WANTED) break;

                    let jobData = {
                        title: job.name || null,
                        company: job.organization_name || null,
                        company_slug: job.organization_slug || null,
                        location: job.office?.name || job.offices?.map(o => o.name).join(', ') || 'Remote',
                        country: job.office?.country_name || job.offices?.map(o => o.country_name).filter(Boolean)[0] || null,
                        contract_type: job.contract_type || null,
                        remote: job.remote || null,
                        salary: job.salary || null,
                        date_posted: job.published_at || null,
                        description_text: job.description ? cleanText(job.description) : null,
                        url: toAbs(`/en/companies/${job.organization_slug}/jobs/${job.slug}`),
                        job_id: job.objectID || null,
                    };

                    // Fetch full details if requested
                    if (collectDetails && jobData.url) {
                        try {
                            const detailResponse = await gotScraping({
                                url: jobData.url,
                                proxyUrl: proxyConf ? await proxyConf.newUrl() : undefined,
                            });
                            const $detail = cheerioLoad(detailResponse.body);
                            
                            // Extract from JSON-LD
                            const jsonLd = extractFromJsonLd($detail);
                            if (jsonLd) {
                                jobData.description_html = jsonLd.description_html || jobData.description_html;
                                jobData.description_text = cleanText(jsonLd.description_html || '');
                            }

                            // Extract additional details from HTML
                            const descContainer = $detail('[data-testid="job-description"], .job-description, [class*="description"]').first();
                            if (descContainer.length) {
                                jobData.description_html = descContainer.html();
                                jobData.description_text = cleanText(descContainer.html());
                            }
                        } catch (err) {
                            log.warning(`Failed to fetch details for ${jobData.url}: ${err.message}`);
                        }
                    }

                    await Dataset.pushData(jobData);
                    saved++;
                }

                currentPage++;
                hasMore = currentPage < algoliaResponse.nbPages;
            }

            log.info(`Finished using Algolia API. Saved ${saved} jobs`);
            await Actor.exit();
            return;
        }

        // HTML Parsing fallback method
        log.info('Using HTML parsing to fetch jobs...');

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
                                location: (e.jobLocation && e.jobLocation.address && (e.jobLocation.address.addressLocality || e.jobLocation.address.addressRegion)) || null,
                                salary: e.baseSalary?.value?.value || e.baseSalary?.value || null,
                            };
                        }
                    }
                } catch (e) { /* ignore parsing errors */ }
            }
            return null;
        }

        function buildSearchUrl(page = 1) {
            const u = new URL('https://www.welcometothejungle.com/en/jobs');
            if (keyword) u.searchParams.set('query', keyword);
            if (location) u.searchParams.set('refinementList[offices.country_code][]', location.toUpperCase());
            
            if (Array.isArray(remote) && remote.length > 0) {
                remote.forEach(r => u.searchParams.append('refinementList[remote][]', r));
            }
            
            if (Array.isArray(contract_type) && contract_type.length > 0) {
                contract_type.forEach(ct => u.searchParams.append('refinementList[contract_type][]', ct));
            }
            
            u.searchParams.set('page', String(page));
            return u.href;
        }

        const crawler = new CheerioCrawler({
            proxyConfiguration: proxyConf,
            maxRequestRetries: 3,
            useSessionPool: true,
            maxConcurrency: 5,
            requestHandlerTimeoutSecs: 90,
            async requestHandler({ request, $, enqueueLinks, log: crawlerLog }) {
                const label = request.userData?.label || 'LIST';
                const pageNo = request.userData?.pageNo || 1;

                if (label === 'LIST') {
                    crawlerLog.info(`Processing search page ${pageNo}`);
                    
                    // Extract job links from HTML
                    const jobLinks = [];
                    $('a[href*="/jobs/"]').each((_, el) => {
                        const href = $(el).attr('href');
                        if (href && /\/companies\/[^\/]+\/jobs\/[^\/]+/.test(href)) {
                            const fullUrl = toAbs(href);
                            if (fullUrl && !jobLinks.includes(fullUrl)) {
                                jobLinks.push(fullUrl);
                            }
                        }
                    });

                    crawlerLog.info(`Found ${jobLinks.length} job links on page ${pageNo}`);

                    if (collectDetails && jobLinks.length > 0) {
                        const remaining = RESULTS_WANTED - saved;
                        const toEnqueue = jobLinks.slice(0, Math.max(0, remaining));
                        if (toEnqueue.length) {
                            await enqueueLinks({ urls: toEnqueue, userData: { label: 'DETAIL' } });
                        }
                    } else if (jobLinks.length > 0) {
                        const remaining = RESULTS_WANTED - saved;
                        const toPush = jobLinks.slice(0, Math.max(0, remaining));
                        if (toPush.length) { 
                            await Dataset.pushData(toPush.map(u => ({ url: u, _source: 'welcometothejungle.com' }))); 
                            saved += toPush.length; 
                        }
                    }

                    // Check if we need to fetch more pages
                    if (saved < RESULTS_WANTED && pageNo < MAX_PAGES) {
                        const nextUrl = buildSearchUrl(pageNo + 1);
                        await enqueueLinks({ urls: [nextUrl], userData: { label: 'LIST', pageNo: pageNo + 1 } });
                    }
                    return;
                }

                if (label === 'DETAIL') {
                    if (saved >= RESULTS_WANTED) return;
                    try {
                        const json = extractFromJsonLd($);
                        const data = json || {};
                        
                        // Fallback to HTML parsing
                        if (!data.title) {
                            data.title = $('h1').first().text().trim() || 
                                        $('[data-testid="job-title"], [class*="job-title"]').first().text().trim() || null;
                        }
                        
                        if (!data.company) {
                            data.company = $('[data-testid="company-name"], [class*="company-name"]').first().text().trim() || null;
                        }
                        
                        if (!data.location) {
                            data.location = $('[data-testid="job-location"], [class*="location"]').first().text().trim() || null;
                        }
                        
                        if (!data.description_html) { 
                            const desc = $('[data-testid="job-description"], .job-description, [class*="description"]').first(); 
                            data.description_html = desc && desc.length ? String(desc.html()).trim() : null; 
                        }
                        
                        data.description_text = data.description_html ? cleanText(data.description_html) : null;
                        
                        // Extract contract type and remote info
                        const contractType = $('[data-testid="contract-type"], [class*="contract"]').first().text().trim() || null;
                        const remoteInfo = $('[data-testid="remote-info"], [class*="remote"]').first().text().trim() || null;

                        const item = {
                            title: data.title || null,
                            company: data.company || null,
                            location: data.location || null,
                            contract_type: contractType,
                            remote: remoteInfo,
                            salary: data.salary || null,
                            date_posted: data.date_posted || null,
                            description_html: data.description_html || null,
                            description_text: data.description_text || null,
                            url: request.url,
                        };

                        await Dataset.pushData(item);
                        saved++;
                        crawlerLog.info(`Saved job ${saved}/${RESULTS_WANTED}: ${item.title}`);
                    } catch (err) { 
                        crawlerLog.error(`DETAIL ${request.url} failed: ${err.message}`); 
                    }
                }
            }
        });

        const startUrl = buildSearchUrl(1);
        await crawler.run([{ url: startUrl, userData: { label: 'LIST', pageNo: 1 } }]);
        log.info(`Finished HTML parsing. Saved ${saved} items`);
    } finally {
        await Actor.exit();
    }
}

main().catch(err => { console.error(err); process.exit(1); });
