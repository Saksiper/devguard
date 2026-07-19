'use strict';

const fs = require('fs');
const { debugLog } = require('./debug-log');
const { normalizePath, normalizeProjectPath } = require('./normalize-path');

const MAX_READ_BYTES = 512 * 1024; // Last 512KB — avoid OOM on large transcripts
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);
const DIFF_MAX = 2 * 1024;
const DESC_MAX = 80;
const MAX_EXTRACT_BYTES = 4 * 1024 * 1024; // 4MB per pass — bounded; cursor resumes the rest

/**
 * Scan the last assistant block for reasoning + confidence.
 * @param {string} transcriptPath
 * @returns {import('./types.js').ParseTranscriptResult|null} null if unreadable/empty.
 */
function parseTranscript(transcriptPath) {
  if (!transcriptPath) return null;

  try {
    if (!fs.existsSync(transcriptPath)) {
      debugLog('transcript-parser', 'File not found', { transcriptPath });
      return null;
    }

    const stat = fs.statSync(transcriptPath);
    let raw;
    if (stat.size > MAX_READ_BYTES) {
      const fd = fs.openSync(transcriptPath, 'r');
      const buf = Buffer.alloc(MAX_READ_BYTES);
      fs.readSync(fd, buf, 0, MAX_READ_BYTES, stat.size - MAX_READ_BYTES);
      fs.closeSync(fd);
      raw = buf.toString('utf-8');
      // Drop first partial line
      const firstNewline = raw.indexOf('\n');
      if (firstNewline > 0) raw = raw.substring(firstNewline + 1);
    } else {
      raw = fs.readFileSync(transcriptPath, 'utf-8');
    }

    // JSONL format: one JSON object per line
    const lines = raw.trim().split('\n');
    let reasoning = null;

    // Find the last assistant message that has text content (skip tool_use-only messages)
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type !== 'assistant' || !entry.message) continue;

        const content = entry.message.content;
        let text = null;

        if (typeof content === 'string') {
          text = content;
        } else if (Array.isArray(content)) {
          const textParts = content
            .filter(p => p && p.type === 'text')
            .map(p => p.text || '')
            .filter(Boolean);
          if (textParts.length > 0) text = textParts.join('\n');
        }

        if (text && text.length >= 10) {
          reasoning = text;
          break;
        }
      } catch { /* skip malformed lines */ }
    }

    if (!reasoning || reasoning.length < 10) return null;

    const truncated = reasoning.length > 500 ? reasoning.substring(0, 500) : reasoning;
    const confidence = reasoning.length > 100 ? 0.8 : 0.5;

    debugLog('transcript-parser', 'Parsed successfully', { lines: lines.length, reasoningLen: truncated.length });
    return { reasoning: truncated, confidence };
  } catch (err) {
    debugLog('transcript-parser', 'Parse failed (non-fatal)', { error: String(err) });
    return null;
  }
}

// git-bash POSIX drive form '/c/Users/...' -> Windows form 'C:/Users/...'.
// path.resolve('/c/Users/x') wrongly yields 'C:\\c\\Users\\x' on Windows, so
// convert the drive prefix BEFORE handing off to normalize-path.
function posixToWindows(p) {
  if (!p || typeof p !== 'string') return p;
  let out = p;
  // git-bash drive form (/c/repo -> C:/repo) only exists on Windows. On POSIX a
  // one-letter first segment ('/w/repo') is a REAL path and must not be rewritten.
  if (process.platform === 'win32') {
    const m = out.match(/^\/([a-z])\//i);
    if (m) out = m[1].toUpperCase() + ':/' + out.slice(3);
  }
  return out.replace(/\\/g, '/');
}

function truncate(str, max) {
  if (typeof str !== 'string') return '';
  return str.length > max ? str.slice(0, max) : str;
}

function describeEdit(name, input) {
  input = input || {};
  if (name === 'Edit') return truncate(input.new_string || 'edit', DESC_MAX);
  if (name === 'Write') return truncate(input.content || 'write', DESC_MAX);
  if (name === 'MultiEdit') {
    const n = Array.isArray(input.edits) ? input.edits.length : 0;
    return `${n} edits`;
  }
  return 'edit';
}

function diffForEdit(name, input) {
  input = input || {};
  if (name === 'Edit') {
    return truncate((input.old_string || '') + ' => ' + (input.new_string || ''), DIFF_MAX);
  }
  if (name === 'Write') return truncate(input.content || '', DIFF_MAX);
  if (name === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    const joined = edits
      .map(e => (e && typeof e === 'object') ? ((e.old_string || '') + ' => ' + (e.new_string || '')) : '')
      .join('\n');
    return truncate(joined, DIFF_MAX);
  }
  return '';
}

/**
 * Extract Edit/Write/MultiEdit tool calls from a transcript, starting at a byte
 * offset so callers can incrementally re-scan only the new tail.
 * @param {string} transcriptPath
 * @param {number} [fromOffset]
 * @param {number} [maxBytes]
 * @returns {import('./types.js').ExtractEditsResult} bytesRead is the cursor to persist.
 */
function extractEdits(transcriptPath, fromOffset = 0, maxBytes = MAX_EXTRACT_BYTES) {
  const result = { edits: [], bytesRead: fromOffset };
  if (!transcriptPath) return result;

  try {
    if (!fs.existsSync(transcriptPath)) {
      debugLog('transcript-parser', 'extractEdits: file not found', { transcriptPath });
      return result;
    }

    const stat = fs.statSync(transcriptPath);
    const start = fromOffset > 0 ? Math.min(fromOffset, stat.size) : 0;
    if (stat.size - start <= 0) {
      result.bytesRead = stat.size;
      return result;
    }

    // Bounded read: at most maxBytes per pass so an unbounded transcript can't
    // OOM. The cursor (bytesRead) advances only over fully-consumed content, so
    // the remainder is picked up on a later pass — no data is lost.
    const readLen = Math.min(stat.size - start, maxBytes);
    const reachedEof = start + readLen >= stat.size;

    const fd = fs.openSync(transcriptPath, 'r');
    let raw;
    try {
      const buf = Buffer.alloc(readLen);
      fs.readSync(fd, buf, 0, readLen, start);
      raw = buf.toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }

    // The cursor is only ever set to a newline-aligned offset (line boundary or
    // EOF), so `start` is never mid-line — no partial-first-line handling needed.
    const baseOffset = start;

    // Furthest offset we may mark consumed: EOF if we read to the end, else the
    // end of the last COMPLETE line in the capped window (drop the partial tail).
    let consumedEnd;
    if (reachedEof) {
      consumedEnd = stat.size;
    } else {
      const lastNl = raw.lastIndexOf('\n');
      consumedEnd = lastNl >= 0 ? baseOffset + Buffer.byteLength(raw.slice(0, lastNl + 1), 'utf-8') : baseOffset;
    }

    // Parse complete lines, recording each line's absolute start offset so an
    // orphan edit (tool_use whose tool_result hasn't been written yet) can pin
    // the resume cursor to BEFORE it.
    const segments = raw.split('\n');
    const records = [];
    let off = baseOffset;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const isLast = i === segments.length - 1;
      const complete = !isLast || raw.endsWith('\n');
      const segStart = off;
      off += Buffer.byteLength(seg, 'utf-8') + (complete ? 1 : 0);
      if (!seg) continue;
      if (isLast && !complete && !reachedEof) break; // partial tail cut by the cap
      let entry = null;
      try { entry = JSON.parse(seg); } catch { /* skip malformed line */ }
      if (entry) records.push({ entry, start: segStart });
    }

    // tool_use_id -> isError (from user tool_result entries in this window).
    const resultMap = new Map();
    for (const r of records) {
      const e = r.entry;
      if (e.type !== 'user' || !e.message || !Array.isArray(e.message.content)) continue;
      for (const item of e.message.content) {
        if (item && item.type === 'tool_result' && item.tool_use_id) {
          resultMap.set(item.tool_use_id, item.is_error === true);
        }
      }
    }

    // Collect edits up to (but excluding) the first ORPHAN — an edit whose result
    // isn't in this window yet. Stop there and pin the cursor so the next pass
    // re-reads it together with its (by-then-written) result. This prevents a
    // not-yet-resolved (possibly failing) edit from being imported as a success.
    let cursorStop = consumedEnd;
    let stopped = false;
    for (const r of records) {
      if (stopped) break;
      const e = r.entry;
      if (e.type !== 'assistant' || !e.message || !Array.isArray(e.message.content)) continue;
      const projectPath = normalizeProjectPath(posixToWindows(e.cwd));
      for (const item of e.message.content) {
        if (!item || item.type !== 'tool_use' || !EDIT_TOOLS.has(item.name)) continue;
        if (!resultMap.has(item.id)) {
          cursorStop = r.start; // orphan — resume from this line on the next pass
          stopped = true;
          break;
        }
        if (resultMap.get(item.id) === true) continue; // failed/rejected edit — skip
        const input = item.input || {};
        result.edits.push({
          tool_use_id: item.id,
          action: item.name,
          file: normalizePath(posixToWindows(input.file_path)),
          project_path: projectPath,
          description: describeEdit(item.name, input),
          diff_text: diffForEdit(item.name, input),
          timestamp: e.timestamp || null,
          isSidechain: e.isSidechain === true,
          session_id: e.sessionId || null,
          version: e.version || null,
          resolved: true,
        });
      }
    }

    // Guard against a single line larger than maxBytes stalling forever: if we
    // made no forward progress and there's more file, skip past this window.
    if (cursorStop <= start && !reachedEof) {
      cursorStop = start + readLen;
      debugLog('transcript-parser', 'extractEdits: oversized window skipped', { transcriptPath, start });
    }

    result.bytesRead = cursorStop;
    debugLog('transcript-parser', 'extractEdits done', { count: result.edits.length, bytesRead: result.bytesRead });
    return result;
  } catch (err) {
    debugLog('transcript-parser', 'extractEdits failed (non-fatal)', { error: String(err) });
    return result;
  }
}

// Like parseTranscript's last-assistant-block scan, but returns the FULL
// untruncated text (no 500-char cap). Used by the sphere layer to recover the
// complete DG-NOTE marker the assistant appended at the very end of its reply,
// which the 500-char truncation would otherwise crop off. Returns the text, or
// null if there is no qualifying block / the file is unreadable (non-fatal).
function getLastAssistantText(transcriptPath) {
  if (!transcriptPath) return null;

  try {
    if (!fs.existsSync(transcriptPath)) {
      debugLog('transcript-parser', 'getLastAssistantText: file not found', { transcriptPath });
      return null;
    }

    const stat = fs.statSync(transcriptPath);
    let raw;
    if (stat.size > MAX_READ_BYTES) {
      const fd = fs.openSync(transcriptPath, 'r');
      const buf = Buffer.alloc(MAX_READ_BYTES);
      fs.readSync(fd, buf, 0, MAX_READ_BYTES, stat.size - MAX_READ_BYTES);
      fs.closeSync(fd);
      raw = buf.toString('utf-8');
      // Drop first partial line
      const firstNewline = raw.indexOf('\n');
      if (firstNewline > 0) raw = raw.substring(firstNewline + 1);
    } else {
      raw = fs.readFileSync(transcriptPath, 'utf-8');
    }

    const lines = raw.trim().split('\n');

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type !== 'assistant' || !entry.message) continue;

        const content = entry.message.content;
        let text = null;

        if (typeof content === 'string') {
          text = content;
        } else if (Array.isArray(content)) {
          const textParts = content
            .filter(p => p && p.type === 'text')
            .map(p => p.text || '')
            .filter(Boolean);
          if (textParts.length > 0) text = textParts.join('\n');
        }

        if (text && text.length >= 10) return text;
      } catch { /* skip malformed lines */ }
    }

    return null;
  } catch (err) {
    debugLog('transcript-parser', 'getLastAssistantText failed (non-fatal)', { error: String(err) });
    return null;
  }
}

// Read the last MAX_READ_BYTES of a transcript, dropping the first partial line
// when the file exceeds the window (recent activity is at the tail).
// NOTE: parseTranscript/getLastAssistantText still inline this same read; unifying
// all three is a separate cleanup, out of scope here.
function readTail(transcriptPath) {
  const stat = fs.statSync(transcriptPath);
  if (stat.size <= MAX_READ_BYTES) return fs.readFileSync(transcriptPath, 'utf-8');

  const fd = fs.openSync(transcriptPath, 'r');
  const buf = Buffer.alloc(MAX_READ_BYTES);
  fs.readSync(fd, buf, 0, MAX_READ_BYTES, stat.size - MAX_READ_BYTES);
  fs.closeSync(fd);
  let raw = buf.toString('utf-8');
  const firstNewline = raw.indexOf('\n');
  if (firstNewline > 0) raw = raw.substring(firstNewline + 1);
  return raw;
}

// Full text of an assistant entry (string or array-of-blocks), or null if the
// entry is not an assistant message / carries no text block.
function assistantText(entry) {
  if (!entry || entry.type !== 'assistant' || !entry.message) return null;
  const content = entry.message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content.filter(p => p && p.type === 'text').map(p => p.text || '').filter(Boolean);
    if (parts.length > 0) return parts.join('\n');
  }
  return null;
}

// True if this entry references the tool_use_id — either as an assistant tool_use.id
// or as a user tool_result.tool_use_id.
function lineReferencesToolUseId(entry, anchor) {
  if (!entry || !entry.message || !Array.isArray(entry.message.content)) return false;
  for (const item of entry.message.content) {
    if (!item) continue;
    if (item.type === 'tool_use' && item.id === anchor) return true;
    if (item.type === 'tool_result' && item.tool_use_id === anchor) return true;
  }
  return false;
}

// True if this entry is a genuine human prompt (a text/string user turn), as opposed
// to a tool_result-carrying user entry. Used by findResponseAfter's opt-in guard to
// detect a user turn interposed between an edit anchor and its reply.
function isUserPrompt(entry) {
  if (!entry || entry.type !== 'user' || !entry.message) return false;
  const content = entry.message.content;
  if (typeof content === 'string') return content.trim().length > 0;
  if (Array.isArray(content)) {
    return content.some(p => p && p.type === 'text' && typeof p.text === 'string' && p.text.trim().length > 0);
  }
  return false;
}

// True if this assistant entry issues an edit-family tool_use (Edit/Write/MultiEdit).
function hasEditToolUse(entry) {
  if (!entry || entry.type !== 'assistant' || !entry.message || !Array.isArray(entry.message.content)) return false;
  return entry.message.content.some(item => item && item.type === 'tool_use' && EDIT_TOOLS.has(item.name));
}

// Response-locator primitive: return the FIRST assistant text block appearing AFTER
// a given anchor (a tool_use_id, matched on the assistant tool_use.id or the user
// tool_result.tool_use_id). Unlike parseTranscript's last-block scan, this pins the
// reply to a specific point — so a verdict can be attributed to the edit/injection
// that triggered it, not to whatever the model happened to say last. Returns the
// FULL untruncated text (an end-of-block DG-tag must survive), or null when the
// anchor is absent, nothing follows it, or the file is unreadable (non-fatal).
// opts.stopAtUserTurn (default false): return null if a genuine user prompt is
// interposed between the anchor and the first assistant text — the reply then
// belongs to the new prompt, not the anchor edit. Opt-in so existing callers /
// tests keep the original cross-attributing behavior.
function findResponseAfter(transcriptPath, anchor, opts = {}) {
  if (!transcriptPath || !anchor) return null;
  const stopAtUserTurn = opts && opts.stopAtUserTurn === true;

  try {
    if (!fs.existsSync(transcriptPath)) {
      debugLog('transcript-parser', 'findResponseAfter: file not found', { transcriptPath });
      return null;
    }

    const lines = readTail(transcriptPath).trim().split('\n');

    // Last line that references the anchor — for an edit this is its tool_result,
    // so the forward scan begins only after the edit actually resolved.
    let anchorIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      let entry;
      try { entry = JSON.parse(lines[i]); } catch { continue; }
      if (lineReferencesToolUseId(entry, anchor)) anchorIdx = i;
    }
    if (anchorIdx < 0) {
      debugLog('transcript-parser', 'findResponseAfter: anchor not found in window', { anchor });
      return null;
    }

    // First main-session text after the anchor is the reply. Ignore sidechain
    // (subagent) turns entirely — their text must not be attributed to the main
    // thread. Stop at an intervening main-thread edit and return null: the anchor
    // has no reply of its own (the model batched edits, commenting once later), so
    // don't steal the next edit's verdict. Any non-empty first text wins, even a
    // terse one ("Done."), since the contract is the FIRST reply.
    for (let i = anchorIdx + 1; i < lines.length; i++) {
      let entry;
      try { entry = JSON.parse(lines[i]); } catch { continue; }
      if (entry && entry.isSidechain === true) continue;
      if (stopAtUserTurn && isUserPrompt(entry)) return null;
      const text = assistantText(entry);
      if (text) return text;
      if (hasEditToolUse(entry)) return null;
    }
    return null;
  } catch (err) {
    debugLog('transcript-parser', 'findResponseAfter failed (non-fatal)', { error: String(err) });
    return null;
  }
}

// Recover the tool_use_id of the LAST edit-family (Edit/Write/MultiEdit) tool_use
// whose file matches filePath, scanning the transcript TAIL (last MAX_READ_BYTES).
// Unlike extractEdits — which head-anchors at byte 0 with a 4MB cap and would miss
// the current edit in a long (>4MB) session — this reads the tail, where the just-
// executed edit lives. It also matches on the assistant tool_use line directly, so
// it does NOT require the tool_result to be flushed yet (PostToolUse can fire first).
// Returns the id, or null (absent / unreadable — non-fatal).
function findLastEditToolUseId(transcriptPath, filePath) {
  if (!transcriptPath || !filePath) return null;
  const target = normalizePath(posixToWindows(filePath));
  try {
    if (!fs.existsSync(transcriptPath)) return null;
    const lines = readTail(transcriptPath).trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      let entry;
      try { entry = JSON.parse(lines[i]); } catch { continue; }
      if (!entry || entry.type !== 'assistant' || !entry.message || !Array.isArray(entry.message.content)) continue;
      for (let j = entry.message.content.length - 1; j >= 0; j--) {
        const item = entry.message.content[j];
        if (!item || item.type !== 'tool_use' || !EDIT_TOOLS.has(item.name)) continue;
        const file = normalizePath(posixToWindows((item.input || {}).file_path));
        if (file === target) return item.id;
      }
    }
    return null;
  } catch (err) {
    debugLog('transcript-parser', 'findLastEditToolUseId failed (non-fatal)', { error: String(err) });
    return null;
  }
}

module.exports = { parseTranscript, extractEdits, posixToWindows, getLastAssistantText, findResponseAfter, findLastEditToolUseId };
