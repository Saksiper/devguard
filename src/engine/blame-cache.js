'use strict';

const { execFileSync } = require('child_process');
const { debugLog } = require('./debug-log');

function getFileCommitHash(filePath, cwd) {
  try {
    // execFileSync (no shell) + '--' pathspec separator: filePath is passed as a
    // literal argv element, never interpolated into a shell string. Keep the '--'
    // or a filePath starting with '-' becomes a git flag (argument injection).
    const result = execFileSync('git', ['log', '-1', '--format=%H', '--', filePath], {
      encoding: 'utf-8',
      cwd: cwd || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    }).trim();
    return result || null;
  } catch (err) {
    debugLog('blame-cache', 'getFileCommitHash failed', { filePath, error: String(err) });
    return null;
  }
}

function parseBlame(rawOutput) {
  if (!rawOutput || !rawOutput.trim()) return [];

  const lines = rawOutput.split('\n');
  const results = [];
  const hexPattern = /^([0-9a-f]{40})\s+(\d+)\s+(\d+)/;

  for (const line of lines) {
    const match = hexPattern.exec(line);
    if (match) {
      results.push({
        commitHash: match[1],
        lineNo: parseInt(match[3], 10),
      });
    }
  }

  return results;
}

function filterLines(blameData, startLine, endLine) {
  if (!startLine && !endLine) return blameData;
  return blameData.filter(entry => {
    if (startLine && entry.lineNo < startLine) return false;
    if (endLine && entry.lineNo > endLine) return false;
    return true;
  });
}

function getBlame(db, filePath, startLine, endLine, cwd) {
  const commitHash = getFileCommitHash(filePath, cwd);
  if (!commitHash) {
    debugLog('blame-cache', 'No commit hash, file untracked or new', { filePath });
    return [];
  }

  const cached = db.getBlameCache(filePath, commitHash);
  if (cached) {
    debugLog('blame-cache', 'Cache hit', { filePath, commitHash: commitHash.substring(0, 8) });
    try {
      const parsed = JSON.parse(cached.blame_data);
      return filterLines(parsed, startLine, endLine);
    } catch {
      debugLog('blame-cache', 'Corrupt cache entry, re-fetching', { filePath });
    }
  }

  try {
    // execFileSync (no shell) + '--' pathspec separator — see getFileCommitHash.
    const raw = execFileSync('git', ['blame', '--porcelain', '--', filePath], {
      encoding: 'utf-8',
      cwd: cwd || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });

    const parsed = parseBlame(raw);
    db.insertBlameCache(filePath, commitHash, JSON.stringify(parsed));
    debugLog('blame-cache', 'Cache miss, fetched full blame and stored', {
      filePath, commitHash: commitHash.substring(0, 8), lineCount: parsed.length,
    });
    return filterLines(parsed, startLine, endLine);
  } catch (err) {
    debugLog('blame-cache', 'git blame failed', { filePath, error: String(err) });
    return [];
  }
}

function invalidateFile(db, filePath) {
  debugLog('blame-cache', 'invalidateFile', { filePath });
  return db.invalidateBlameCacheFile(filePath);
}

function flushAll(db) {
  debugLog('blame-cache', 'flushAll');
  return db.flushBlameCache();
}

module.exports = { getFileCommitHash, parseBlame, filterLines, getBlame, invalidateFile, flushAll };
