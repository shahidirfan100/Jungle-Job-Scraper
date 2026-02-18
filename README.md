# Welcome to the Jungle Jobs Scraper

Extract, collect, and monitor job listings from Welcome to the Jungle at scale. Gather structured job data including titles, companies, locations, contract types, and optional full descriptions. Built for fast research, hiring intelligence, and recurring job-market tracking workflows.

## Features

- **Fast job extraction** — Collect listings quickly for immediate analysis.
- **Smart reliability fallback** — Continues collecting data even when source conditions change.
- **Flexible filtering** — Narrow results by keyword, country code, contract type, and remote options.
- **Optional detail enrichment** — Add full job descriptions and additional metadata when needed.
- **Deduplicated output** — Keeps dataset clean by avoiding duplicate job records.
- **Ready-to-use exports** — Download results in multiple formats for reporting and automation.

## Use Cases

### Recruitment Intelligence
Track hiring activity by role and region to understand where companies are investing. Build recurring snapshots for trend analysis and planning.

### Job Board Aggregation
Collect targeted listings for niche job boards or internal talent portals. Keep your listings fresh with scheduled runs and consistent output.

### Labor Market Research
Analyze role distribution, remote policies, and contract patterns across countries. Use structured data to support market reports and strategic decisions.

### Career Opportunity Monitoring
Create filtered datasets for specific job titles and locations. Power custom alerts and opportunity dashboards for teams or communities.

---

## Input Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `keyword` | String | No | `""` | Job title, skill, or search keyword. |
| `location` | String | No | `""` | Two-letter country code such as `US`, `GB`, `FR`, or `DE`. |
| `contract_type` | Array[String] | No | `[]` | Contract filters: `full_time`, `part_time`, `internship`, `apprenticeship`, `freelance`, `fixed_term`. |
| `remote` | Array[String] | No | `[]` | Remote filters: `fulltime`, `partial`, `punctual`, `no`. |
| `collectDetails` | Boolean | No | `false` | When enabled, adds extended job description fields. |
| `results_wanted` | Integer | No | `20` | Maximum number of job listings to collect. |
| `max_pages` | Integer | No | `5` | Maximum result pages to process for one run. |
| `proxyConfiguration` | Object | No | `{ "useApifyProxy": false }` | Proxy settings for reliability and access control. |

---

## Output Data

Each dataset item can include the following fields:

| Field | Type | Description |
|-------|------|-------------|
| `job_id` | String | Stable identifier for the job record. |
| `title` | String | Job title. |
| `company` | String | Company name. |
| `company_slug` | String | Company slug when available. |
| `location` | String | Job location text. |
| `country` | String | Country value when available. |
| `contract_type` | String | Contract type value. |
| `remote` | String | Remote-work value. |
| `salary` | String | Salary range or amount when available. |
| `date_posted` | String | Posting date/time when available. |
| `url` | String | Direct URL of the job listing. |
| `tags` | Array[String] | Job-related tags or categories. |
| `description_html` | String | HTML description (when detail collection is enabled). |
| `description_text` | String | Clean text description (when detail collection is enabled). |
| `employment_type` | String | Employment type from detail page when available. |
| `_source` | String | Collection path marker for traceability. |
| `_fetched_at` | String | ISO timestamp of data collection. |
| `_page` | Integer | Source page number when available. |

---

## Usage Examples

### Basic Extraction

Collect a small dataset for a quick check:

```json
{
  "keyword": "software engineer",
  "location": "US",
  "results_wanted": 20,
  "max_pages": 5,
  "collectDetails": false
}
```

### Remote-First Roles

Find remote-friendly product jobs in the United Kingdom:

```json
{
  "keyword": "product manager",
  "location": "GB",
  "remote": ["fulltime", "partial"],
  "results_wanted": 50,
  "max_pages": 8,
  "collectDetails": false
}
```

### Deep Research Dataset

Build a richer dataset with full descriptions:

```json
{
  "keyword": "data scientist",
  "location": "FR",
  "contract_type": ["full_time", "fixed_term"],
  "results_wanted": 80,
  "max_pages": 12,
  "collectDetails": true,
  "proxyConfiguration": {
    "useApifyProxy": true,
    "apifyProxyGroups": ["RESIDENTIAL"]
  }
}
```

---

## Sample Output

```json
{
  "job_id": "senior-data-scientist-abc123",
  "title": "Senior Data Scientist",
  "company": "TechVision",
  "company_slug": "techvision",
  "location": "Paris, Ile-de-France, France",
  "country": "France",
  "contract_type": "full_time",
  "remote": "partial",
  "salary": "65000-85000 EUR",
  "date_posted": "2026-02-10T09:15:00.000Z",
  "url": "https://www.welcometothejungle.com/en/companies/techvision/jobs/senior-data-scientist-abc123",
  "tags": ["Data", "Machine Learning", "Python"],
  "description_text": "You will build and deploy machine learning solutions...",
  "_source": "algolia",
  "_fetched_at": "2026-02-18T08:21:13.452Z"
}
```

---

## Tips for Best Results

### Start with a Focused Query
- Use specific role names like `backend engineer` instead of broad terms.
- Add location filters early to reduce irrelevant records.

### Scale Progressively
- Test with `results_wanted: 20` first.
- Increase limits after validating output quality for your use case.

### Use Detail Enrichment Strategically
- Keep `collectDetails` off for fast monitoring runs.
- Enable it for monthly deep-dive reporting and analysis.

### Proxy Configuration

For high reliability, especially on larger runs:

```json
{
  "proxyConfiguration": {
    "useApifyProxy": true,
    "apifyProxyGroups": ["RESIDENTIAL"]
  }
}
```

---

## Integrations

Connect your data with:

- **Google Sheets** — Build shared hiring dashboards.
- **Airtable** — Store and filter job intelligence in custom views.
- **Slack** — Send role-specific updates to hiring channels.
- **Make** — Automate enrichment and routing workflows.
- **Zapier** — Trigger downstream actions without code.
- **Webhooks** — Push fresh data into your own services.

### Export Formats

- **JSON** — API pipelines and custom applications.
- **CSV** — Spreadsheet analysis and reporting.
- **Excel** — Business-ready reporting packs.
- **XML** — Legacy system integrations.

---

## Frequently Asked Questions

### How many jobs can I collect in one run?
Set `results_wanted` to your target volume. Start small for testing, then scale based on runtime and data needs.

### What happens if I leave all filters empty?
The actor collects broad job results from the default scope, limited by `results_wanted` and `max_pages`.

### Can I collect full job descriptions?
Yes. Set `collectDetails` to `true` to enrich each listing with detailed description fields.

### Is the output deduplicated?
Yes. Duplicate job entries are filtered during collection to keep the dataset clean.

### Which location format should I use?
Use two-letter country codes such as `US`, `GB`, `FR`, or `DE`.

### What if I run with empty input?
If no input is provided, the actor automatically falls back to `INPUT.json` values. If that file is unavailable, built-in defaults are used.

---

## Support

For issues or feature requests, contact support through the Apify Console.

### Resources

- [Apify Documentation](https://docs.apify.com/)
- [Apify API Reference](https://docs.apify.com/api/v2)
- [Apify Scheduling](https://docs.apify.com/platform/schedules)

---

## Legal Notice

This actor is intended for legitimate data collection. You are responsible for complying with applicable laws, regulations, and website terms. Use collected data responsibly.
