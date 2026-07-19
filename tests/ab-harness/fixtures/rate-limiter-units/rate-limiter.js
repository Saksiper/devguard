'use strict';

// A token-bucket rate limiter. `refillRatePerSec` tokens are meant to be added
// per second of elapsed time, capped at `capacity`.
class RateLimiter {
  constructor(capacity, refillRatePerSec) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillRatePerSec = refillRatePerSec;
    this.lastRefill = Date.now();
  }

  _refill() {
    const now = Date.now();
    const elapsedMs = now - this.lastRefill;
    const refill = elapsedMs * this.refillRatePerSec;
    this.tokens = Math.min(this.capacity, this.tokens + refill);
    this.lastRefill = now;
  }

  tryRemove(count = 1) {
    this._refill();
    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    return false;
  }
}

module.exports = { RateLimiter };
