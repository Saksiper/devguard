'use strict';

// Deterministic "don't touch" hint generated at edit-capture time. Goal: when
// future Claude reads a ring's history through the viz, it sees a short warning
// that hints at what this code chunk is load-bearing for. Pure function — no
// IO, fully unit-testable.
//
// Output: short string (max ~200 chars), or null when no rule applies.

const MAX_LEN = 200;
const JOIN = ' · ';

function isTestFile(filePath) {
  const f = (filePath || '').replace(/\\/g, '/').toLowerCase();
  return /(^|\/)tests?\//.test(f) || /\.(test|spec)\.[a-z]+$/.test(f);
}

function isHookFile(filePath) {
  const f = (filePath || '').replace(/\\/g, '/').toLowerCase();
  return /(^|\/)src\/hooks\//.test(f);
}

function isMigrationFile(filePath) {
  const f = (filePath || '').replace(/\\/g, '/').toLowerCase();
  if (/migration/.test(f)) return true;
  // db.js schema block (CREATE TABLE / MIGRATION_V*_SQL) handled by content rule
  return false;
}

function isConfigFile(filePath) {
  const f = (filePath || '').replace(/\\/g, '/').toLowerCase();
  return /\.(ya?ml|toml|ini|env)$/.test(f)
    || /\.config\.[a-z]+$/.test(f)
    || /(^|\/)config\.(js|ts|json)$/.test(f);
}

function isSchemaTouching(filePath, newCode, oldCode) {
  const f = (filePath || '').replace(/\\/g, '/').toLowerCase();
  if (!/\/engine\/db\.js$/.test(f)) return false;
  const combined = String(newCode || '') + '\n' + String(oldCode || '');
  return /CREATE TABLE|ALTER TABLE|MIGRATION_V\d+_SQL/i.test(combined);
}

function fileTypeRule({ filePath, newCode, oldCode }) {
  if (isTestFile(filePath)) {
    return 'Test file — run the related test before editing to check semantics changed.';
  }
  if (isHookFile(filePath)) {
    return 'DevGuard hook — every exit must be 0 for silent-fail; do not remove try/catch.';
  }
  if (isSchemaTouching(filePath, newCode, oldCode) || isMigrationFile(filePath)) {
    return 'Schema/migration — changing this breaks the downstream table/query chain; bump the version.';
  }
  if (isConfigFile(filePath)) {
    return 'Config file — changing a value silently shifts environment behavior.';
  }
  return null;
}

// Lines added in this edit (present in new, absent in old). Lets content rules
// fire on what the edit introduced rather than on pre-existing code.
function addedText(newCode, oldCode) {
  const n = String(newCode || '');
  const o = String(oldCode || '');
  const oldLines = new Set(o.split('\n').map((l) => l.trim()));
  return n
    .split('\n')
    .filter((l) => l.trim() && !oldLines.has(l.trim()))
    .join('\n');
}

// Content rules in rough priority order (error-handling and time/unit bugs
// first). generateProtectNote keeps the file-type rule plus the top content
// rules, capped at 2 parts total to avoid note spam.
function diffContentRules({ newCode, oldCode }) {
  const rules = [];
  const n = String(newCode || '');
  const o = String(oldCode || '');
  const added = addedText(newCode, oldCode);

  const newHasTryCatch = /\btry\s*\{/.test(n) && /\bcatch\s*\(/.test(n);
  const oldHasTryCatch = /\btry\s*\{/.test(o) && /\bcatch\s*\(/.test(o);
  if (newHasTryCatch && !oldHasTryCatch) {
    rules.push('Error handling added — understand which error it catches before removing it.');
  } else if (!newHasTryCatch && oldHasTryCatch) {
    rules.push('Error handling removed — the lost guard may affect upstream callers.');
  }

  // Time-based math: the classic ms-vs-s silent-bug source (e.g. token-bucket
  // refill). Two ways to fire, both robust to a one-line incremental Edit where
  // the clock read sits on an UNCHANGED line:
  //   (a) an elapsed/rate idiom multiplied or divided in the ADDED lines, or
  //   (b) a clock read anywhere in the new code together with such an idiom.
  const elapsedIdiom = /\b(elapsed|deltaT?|refillRate|refill|duration)\b/i;
  const hasElapsedMath = elapsedIdiom.test(added) && /[*/]/.test(added);
  const hasClockRead = /\b(Date\.now|performance\.now|process\.hrtime|getTime|hrtime)\b/.test(n);
  if (hasElapsedMath || (hasClockRead && elapsedIdiom.test(added))) {
    rules.push('Time-based calc — verify unit consistency (ms vs s) before editing.');
  }

  // Numeric clamp / bounds.
  if (/\b(Math\.(min|max)|clamp)\b/.test(added)) {
    rules.push('Numeric bound — preserve the clamp; removing it lets the value over/underflow.');
  }

  // Async / IO / network calls introduced. Narrow, explicit matchers only —
  // a broad noun/verb alternation used to flag things like `this.pool.run()`.
  if (/\b(await\s+)?(fetch|axios)\s*\(/.test(added)
    || /\brequire\(['"](node:)?(fs|http|https|net|dns|tls|dgram)['"]\)/.test(added)
    || /\b(fs|fsPromises)\.(readFile|writeFile|appendFile|readdir|unlink|stat)\b/.test(added)
    || /\b(prisma|knex|sequelize)\b[^\n]*\.(find|create|update|delete|query|raw)\b/i.test(added)) {
    rules.push('Async/IO call — confirm error and timeout handling for the new request.');
  }

  // Regex constructed explicitly. Literal /.../ detection is ambiguous with the
  // division operator, so only the unambiguous new RegExp(...) form is matched.
  if (/\bnew\s+RegExp\s*\(/.test(added)) {
    rules.push('Regex — narrow pattern; edits can silently change what it matches.');
  }

  // Public surface change: module.exports / ESM export touched in the diff.
  if (/\b(module\.exports|exports\.[\w$]+|export\s+(default|const|function|class|\{))/.test(added)) {
    rules.push('Public API — callers depend on this signature.');
  }

  if (/\/\/\s*(TODO|FIXME|HACK|XXX)\b/.test(n) && !/\/\/\s*(TODO|FIXME|HACK|XXX)\b/.test(o)) {
    rules.push('TODO/FIXME marker added — check the description history for the reason.');
  }

  return rules;
}

function generateProtectNote({ filePath, action, newCode, oldCode } = {}) {
  // action is currently unused but accepted for future use (e.g., differentiate
  // Edit vs Write vs MultiEdit). Kept in signature for API stability.
  void action;

  const parts = [];
  const fileRule = fileTypeRule({ filePath, newCode, oldCode });
  if (fileRule) parts.push(fileRule);

  const contentRules = diffContentRules({ newCode, oldCode });
  parts.push(...contentRules);

  if (parts.length === 0) return null;

  // The file-type rule (if any) is pushed first and always survives; content
  // rules follow in rough priority order. Keep at most 2 parts total to avoid
  // note spam.
  let note = parts.slice(0, 2).join(JOIN);
  if (note.length > MAX_LEN) {
    note = note.slice(0, MAX_LEN - 1) + '…';
  }
  return note;
}

module.exports = { generateProtectNote };
