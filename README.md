# Clinical Trials Scraper

[![Node.js](https://img.shields.io/badge/Node.js-20+-43853D?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg?style=for-the-badge)](https://opensource.org/licenses/ISC)
[![clinicaltrials.gov](https://img.shields.io/badge/Data_Source-clinicaltrials.gov-0078D4?style=for-the-badge)](https://clinicaltrials.gov/)
[![API v2](https://img.shields.io/badge/API-v2-0066CC?style=for-the-badge)](https://clinicaltrials.gov/data-api/api)

A high-performance, resilient Node.js scraper for fetching clinical trial data from [ClinicalTrials.gov](https://clinicaltrials.gov/). Built with enterprise-grade reliability patterns including proxy rotation, rate limiting, circuit breakers, and automatic retries.

**Status**: Actively fetching real data from ClinicalTrials.gov API v2

---

## Features

### Core Capabilities

- **Bulk Study Fetching**: Retrieve thousands of clinical trials with cursor-based pagination
- **Detailed Trial Data**: Fetch full study records including protocols, phases, status, and historical changes
- **Date-Range Querying**: Filter trials by start date or other criteria
- **Concurrent Processing**: Parallel fetching with configurable concurrency limits

### Reliability Features

- **Proxy Rotation**: Distribute requests across multiple proxy endpoints to avoid IP blocking
- **Token Bucket Rate Limiting**: Prevent API rate limit violations with configurable limits
- **Circuit Breaker Pattern**: Temporarily stop requests to failing proxies with automatic cooldown
- **Exponential Backoff**: Intelligent retry logic with configurable delays
- **Automatic Retries**: Handles 429, 5xx errors, timeouts, and network failures
- **Connection Pooling**: Efficient HTTP connection reuse via undici

### Architecture Highlights

- **Dependency Injection**: Fully testable with mock HTTP clients
- **Immutable Configurations**: Type-safe environment variable parsing
- **Comprehensive Logging**: Structured logging with pino
- **Error Classification**: Custom error types for different failure scenarios
- **Validation Layers**: Input validation for NCT IDs and query parameters

---

## Data Source

This scraper interacts with the **ClinicalTrials.gov API v2**:

- **Studies Endpoint**: `https://clinicaltrials.gov/api/v2/studies`
- **Study Detail Endpoint**: `https://clinicaltrials.gov/api/v2/studies/{nctId}`

**Verified**: Both endpoints tested and working as of July 2026

The API provides:

- Cursor-based pagination (up to 1000 studies per page)
- Rich study metadata including protocols, interventions, eligibility criteria
- Historical data tracking (with `history=true` parameter)
- Study status, phase, and classification information
- Results data for completed studies
- Participant flow and baseline characteristics

---

## Live API Examples

### Fetch Recent Studies

```bash
# Get 3 studies (verified working)
curl -A "ClinicalTrialsScraper/1.0" \
  "https://clinicaltrials.gov/api/v2/studies?pageSize=3&countTotal=false"
```

### Fetch Specific Study Details

```bash
# Get full details for a specific trial (verified working)
curl -A "ClinicalTrialsScraper/1.0" \
  "https://clinicaltrials.gov/api/v2/studies/NCT01968135"
```

### Search with Date Range

```bash
# Studies started between specific dates
curl -A "ClinicalTrialsScraper/1.0" \
  "https://clinicaltrials.gov/api/v2/studies?pageSize=10&query.term=AREA[StartDate]RANGE[2026-01-01,2026-07-30]"
```

---

## Installation

### Prerequisites

- [Node.js](https://nodejs.org/) 20+ (ESM required)
- [npm](https://www.npmjs.com/) or [yarn](https://yarnpkg.com/)

### Quick Start

```bash
# Clone the repository
git clone https://github.com/your-org/clinical-trials-scraper.git
cd clinical-trials-scraper

# Install dependencies
npm install

# Copy environment file and configure
cp .env.example .env
# Edit .env with your proxy URLs and settings
nano .env  # or use your preferred editor

# Run the scraper
npm start

# Or run with custom date range (modify src/index.ts)
nano src/index.ts  # Edit DATE_RANGE variable
npm start
```

---

## Configuration

The scraper is configured entirely through environment variables. See `.env` and `.env.example` for all available options.

### Essential Settings

```env
# API Endpoints
API_BASE_URL='https://clinicaltrials.gov/api/v2/studies'
API_DETAIL_URL='https://clinicaltrials.gov/api/v2/studies'

# Performance
PAGE_SIZE=1000                    # Studies per page (max: 1000)
CONCURRENCY=40                    # Concurrent detail requests

# Proxy Configuration (comma-separated URLs)
PROXY_URLS="http://user:pass@host:port,http://user2:pass2@host2:port"

# Rate Limiting
PROXY_RATE_LIMIT_CAPACITY=10     # Requests per proxy per window
PROXY_RATE_LIMIT_WINDOW_MS=60000 # 60 seconds

# Retry Logic
MAX_RETRIES=3
RETRYABLE_STATUS_CODES=408,429,500,502,503,504
RETRY_BASE_DELAY_MS=500
BACKOFF_CAP_MS=15000

# Timeouts
FETCH_TIMEOUT_MS=10000
PROXY_ACQUIRE_TIMEOUT_MS=30000
```

### Full Configuration Reference

| Category            | Variable                            | Default                 | Description                        |
| ------------------- | ----------------------------------- | ----------------------- | ---------------------------------- |
| **API**             | `API_BASE_URL`                      | -                       | Base URL for studies endpoint      |
| **API**             | `API_DETAIL_URL`                    | -                       | Base URL for study detail endpoint |
| **API**             | `PAGE_SIZE`                         | 10                      | Studies per page (max: 1000)       |
| **Performance**     | `CONCURRENCY`                       | 10                      | Concurrent detail requests         |
| **Performance**     | `FETCH_TIMEOUT_MS`                  | 15000                   | Request timeout in ms              |
| **Proxy**           | `PROXY_URLS`                        | -                       | Comma-separated proxy URLs         |
| **Proxy**           | `PROXY_POOL_CONNECTIONS`            | 10                      | Max connections per proxy          |
| **Rate Limit**      | `PROXY_RATE_LIMIT_CAPACITY`         | 40                      | Requests per window                |
| **Rate Limit**      | `PROXY_RATE_LIMIT_WINDOW_MS`        | 60000                   | Window size in ms                  |
| **Retry**           | `MAX_RETRIES`                       | 3                       | Maximum retry attempts             |
| **Retry**           | `RETRYABLE_STATUS_CODES`            | 408,429,500,502,503,504 | Status codes to retry              |
| **Retry**           | `RETRY_BASE_DELAY_MS`               | 1000                    | Base backoff delay                 |
| **Retry**           | `BACKOFF_CAP_MS`                    | 30000                   | Maximum backoff delay              |
| **Circuit Breaker** | `CIRCUIT_BREAKER_FAILURE_THRESHOLD` | 3                       | Failures before opening            |
| **Circuit Breaker** | `CIRCUIT_BREAKER_COOLDOWN_MS`       | 30000                   | Cooldown period in ms              |

---

## Usage

### Running the Scraper

```bash
# Start scraping with default date range
npm start

# With custom date range (modify in src/index.ts)
# DATE_RANGE='AREA[StartDate]RANGE[2026-01-01,2026-12-31]'
```

### Programmatic Usage

```javascript
import { createApiClient } from './api.ts';
import { createHttpClient } from './httpClient.ts';

// Wire up your HTTP infrastructure, e.g. via createApiClient() in src/api/api.ts
const httpClient = await createHttpClient({
    provider, // EndpointProvider
    limiterFactory, // LimiterFactory
    endpointManagerFactory, // EndpointManagerFactory
    retryConfig, // RetryPolicyConfig, optional (defaults to module config)
    // Optional test overrides: sleep, random, wallClock
});

const api = createApiClient();

// Fetch a page of studies
const studies = await api.fetchStudiesPage({
    pageSize: 100,
    'query.term': 'AREA[StartDate]RANGE[2026-01-01,2026-07-30]',
});

// Fetch a single trial's details
const trial = await api.fetchTrialDetail('NCT12345678', { history: true });
```

---

## API Methods

### `fetchStudiesPage(params)`

Fetch a paginated list of clinical studies.

**Parameters:**

- `params.pageSize` (number): Number of studies per page (default: configured PAGE_SIZE)
- `params.pageToken` (string): Cursor token for pagination
- `params.countTotal` (boolean): Include total count in response
- `params['query.term']` (string): Search query (e.g., date range filter)

**Returns:** Promise<{ studies: Array, nextPageToken: string, totalCount: number }>

**Example:**

```javascript
const result = await api.fetchStudiesPage({
    pageSize: 100,
    countTotal: true,
    'query.term': 'AREA[StartDate]RANGE[2026-01-01,2026-07-30]',
});
```

### `fetchTrialDetail(nctId, params)`

Fetch full details for a single clinical trial.

**Parameters:**

- `nctId` (string): Required. NCT identifier (e.g., "NCT12345678")
- `params.history` (boolean): Include historical changes (optional)

**Returns:** Promise<Object> - Full study record

**Throw
