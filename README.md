# ClinicalTrials.gov History Sync

A TypeScript data-acquisition service for retrieving clinical study records and historical study information from the [ClinicalTrials.gov API v2](https://clinicaltrials.gov/data-api/api).

The project is designed around a broader engineering problem than simply scraping an API: **how to build a reliable, testable, observable acquisition pipeline that can collect large numbers of clinical-trial records while remaining resilient to pagination, concurrency, rate limits, endpoint failures, timeouts, transient HTTP errors, and changing execution strategies.**

The current application selects a study set, walks cursor-based pagination, extracts NCT identifiers, and fetches detailed records concurrently. Underneath it is a deliberately separated HTTP/resilience subsystem responsible for endpoint selection, rate limiting, proxy routing, connection pooling, retry decisions, timeout/cancellation handling, and error classification.

> **Current scope:** this repository is primarily a data-acquisition and synchronization pipeline. It currently fetches and validates study data; it does not contain a database or durable output-storage layer.

## Why this project exists

At first glance, this project could be described as a ClinicalTrials.gov scraper. That description is technically correct but incomplete.

The interesting part of the system is the **acquisition infrastructure around the API**. A production-quality scraper cannot treat HTTP as a single `fetch()` call when it has to process many records reliably. It needs explicit answers to questions such as:

- Which endpoint should handle the next request?
- Is that endpoint currently allowed to make another request?
- Should the request go directly to the API or through a proxy?
- What happens when a request times out?
- Which HTTP statuses are transient and worth retrying?
- How should retry delays be calculated?
- What happens when the caller cancels an operation?
- How can transport-specific failures be translated into application-level errors?
- Can each of these behaviors be tested independently?
- Can the execution mechanism evolve without rewriting the application logic?

The repository therefore treats **reliability, separation of concerns, and testability as first-class design goals** rather than incidental implementation details.

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
  HTTP acquisition layer
        │
        ├── endpoint selection
        ├── proxy transport
        ├── rate limiting
        ├── connection pooling
        ├── timeout / cancellation
        ├── error classification
        └── retry + backoff
        │
        ▼
  validated trial records
```

The current executable entry point (`src/index.ts`) also maintains page/checkpoint state in memory and records per-page and overall success/failure information through structured logging.

## Main capabilities

### ClinicalTrials.gov acquisition

- Query ClinicalTrials.gov studies using API search parameters.
- Process cursor-based pagination with `nextPageToken`.
- Extract NCT identifiers from returned study records.
- Fetch individual study details.
- Request historical study information through the API's `history=true` option.
- Process multiple study-detail requests concurrently.
- Validate API responses before returning them to higher layers.

### HTTP resilience

The HTTP subsystem is intentionally decomposed into ports and implementations instead of putting all behavior into one HTTP client.

- **Endpoint providers** — define how endpoints are created and supplied.
- **Endpoint manager** — selects available endpoints and waits for capacity when necessary.
- **Token-bucket rate limiting** — controls request frequency per endpoint.
- **HTTP transport abstraction** — isolates the actual network implementation.
- **Undici transport** — provides pooled HTTP connections for the proxy-based production path.
- **Direct transport** — provides a native-fetch implementation useful for alternative execution and integration scenarios.
- **Timeout handling** — aborts requests that exceed configured limits.
- **Retry policy** — independently decides whether HTTP, timeout, and network failures are retryable.
- **Retry engine** — executes a retryable business operation without embedding retry mechanics inside that operation.
- **Exponential backoff with jitter** — avoids immediate repeated retries and synchronized retry bursts.
- **`Retry-After` handling** — respects server-provided retry timing where applicable.
- **Cancellation propagation** — caller aborts are treated differently from transient infrastructure failures.

### Explicit error contract

The project uses a domain-specific error taxonomy instead of allowing arbitrary transport exceptions to leak through the application.

The central contract is:

```text
Known failure
    │
    ▼
Specific TrialError subclass

Unknown failure
    │
    ▼
TrialError.normalize(error)
    │
    ▼
UnexpectedError
```

Examples include:

- configuration errors
- validation errors
- API response validation errors
- trial-not-found errors
- HTTP errors
- network errors
- timeout errors
- caller-aborted operations
- endpoint acquisition failures
- token-bucket acquisition failures
- unexpected errors

This keeps error handling at application boundaries predictable while preserving useful failure categories for retry and logging decisions.

### Observability

Logging is implemented with **Pino** and uses structured context rather than relying only on formatted messages.

Important fields include:

- correlation ID
- operation name
- NCT ID
- HTTP status
- page number
- study counts
- success/failure counts
- request duration
- retry/error information

Sensitive URL components are sanitized before being written to logs. Correlation/request identifiers are intended to make a single acquisition traceable across retries and endpoint changes.

## Architecture

The repository is organized around explicit boundaries between application behavior, API adaptation, HTTP orchestration, endpoint management, transport, and resilience.

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
    ├── response parsing / validation
    ├── FetchOperation
    └── Retry
            │
            ├───────────────────┐
            ▼                   ▼
Endpoint Domain          Resilience
├── Endpoint             ├── RetryPolicy
├── EndpointProvider     ├── Retry
├── EndpointManager      ├── TokenBucket
└── EndpointFactory      └── timeout / cancellation
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

### Core design boundaries

**`ApiClient`** exposes domain-facing API operations such as fetching a study page or a trial detail. Callers do not need to know how endpoints, proxies, transports, or limiters are constructed.

**`HttpClient`** coordinates HTTP request construction, endpoint acquisition, execution, response handling, and retry composition. It is an orchestration boundary rather than the implementation of every infrastructure concern.

**`HttpTransport`** abstracts the actual HTTP request mechanism. Transport implementations are responsible for performing the request and classifying transport-level failures; higher layers do not depend directly on Undici or native `fetch`.

**`EndpointProvider`** creates endpoint definitions. The current application composes a proxy-backed provider, while a direct provider also exists for alternative execution and testing scenarios.

**`EndpointManager`** owns endpoint selection and acquisition. It coordinates endpoint availability, round-robin selection, limiter capacity, acquisition timeouts, and cancellation.

**`Limiter`** is a separate port with token-bucket and unlimited implementations. Rate limiting therefore remains independent from transport implementation.

**`Retry` / `RetryPolicy`** separate the retry mechanism from the operation being retried. The retry engine owns attempts and backoff, while policy decides whether a particular failure should be retried.

**Error taxonomy** provides a stable application-level contract above transport-specific exceptions.

## Architectural direction

One of the project's central architectural questions is how far the execution mechanism should be abstracted.

The current design already separates **HTTP transport** from endpoint management and application behavior. This makes direct and proxy-backed HTTP execution possible without changing the higher-level API operations.

The architecture review identified a potential future boundary above `HttpTransport`: an **acquisition strategy** abstraction that could eventually allow fundamentally different mechanisms such as browser automation, raw sockets, or fallback strategies. This is intentionally treated as an architectural direction rather than a requirement to introduce another abstraction prematurely.

The important principle is:

> **Application logic should describe what data needs to be acquired; infrastructure should determine how that acquisition is executed.**

The current implementation solves this principle well within the HTTP domain. Extending it beyond HTTP should happen when a concrete execution strategy requires it, rather than adding speculative abstractions.

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
│   │   └── urlPrepare.ts             # URL construction
│   │
│   ├── retry/
│   │   ├── businessOperation.ts     # Retryable operation contract
│   │   ├── retry.ts                 # Retry engine
│   │   └── retryPolicy.ts            # Retry decisions and backoff
│   │
│   ├── utils/
│   │   └── assertions.ts             # Reusable assertions
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

The studies endpoint is used for search and pagination. The detail endpoint retrieves an individual study record, optionally including history.

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

See `.env.example` for the complete set of currently supported variables and example values.

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

Testing follows the architecture: important infrastructure boundaries have focused unit tests, while integration tests verify that the boundaries work correctly together.

Coverage areas include:

- configuration validation and defaults
- error taxonomy and error normalization
- API client behavior and response validation
- endpoint creation and management
- direct and proxy endpoint providers
- proxy URL parsing
- HTTP transport implementations
- transport error classification
- token-bucket and unlimited limiters
- HTTP client happy paths and lifecycle behavior
- network failures and 404 behavior
- retry policy and retry execution
- request and response validation
- URL construction
- logging and correlation context

Integration tests use local HTTP servers where appropriate to exercise real TCP/HTTP behavior rather than relying exclusively on mocks.

The testing approach is intentionally focused on **contracts and observable behavior**. For example, retry tests verify attempt counts, retry decisions, cancellation behavior, and backoff behavior rather than coupling tests to private implementation details.

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

A caller cancellation is deliberately distinguished from a retryable timeout or network failure. This prevents an operation explicitly cancelled by its caller from being retried as though it were a transient infrastructure failure.

## Current limitations and technical direction

The current architecture is intentionally focused on reliable HTTP acquisition. The architecture review identifies several areas where the system can evolve:

- **Application orchestration:** `src/index.ts` currently combines scraping orchestration, pagination, concurrency, and in-memory checkpoint state. A dedicated scraping/use-case boundary would make those responsibilities easier to evolve independently.
- **Composition root:** `src/api/api.ts` currently wires the concrete production proxy/transport stack directly. This is functional, but stronger dependency injection would reduce infrastructure coupling.
- **Configuration coupling:** configuration values are still consumed from module-level exports in several layers. Moving toward explicit configuration value objects would make dependencies clearer and improve isolation in tests.
- **Acquisition strategy:** there is no higher-level abstraction for fundamentally different acquisition mechanisms. A future browser, socket, or fallback strategy could justify such a port; it should be introduced when there is a concrete need.
- **Checkpoint durability:** the current checkpoint is in memory. There is no durable resume state.
- **Persistence:** fetched study records are not currently written to a database, object store, or other durable data sink.

These are **evolution points, not descriptions of missing core functionality**. The existing HTTP acquisition subsystem is already deliberately separated into independently testable components.

See the detailed documents in `docs/` for the architecture review, UML model, and technical-debt analysis.

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

The project is an actively developed engineering codebase focused on building a robust, testable ClinicalTrials.gov acquisition and synchronization layer.

The important engineering problem is not the HTTP request itself. It is the infrastructure around that request: **endpoint selection, rate limiting, connection management, retry semantics, timeout and cancellation contracts, error classification, observability, and the ability to test each responsibility independently.**

The architecture is intentionally being evolved toward a system where the application describes **what data should be acquired**, while infrastructure determines **how that acquisition is executed**.
