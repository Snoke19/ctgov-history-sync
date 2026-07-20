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

---
Here's how the credit-based `TokenBucket` works, from the ground up.

## The core idea

Instead of literally refilling the bucket on a timer, the bucket stores two things:

- `#creditMs` — how much "capacity" is currently banked, expressed in milliseconds rather than token count
- `#lastRefill` — the timestamp of the last time that credit was updated

Nothing runs in the background. Every time you *ask* the bucket a question ("can I go?" / "how many can I do?" / "let me in"), it recomputes the current state on the spot based on how much time has passed. This is the "lazy refill" pattern — cheap, no timers to leak, no drift.

## Why milliseconds instead of token counts

A token is really just a unit of "permission," and permission accumulates over time. If `capacity=10` tokens refill every `windowMs=1000` ms, then one token is worth `100ms` of accumulated time. So instead of tracking "6.3 tokens available," the bucket tracks "630ms of credit available" — same information, different ruler. The payoff: refilling becomes plain addition (`credit + elapsed`), and "how long until I can go" becomes plain subtraction (`needed - available`), with no multiplication or division needed on the hot path.

## Walking through each piece

**Constructor**
```js
this.#msPerToken = windowMs / capacity;   // cost of one token, in ms
this.#creditMs = windowMs;                // start full: capacity tokens' worth
```
The bucket starts completely full — full credit, equivalent to `capacity` tokens available immediately, which matches how a fresh rate limiter should behave (burst capacity available right away).

**`#availableCreditMs(now)` — the refill calculation**
```js
const elapsed = now - this.#lastRefill;
return Math.min(this.#windowMs, this.#creditMs + elapsed);
```
This is the heart of the whole class. It says: "however much credit we had last time, add back the time that's passed since then — but never go over a full bucket (`windowMs`)." This function doesn't mutate anything; it's a pure calculation of "what would the state be right now."

**`peekTokens()` — read-only check**
```js
Math.floor(this.#availableCreditMs() / this.#msPerToken);
```
Converts current credit back into a whole token count, for display or for comparing proxies against each other, without spending anything. Purely observational — call it as often as you like.

**`timeUntil(count)` — "when will I be able to go?"**
```js
const neededCreditMs = count * this.#msPerToken;
const availableCreditMs = this.#availableCreditMs(now);
if (availableCreditMs >= neededCreditMs) return 0;
return Math.ceil(neededCreditMs - availableCreditMs);
```
Figures out the ms-value of the requested token count, compares it to what's currently available, and returns the shortfall directly as a millisecond wait time — no unit conversion needed, because everything's already in ms. If you ask for more tokens than the bucket can ever hold (`count > capacity`), it returns `Infinity` rather than a misleading finite number.

**`acquire(timeoutMs)` — the actual gate**

This is a loop, not a single check, because time keeps passing while you wait:

1. Compute current available credit.
2. If there's enough to cover one token's cost (`#msPerToken`), **spend it immediately**: subtract the cost from the credit, stamp `#lastRefill = now`, and return. The caller proceeds.
3. If not, compute exactly how long until there *would* be enough (the deficit, in ms — no division needed), cap that by whatever's left before `timeoutMs` runs out, and `await` a `setTimeout` for that exact duration.
4. Loop back to step 1 and check again.

The sleep duration is calculated precisely to the millisecond needed — not a fixed polling interval — so it doesn't oversleep or busy-wait.

If the deadline arrives before a token frees up, it throws `TokenBucketTimeoutError` instead of hanging forever.

## Why it's safe with many concurrent callers

Node runs on a single thread with an event loop. Inside `acquire()`, everything between reading `availableCreditMs` and writing `this.#creditMs`/`this.#lastRefill` happens **synchronously** — there's no `await` in between. That means if ten `acquire()` calls are all waiting on `setTimeout` and their timers fire around the same moment, JavaScript still only runs one of their "wake up and check" blocks at a time, start to finish, before moving to the next. So two callers can never both see "1 token available" and both successfully deduct it — whichever runs first spends the credit, and the next one recomputes and (correctly) sees it's gone.

## The mental model, summarized

Think of it less like "a bucket filling with marbles" and more like **a running balance of pre-paid time**. Every millisecond that passes deposits one millisecond of balance (capped at a full window's worth). Spending a token withdraws `windowMs/capacity` milliseconds from that balance. If the balance can't cover a withdrawal, you wait exactly as long as it takes for the balance to reach zero-or-above, then try again.
