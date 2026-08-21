# Clinical Trial Scraper — Architecture Review

> Senior review: can the scraper support multiple scraping execution mechanisms without coupling business logic to transport?
> Scope: traces `src/index.ts:239 → src/api/api.ts:48 → src/http/httpClient.ts:81 → src/http/fetchOperation.ts:43 → src/http/transport/httpTransport.ts:8` and `EndpointFactory → EndpointManager → Limiter`.

---

## Architecture Verdict

🟡 **Mostly sound, but has architectural gaps**

`HttpTransport` + `EndpointProvider` + `Limiter` + `BusinessOperation/Retry` are exemplary ports. The gap is **above** them: no `Acquisition` port for browser/socket vs HTTP, no fallback/composition, and a config-coupled composition root (`src/api/api.ts:48`, `src/config/config.ts:1`) that forces homogeneous single-pool execution.

---

## 1. Current architecture

Derived from actual imports and call graph (see `docs/ARCHITECTURE_UML.md` for full diagram).

```text
index.ts [use-case + orchestration + global state resumePageToken:13/pageNum:14]
  │ dynamic import ./config/config.js:208 + ./api/api.js:209
  ├─ withConcurrency<T,R>:16 + scrape:92 + fetchTrialSafe:53
  └─ withLogContext({correlationId, operation:'scrape'}):239

config.ts [eager singleton, 20+ const, validateConfig:100]
  │ imported directly in 7 files
  ├─ httpClient.ts:2 (BACKOFF_CAP_MS,FETCH_TIMEOUT_MS,MAX_RETRIES,RETRY_BASE_DELAY_MS)
  ├─ fetchOperation.ts:1 (DEFAULT_USER_AGENT,FETCH_TIMEOUT_MS)
  ├─ retryPolicy.ts:1 (5 constants)
  ├─ api/api.ts:1 (10 constants + ProxyPoolConfig)
  └─ undiciProxyTransport.ts:3 (ProxyPoolConfig)

api/api.ts::createApiClient():48  [composition root — hardcodes infra]
  │ new ProxyEndpointProvider(
  │     new UndiciTransportFactory({poolConfig:PROXY_POOL_CONFIG}):67,
  │     new HttpProxyUrlParser():68,
  │     {proxyUrls:PROXY_URLS, concurrency:CONCURRENCY}):66-71
  ├─ new DefaultLimiterFactory({capacity,windowMs}):74
  ├─ new DefaultEndpointManagerFactory({acquireTimeout}):79
  └─ createHttpClient({provider,limiterFactory,endpointManagerFactory}):65
       │ EndpointFactory(provider,limiterFactory):95 → build():96
       │   provider.build() → HttpProxyUrlParser.parse:25 → EndpointDefinition{id,createTransport}[]
       │   UndiciTransportFactory.create(url,context):60 → resolveConnections:64 → ProxyAgent{clientFactory}
       │   limiterFactory.create():35 → TokenBucket:65 | UnlimitedLimiter:3
       │ endpointManagerFactory.create(endpoints):101 → EndpointManager:32
       └─ fetchJson:181 → fetchResponse:130
            │ new FetchOperation(endpointManager,url,wallClock.now):131
            │ buildRetry:132 → new Retry(operation,maxAttempts,shouldRetry,calculateBackoff,sleep,signal):275
            └─ retry.perform():51 → operation.perform() → fetchOperation.ts:43
                 acquireEndpoint(signal):62 → endpointManager.acquireEndpoint:60 (round-robin + TokenBucket)
                 executeRequest:98 → transport.request({url,method:'GET',headers,signal}):102
                                   → UndiciHttpTransport.request:29 (undici fetch + ProxyAgent)
                                   → FetchDirectTransport.request:7 (native fetch, unused in prod)
                 classifyTransportError:131 → transport.classifyError → Network/Timeout/Cancelled/Unknown
                                              → HttpException retryAfter via parseRetryAfterHeader:117
```

**Layer map**

| Actual layer | Files | Port exists? |
|---|---|---|
| Foundation | `config/*`, `error/errors.ts:12`, `http/clock.ts:4`, `utils/validation.ts` | - |
| HTTP primitives | `http/transport/httpTransport.ts:8`, `transport/impl/*`, `limiter/*` | Yes — `HttpTransport`, `Limiter`, factory interfaces |
| Endpoint domain | `endpoint/endpoint.ts:4`, `endpointFactory.ts:27`, `endpoint/manager/*`, `endpoint/provider/*` | Yes — `EndpointProvider:9`, `EndpointManagerFactory:4` |
| Resilience | `retry/retry.ts:11`, `retry/businessOperation.ts:1`, `http/retryPolicy.ts:26`, `http/fetchOperation.ts:35` | Yes — `BusinessOperation`, `RetryPolicyConfig` |
| API adapter | `api/api.ts:30`, `api/types.ts`, `http/urlPrepare.ts:3` | Partial — `ApiClient:30` interface exists, `ApiHttpClient:25` is narrow `fetchJson` |
| Application | `index.ts:92` | No — scrape/orchestration not abstracted |

**What is clean:** no `if(proxy)` in `endpointFactory.ts`/`endpointManager.ts`/`fetchOperation.ts`; proxy vs direct is a strategy swap via `EndpointProvider`.

**What leaks:** `config.ts` globals imported everywhere; `createApiClient:48` hardcodes concrete `Proxy*` stack; `httpClient.ts:294`/`fetchOperation.ts:210`/`error/errors.ts:161`/`api/api.ts:237` duplicate URL sanitization; `GET` hardcoded in 5 places; `index.ts` mixes pagination + concurrency + global checkpoint state.

---

## 2. Main architectural risk

**No `Acquisition` port above `HttpTransport`; variation is trapped at the wrong level.**

`HttpTransport.request({url,method,headers,signal}):9` correctly isolates *how* to do a `fetch`. It cannot isolate *whether* acquisition is `fetch` at all. A browser needs navigation/wait/render, a raw socket needs framing, a fallback needs sequential strategy selection. All of those sit **above** `HttpTransport`.

The next layer (`HttpClient.fetchJson:44` + `EndpointManager:32`) is built for a single homogeneous pool: `createHttpClient:96` builds one `Endpoint[]` once, `EndpointManager:33` holds `readonly Endpoint[]` with one `acquireTimeout` and round-robin. There is no per-request routing and no composition:

* Request A→direct, B→proxy, E→`try direct → proxy → browser` has no representation.
* Adding it would force `if(browser)/if(fallback)/if(source===…)` into `httpClient.ts:130`, `fetchOperation.ts:43`, or `index.ts:92` — exactly the leakage the brief warns about.

*Architectural cause:* missing port at `src/http` / `src/acquisition` level.
*Benefit of fixing:* new mechanisms become additive infra classes, not edits to core.

---

## 3. Variation points

| Variation | Variation point? | Abstracted? | Level correct? | Leaking? | Needs business-logic change today? |
|---|---|---|---|---|---|
| Target source / URL | Yes | Partial (`UrlBuilder:3`, but `API_BASE_URL` hardcoded `api/api.ts:124`) | Too low | No | Yes — URLs not injected |
| Request construction | Yes | `FetchJsonRequestOptions:21`, `buildHeaders:194` | Correct | `DEFAULT_USER_AGENT` from config | No |
| Transport (direct vs HTTP proxy) | Yes | Yes (`HttpTransport:8`, `ProxyTransportFactory:20` vs `DirectTransportFactory:15`) | **Correct** | No | **No** — swap provider at composition root |
| HTTP client library | Yes | Yes (`HttpTransport` hides `fetch` vs `undici`) | Correct | No | No |
| SOCKS proxy | Yes | No — `ProxyTransportFactory.create(url,ctx):21` + `HttpProxyUrlParser:23` rejects non-http, `UndiciTransportFactory:57` assumes `ProxyAgent` pools | Too HTTP-specific | `ProxyPoolConfig` tied to `Pool` | Yes — new parser + factory needed |
| Socket/custom transport | Yes | Partial — fits `HttpTransport` only if still request/response shaped | Too low for raw socket | `method:'GET'` hardcoded `fetchOperation.ts:104` | Yes — needs adapter or higher port |
| Browser automation | **Yes, but not behind `HttpTransport`** | No — browser is not `fetch(url,{signal})` | **Wrong level** | Would leak `HttpRequest:14` | Yes — invasive to `HttpClient` |
| Headers/cookies/auth | Yes | `headers?` in `FetchJsonRequestOptions:22` | Correct | No | No |
| Retry policy | Yes | Yes (`RetryPolicyConfig:26`, `shouldRetry:202`, `calculateBackoff:89` pure) | Correct, but defaults coupled to `config.ts` | No | No — per-call `retryPolicy:49` |
| Rate limiting | Yes | Yes (`Limiter:1` per `Endpoint:24`) | Correct | No | No |
| Response parsing | Yes | `parseOkResponseBody:41`, `isStudiesPageResponse:187` in `api.ts` | Correct — domain owns it | No | No |
| Pagination/concurrency | Yes | **No** — `scrape:92` + `withConcurrency:16` + globals `resumePageToken:13` | Missing | `DATE_RANGE:11` hardcoded | Yes |
| Fallback strategy | Yes | **No** — `Retry:11` retries same `BusinessOperation` | Missing | No | Yes — invasive |

---

## 4. Coupling analysis

**Dependency direction (should be Business → Port ← Infra):**

* ✅ **Transport direction correct.** `fetchOperation.ts:102` → `HttpTransport.request` interface; `transport/classifyTransportError.ts:11` generic; predicates isolated (`undiciErrorPredicates:144` with `UND_ERR_*`/`ECONN*`, `fetchErrorPredicates:30`). No business → concrete fetch.
* ✅ **Provider strategy correct.** `EndpointFactory:33` depends on `EndpointProvider:9` interface; `ProxyEndpointProvider:14` vs `DirectEndpointProvider:7` are swappable. Factory sees only `createTransport` closures.
* 🟠 **Composition root coupled.** `api/api.ts:48:createApiClient` directly `import`s 10 `config.ts` symbols + concrete `ProxyEndpointProvider:66`, `UndiciTransportFactory:67`, `HttpProxyUrlParser:68`, `DefaultLimiterFactory:74`, `DefaultEndpointManagerFactory:79`. Its *methods* (`fetchStudiesPage:123`, `fetchTrialDetail:143`) are decoupled (only `httpClient.fetchJson`), but the factory is not.
* 🔴 **Config god object.** `config.ts:100` eagerly `validateConfig` at import time; imported in `api/api.ts`, `httpClient.ts:2`, `fetchOperation.ts:1`, `retryPolicy.ts:1`, `undiciProxyTransport.ts:3`, `logging.ts`. Unrelated concerns (API URLs, HTTP timeouts, proxy pools `PROXY_POOL_CONFIG:64`, rate limits `RATE_LIMIT_*:87`) share one module. Cannot inject per-source or per-test values without module mocking.
* **Smells (real vs harmless):**
  * Real: `httpClient.ts:81:createHttpClient` god facade (assembly+retry+log context+sanitization+close `235-247`), duplicated sanitization (`stripUserInfo:161` / `sanitizedUrl:210` / `sanitizeHttpUrl:294` / `safeApiUrl:237`), `index.ts:13` mutable globals with `require-atomic-updates` suppressions.
  * Harmless: `HttpResponse` exposing `Headers` — intentional reuse of platform type.

---

## 5. Replaceability test

| # | Introduce | Files that **must** change today | Files that **can stay** | Additive or invasive? | Breaks? |
|---|---|---|---|---|---|
| 1 | Direct HTTP | `api/api.ts:65` switch to `new DirectEndpointProvider(new FetchDirectTransportFactory())` (now dead code `directEndpointProvider.ts:7`, `fetchDirectTransport.ts:6`) | `httpClient.ts`, `fetchOperation.ts`, `retryPolicy.ts`, `endpointManager.ts`, `api.ts:122` methods | **Additive** (one-line wiring) | No |
| 2 | HTTP + proxy (current) | — already wired | All ports unchanged | — | — |
| 3 | SOCKS proxy | New `SocksProxyUrlParser`, new `SocksTransportFactory implements ProxyTransportFactory` (wrap `SocksProxyAgent`); edit `api.ts:65` wiring + `config.ts:33` for `SOCKS_PROXY_URLS`; `httpProxyUrlParser.ts:23` protocol allow-list edit | `fetchOperation.ts`, `Retry`, `Limiter` | Additive + small edit | Pool config reuse questionable |
| 4 | Custom socket transport | New `SocketTransport implements HttpTransport` + `adaptHttpResponse`; register via new `EndpointProvider` if still HTTP-shaped. If raw framing, need new `Acquisition` port — then `httpClient.ts:131`/`fetchOperation.ts:43` invasive | `retryPolicy`/`endpointManager` if HTTP-shaped | Borderline invasive | `GET`/`HttpResponse` assumptions |
| 5 | Browser-based acquisition | **Invasive if forced behind `HttpTransport`.** Browser needs navigate+wait, not `request:9`. Requires change to `httpTransport.ts:8`, `httpClient.ts:130`, `fetchOperation:43`, `api.ts:136` JSON parse. **Clean only behind new `DataAcquisition` port** | Business `Study` types | **Invasive today** | Yes — HTTP semantics leak |
| 6 | Fallback between two mechanisms (`try direct → proxy → other` on predicate e.g. `HttpException.status===403`) | No abstraction: `Retry:51` retries same op, `EndpointManager:60` round-robins only. Would add `if(fallback)` branching in `httpClient.ts:130` / `retry.ts` — leaks across layers | `HttpTransport` impls | **Invasive** | Scattered conditionals |

**Summary:** `direct↔http proxy` passes; `SOCKS` additive with edits; `browser` and `fallback` fail until a higher port exists.

---

## 6. Recommended abstraction boundaries

Smallest set that creates stability — each isolates one real variability, at the level where it naturally varies:

1. **Port `DataAcquisition` (above `HttpTransport`) — `src/acquisition/acquisition.ts`**
   ```ts
   interface DataAcquisition { fetchJson<T>(url: string, opts?: FetchJsonRequestOptions): Promise<T|null>; close(): void; }
   ```
   *Isolates:* `fetch` vs browser vs raw socket. *Why above `HttpTransport`:* browser is not a `fetch`; `HttpTransport` stays for HTTP-like transports (direct, HTTP proxy, SOCKS via agent swap). `api/api.ts:30:ApiClient` will depend on this port, not concrete `HttpClient`.

2. **Keep `HttpTransport:8` + `EndpointProvider:9` + `Limiter:1`** as-is — correct level for HTTP client/pool/rate-limit variations. Minimal tweak: let `ProxyTransportFactory.create` accept a parsed URL object so `SocksProxyUrlParser` can differ from `HttpProxyUrlParser:9` without protocol allow-list hack.

3. **Port `FallbackAcquisition` (composition, not inheritance) — `src/retry/fallback.ts`**
   ```ts
   class FallbackAcquisition<T> implements BusinessOperation<T> {
     constructor(private strategies: BusinessOperation<T>[], private shouldFallback:(e:TrialError)=>boolean) {}
     perform(): Promise<T> { /* try s0, if shouldFallback(e) try s1 … */ }
   }
   ```
   *Isolates:* chain/fallback. *Why at `BusinessOperation` layer:* composes with existing `Retry<T>:11` (retry decorates each strategy, fallback decorates retries) without touching `EndpointManager:60`.

4. **Config value object injected at composition root**
   Replace `import {FETCH_TIMEOUT_MS} from '../config/config.js'` in `fetchOperation.ts:1`, `httpClient.ts:2`, `retryPolicy.ts:1` with `constructor(config: HttpClientConfig)`. *Isolates:* per-source tuning and testability. *Why at root:* `api/api.ts:48` already is the composition root — it should build the value object from `env` and pass it down.

5. **Port `ScrapingUseCase` — extract `src/application/scrapeUseCase.ts` from `index.ts:92`**
   Depends on `ApiClient:30` port; owns `withConcurrency:16`, `fetchTrialSafe:53` error mapping, pagination, checkpoint state (replacing globals `13-14`). *Isolates:* pagination/concurrency/orchestration from transport. *Why there:* today `index.ts` mixes all three.

Do NOT add: per-class interfaces, DI container, generic plugin system, circuit breaker/metrics (not required by codebase).

---

## 7. Proposed architecture

### A. Current

```text
index.ts (use-case+orchestration+globals:13,16,53,92)
  ↓ direct import
config.ts (singleton, 20+ const, PROXY_POOL_CONFIG:64)
  ↓ imported in 7 files
api/api.ts::createApiClient —hardcodes→ ProxyEndpointProvider
                                         UndiciTransportFactory (ProxyAgent+Pool)
                                         HttpProxyUrlParser
                                         DefaultLimiterFactory
  ↓ createHttpClient
httpClient.ts (facade: assembly+Retry+logContext+sanitize) → EndpointFactory → EndpointManager → Endpoint{limiter,HttpTransport}
  ↓ Retry + FetchOperation
transport/httpTransport.ts → UndiciHttpTransport | FetchDirectTransport
```

### B. Proposed (business → ports ← infra)

```text
  [Business]  api/types.ts:14 Study, validation — no infra deps
      ↑
  [Application Port]  ApiClient:30, ScrapingUseCase (extracted from index.ts:92)
      ↑                    ↑
      │  DataAcquisition Port (DataAcquisition / BusinessOperation<T>:1)
      │   fetchJson / perform
      └────────┬─────────────────┬──────────────┐
               │                 │ composite    │
               ▼                 ▼              ▼
        DirectHttpAcquisition  FallbackAcquisition  BrowserAcquisition (Playwright)
               │            (shouldFallback predicate)
               │                 │
               └────────┬────────┘
                        ▼
               [Transport Port] HttpTransport:8  (HTTP-like only)
                        ↓
               FetchDirectTransport | UndiciProxyTransport | SocksProxyTransport
                        ↓
               [Infra] EndpointProvider + Limiter + EndpointManager → Pool/Agent

  Cross-cutting: Retry<T>:11 decorates BusinessOperation (shouldRetry:202, calculateBackoff:89)
                 TrialError:12 hierarchy maps TransportErrorKind at fetchOperation:131
                 Config value object injected at composition root (not global import)
                 pino + AsyncLocalStorage logContext:15-27
```

Dependency direction: Business/Application → Ports ← Infrastructure. Markers: **Business** (api types/validation), **Orchestration** (ScrapingUseCase), **Ports** (`DataAcquisition`, `HttpTransport`, `EndpointProvider`, `Limiter`, `BusinessOperation`), **Infra** (`Undici*`, `Fetch*`, `*Provider`), **Retry/Policy**, **Proxy/Pool**.

### C. Example flow

Primary (direct HTTP):

```text
ScrapingUseCase.run() → ApiClient.fetchStudiesPage → DataAcquisition Port
  → DirectHttpAcquisition → HttpTransport.request (FetchDirectTransport)
  → Network → HttpResponse → parseOkResponseBody:41 → Study[] → pagination next
```

Alternative (proxy, no use-case change):

```text
Same UseCase → same DataAcquisition Port
  → (swapped impl) ProxyHttpAcquisition → UndiciHttpTransport (ProxyAgent:91)
  → Network via proxy → same parse path
```

Fallback (predicate on error):

```text
Same UseCase → FallbackAcquisition([Retry(Direct), Retry(Proxy)], e=> e instanceof HttpException && e.status===403)
  → try Direct → on 403 fallback to Proxy → same return type
```

---

## 8. Concrete refactoring plan (incremental, no rewrite)

1. **Inject config value object (1–2 days, low risk)** — Create `HttpClientConfig` built in `api/api.ts:48` from `config.ts`; change `createHttpClient:58` signature to `createHttpClient(config, {provider,limiterFactory,endpointManagerFactory})`; remove `import {FETCH_TIMEOUT_MS,MAX_RETRIES} from config` from `httpClient.ts:2`, `fetchOperation.ts:1`, `retryPolicy.ts:1` (pass via `effectiveConfig:257`). *Problem→Cause→Boundary→Benefit→Cost:* scattered `import config` → global singleton → config port at composition root → per-source tuning + deterministic tests → ~20 import edits, all type-checked.

2. **Introduce `DataAcquisition` port (½ day)** — `src/acquisition/acquisition.ts` aliasing `HttpClient:44` initially; make `createApiClientWithHttpClient:122` accept `DataAcquisition` → rename to `createApiClientWithAcquisition`. *Benefit:* browser implements same port without touching `HttpTransport` or `ApiClient` methods.

3. **Normalize proxy factories (1 day)** — Keep `DirectTransportFactory:15` / `ProxyTransportFactory:20` but add `SocksProxyUrlParser` + `SocksTransportFactory`. Allow `createApiClient` to select via `ACQUISITION_MODE` env flag — additive, no core edits.

4. **Add `FallbackAcquisition` decorator (1 day)** — `src/acquisition/fallbackAcquisition.ts` implementing `BusinessOperation<T>`; compose as `new FallbackAcquisition([new Retry(directOp), new Retry(proxyOp)], shouldFallback)`; wire per-request via `FetchJsonRequestOptions` extension `fallback?: {strategies, predicate}` or per-source factory. *Benefit:* Request E flow without `if(fallback)` branching.

5. **Extract orchestration (1 day)** — Move `scrape:92`, `withConcurrency:16`, `fetchTrialSafe:53`, globals `13-14` into `src/application/scrapeUseCase.ts` with injected `ApiClient` + `ScrapeConfig{pageSize,concurrency,dateRange}`; `index.ts:202` becomes thin `withLogContext → new ScrapeUseCase(api).run()` + signal handling. *Benefit:* pagination testable, removes global state.

Each step keeps `npm test` green; no breaking change to `HttpTransport` dependents.

---

## 9. Migration safety

* Keep `ProxyEndpointProvider + UndiciTransportFactory` path as default; new mechanisms added as **new classes** (`Socks*`, `BrowserAcquisition`, `FallbackAcquisition`), not edits to `EndpointFactory:27` or `EndpointManager:60`.
* Feature-flag at composition root: `ACQUISITION_MODE=direct|proxy|socks|browser` switch in `api/api.ts:48` — no scattered `if(proxy)`.
* Existing DI seam `createApiClientWithHttpClient:122` stays; add overload `createApiClientWithAcquisition` for tests — no module mocking needed after step 1.
* Browser impl lives behind `DataAcquisition`, not forced into `HttpTransport`, so `HttpResponse` adapter leak is avoided; `parseOkResponseBody:41` path reused via `adaptHttpResponse`-style adapter.
* Rollback: revert wiring in `api/api.ts:48` only.

---

## 10. Final assessment

* **Can the architecture support multiple acquisition mechanisms?** Partially — HTTP-like (direct, HTTP proxy) yes via clean `HttpTransport` + `EndpointProvider` swap (`directEndpointProvider.ts:7` / `proxyEndpointProvider.ts:14`). SOCKS additive with small edits. Browser/socket **no** until `DataAcquisition` port is added above `HttpTransport`.
* **Can they be composed?** **No** today — `Retry:51` retries same op, `EndpointManager:60` only round-robins homogeneous pool. Requires `FallbackAcquisition` decorator.
* **Can they be selected dynamically?** **No** — one `Endpoint[]` built at `createHttpClient:96` for all requests. Per-request routing (A→direct, B→proxy) needs strategy selector at `DataAcquisition` level.
* **Can they have different retry behavior?** Per-call `options.retryPolicy:49` + `buildRetry:251` yes, but not per-strategy (proxy 3× vs direct 0×) without acquisition-level policy.
* **Can new mechanisms be added without modifying business logic?** Methods yes (`fetchStudiesPage:123` unchanged); **composition root `api/api.ts:48` no** — must edit wiring. Target is additive infra only.
* **Are the current abstractions at the correct level?** `HttpTransport:8` + `EndpointProvider:9` + `Limiter:1` **correct** for HTTP pooling/rate-limit. Missing higher `DataAcquisition` port is the gap; `BusinessOperation:1`/`Retry:11` is correct for resilience.
* **Minimum refactoring to production-ready & extensible?** Steps 1–4 above (~4 days): config injection + `DataAcquisition` port + `FallbackAcquisition`. No rewrite; stabilize boundaries before adding browser/SOCKS. Steps 1–2 alone make the system testable and per-source configurable.

> **Most important question — which part should change?**
> Replacing direct HTTP with proxy/SOCKS/socket/browser **should** change only **infrastructure** (`EndpointProvider`, `Transport` impl, `AcquisitionStrategy`, composition root wiring `api/api.ts:48`). **Should NOT** change **business logic** (`api/api.ts:123-162` methods, `scrape` use case), nor **resilience** (`retryPolicy.ts:202`/`retry.ts:11`) nor **error hierarchy** (`error/errors.ts:12`). Today the first holds for direct↔HTTP proxy (exemplary); browser/fallback will violate it until the `DataAcquisition` + `FallbackAcquisition` ports and config injection are introduced.

---

*Trace basis: `src/index.ts:1-239`, `src/api/api.ts:1-244`, `src/http/httpClient.ts:1-301`, `src/http/fetchOperation.ts:1-241`, `src/http/transport/httpTransport.ts:1-29`, `src/http/transport/impl/undiciProxyTransport.ts:1-153`, `src/http/transport/impl/fetchDirectTransport.ts:1-37`, `src/http/endpoint/endpoint.ts:1-39`, `src/http/endpoint/endpointFactory.ts:1-162`, `src/http/endpoint/manager/endpointManager.ts:1-132`, `src/retry/retry.ts:1-171`, `src/http/retryPolicy.ts:1-220`, `src/config/config.ts:1-100`.*
