// main.js
// Welcome to the Jungle jobs scraper - pure HTTP + Next.js JSON (__NEXT_DATA__), no Playwright, no Algolia.

import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';

// ------------- Helpers -------------

const cleanText = (html) => {
    if (!html) return '';
    const $ = cheerioLoad(html);
    $('script, style, noscript, iframe').remove();
    return $.root().text().replace(/\s+/g, ' ').trim();
};

const toAbs = (href, base = 'https://www.welcometothejungle.com') => {
    try {
        return new URL(href, base).href;
    } catch {
        return null;
    }
};

function extractJobsFromNextData(raw) {
    // Generic BFS: collect any objects that look like job postings (have slug + organization_slug)
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

        if (hasSlug && hasOrg) {
            jobs.push(cur);
        }

        for (const k of keys) {
            queue.push(cur[k]);
        }
    }

    return jobs;
}

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

// ------------- Main actor -------------

await Actor.main(async () => {
    const input = (await Actor.getInput()) || {};

    const {
        keyword = '',
        // IMPORTANT: ISO country code (e.g. "FR", "US") – but can be blank.
        location = '',
        contract_type = [],
        remote = [],
        results_wanted: RESULTS_WANTED_RAW = 50,
        max_pages: MAX_PAGES_RAW = 10,
        proxyConfiguration,
        maxConcurrency = 4,
    } = input;

    log.info('Actor input', {
        keyword,
        location,
        contract_type,
        remote,
        RESULTS_WANTED_RAW,
        MAX_PAGES_RAW,
        maxConcurrency,
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
                'This may reduce or skew results, as filters expect country codes.',
        );
    }

    const proxyConf = proxyConfiguration
        ? await Actor.createProxyConfiguration({ ...proxyConfiguration })
        : undefined;

    const seenIds = new Set();
    const seenUrls = new Set();
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
                };
            },
        ],
        async requestHandler({ request, $, enqueueLinks, log: crawlerLog }) {
            const label = request.userData?.label || 'LIST';
            const pageNo = request.userData?.pageNo || 1;

            if (label !== 'LIST') return;

            crawlerLog.info(`Processing LIST page ${pageNo}: ${request.url}`);

            // 1) Find the Next.js data script (__NEXT_DATA__ or similar)
            let nextJsonText =
                $('script#__NEXT_DATA__').first().html() ||
                $('script[id="__NEXT_DATA__"]').first().html() ||
                $('script[type="application/json"][data-nextjs-data]').first().html() ||
                $('script[type="application/json"][data-next-page]').first().html();

            if (!nextJsonText) {
                crawlerLog.warning(
                    `No __NEXT_DATA__-style script found on page ${pageNo}. HTML snippet:\n` +
                        $.html().slice(0, 1500),
                );
                return;
            }

            let parsed;
            try {
                parsed = JSON.parse(nextJsonText);
            } catch (err) {
                crawlerLog.error(`Failed to parse __NEXT_DATA__ JSON on page ${pageNo}: ${err.message}`);
                return;
            }

            const candidateJobs = extractJobsFromNextData(parsed);
            crawlerLog.info(
                `extractJobsFromNextData() found ${candidateJobs.length} candidate jobs on page ${pageNo}`,
            );

            if (!candidateJobs.length) {
                crawlerLog.warning(
                    `No candidate jobs discovered in Next.js data on page ${pageNo}. JSON excerpt: ` +
                        nextJsonText.slice(0, 800),
                );
            }

            const remaining = RESULTS_WANTED - saved;
            if (remaining <= 0) {
                crawlerLog.info(
                    `Already reached requested RESULTS_WANTED=${RESULTS_WANTED}, skipping further extraction.`,
                );
                return;
            }

            for (const job of candidateJobs.slice(0, Math.max(0, remaining))) {
                if (saved >= RESULTS_WANTED) break;

                const url =
                    (job.slug && job.organization_slug
                        ? toAbs(`/en/companies/${job.organization_slug}/jobs/${job.slug}`)
                        : job.url && toAbs(job.url)) || null;

                const item = {
                    title: job.name || job.title || null,
                    company:
                        job.organization_name ||
                        job.company ||
                        job.organization?.name ||
                        null,
                    company_slug:
                        job.organization_slug || job.organization?.slug || null,
                    location:
                        job.office?.name ||
                        (Array.isArray(job.offices)
                            ? job.offices
                                  .map((o) => o.name)
                                  .filter(Boolean)
                                  .join(', ')
                            : null) ||
                        job.location ||
                        null,
                    country:
                        job.office?.country_name ||
                        (Array.isArray(job.offices)
                            ? job.offices
                                  .map((o) => o.country_name)
                                  .filter(Boolean)[0]
                            : null) ||
                        null,
                    contract_type: normalizeContract(job.contract_type),
                    remote: normalizeRemote(job.remote),
                    salary: job.salary || null,
                    date_posted: job.published_at || job.date_posted || null,
                    description_text: job.description ? cleanText(job.description) : null,
                    url,
                    job_id: job.objectID || job.id || null,
                    _source: 'next-list',
                    _page: pageNo,
                };

                const stored = await pushJob(item);
                if (stored) {
                    crawlerLog.info(
                        `Saved job ${saved}/${RESULTS_WANTED} from LIST page ${pageNo}: ${
                            item.title || 'Untitled'
                        }`,
                    );
                } else {
                    crawlerLog.debug(
                        `Skipped duplicate job on LIST page ${pageNo}: ${item.url || item.job_id}`,
                    );
                }
            }

            // 2) Enqueue next LIST page if we still want more
            if (saved < RESULTS_WANTED && pageNo < MAX_PAGES) {
                const nextUrl = buildSearchUrl(pageNo + 1);
                crawlerLog.info(
                    `Enqueuing next LIST page ${pageNo + 1} (${nextUrl}) - current saved=${saved}`,
                );
                await enqueueLinks({
                    urls: [nextUrl],
                    userData: { label: 'LIST', pageNo: pageNo + 1 },
                });
            } else {
                crawlerLog.info(
                    `Stopping pagination. saved=${saved}, pageNo=${pageNo}, MAX_PAGES=${MAX_PAGES}`,
                );
            }
        },
    });

    const startUrl = buildSearchUrl(1);
    log.info(`Starting CheerioCrawler on: ${startUrl}`);

    await crawler.run([{ url: startUrl, userData: { label: 'LIST', pageNo: 1 } }]);

    if (saved === 0) {
        throw new Error(
            `Run completed but produced 0 jobs. ` +
                `Inputs={keyword:"${keyword}", location:"${location}", contract_type:${JSON.stringify(
                    contract_type,
                )}, remote:${JSON.stringify(remote)}}. ` +
                `Mode=next-json-html — either the embedded Next.js data format changed, ` +
                `or the site is blocking the actor / serving different HTML to bots.`,
        );
    }

    await Actor.pushData({
        _summary: true,
        saved,
        mode: 'next-json-html',
        keyword,
        location,
    });

    log.info(`Finished. Saved ${saved} jobs`);
});
