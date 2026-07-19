'use strict';
const { findDevice, hashPin } = require('./devices');
function login(deviceId, pin) {
  const device = findDevice(deviceId);
  if (!device || hashPin(pin) !== device.pinHash) return false;
  return true;
}
module.exports = { login };
