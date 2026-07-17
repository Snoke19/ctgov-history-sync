# Clinical Trials Scraper

A resilient Node.js scraper for [ClinicalTrials.gov](https://clinicaltrials.gov/) built on `undici` with proxy rotation,
token-bucket rate limiting, automatic retries, and exponential backoff.

---

## Features

- **Cursor-based pagination** — fetches study listings with `pageToken`, no offset limits
- **Detail retrieval** — fetches full trial records by NCT ID
- **Proxy pool with health tracking** — distributes load across multiple proxies; dead proxies recover via exponential
  decay
- **Token bucket rate limiting** — per-proxy request pacing (e.g. 40 req/min per IP)
- **Automatic retries** — configurable status codes, exponential backoff with jitter, respects `Retry-After` headers
- **Timeout budget management** — proxy acquisition + fetch share a single deadline
- **Connection hygiene** — guaranteed body drain/cancel before returning connections to the undici pool
- **Structured logging** — Pino with pretty-printing in development, JSON in production
- **Input validation** — NCT ID, geo filters, page size, and decay function validators

---

## Requirements

- Node.js >= 20.3.0 (uses `AbortSignal.any` and `AbortSignal.timeout`)
- npm >= 9

---

## Installation

```bash
git clone <repository-url>
cd clinical_trials_scrap
npm install
```

---

## Configuration

Create a `.env` file in the project root:

```bash
# ---------------------------------------------------------------------------
# API endpoints
# ---------------------------------------------------------------------------
API_BASE_URL=https://clinicaltrials.gov/api/v2/studies
API_DETAIL_URL=https://clinicaltrials.gov/api/int/studies

# ---------------------------------------------------------------------------
# Fetching
# ---------------------------------------------------------------------------
CONCURRENCY=10
PAGE_SIZE=1000
FETCH_TIMEOUT_MS=15000

# ---------------------------------------------------------------------------
# Retry & backoff
# ---------------------------------------------------------------------------
MAX_RETRIES=3
RETRY_BASE_DELAY_MS=1000
DEFAULT_RETRY_AFTER_MS=5000
BACKOFF_CAP_MS=30000

# Comma-separated HTTP status codes that trigger retry
RETRYABLE_STATUS_CODES=408,429,500,502,503,504

# Status codes that may carry a Retry-After header
RETRY_AFTER_STATUS_CODES=429

# Whether to retry on timeout / network errors
RETRY_ON_TIMEOUT=true
RETRY_ON_NETWORK_ERROR=true

# ---------------------------------------------------------------------------
# HTTP client
# ---------------------------------------------------------------------------
DEFAULT_USER_AGENT=ClinicalTrialsScraper/1.0
ERROR_BODY_PREVIEW_LENGTH=200

# ---------------------------------------------------------------------------
# Proxy pool (comma-separated HTTP proxy URLs)
# ---------------------------------------------------------------------------
PROXY_IP=http://user:pass@proxy1:8080,http://user:pass@proxy2:8080

PROXY_POOL_CONNECTIONS=50
PROXY_POOL_KEEP_ALIVE_TIMEOUT_MS=300000
PROXY_POOL_HEADERS_TIMEOUT_MS=15000
PROXY_POOL_BODY_TIMEOUT_MS=45000

PROXY_RATE_LIMIT_CAPACITY=40
PROXY_RATE_LIMIT_WINDOW_MS=60000
PROXY_ACQUIRE_TIMEOUT_MS=30000
PROXY_ACQUIRE_TIER_SIZE=3

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
LOG_LEVEL=debug
NODE_ENV=development
```

---

## Usage

### Run the scraper

```bash
npm start
```

### Development

```bash
# Lint
npm run lint

# Auto-fix lint issues
npm run lint:fix

# Format with Prettier
npm run format
```

---

## Project Structure

```
src/
├── index.js                  # Entry point — orchestrates fetch pipeline
├── api.js                    # High-level API: fetchStudiesPage, fetchTrialDetail
├── config/
│   ├── config.js             # Environment variable loader & constants
│   └── logging.js            # Pino logger configuration
├── error/
│   └── errors.js             # Custom error classes
├── http/
│   ├── httpClient.js         # Resilient fetch with retry/backoff/proxy
│   ├── proxyPool.js          # Proxy pool, token bucket, health tracking
│   ├── cleanParams.js        # Parameter cleaning utility
│   └── urlPrepare.js         # URL builder (UrlBuilder class)
└── validators.js             # Input validation (NCT ID, geo filters, etc.)
```

---

## Architecture

### HTTP Client Stack

```
fetchJson(url, options)
    └── fetchWithRetry(url, options)
            └── attemptFetch(url, options)
                    └── executeFetch(url, options)
                            └── acquireProxyDispatcher(timeoutMs)
                                    └── TokenBucket.acquire()
```

**Layers:**

1. **`fetchJson`** — public API. Parses JSON, handles 404 short-circuit, drains body.
2. **`fetchWithRetry`** — retry loop. Idempotent methods only (GET/HEAD/PUT/DELETE/OPTIONS). Respects `Retry-After`.
3. **`executeFetch`** — single request. Acquires proxy, manages timeout budget, reports proxy health.
4. **`proxyPool`** — proxy selection. Anti-herding (random from top-N), health sorting, token-bucket pacing.

### Proxy Selection Strategy

1. **Filter** — proxies with ≥1 token available
2. **Sort** — by `failures` asc, then `tokens` desc
3. **Pick** — random from top `ACQUIRE_TIER` (default 3)
4. **Fallback** — if all exhausted, wait on proxy with oldest `lastRefill`

### Health Tracking

- **Failure:** `failures += 1` (linear)
- **Success:** `failures = floor(failures × 0.5)` (exponential decay)

A proxy with 10 failures recovers in ~4 successful requests.

---

## API Reference

### `fetchJson(url, options)`

The single entry point for all HTTP requests.

```javascript
import { fetchJson } from './http/httpClient.js';

// Basic GET
const data = await fetchJson('https://api.example.com/data');

// With options
const data = await fetchJson('https://api.example.com/data', {
    method: 'POST',
    body: JSON.stringify({ query: 'cancer' }),
    headers: { 'Content-Type': 'application/json' },
    timeoutMs: 10000,
    maxRetries: 5,
    allow404: true, // returns null instead of throwing on 404
    signal: abortSignal, // external cancellation
});
```

**Options:**

| Option       | Type          | Default            | Description                               |
| ------------ | ------------- | ------------------ | ----------------------------------------- |
| `method`     | `string`      | `'GET'`            | HTTP method                               |
| `body`       | `BodyInit`    | —                  | Request body                              |
| `headers`    | `object`      | —                  | Additional headers (merged with defaults) |
| `timeoutMs`  | `number`      | `FETCH_TIMEOUT_MS` | Total timeout for acquire + fetch         |
| `maxRetries` | `number`      | `MAX_RETRIES`      | Retry limit override                      |
| `idempotent` | `boolean`     | —                  | Force retry on/off regardless of method   |
| `allow404`   | `boolean`     | `false`            | Return `null` on 404 instead of throwing  |
| `signal`     | `AbortSignal` | —                  | External cancellation                     |

### `UrlBuilder`

Fluent URL constructor.

```javascript
import { UrlBuilder } from './http/urlPrepare.js';

const url = new UrlBuilder('https://api.example.com')
    .path('v2')
    .path('studies')
    .queryParam('pageSize', 100)
    .queryParams({ countTotal: true, filter: 'active' })
    .build();
// → https://api.example.com/v2/studies?pageSize=100&countTotal=true&filter=active
```

### `cleanParams(params)`

Removes empty/null/undefined values and joins arrays.

```javascript
import { cleanParams } from './http/cleanParams.js';

cleanParams({
    pageSize: 100,
    empty: '',
    nullish: null,
    arr: ['a', 'b'],
});
// → { pageSize: 100, arr: 'a,b' }
```

### `validateSearchParams(params)`

Validates geo filters, page size, and decay functions before sending.

```javascript
import { validateSearchParams } from './validators.js';

validateSearchParams({
    pageSize: 1000,
    'filter.geo': 'distance(40.7128,-74.0060,100km)',
});
// Throws TrialValidationError on invalid input
```

### Custom Errors

| Error                  | When Thrown                            | Properties                              |
| ---------------------- | -------------------------------------- | --------------------------------------- |
| `TrialFetchError`      | HTTP error or network failure          | `url`, `cause`, `status`, `isTransient` |
| `TrialTimeoutError`    | Request or proxy acquisition timed out | `url`, `timeoutMs`                      |
| `TrialNotFoundError`   | Trial/NCT ID not found                 | `code`                                  |
| `TrialValidationError` | Invalid input parameters               | —                                       |

---

## Environment Variables

### API

| Variable         | Default | Description                           |
| ---------------- | ------- | ------------------------------------- |
| `API_BASE_URL`   | —       | Base URL for study listings           |
| `API_DETAIL_URL` | —       | Base URL for individual study details |

### Fetching

| Variable           | Default | Description                      |
| ------------------ | ------- | -------------------------------- |
| `CONCURRENCY`      | `10`    | Concurrent detail requests       |
| `PAGE_SIZE`        | `1000`  | Studies per list page (max 1000) |
| `FETCH_TIMEOUT_MS` | `15000` | Per-request timeout              |

### Retry & Backoff

| Variable                   | Default                   | Description                         |
| -------------------------- | ------------------------- | ----------------------------------- |
| `MAX_RETRIES`              | `3`                       | Retry attempts after first failure  |
| `RETRY_BASE_DELAY_MS`      | `1000`                    | Base for exponential backoff        |
| `DEFAULT_RETRY_AFTER_MS`   | `5000`                    | Fallback when no Retry-After header |
| `BACKOFF_CAP_MS`           | `30000`                   | Max backoff delay                   |
| `RETRYABLE_STATUS_CODES`   | `408,429,500,502,503,504` | Comma-separated retryable statuses  |
| `RETRY_AFTER_STATUS_CODES` | `429`                     | Statuses that may carry Retry-After |
| `RETRY_ON_TIMEOUT`         | `true`                    | Retry on request timeout            |
| `RETRY_ON_NETWORK_ERROR`   | `true`                    | Retry on network-level errors       |

### Proxy Pool

| Variable                           | Default  | Description                     |
| ---------------------------------- | -------- | ------------------------------- |
| `PROXY_IP`                         | —        | Comma-separated proxy URLs      |
| `PROXY_POOL_CONNECTIONS`           | `50`     | TCP connections per proxy       |
| `PROXY_POOL_KEEP_ALIVE_TIMEOUT_MS` | `300000` | Connection keep-alive           |
| `PROXY_POOL_HEADERS_TIMEOUT_MS`    | `15000`  | Max wait for response headers   |
| `PROXY_POOL_BODY_TIMEOUT_MS`       | `45000`  | Max wait for response body      |
| `PROXY_RATE_LIMIT_CAPACITY`        | `40`     | Max tokens per proxy per window |
| `PROXY_RATE_LIMIT_WINDOW_MS`       | `60000`  | Token refill window             |
| `PROXY_ACQUIRE_TIMEOUT_MS`         | `30000`  | Max wait for proxy token        |
| `PROXY_ACQUIRE_TIER_SIZE`          | `3`      | Random selection pool size      |

### Logging

| Variable    | Default                       | Description                      |
| ----------- | ----------------------------- | -------------------------------- |
| `LOG_LEVEL` | `debug` (dev) / `info` (prod) | Pino log level                   |
| `NODE_ENV`  | —                             | Set to `test` to disable proxies |

---

## License

MIT
