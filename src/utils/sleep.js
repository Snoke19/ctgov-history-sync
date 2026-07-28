/**
 * Returns a Promise that resolves after `ms` milliseconds.
 *
 * @param {number} ms - Sleep duration in milliseconds.
 * @returns {Promise<void>}
 */
export function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
