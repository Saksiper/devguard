'use strict';
const { findDevice, hashPin } = require('./devices');

// In-memory per-process failure counters, keyed by deviceId. A brute-force
// guard: 3 consecutive failures locks the device until the process restarts.
const failCounts = new Map();
const lockedDevices = new Set();

function login(deviceId, pin) {
  if (lockedDevices.has(deviceId)) return 'locked';

  const device = findDevice(deviceId);
  const ok = !!device && hashPin(pin) === device.pinHash;

  if (ok) {
    failCounts.set(deviceId, 0);
    return true;
  }

  const fails = (failCounts.get(deviceId) || 0) + 1;
  failCounts.set(deviceId, fails);
  if (fails >= 3) {
    lockedDevices.add(deviceId);
    return 'locked';
  }
  return false;
}

module.exports = { login };
