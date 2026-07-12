import {logger} from './logging.js';

function formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return [h > 0 && `${h}h`, m > 0 && `${m}m`, `${s}s`].filter(Boolean).join(' ');
}

/**
 * Tracks throughput and prints rolling stats at regular intervals.
 */
export class ProgressTracker {
    #total;
    #done = 0;
    #failed = 0;
    #startMs;
    #lastLogMs;
    #lastDoneAtLog = 0;
    #intervalMs;

    /**
     * @param {number} total - expected total items
     * @param {number} [intervalMs=10000] - how often to print stats (ms)
     */
    constructor(total, intervalMs = 10_000) {
        this.#total = total;
        this.#intervalMs = intervalMs;
        this.#startMs = Date.now();
        this.#lastLogMs = Date.now();
    }

    /**
     * Record N completed items and maybe print stats.
     * @param {number} [count=1]
     * @param {boolean} [failed=false]
     */
    tick(count = 1, failed = false) {
        this.#done += count;
        if (failed) this.#failed += count;

        const now = Date.now();
        if (now - this.#lastLogMs >= this.#intervalMs) {
            this.#printStats(now);
        }
    }

    /** Force a stats print regardless of interval. */
    print() {
        this.#printStats(Date.now());
    }

    #printStats(now) {
        const elapsedSec = (now - this.#startMs) / 1000;
        const windowSec  = (now - this.#lastLogMs) / 1000;
        const windowDone = this.#done - this.#lastDoneAtLog;

        const rateOverall = elapsedSec > 0 ? (this.#done / elapsedSec).toFixed(1) : '0';
        const rateWindow  = windowSec  > 0 ? (windowDone / windowSec).toFixed(1)  : '—';
        const pct         = this.#total > 0 ? ((this.#done / this.#total) * 100).toFixed(1) : '?';

        const remainingSec = this.#total > 0 && this.#done > 0
            ? (this.#total - this.#done) / (this.#done / elapsedSec)
            : null;
        const eta = remainingSec !== null ? formatDuration(remainingSec) : '?';

        logger.info(
            `Progress: ${this.#done.toString()}/${this.#total.toString()} (${pct}%) ` +
            `| rate: ${rateWindow}/s (avg ${rateOverall}/s) ` +
            `| failed: ${this.#failed} ` +
            `| ETA: ${eta}`
        );

        this.#lastLogMs = now;
        this.#lastDoneAtLog = this.#done;
    }

    get done()   { return this.#done; }
    get failed() { return this.#failed; }
    get total()  { return this.#total; }
    get elapsedMs() { return Date.now() - this.#startMs; }
}
