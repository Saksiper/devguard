'use strict';

// Reading an error_outputs row: which line actually carries the failure, and is
// the row still relevant?
//
// MEASURED (2026-09-06, 53 real error_outputs rows): a failed command's output is
// stored whole, and the failure signature is almost always at the END while the
// beginning is ordinary stdout. Previewing it from the front (substring(0,100))
// surfaced tool banners instead of causes — id=45 showed "9.7.1 dist/index.umd.cjs
// ./dist/index.mjs {...}" when the real line was "TypeError: Cannot read properties
// of undefined (reading 'slice')". Scanning from the end recovers a signature in
// 32/53 rows (60%); callers decide what to do with the other 40%.
//
// The age gate exists because a session can live for days: a KOAV session ran
// 2026-09-02 -> 09-06 and its "last error" was a 3-day-old node -e escaping bug,
// unrelated to the work in progress. A stale error anchors reasoning instead of
// informing it, so it is worse than silence.

const ERROR_MAX_AGE_MINUTES = 120;
const MAX_ESSENCE_LEN = 200;

// Two tiers, because a node crash prints BOTH a sentence and a code dump:
//   Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'x' imported from y   <- tier 1
//     ...
//     code: 'ERR_MODULE_NOT_FOUND',                                        <- tier 2
// Scanning bottom-up with one flat list returns the code dump, which names the
// failure without saying what failed. Tier 1 is swept first so the sentence wins;
// tier 2 only catches outputs that never produced one.
const ESSENCE_TIERS = [
  [
    /^\w*(?:Error|Exception)\b/,                                 // Error:, TypeError:, FileNotFoundError:, Error [CODE]:
    /^Traceback \(most recent call last\):/,                     // python header (when nothing follows it)
    /:\s*command not found\b/,                                   // shell
    /^fatal:/,                                                   // git
    /^error(?:\[E\d+\])?:/i,                                     // rust/tsc style
    // Prefix-less failures that tools print as a bare sentence (curl, psql, OS).
    /\b(?:connection refused|permission denied|access denied|no such file or directory|operation timed out|out of memory|segmentation fault|killed)\b/i,
  ],
  [
    /\b(?:ENOENT|EACCES|EPERM|ECONNREFUSED|ETIMEDOUT|MODULE_NOT_FOUND|ERR_[A-Z][A-Z_]*)\b/, // bare node codes
  ],
];

// Returns the failure line, or null when the output carries no recognizable
// signature. Null is a real answer: callers that cannot show something specific
// are expected to show nothing.
function extractErrorEssence(errorString) {
  if (!errorString || typeof errorString !== 'string') return null;

  const lines = errorString.replace(/\r\n/g, '\n').split('\n');
  for (const tier of ESSENCE_TIERS) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      if (tier.some((re) => re.test(line))) {
        return line.length > MAX_ESSENCE_LEN ? line.substring(0, MAX_ESSENCE_LEN) : line;
      }
    }
  }
  return null;
}

// SQLite CURRENT_TIMESTAMP is UTC but carries no zone marker; without the added
// 'Z' the string parses as local time and every age comparison drifts.
function parseDbTs(s) {
  if (!s) return null;
  const iso = String(s).replace(' ', 'T');
  const d = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : iso + 'Z');
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

// Fail-open on an unreadable timestamp — same rule the issue-age filter in
// post-compact already uses: drop what is known-stale, keep what is unknown.
function isErrorFresh(timestamp, nowMs) {
  const t = parseDbTs(timestamp);
  if (t === null) return true;
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  return now - t <= ERROR_MAX_AGE_MINUTES * 60000;
}

// "12m ago" / "3h ago" / "3d ago" — the age the reader needs to judge relevance.
function formatAge(timestamp, nowMs) {
  const t = parseDbTs(timestamp);
  if (t === null) return null;
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const min = Math.max(0, Math.round((now - t) / 60000));
  if (min < 60) return `${min}m ago`;
  if (min < 1440) return `${Math.round(min / 60)}h ago`;
  return `${Math.round(min / 1440)}d ago`;
}

module.exports = {
  extractErrorEssence,
  parseDbTs,
  isErrorFresh,
  formatAge,
  ERROR_MAX_AGE_MINUTES,
  MAX_ESSENCE_LEN,
};
