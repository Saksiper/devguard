'use strict';

const path = require('path');

const DOS_DEVICE_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;

// Uppercase a leading Windows drive letter so 'c:/x' and 'C:/x' collapse to one
// key. path.resolve preserves drive-letter case, and every DB lookup uses a
// case-sensitive SQLite '=', so an unfolded lowercase drive split the data.
function upperDrive(s) {
  return s.replace(/^([a-z]):/, (m, d) => d.toUpperCase() + ':');
}

function normalizePath(filePath) {
  if (!filePath || typeof filePath !== 'string') return filePath;
  if (filePath.includes('\0')) return '';
  // UNC / long-path prefixes (\\server, //server, \\?\, \\.\) all start with two
  // separators — one check covers them (NTLM-leak guard; long-path forms included).
  if (filePath.startsWith('\\\\') || filePath.startsWith('//')) return '';

  const resolved = path.resolve(filePath);
  const normalized = upperDrive(resolved.replace(/\\/g, '/'));

  // NTFS Alternate Data Stream: reject paths with colon after drive letter
  const afterDrive = normalized.length > 2 && normalized[1] === ':' ? normalized.substring(2) : normalized;
  if (afterDrive.includes(':')) return '';

  // DOS device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9) — reserved only on
  // Windows; on POSIX 'aux.js'/'con.py' are valid files, so gate on platform.
  const basename = path.basename(normalized).replace(/\.[^.]*$/, '');
  if (process.platform === 'win32' && DOS_DEVICE_NAMES.test(basename)) return '';

  return normalized;
}

function normalizeProjectPath(projectPath) {
  if (!projectPath || typeof projectPath !== 'string') return projectPath;
  return upperDrive(path.resolve(projectPath).replace(/\\/g, '/'));
}

module.exports = { normalizePath, normalizeProjectPath };
