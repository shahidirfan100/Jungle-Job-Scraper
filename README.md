# Welcome to the Jungle Jobs Scraper

Extract comprehensive job listings from Welcome to the Jungle with advanced filtering options. This powerful scraper supports both high-speed API extraction and detailed HTML parsing to deliver accurate, up-to-date job data.

## What does the Welcome to the Jungle Jobs Scraper do?

This scraper automates job data collection from Welcome to the Jungle, one of Europe's leading job platforms. It efficiently extracts job postings with complete details including title, company, location, remote work options, contract type, salary information, and full descriptions.

**Key capabilities:**
- **Dual extraction methods**: Fast Algolia API queries or comprehensive HTML parsing (automatically falls back if API is blocked or empty)
- **Advanced filtering**: Search by keyword, location, contract type, and remote work preferences
- **Complete job details**: Extract descriptions, requirements, benefits, and metadata
- **Smart pagination**: Automatically handles multiple pages of search results
- **Structured output**: Clean, standardized data ready for analysis or integration

## Why scrape Welcome to the Jungle?

Welcome to the Jungle hosts thousands of job opportunities across multiple countries and industries. Scraping enables:

- **Market research**: Analyze hiring trends, salary ranges, and skill demands
- **Job aggregation**: Build comprehensive job boards or comparison tools
- **Recruitment intelligence**: Monitor competitor hiring and industry movements
- **Career planning**: Track opportunities matching specific criteria
- **Data analysis**: Study employment patterns and market dynamics

## How much does it cost to scrape Welcome to the Jungle?

The scraper is optimized for efficiency and cost-effectiveness. Costs depend on the number of jobs extracted and detail level:

**Using Datacenter Proxies (default):**
- **50 jobs (basic data)**: ~$0.003 - $0.01
- **100 jobs (basic data)**: ~$0.005 - $0.02
- **500 jobs (basic data)**: ~$0.05 - $0.15
- **1000 jobs (basic data)**: ~$0.10 - $0.30

**Using Residential Proxies:**
- **50 jobs**: ~$0.05 - $0.10
- **100 jobs**: ~$0.10 - $0.20
- **500 jobs**: ~$0.50 - $1.00
- **1000 jobs**: ~$1.50 - $3.00

*Note: Enabling `collectDetails` significantly increases runtime and costs. Estimates based on Apify platform pricing.*

## Performance & Reliability

### Timeout Handling
The scraper includes robust timeout and migration support:
- **Graceful shutdown**: Automatically handles platform timeouts and migrations
- **State persistence**: Saves progress every 10 jobs and every 30 seconds
- **Resume capability**: Can continue from where it left off if interrupted
- **Smart exit**: Stops cleanly when target is reached or timeout occurs

### Recommended Timeout Settings
- **50 jobs (basic)**: 1-2 minutes
- **100 jobs (basic)**: 2-5 minutes
- **500 jobs**: 10-15 minutes  
- **1000 jobs**: 20-30 minutes
- **With collectDetails enabled**: Add 100-200% more time

If the actor times out before reaching your target, it will save all collected data and can be resumed with a longer timeout.

### Proxy Configuration
- **Datacenter proxies** (default): Fast, cost-effective, works well for most use cases
- **Residential proxies**: Use if you encounter rate limiting or blocking (more expensive)

## Input Configuration

### Basic Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `keyword` | String | No | Job title, skill, or keyword (e.g., "Software Engineer", "Marketing Manager") |
| `location` | String | No | Two-letter country code (US, GB, FR, DE) - leave empty for worldwide |
| `contract_type` | Array | No | Filter by employment type: full_time, part_time, internship, apprenticeship, freelance, fixed_term |
| `remote` | Array | No | Remote work options: fulltime, partial, punctual, no |
| `results_wanted` | Integer | No | Maximum jobs to extract (default: 100, max: 1000) |
| `max_pages` | Integer | No | Page limit for safety (default: 20, max: 100) |
| `useAlgoliaAPI` | Boolean | No | Use fast Algolia API (default: true). Disable to force HTML-only crawling |
| `algoliaApiKey` | String | No | Optional Algolia API key override (leave empty to use built-in) |

### Advanced Settings

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `mode` | String | No | Extraction mode: 'auto' (API first, HTML fallback), 'json' (API only), 'html' (HTML only) |
| `collectDetails` | Boolean | No | Visit job pages for full descriptions (default: false, increases runtime 100-200%) |
| `maxConcurrency` | Integer | No | Concurrent page processing (default: 5, range: 1-20) |
| `language` | String | No | Site language code: 'en', 'fr', 'de' (default: 'en') |
| `proxyConfiguration` | Object | No | Proxy settings - datacenter (default) or residential |

### Example Input

```json
{
  "keyword": "data scientist",
  "location": "US",
  "contract_type": ["full_time"],
  "remote": ["fulltime", "partial"],
  "results_wanted": 100,
  "max_pages": 10,
  "mode": "auto",
  "language": "en",
  "collectDetails": false,
  "maxConcurrency": 5,
  "proxyConfiguration": {
    "useApifyProxy": true,
    "apifyProxyGroups": ["RESIDENTIAL"]
  }
}
```

## Output Format

The scraper delivers structured JSON data for each job listing:

```json
{
  "title": "Senior Data Scientist",
  "company": "TechCorp Inc",
  "company_slug": "techcorp-inc",
  "location": "San Francisco, CA",
  "country": "United States",
  "contract_type": "full_time",
  "remote": "partial",
  "salary": "$120,000 - $160,000",
  "date_posted": "2025-11-28T10:30:00Z",
  "description_html": "<p>Full HTML description...</p>",
  "description_text": "Clean text version of description...",
  "url": "https://www.welcometothejungle.com/en/companies/techcorp-inc/jobs/senior-data-scientist_abc123",
  "job_id": "abc123def456"
}
```

### Output Fields

- **title**: Job position title
- **company**: Company name
- **company_slug**: URL-friendly company identifier
- **location**: Office location or "Remote"
- **country**: Country name
- **contract_type**: Employment contract type
- **remote**: Remote work arrangement
- **salary**: Compensation range (when disclosed)
- **date_posted**: Publication timestamp
- **description_html**: Full job description with formatting
- **description_text**: Plain text description
- **url**: Direct link to job posting
- **job_id**: Unique job identifier

## How to Use

### Quick Start

1. **Create a free Apify account** at [apify.com](https://apify.com)
2. **Find this scraper** in the Apify Store
3. **Configure your search** using the input fields above
4. **Click "Start"** and wait for results
5. **Download data** in JSON, CSV, XML, or Excel format

### API Integration

Integrate the scraper into your workflow using the Apify API:

```javascript
// JavaScript/Node.js example
const ApifyClient = require('apify-client');
const client = new ApifyClient({ token: 'YOUR_API_TOKEN' });

const input = {
  keyword: "product manager",
  location: "GB",
  results_wanted: 50,
  collectDetails: true
};

const run = await client.actor('YOUR_ACTOR_ID').call(input);
const { items } = await client.dataset(run.defaultDatasetId).listItems();
console.log(items);
```

```python
# Python example
from apify_client import ApifyClient

client = ApifyClient('YOUR_API_TOKEN')
input_data = {
    "keyword": "product manager",
    "location": "GB",
    "results_wanted": 50,
    "collectDetails": True
}

run = client.actor('YOUR_ACTOR_ID').call(run_input=input_data)
items = client.dataset(run['defaultDatasetId']).list_items().items
print(items)
```

### Scheduling

Set up automatic scraping runs:
- **Daily monitoring**: Track new job postings
- **Weekly reports**: Analyze market trends
- **Real-time alerts**: Get notified of relevant opportunities

Configure schedules in your Apify account under "Schedules."

## Best Practices

### Optimize Performance
- Use **Algolia API mode** for speed (10x faster than HTML parsing); HTML fallback will engage automatically if blocked
- Enable **collectDetails** only when full descriptions are needed
- Set reasonable **results_wanted** limits to control costs and runtime

### Improve Data Quality
- Use **specific keywords** for targeted results
- Combine **multiple filters** to refine searches
- Enable **residential proxies** for maximum reliability

### Respect Rate Limits
- Avoid excessive requests in short timeframes
- Use appropriate **max_pages** limits
- Space out scheduled runs appropriately

## Common Use Cases

### Job Board Aggregation
Collect jobs matching specific criteria to populate your own job board or comparison platform.

### Recruitment Intelligence
Monitor hiring trends, competitor activities, and emerging skill requirements in your industry.

### Market Analysis
Analyze salary ranges, location preferences, and remote work adoption across sectors.

### Career Research
Track opportunities for specific roles, skills, or companies to inform career decisions.

### Automated Job Alerts
Build custom notification systems for jobs matching precise criteria beyond standard job alerts.

## FAQ

**Q: How many jobs can I scrape?**  
A: The scraper supports up to 1000 jobs per run. For larger datasets, run multiple times with different filters.

**Q: Does it work for all countries?**  
A: Yes, Welcome to the Jungle operates in multiple countries. Use the location parameter to filter by country code.

**Q: Can I get salary information?**  
A: Yes, when companies disclose salary ranges, they're included in the output.

**Q: How often is data updated?**  
A: The scraper extracts real-time data directly from Welcome to the Jungle's current listings.

**Q: What if a job page structure changes?**  
A: The scraper uses both API extraction and HTML parsing with multiple fallback selectors for resilience.

**Q: Do I need programming knowledge?**  
A: No, the scraper works through Apify's web interface. API integration is optional for advanced users.

## Support

Need help? Here's how to get assistance:

- **Documentation**: Review this guide and input field descriptions
- **Apify Support**: Contact via the platform's support channels
- **Community**: Join Apify Discord for community help
- **Issues**: Report bugs or request features through Apify

## Legal and Ethical Considerations

- **Respect robots.txt**: The scraper follows website guidelines
- **Terms of Service**: Review Welcome to the Jungle's terms before scraping
- **Data usage**: Use extracted data responsibly and legally
- **Privacy**: Job postings are public, but respect privacy in data handling
- **Rate limiting**: Avoid excessive requests that impact service availability

## Updates and Maintenance

This scraper is regularly updated to ensure compatibility with Welcome to the Jungle's website structure. Updates include:
- Selector adjustments for layout changes
- Performance optimizations
- New feature additions
- Bug fixes and stability improvements

---

**Ready to extract job data?** Start your free trial on Apify and discover thousands of opportunities from Welcome to the Jungle!
