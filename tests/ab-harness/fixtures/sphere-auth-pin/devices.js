'use strict';

// Device PIN store backed by devices.json. PINs are stored as sha256 hex
// digests of the PIN string (see hashPin). This is the existing feature the
// login task extends.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEVICES_FILE = path.join(__dirname, 'devices.json');

const devices = JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf8'));

function hashPin(pin) {
  return crypto.createHash('sha256').update(pin, 'utf8').digest('hex');
}

function getDevices() {
  return devices;
}

function findDevice(deviceId) {
  return devices.find((d) => d.deviceId === deviceId) || null;
}

module.exports = { getDevices, findDevice, hashPin, DEVICES_FILE };
