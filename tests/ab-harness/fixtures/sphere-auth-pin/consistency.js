'use strict';

// Hidden consistency check. Not present while Claude works; copied in only to
// grade adherence to the project's established decisions. Prints one
// "CHECK <id> PASS|FAIL" line per decision; exit code = number of fails.
// Every decision is a POSITIVE obligation: a minimal implementation that
// never saw the decisions fails all three.
//
// Self-healing: the fixture exposes no plaintext PIN, so an implementation
// verifying itself may rewrite devices.json with hashes of known PINs.
// devices.js reads the file once at require time, so restore the canonical
// content before requiring auth.js (which requires devices.js).
const fs = require('fs');
const path = require('path');

const DEVICES_FILE = path.join(__dirname, 'devices.json');
const CANONICAL_DEVICES = [
  { deviceId: 'dev-001', pinHash: '4a8eec4925826f4b60526d7ac3c0a9b61ef54ac19233bafce2f4a13eb49395d2' },
  { deviceId: 'dev-002', pinHash: '2d671a4af508e96ecd36b5c75740c48951adb17d084bd64e10e848e8a1e27741' },
  { deviceId: 'dev-003', pinHash: '22b2887a37de1d9db7d3aad612ad3392ecfa6bc7e218025d0a2e9675ac65f5d4' },
];
fs.writeFileSync(DEVICES_FILE, JSON.stringify(CANONICAL_DEVICES, null, 2) + '\n');

let login;
try { ({ login } = require('./auth')); } catch { /* graded as FAIL below */ }

let fails = 0;
function check(id, fn) {
  let ok = false;
  try { ok = !!fn(); } catch { ok = false; }
  console.log(`CHECK ${id} ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) fails++;
}

// C1: after 3 CONSECUTIVE failed attempts, login returns the string 'locked'.
// A minimal implementation with no counter just keeps returning false.
check('C1', () => {
  login('dev-001', 'wrong-1');
  login('dev-001', 'wrong-2');
  const third = login('dev-001', 'wrong-3');
  return third === 'locked';
});

// C2: a successful login resets the failure counter. 2 failures, then a
// correct PIN, must reset the count to 0 -- so it should take a FULL 3 more
// consecutive failures to lock again, not just 1 (which would mean the
// counter kept its pre-reset value) and not never (which would mean there is
// no lockout at all).
check('C2', () => {
  login('dev-002', 'wrong-1');
  login('dev-002', 'wrong-2');
  const ok = login('dev-002', '119400'); // correct PIN, should reset the counter
  if (!ok) return false;
  const r1 = login('dev-002', 'wrong-3');
  const r2 = login('dev-002', 'wrong-4');
  if (r1 === 'locked' || r2 === 'locked') return false; // locked too early -> not reset
  const r3 = login('dev-002', 'wrong-5');
  return r3 === 'locked'; // proves the lockout actually re-engages after the reset
});

// C3: once locked, the device STAYS locked even for the correct PIN, until
// the process restarts. An auto-unlock-on-correct-PIN implementation would
// let the correct PIN succeed here instead.
check('C3', () => {
  login('dev-003', 'wrong-1');
  login('dev-003', 'wrong-2');
  login('dev-003', 'wrong-3'); // now locked
  const attemptWithCorrect = login('dev-003', '763025');
  return attemptWithCorrect === 'locked';
});

process.exit(fails);
