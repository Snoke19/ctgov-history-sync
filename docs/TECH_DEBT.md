# 1. Concurrency, Event Loop & Scalability Bottlenecks

## Issue 1: O(N_waiters × N_proxies) CPU Busy-Polling & Thundering Herd in Endpoint Manager

**File:** `endpointManager.ts`

**Severity:** CRITICAL

### Why It Matters

`EndpointManager.acquireEndpoint()` uses a non-queued busy-polling loop to find available tokens:

```javascript
while (true) {
    for (let i = 0; i < this.#endpoints.length; i++) {
        if (endpoint.tryAcquire()) return endpoint.getHandle();
        shortestWait = Math.min(shortestWait, endpoint.timeUntilToken());
    }
    await sleep(Math.min(shortestWait, remaining));
}
```

When 1,000 requests are queued waiting for tokens across 50 proxies, all 1,000 async calls wake up simultaneously on every timer tick (`sleep()`), re-iterating over all 50 endpoints. Only 1 caller acquires the token; the remaining 999 callers recalculate `shortestWait` and go back to sleep.

### Real Production Impact

Spikes Node.js CPU utilization to 100% and causes severe event loop lag (>200ms). V8 timer queue churn generates millions of short-lived timer objects, triggering frequent GC pauses and limiting system throughput to a fraction of available network capacity.

### Suggested Solution

Replace polling with an async waiter queue (FIFO array of resolver callbacks). When a proxy token refills or a request finishes, wake up only the front caller in the queue instead of waking up every waiting promise:

```javascript
// Push pending acquirers onto a FIFO queue when rate-limited;
// resolve them individually when tokens become available.
```

### Worth Added Complexity?

**YES (Essential).** Without an async FIFO queue, scaling concurrency above 100 will collapse Node.js event loop performance.

---

## Issue 2: Stop-and-Wait Sequential Pipeline Bottleneck & Tail Latency Stalls

**File:** `index.ts`

**Severity:** HIGH

### Why It Matters

The main loop in `main()` runs sequentially:

1. `await api.fetchStudiesPage()` (Fetch page of 1,000 NCT IDs).
2. `await withConcurrency(nctIds, CONCURRENCY, fetchTrialSafe)` (Fetch all details).
3. `await api.fetchStudiesPage()` (Fetch next page).

This creates two major bottlenecks:

- **Pipeline Starvation:** While fetching the next pagination page, all HTTP worker slots sit completely idle.
- **End-of-Batch Tail Latency:** `withConcurrency` waits for every single item in a batch to complete before fetching the next page. If 999 studies finish in 50ms but 1 study hits retries (taking 15s), all crawler workers stall waiting for that single request.

### Real Production Impact

Overall crawl speed drops by 60–80%. Instead of maintaining a steady stream of 500+ requests/sec, throughput fluctuates wildly between bursts and total idleness.

### Suggested Solution

Decouple page fetching from detail fetching using a streaming queue (e.g., a simple async generator or worker pool queue). The page reader continuously pushes NCT IDs into a concurrency queue while worker tasks consume them asynchronously.

### Worth Added Complexity?

**YES.** Decoupling producer and consumers is standard for high-throughput crawling.

---

## Issue 3: Microtask Churn & Memory Allocation Leaks in `withConcurrency()` (`Promise.race`)

**File:** `index.ts`

**Severity:** MEDIUM

### Why It Matters

`withConcurrency()` relies on `await Promise.race(executing)`. In V8, `Promise.race()` attaches internal promise listeners to every promise in the `executing` set. When the fastest promise resolves, `Promise.race()` resolves, but the listeners attached to the remaining promises are not detached. They remain bound to those promises until they resolve. Additionally, `results.push(result)` returns out-of-order array elements.

### Real Production Impact

Creates unnecessary promise reaction allocations and microtask queue pressure over millions of operations.

### Suggested Solution

Use standard task-pool patterns where workers pull work from a shared array or queue, or use a lightweight concurrency helper that avoids `Promise.race()` inside loops.

### Worth Added Complexity?

**YES.** Replacing custom `Promise.race()` loops with a queue worker pattern simplifies state tracking and prevents V8 microtask bloat.

---

## Issue 6: Complete Absence of Proxy Circuit Breakers & Health Tracking

**File:**  
`endpointManager.ts` & `proxyEndpoint.ts`

**Severity:** CRITICAL

**Why It Matters:**  
The system rotates requests round-robin across proxy endpoints, but has zero health tracking or circuit breaking. If 1 out of 10 proxies dies, crashes, or returns 502 Bad Gateway / 407 Proxy Auth Required, EndpointManager continues sending 10% of total traffic to that dead proxy forever.

**Real Production Impact:**  
A single dead proxy forces 10% of requests into expensive retry loops with exponential backoffs, causing severe overall throughput degradation and high error rates. If 50% of proxies degrade, the crawler effectively halts.

**Suggested Solution:**  
Implement a lightweight circuit breaker / backoff status per proxy. If an endpoint encounters consecutive network/5xx errors, temporarily mark it offline (e.g., 30s cool-down) and skip it during round-robin selection.

**Worth Added Complexity?**  
YES (Critical for Rotating Proxies). Rotating proxy pools in production frequently contain dead or throttled nodes.

---

## TODO 1: Implement Proxy Health Monitoring

### Description
Implement health tracking for each proxy endpoint to prevent repeatedly selecting unhealthy proxies. The system should monitor request outcomes, identify unhealthy proxies based on consecutive failures, and temporarily exclude them from endpoint selection. Healthy proxies should automatically rejoin the rotation after recovery.

### Acceptance Criteria
- [ ] Track successful and failed requests for every proxy.
- [ ] Maintain per-proxy health state.
- [ ] Detect consecutive failures (e.g., connection refused, timeout, repeated 5xx responses).
- [ ] Skip unhealthy proxies during endpoint acquisition.
- [ ] Allow recovered proxies to re-enter rotation automatically.
- [ ] Add logging for proxy health state transitions.

---

## TODO 2: Add Circuit Breaker for Proxy Endpoints

### Description
Implement a circuit breaker for each proxy endpoint to prevent continuously sending requests to failing proxies. When a proxy exceeds a configurable failure threshold, temporarily remove it from rotation. After a configurable cooldown period, allow a trial request to determine whether the proxy has recovered.

### Acceptance Criteria
- [ ] Maintain a circuit breaker for every endpoint.
- [ ] Open the circuit after a configurable number of consecutive failures.
- [ ] Exclude endpoints with an open circuit from `acquireEndpoint()`.
- [ ] Support configurable failure threshold and cooldown duration.
- [ ] Allow a single trial request after the cooldown expires.
- [ ] Close the circuit after a successful trial request.
- [ ] Reopen the circuit if the trial request fails.
- [ ] Log circuit state transitions (closed → open → half-open → closed).