# ClinicalTrials.gov History Sync

A TypeScript data-acquisition service for retrieving clinical study records from the [ClinicalTrials.gov API v2](https://clinicaltrials.gov/data-api/api).

The project is designed around one central problem: **reliably collecting large numbers of clinical-trial records from a remote API under pagination, concurrency, rate-limit, proxy, timeout, and transient-failure constraints.**

At the application level, the scraper selects a study set, walks the API's cursor-based pagination, extracts NCT identifiers, and fetches detailed records concurrently. The HTTP subsystem underneath it provides endpoint management, optional proxy routing, per-endpoint rate limiting, connection pooling, retry policies, timeout handling, and structured error classification.

> **Current scope:** the repository is primarily a data acquisition/scraping pipeline. The current application flow fetches and validates data but does not contain a database or file-storage layer.

## What the application does

At a high level, a run looks like this:

```text
ClinicalTrials.gov API
        │
        │  paginated study search
        ▼
  fetchStudiesPage()
        │
        │  extract NCT IDs
        ▼
   concurrent detail fetches
        │
        │  fetchTrialDetail(..., { history: true })
        ▼
  HTTP resilience layer
        │
        ├── endpoint selection
        ├── proxy transport
        ├── rate limiting
        ├── connection pooling
        ├── timeout / cancellation
        └── retry + backoff
        │
        ▼
  trial records returned
```

The current executable entry point (`src/index.ts`) also tracks page/checkpoint state in memory and records per-page and overall success/failure metrics in structured logs.

## Main capabilities

### Data acquisition

- Query ClinicalTrials.gov studies using API search parameters.
- Process cursor-based pagination with `nextPageToken`.
- Extract NCT identifiers from returned study records.
- Fetch individual study details.
- Request historical study information through the API's `history=true` option.
- Process multiple study-detail requests concurrently.

### HTTP resilience

The HTTP layer is intentionally separated into small components so that request execution is not coupled directly to proxy handling or rate limiting.

- **Endpoint providers** — direct or proxy-backed endpoint strategies.
- **Endpoint manager** — selects available endpoints and waits for capacity when necessary.
- **Token-bucket rate limiting** — controls request frequency per endpoint.
- **HTTP transport abstraction** — isolates the actual network implementation.
- **Undici transport** — provides pooled HTTP connections for the proxy-based production path.
- **Timeout handling** — aborts requests that exceed configured limits.
- **Retry policy** — retries selected HTTP, timeout, and network failures.
- **Exponential backoff with jitter** — avoids immediate repeated retries and reduces synchronized retry bursts.
- **`Retry-After` handling** — supports server-provided retry timing for HTTP failures.
- **Cancellation propagation** — caller aborts are treated separately from retryable failures.

### Error model

The project uses a domain-specific error taxonomy instead of exposing arbitrary transport exceptions throughout the application.

Examples include:

- validation errors
- API response validation errors
- trial-not-found errors
- HTTP errors
- network errors
- timeout errors
- caller-aborted operations
- endpoint acquisition failures
- unexpected errors

Unknown errors can be normalized into the project's `TrialError` hierarchy so that application boundaries have a predictable error contract.

### Observability

Logging is implemented with **Pino** and includes structured fields such as:

- correlation ID
- operation name
- NCT ID
- HTTP status
- page number
- study counts
- success/failure counts
- request duration
- retry/error information

Sensitive URL components are sanitized before they are written to logs.

## Architecture

The repository is organized around ports and concrete implementations rather than putting all HTTP behavior into one client class.

```text
Application
└── src/index.ts
    ├── pagination
    ├── concurrency
    ├── checkpoint state
    └── application-level error handling
            │
            ▼
API Adapter
└── src/api/
    ├── createApiClient()
    ├── fetchStudiesPage()
    └── fetchTrialDetail()
            │
            ▼
HTTP Client
└── src/http/httpClient.ts
    ├── request validation
    ├── response parsing
    ├── FetchOperation
    └── Retry
            │
            ├───────────────┐
            ▼               ▼
Endpoint Domain       Resilience
├── Endpoint           ├── RetryPolicy
├── EndpointProvider   ├── TokenBucket
├── EndpointManager    └── timeouts / cancellation
└── EndpointFactory
            │
            ▼
HTTP Transport
└── src/http/transport/
    ├── HttpTransport interface
    ├── direct fetch transport
    └── Undici proxy transport
            │
            ▼
      ClinicalTrials.gov
```

### Important design boundaries

**`ApiClient`** exposes domain-level operations such as fetching a studies page or a trial detail. Callers do not need to know how endpoints, proxies, transports, or rate limiters are constructed.

**`HttpTransport`** abstracts the actual HTTP request mechanism. This allows the endpoint layer to select different transport implementations without changing higher-level request logic.

**`EndpointProvider`** creates endpoint definitions. The current application composes a proxy-backed provider, while a direct provider also exists for other execution and testing scenarios.

**`EndpointManager`** owns endpoint selection and acquisition. It coordinates round-robin selection with limiter availability and an acquisition timeout.

**`Limiter`** is a separate port with a token-bucket implementation and an unlimited implementation.

**`Retry` / `RetryPolicy`** keep retry mechanics separate from the operation being retried. This makes retry behavior independently testable and configurable.

## Repository structure

```text
.
├── docs/
│   ├── ARCHITECTURE_REVIEW.md
│   ├── ARCHITECTURE_UML.md
│   ├── TECH_DEBT.md
│   └── mermaid-diagram-*.png
│
├── examples/
│   └── tockenBucket.html
│
├── src/
│   ├── api/
│   │   ├── api.ts                 # ClinicalTrials.gov API adapter
│   │   └── types.ts               # API-facing types
│   │
│   ├── config/
│   │   ├── config.ts              # Environment configuration
│   │   ├── configValidation.ts     # Configuration validation
│   │   ├── defaults.ts             # Default values
│   │   ├── logContext.ts            # Async logging context
│   │   └── logging.ts               # Pino logging setup
│   │
│   ├── error/
│   │   └── errors.ts               # Domain error taxonomy
│   │
│   ├── http/
│   │   ├── endpoint/               # Endpoint, provider and manager
│   │   ├── limiter/                # Rate limiting
│   │   ├── transport/              # HTTP transport implementations
│   │   ├── fetchOperation.ts        # One HTTP operation
│   │   ├── httpClient.ts            # HTTP client orchestration
│   │   ├── requestValidation.ts     # Request validation
│   │   ├── responseBody.ts          # Response parsing
│   │   └── urlPrepare.ts            # URL construction
│   │
│   ├── retry/
│   │   ├── businessOperation.ts     # Retryable operation contract
│   │   ├── retry.ts                 # Retry engine
│   │   └── retryPolicy.ts           # Retry decisions and backoff
│   │
│   ├── utils/
│   │   └── assertions.ts            # Reusable assertions
│   │
│   └── index.ts                     # Application entry point
│
├── test/                            # Unit and integration tests
├── .env.example                     # Environment configuration template
├── jest.config.mjs                  # Jest configuration
├── eslint.config.js                 # ESLint configuration
├── tsconfig.json                    # TypeScript configuration
└── package.json
```

## Data source

The project targets the **ClinicalTrials.gov API v2**.

Primary operations are based on:

```text
GET /api/v2/studies
GET /api/v2/studies/{nctId}
```

The studies endpoint is used for search/pagination. The detail endpoint is used to retrieve an individual study record, optionally including history.

The API's cursor-based pagination is represented by `pageToken` / `nextPageToken` in the application layer.

## Configuration

Configuration is supplied through environment variables. Start from `.env.example` and create a local `.env` file.

Important groups include:

| Area | Examples | Purpose |
| --- | --- | --- |
| API | `API_BASE_URL`, `API_DETAIL_URL` | ClinicalTrials.gov endpoints |
| Performance | `PAGE_SIZE`, `CONCURRENCY` | Pagination and parallel detail requests |
| Timeouts | `FETCH_TIMEOUT_MS`, `ACQUIRE_TIMEOUT` | Request and endpoint acquisition limits |
| Proxy | `PROXY_URLS`, `PROXY_POOL_*` | Proxy endpoints and connection pools |
| Rate limiting | `RATE_LIMIT_CAPACITY`, `RATE_LIMIT_WINDOW` | Token-bucket request control |
| Retry | `MAX_RETRIES`, `RETRYABLE_STATUS_CODES` | Retry behavior |
| Backoff | `RETRY_BASE_DELAY_MS`, `BACKOFF_CAP_MS` | Retry delay calculation |
| Retry switches | `RETRY_ON_TIMEOUT`, `RETRY_ON_NETWORK_ERROR` | Retry failure categories |
| Logging | `LOG_LEVEL`, `LOG_TO_FILE` | Structured logging behavior |

See `.env.example` for the complete set of currently supported variables and their example values.

## Getting started

### Requirements

- Node.js 20+
- npm

### Install

```bash
npm install
```

### Configure

```bash
cp .env.example .env
```

Then configure the API, concurrency, proxy, rate-limit, retry, and logging settings appropriate for the environment.

### Run

```bash
npm start
```

The application entry point is `src/index.ts`.

The current date-range query is defined in that entry point. Change it there when running a different scrape window.

## Development commands

```bash
# Run the application
npm start

# Run the test suite
npm test

# Run tests in watch mode
npm run test:watch

# Type-check without emitting JavaScript
npm run typecheck

# Lint source and tests
npm run lint

# Automatically fix lint issues where possible
npm run lint:fix

# Format the repository
npm run format

# Verify formatting
npm run format:check
```

## Testing strategy

The repository contains a broad test suite covering both isolated components and integration behavior.

Tests are organized around the same architectural boundaries as the implementation:

- configuration validation and defaults
- error taxonomy and normalization
- API client behavior and response validation
- endpoint creation and management
- direct and proxy endpoint providers
- proxy URL parsing
- HTTP transport implementations
- transport error classification
- token-bucket and unlimited limiters
- HTTP client happy paths and lifecycle behavior
- network failures and 404 handling
- retry policy and retry execution
- request/response validation
- URL construction
- logging and correlation context

Integration tests also exercise real HTTP behavior using local servers where appropriate, which helps verify that the abstractions work together rather than only in mocked unit tests.

## Reliability model

The main reliability path can be summarized as:

```text
Request
  │
  ▼
Validate request
  │
  ▼
Retry operation
  │
  ├── acquire an endpoint
  │       │
  │       ├── select endpoint
  │       └── wait for limiter capacity
  │
  ├── execute HTTP request
  │
  ├── classify transport / HTTP failure
  │
  └── retry when policy allows
          │
          └── exponential backoff + jitter
  │
  ▼
Parse / validate response
  │
  ▼
Return data or domain error
```

A caller cancellation is deliberately distinguished from a retryable timeout or network failure. This prevents an operation that the caller explicitly cancelled from being retried as if it were a transient infrastructure problem.

## Current limitations and direction

The architecture is intentionally focused on reliable HTTP acquisition, but the repository's architecture review identifies several areas for future evolution:

- The application layer currently combines scraping orchestration, pagination, concurrency, and checkpoint state in `src/index.ts`.
- The composition root in `src/api/api.ts` directly wires the production proxy/transport stack.
- Configuration is still consumed from module-level configuration exports in several layers.
- There is currently no higher-level acquisition port for swapping HTTP acquisition with browser automation, raw sockets, or fallback acquisition strategies.
- The current checkpoint is in-memory; there is no durable checkpoint or persistence subsystem.
- The project currently retrieves data but does not persist the resulting study records to a database or object store.

These are architectural evolution points rather than requirements for understanding the current data-acquisition pipeline.

See the detailed documents in `docs/` for the current architecture review, UML model, and technical-debt analysis.

## Documentation

- [`docs/ARCHITECTURE_REVIEW.md`](docs/ARCHITECTURE_REVIEW.md) — architectural assessment, current call graph, strengths, risks, and proposed evolution.
- [`docs/ARCHITECTURE_UML.md`](docs/ARCHITECTURE_UML.md) — UML/architecture model of the current system.
- [`docs/TECH_DEBT.md`](docs/TECH_DEBT.md) — tracked technical debt and follow-up work.

## Technology stack

- **TypeScript** — application language
- **Node.js / ESM** — runtime and module system
- **Undici** — pooled HTTP/proxy transport
- **Pino** — structured logging
- **Jest** — testing
- **ESLint** — static analysis
- **Prettier** — formatting

## Project status

The project is an actively developed engineering codebase focused on building a robust, testable ClinicalTrials.gov data-acquisition layer.

The most important part of the project is not the HTTP request itself. It is the infrastructure around the request: **how endpoints are selected, how rate limits are respected, how transient failures are retried, how errors are classified, and how the whole pipeline remains testable and observable.**
