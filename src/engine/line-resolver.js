'use strict';

const fs = require('fs');
const { debugLog } = require('./debug-log');

function resolveLines(filePath, oldString) {
  if (!oldString) return null;

  let content;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    debugLog('line-resolver', 'File read failed', { filePath, error: String(err) });
    return null;
  }

  let lineCount = 1;
  for (let i = 0; i < oldString.length; i++) {
    if (oldString[i] === '\n') lineCount++;
  }

  const results = [];
  let searchFrom = 0;
  let currentLine = 1;
  let lastIdx = 0;

  while (true) {
    const idx = content.indexOf(oldString, searchFrom);
    if (idx === -1) break;

    for (let i = lastIdx; i < idx; i++) {
      if (content[i] === '\n') currentLine++;
    }
    lastIdx = idx;

    results.push({ start: currentLine, end: currentLine + lineCount - 1 });
    searchFrom = idx + 1;
  }

  return results;
}

module.exports = { resolveLines };
