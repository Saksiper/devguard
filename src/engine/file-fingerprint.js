'use strict';

// Content fingerprint for sphere-note staleness. A whole-file SHA-256 is captured
// when a note is written and recomputed at surface time to detect "the source
// changed since this note was left". Coarse over-flag is the safe direction: any
// edit to the file flags the note for re-verification rather than silently
// trusting stale guidance. Every op is fail-safe — a hash failure never blocks
// capture and never false-alarms at surface.
//
// KNOWN LIMITATION (accepted, watch in dogfood): the hash is whole-file, so when a
// single file hosts several feature-notes, ANY edit to that file marks ALL of them
// stale (over-flag amplification → potential alert fatigue). A narrower symbol-slice
// hash would need per-note line ranges, which sphere notes don't capture today.
// Keep whole-file for now; narrow it only if the noise proves annoying in practice.

const fs = require('fs');
const crypto = require('crypto');

const MAX_FINGERPRINT_BYTES = 2 * 1024 * 1024; // skip oversize files (surface path)

// SHA-256 hex of a file's bytes, or null if the path is invalid, not a regular
// file, oversize, missing, or unreadable. Never throws.
function computeFileFingerprint(absPath) {
  if (!absPath || typeof absPath !== 'string') return null;
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile() || stat.size > MAX_FINGERPRINT_BYTES) return null;
    return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
  } catch {
    return null;
  }
}

// Whether a stored note's source file changed since the note was written.
// Silent (false) when the note carries no fingerprint (old/unattributable notes).
// Missing file -> stale (deleted, re-verify); existing-but-unreadable/oversize
// file -> not stale (never false-alarm on a transient IO condition).
function isNoteStale(note) {
  if (!note || !note.source_file || !note.code_fingerprint) return false;
  if (!fs.existsSync(note.source_file)) return true;
  const current = computeFileFingerprint(note.source_file);
  if (current === null) return false;
  return current !== note.code_fingerprint;
}

module.exports = { computeFileFingerprint, isNoteStale, MAX_FINGERPRINT_BYTES };
