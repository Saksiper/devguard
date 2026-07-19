'use strict';

// Call `fn` repeatedly until it returns without throwing, up to `maxRetries`
// TOTAL attempts. If all attempts throw, re-throw the last error.
function retry(fn, maxRetries) {
  let lastErr;
  for (let i = 0; i < maxRetries - 1; i++) {
    try {
      return fn();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

module.exports = { retry };
