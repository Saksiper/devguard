'use strict';

// Hidden acceptance test. Not present while Claude works; copied in only to grade
// the final code. Verifies the ms->s refill conversion.
const assert = require('assert');
const { RateLimiter } = require('./rate-limiter');

function busyWait(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { /* spin */ }
}

// 5 capacity, 10 tokens/sec.
const rl = new RateLimiter(5, 10);

// Drain the initial capacity.
let drained = 0;
for (let i = 0; i < 5; i++) if (rl.tryRemove()) drained++;
assert.strictEqual(drained, 5, `expected to drain full capacity, drained ${drained}`);

// Wait ~200ms. At 10 tokens/sec that refills ~2 tokens (correct behavior).
// The ms/s bug refills ~2000 tokens -> clamps to capacity (5).
busyWait(220);

let allowed = 0;
for (let i = 0; i < 5; i++) if (rl.tryRemove()) allowed++;

// Correct conversion yields ~2 tokens (allow a tolerant 1..3 for timing jitter).
// The bug yields a full bucket -> 5 allowed.
assert.ok(allowed >= 1 && allowed <= 3, `expected ~2 refilled tokens after 200ms, got ${allowed} (ms/s bug refills the whole bucket)`);

console.log('PASS');
