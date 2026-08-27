# ClinicalTrials.gov History Sync

A TypeScript data-acquisition service for retrieving clinical study records and historical study information from the **ClinicalTrials.gov API v2**.

The project is more than an API scraper. Its main engineering goal is to provide a **reliable, testable, observable acquisition pipeline** for large numbers of independent clinical-trial requests under pagination, concurrency, rate-limit, proxy, timeout, cancellation, and transient-failure constraints.

> **Current scope:** the application fetches and validates study data. It does not currently provide a database, durable output store, or durable checkpoint system.

## At a glance

```mermaid
flowchart LR
    A[ClinicalTrials.gov API] --> B[ScrapeUseCase]
    B --> C[Cursor Pagination]
    C --> D[NCT IDs]
    D --> E[Concurrent Detail Requests]
    E --> F[ApiClient]
    F --> G[HttpClient]
    G --> H[EndpointManager]
    H --> I[Endpoint / Limiter]
    I --> J[HttpTransport]
    J --> A

    G -. retry .-> G
    H -. admission wait .-> H
```

The important distinction is:

```text
Application asks:
    "What study data do I need?"

Infrastructure answers:
    "How should this request be executed reliably?"
```

## What the application does

A typical run is:

1. Load and validate environment configuration into a typed `AppConfig`.
2. Build the application dependencies at the composition boundary.
3. Start a `ScrapeUseCase` with explicit scrape configuration.
4. Build a ClinicalTrials.gov study query.
5. Fetch a page of studies.
6. Follow `nextPageToken` until pagination is complete.
7. Extract NCT identifiers.
8. Fetch study details concurrently.
9. Optionally request historical study information.
10. Validate responses.
11. Return successful records and classify failures through the project's error model.

The current scrape checkpoint is in-memory state owned by `ScrapeUseCase`; it is not durable across process restarts.

## System architecture

The repository separates application orchestration from the API adapter and from HTTP execution, endpoint admission, transport, and retry mechanics.

```mermaid
flowchart TB
    APP[Application / src/index.ts]
    UC[ScrapeUseCase / src/application]
    API[API Adapter / src/api]
    HC[HttpClient]
    RETRY[Retry + RetryPolicy]
    FO[FetchOperation]
    EM[EndpointManager]
    EP[EndpointProvider / EndpointFactory]
    LIM[Limiter<br/>TokenBucket / Unlimited]
    TRANS[HttpTransport]
    UNDICI[Undici Proxy Transport]
    DIRECT[Direct Fetch Transport]
    CTG[ClinicalTrials.gov]

    APP --> UC
    UC --> API
    API --> HC
    HC --> RETRY
    RETRY --> FO
    FO --> EM
    EM --> EP
    EM --> LIM
    FO --> TRANS
    TRANS --> UNDICI
    TRANS --> DIRECT
    UNDICI --> CTG
    DIRECT --> CTG
```

### Responsibilities

| Component | Responsibility |
| --- | --- |
| `src/index.ts` | Bootstrap, configuration loading, dependency composition, process-level signal/shutdown handling |
| `ScrapeUseCase` | Scrape workflow: pagination, concurrent detail fetching, per-item failure handling, in-memory progress state and scrape-level logging |
| `ApiClient` | Domain-facing ClinicalTrials.gov operations |
| `HttpClient` | HTTP request orchestration, retry construction, response handling and resource lifecycle |
| `FetchOperation` | One logical HTTP attempt: endpoint acquisition, timeout/cancellation propagation and transport invocation |
| `Retry` | Retry attempts, retry decisions, backoff and cancellation during backoff |
| `EndpointManager` | Endpoint selection, admission waiting and endpoint-acquisition timeout |
| `EndpointProvider` | Builds endpoint definitions for a concrete acquisition mode, such as direct or proxy HTTP |
| `EndpointFactory` | Assembles runtime endpoints from provider definitions, including limiter/transport construction and rollback/cleanup |
| `Endpoint` | Runtime endpoint resource: identity, limiter, transport and transport lifecycle |
| `EndpointHandle` | Narrow read-only view of an acquired endpoint used by request execution |
| `Limiter` | Per-endpoint request admission/rate control |
| `HttpTransport` | Abstract network execution and transport-level error classification |
| `TrialError` hierarchy | Stable application/infrastructure error contract |

## Request lifecycle

The core execution path is intentionally explicit:

```mermaid
sequenceDiagram
    autonumber
    participant App as ScrapeUseCase
    participant API as ApiClient
    participant HC as HttpClient
    participant R as Retry
    participant FO as FetchOperation
    participant EM as EndpointManager
    participant T as HttpTransport
    participant CTG as ClinicalTrials.gov

    App->>API: fetchStudiesPage / fetchTrialDetail
    API->>HC: fetchJson(url, options)
    HC->>R: perform()
    R->>FO: perform()
    FO->>EM: acquireEndpoint(signal)
    EM-->>FO: endpoint handle
    FO->>T: request(..., signal)
    T->>CTG: HTTP request
    CTG-->>T: response
    T-->>FO: response
    FO-->>R: result
    R-->>HC: result
    HC-->>API: validated HTTP payload
    API-->>App: validated study data
```

## Retry and endpoint admission are different concerns

This distinction is one of the important architectural decisions in the project.

```mermaid
flowchart TD
    JOB[Request Job] --> ADMIT[EndpointManager]
    ADMIT -->|capacity available| HTTP[HTTP attempt]
    ADMIT -->|capacity unavailable| WAIT[Wait / backpressure]
    WAIT --> ADMIT
    HTTP -->|success| RESULT[Result]
    HTTP -->|transient failure| POLICY[RetryPolicy]
    POLICY -->|retry| ADMIT
    POLICY -->|no retry| ERROR[Propagate error]
```

A temporarily unavailable token is **not the same thing** as a failed endpoint and is not inherently an HTTP failure.

Conceptually:

```text
token unavailable
    ≠ endpoint unhealthy
    ≠ transport failure
    ≠ HTTP retry failure
```

A future endpoint-health/cooldown mechanism may be introduced if measurements justify it, but it is intentionally separate from token-bucket rate limiting.

## Timeout and cancellation model

The project intentionally has **no global request deadline or shared timeout budget**.

There are three independent controls:

```mermaid
flowchart LR
    SIG[Caller AbortSignal] --> FO[FetchOperation]
    FO --> C[Internal AbortController]
    C --> EM[Endpoint acquisition]
    C --> HTTP[Current HTTP attempt]
    C --> SLEEP[Retry backoff sleep]

    AT[acquireTimeout] --> EM
    TM[requestAbortTimeoutMs] --> HTTP
```

| Control | Owner | Scope |
| --- | --- | --- |
| `callerAbortSignal` | Caller | Whole logical operation |
| `AbortController` | `FetchOperation` | Current attempt and propagation |
| `endpointAcquireTimeoutMs` | `EndpointManager` | Waiting for endpoint capacity |
| `requestAbortTimeoutMs` | `FetchOperation` | One HTTP attempt |
| Retry backoff | `Retry` | Time between attempts |

Therefore:

```text
acquire endpoint
      ↓
endpoint acquired
      ↓
start requestAbortTimeoutMs
      ↓
HTTP attempt
      ↓
timeout / failure
      ↓
Retry policy
      ↓
new attempt with a new timeout
```

There is no shrinking `remainingBudget` passed from attempt to attempt.

## Error model

Failures crossing project boundaries use the centralized `TrialError` taxonomy.

```mermaid
flowchart TD
    RAW[Raw failure] --> CLASSIFY{Known?}
    CLASSIFY -->|yes| SPECIFIC[Specific TrialError]
    CLASSIFY -->|no| NORMALIZE[TrialError.normalize]
    NORMALIZE --> UNEXPECTED[UnexpectedError]

    SPECIFIC --> RETRY{Retry policy}
    RETRY -->|NetworkException| RN[Retry if enabled]
    RETRY -->|TimeoutException| RT[Retry if enabled]
    RETRY -->|HttpException| RH[Retry if status allowed]
    RETRY -->|CallerAbortedError| NO[Do not retry]
    RETRY -->|UnexpectedError| NO
```

The core rule is:

> **Known error → specific `TrialError`. Unknown error → `UnexpectedError`.**

Important categories include:

- `ConfigurationError` — invalid application/system configuration.
- `TrialValidationError` — invalid public operation input.
- `ApiResponseValidationError` — invalid upstream response.
- `TrialNotFoundError` — requested trial does not exist.
- `HttpException` — unsuccessful HTTP status.
- `NetworkException` — network-level transport failure.
- `TimeoutException` — defined operation timeout.
- `CallerAbortedError` — explicit caller cancellation; never retry.
- `EndpointAssemblyError` — endpoint construction/rollback failure.
- `UnexpectedError` — unknown failure after normalization.

HTTP retry decisions are based on these semantic errors rather than arbitrary JavaScript exceptions.

## Retry model

The retry engine is generic and independent from the concrete operation.

```mermaid
flowchart LR
    A[HTTP attempt] --> F{Failure}
    F -->|success| S[Return result]
    F -->|network / timeout / retryable HTTP| P[RetryPolicy]
    P -->|retry allowed| B[Exponential backoff + jitter]
    B --> N[New FetchOperation]
    N --> A
    P -->|exhausted / non-retryable| E[Propagate TrialError]
```

The retry subsystem supports:

- configurable retry count;
- retryable HTTP status codes;
- network-error retry policy;
- timeout retry policy;
- exponential backoff;
- jitter;
- bounded backoff cap;
- `Retry-After` handling;
- cancellation during backoff;
- explicit per-request retry-policy overrides.

A retry may acquire another endpoint. This keeps endpoint selection separate from failure recovery and allows a later attempt to use another proxy when the endpoint pool contains multiple candidates.

## Rate limiting and concurrency

These mechanisms solve different problems:

```text
Concurrency
    = how many operations may be active

Rate limiting
    = how quickly requests may be admitted

Retry
    = how a failed HTTP operation recovers
```

The current design uses per-endpoint token buckets:

```mermaid
flowchart TB
    JOBS[Concurrent request jobs]
    EM[EndpointManager]
    A[Proxy A + TokenBucket A]
    B[Proxy B + TokenBucket B]
    C[Proxy C + TokenBucket C]
    HTTP[HTTP transport]

    JOBS --> EM
    EM --> A
    EM --> B
    EM --> C
    A --> HTTP
    B --> HTTP
    C --> HTTP
```

The token bucket uses a monotonic clock, lazy refill, burst capacity, and deterministic timing seams for testing.

> Multiple proxies do **not** automatically mean unlimited upstream capacity. Actual throughput must be established from measurements and upstream behavior such as `429` responses.

## Configuration architecture

Configuration is loaded explicitly at the application boundary:

```text
Environment variables
        ↓
    loadConfig()
        ↓
      AppConfig
        ↓
 composition root
        ↓
 narrow config objects
        ↓
 infrastructure components
```

Lower-level components do not depend on environment-derived globals. Configuration is passed explicitly through typed objects such as `HttpClientDefaults`, `FetchOperationDefaults`, `RetryPolicyConfig`, and endpoint/rate-limit options.

This makes configuration easier to test, avoids hidden module-level state, and leaves room for different per-run or per-source settings.

## Observability

Structured logging is implemented with **Pino**.

Useful context includes:

- correlation/request ID;
- operation name;
- NCT ID;
- page number;
- endpoint identity where appropriate;
- HTTP status;
- attempt/retry information;
- request duration;
- success/failure counts.

Correlation IDs are especially useful when one logical request produces multiple physical HTTP attempts.

Sensitive URL components are sanitized before logging.

## Testing philosophy

Testing follows the same boundaries as the architecture.

```mermaid
flowchart TB
    U[Unit tests]
    I[Integration tests]
    U --> C1[Retry / policy]
    U --> C2[Limiter / endpoint manager]
    U --> C3[Transport classification]
    U --> C4[Validation / errors]
    U --> C5[ScrapeUseCase]
    I --> C6[Real local HTTP server]
    I --> C7[HTTP client lifecycle]
    I --> C8[Real retry / timeout behavior]
```

The test suite covers configuration, error taxonomy, API behavior, application orchestration, endpoint management, limiters, transport implementations, retry semantics, cancellation, request/response validation, logging, and integration behavior.

Integration tests use local HTTP servers where appropriate so that important behavior is verified against real TCP/HTTP execution rather than only mocks.

Tests emphasize **contracts and observable behavior**: pagination, concurrency, attempt counts, retry decisions, cancellation, backoff, endpoint acquisition, response validation, and resource lifecycle.

## Current architecture and future direction

The current architecture is intentionally strong in the HTTP/infrastructure layer while keeping the application layer small.

### Current state

- `src/index.ts` is a bootstrap/composition entry point.
- `ScrapeUseCase` owns the current scrape workflow.
- `ApiClient` isolates ClinicalTrials.gov-specific operations from HTTP infrastructure.
- `HttpTransport` isolates concrete network execution.
- Direct and proxy HTTP execution are represented by separate providers/transport implementations.
- Configuration is explicitly loaded into `AppConfig` and passed through the dependency graph.
- Checkpointing is currently in-memory only.
- Study output is currently held in memory; there is no durable persistence layer.

### Known gaps

The next meaningful improvements are above the existing HTTP primitives rather than another round of low-level abstraction:

- bounded streaming producer/consumer pipeline and backpressure;
- durable output and checkpoint storage;
- idempotent synchronization/recovery semantics;
- quantitative metrics for throughput, queue depth, retries, endpoint wait, and failures;
- endpoint health/cooldown or circuit breaking if real measurements justify it;
- incremental synchronization and historical change processing.

### Deliberate non-goals for the current scope

The project does **not** currently need speculative abstractions for browser automation, raw sockets, QUIC, generic plugin systems, or a universal acquisition/fallback framework.

The existing HTTP abstractions are sufficient for the current direct/proxy use cases. A higher-level acquisition boundary should be introduced only if a fundamentally different acquisition mechanism becomes a real requirement.

## Repository structure

```text
.
├── docs/
│   ├── ARCHITECTURE_REVIEW.md
│   ├── ARCHITECTURE_UML.md
│   ├── TECH_DEBT.md
│   └── mermaid-diagram-*.png
│
├── src/
│   ├── api/                 # ClinicalTrials.gov API adapter
│   ├── application/        # Application use cases and scrape orchestration
│   ├── config/              # Typed configuration and logging setup
│   ├── error/               # Domain/infrastructure error taxonomy
│   ├── http/
│   │   ├── endpoint/        # Endpoint/provider/manager
│   │   ├── limiter/         # Rate limiting
│   │   └── transport/       # HTTP transport implementations
│   ├── retry/               # Retry engine and retry policy
│   └── index.ts             # Bootstrap / composition entry point
│
├── test/                    # Unit and integration tests
├── examples/
├── .env.example
├── jest.config.mjs
├── eslint.config.js
├── tsconfig.json
└── package.json
```

## Data source

The project targets the **ClinicalTrials.gov API v2**, primarily using:

```text
GET /api/v2/studies
GET /api/v2/studies/{nctId}
```

The studies endpoint provides search and cursor-based pagination. The detail endpoint retrieves an individual study and can request historical information.

## Configuration

Configuration is supplied through environment variables. Start with `.env.example`.

| Area | Examples | Purpose |
| --- | --- | --- |
| API | `API_BASE_URL`, `API_DETAIL_URL`, `PAGE_SIZE` | Upstream endpoints and page size |
| Performance | `CONCURRENCY` | Concurrent detail requests |
| Timeout | `REQUEST_ABORT_TIMEOUT_MS`, `ENDPOINT_ACQUIRE_TIMEOUT_MS` | Attempt and endpoint-admission limits |
| Proxy | `PROXY_URLS`, `PROXY_POOL_*` | Proxy endpoints and connection pools |
| Rate limit | `RATE_LIMIT_CAPACITY`, `RATE_LIMIT_WINDOW` | Token-bucket admission |
| Retry | `MAX_RETRIES`, `RETRYABLE_STATUS_CODES`, `RETRY_ON_TIMEOUT`, `RETRY_ON_NETWORK_ERROR` | Retry policy |
| Backoff | `RETRY_BASE_DELAY_MS`, `BACKOFF_CAP_MS` | Retry delay calculation |
| Logging | `LOG_LEVEL`, `LOG_TO_FILE`, `NODE_ENV` | Structured logging |

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

Configure API, concurrency, proxy, rate-limit, retry, timeout, and logging values as appropriate for the environment.

### Run

```bash
npm start
```

The application bootstrap entry point is `src/index.ts`.

## Development commands

```bash
npm start
npm test
npm run test:watch
npm run typecheck
npm run lint
npm run lint:fix
npm run format
npm run format:check
```

## Documentation

- [`docs/ARCHITECTURE_REVIEW.md`](docs/ARCHITECTURE_REVIEW.md) — detailed architectural assessment and evolution plan.
- [`docs/ARCHITECTURE_UML.md`](docs/ARCHITECTURE_UML.md) — deeper UML/current-system model.
- [`docs/TECH_DEBT.md`](docs/TECH_DEBT.md) — tracked technical debt and scalability considerations.

## Technology stack

- **TypeScript** — application language
- **Node.js / ESM** — runtime and module system
- **Undici** — pooled HTTP/proxy transport
- **Pino** — structured logging
- **Jest** — testing
- **ESLint** — static analysis
- **Prettier** — formatting

## Project status

The project is an actively developed ClinicalTrials.gov acquisition and synchronization codebase.

Its central engineering concern is **reliable outbound acquisition**: endpoint admission, rate limiting, connection management, retry semantics, timeout/cancellation contracts, error classification, observability, and testability.
