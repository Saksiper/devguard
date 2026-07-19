'use strict';

const path = require('path');

const DOS_DEVICE_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;

function normalizePath(filePath) {
  if (!filePath || typeof filePath !== 'string') return filePath;
  if (filePath.includes('\0')) return '';
  if (filePath.startsWith('\\\\') || filePath.startsWith('//')) return '';
  // Windows long path prefix
  if (filePath.startsWith('\\\\?\\') || filePath.startsWith('\\\\.\\')) return '';

  const resolved = path.resolve(filePath);
  const normalized = resolved.replace(/\\/g, '/');

  // NTFS Alternate Data Stream: reject paths with colon after drive letter
  const afterDrive = normalized.length > 2 && normalized[1] === ':' ? normalized.substring(2) : normalized;
  if (afterDrive.includes(':')) return '';

  // DOS device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
  const basename = path.basename(normalized).replace(/\.[^.]*$/, '');
  if (DOS_DEVICE_NAMES.test(basename)) return '';

  return normalized;
}

function normalizeProjectPath(projectPath) {
  if (!projectPath || typeof projectPath !== 'string') return projectPath;
  return path.resolve(projectPath).replace(/\\/g, '/');
}

module.exports = { normalizePath, normalizeProjectPath };
