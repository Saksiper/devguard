import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
let tmpDir;

beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-transcript-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function loadModule() {
  const key = require.resolve('../../src/engine/transcript-parser');
  delete require.cache[key];
  return require('../../src/engine/transcript-parser');
}

function writeJsonl(filePath, entries) {
  const lines = entries.map(e => JSON.stringify(e)).join('\n');
  fs.writeFileSync(filePath, lines);
}

describe('parseTranscript', () => {
  it('returns null for null path', () => {
    const { parseTranscript } = loadModule();
    expect(parseTranscript(null)).toBe(null);
  });

  it('returns null for missing file', () => {
    const { parseTranscript } = loadModule();
    expect(parseTranscript('/nonexistent/file.json')).toBe(null);
  });

  it('parses JSONL with assistant text content', () => {
    const { parseTranscript } = loadModule();
    const entries = [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Fix the bug' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'I will fix the authentication issue by updating the token validation logic to handle expired tokens gracefully.' }] } },
    ];
    const filePath = path.join(tmpDir, 'transcript.jsonl');
    writeJsonl(filePath, entries);
    const result = parseTranscript(filePath);
    expect(result).not.toBe(null);
    expect(result.reasoning).toContain('authentication');
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('parses messages with mixed content (text + tool_use)', () => {
    const { parseTranscript } = loadModule();
    const entries = [
      { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'text', text: 'Looking at the code, the issue is in the retry logic which does not back off exponentially.' },
        { type: 'tool_use', id: 'tool-1', name: 'Edit', input: {} },
      ]}},
    ];
    const filePath = path.join(tmpDir, 'transcript.jsonl');
    writeJsonl(filePath, entries);
    const result = parseTranscript(filePath);
    expect(result).not.toBe(null);
    expect(result.reasoning).toContain('retry logic');
  });

  it('skips tool_use-only messages and finds text in earlier message', () => {
    const { parseTranscript } = loadModule();
    const entries = [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'I need to refactor the database connection pooling logic for better performance.' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Edit', input: {} }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-2', name: 'Bash', input: {} }] } },
    ];
    const filePath = path.join(tmpDir, 'transcript.jsonl');
    writeJsonl(filePath, entries);
    const result = parseTranscript(filePath);
    expect(result).not.toBe(null);
    expect(result.reasoning).toContain('database connection pooling');
  });

  it('returns null for invalid JSONL', () => {
    const { parseTranscript } = loadModule();
    const filePath = path.join(tmpDir, 'bad.jsonl');
    fs.writeFileSync(filePath, 'not json\nalso not json');
    expect(parseTranscript(filePath)).toBe(null);
  });

  it('returns null when no assistant messages', () => {
    const { parseTranscript } = loadModule();
    const entries = [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] } },
    ];
    const filePath = path.join(tmpDir, 'user-only.jsonl');
    writeJsonl(filePath, entries);
    expect(parseTranscript(filePath)).toBe(null);
  });

  it('truncates long reasoning to 500 chars', () => {
    const { parseTranscript } = loadModule();
    const longText = 'A'.repeat(1000);
    const entries = [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: longText }] } },
    ];
    const filePath = path.join(tmpDir, 'long.jsonl');
    writeJsonl(filePath, entries);
    const result = parseTranscript(filePath);
    expect(result.reasoning.length).toBe(500);
  });

  it('handles string content in message', () => {
    const { parseTranscript } = loadModule();
    const entries = [
      { type: 'assistant', message: { role: 'assistant', content: 'Direct string reasoning about the fix applied to resolve the timeout.' } },
    ];
    const filePath = path.join(tmpDir, 'string.jsonl');
    writeJsonl(filePath, entries);
    const result = parseTranscript(filePath);
    expect(result).not.toBe(null);
    expect(result.reasoning).toContain('timeout');
  });
});

describe('getLastAssistantText', () => {
  it('returns the FULL text for a 600+ char last assistant block (not cropped to 500)', () => {
    const { getLastAssistantText } = loadModule();
    const longText = 'B'.repeat(650);
    const entries = [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: longText }] } },
    ];
    const filePath = path.join(tmpDir, 'long-full.jsonl');
    writeJsonl(filePath, entries);
    const result = getLastAssistantText(filePath);
    expect(result).toBe(longText);
    expect(result.length).toBe(650);
  });

  it('preserves a marker sitting at the very end of the block', () => {
    const { getLastAssistantText } = loadModule();
    const text = 'X'.repeat(600) + ' [DG-NOTE ui_ux/filter] added debounce to the search input';
    const entries = [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'do it' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } },
    ];
    const filePath = path.join(tmpDir, 'marker-end.jsonl');
    writeJsonl(filePath, entries);
    const result = getLastAssistantText(filePath);
    expect(result).toContain('[DG-NOTE ui_ux/filter]');
    expect(result.endsWith('search input')).toBe(true);
  });

  it('returns null when there is no assistant entry', () => {
    const { getLastAssistantText } = loadModule();
    const entries = [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Hello there friend' }] } },
    ];
    const filePath = path.join(tmpDir, 'no-assistant.jsonl');
    writeJsonl(filePath, entries);
    expect(getLastAssistantText(filePath)).toBe(null);
  });

  it('returns null for malformed, missing, or null file (non-fatal)', () => {
    const { getLastAssistantText } = loadModule();
    const bad = path.join(tmpDir, 'bad.jsonl');
    fs.writeFileSync(bad, 'not json\nalso not json');
    expect(getLastAssistantText(bad)).toBe(null);
    expect(getLastAssistantText('/nonexistent/file.jsonl')).toBe(null);
    expect(getLastAssistantText(null)).toBe(null);
  });

  it('capture-rate: recovers the end marker in 20/20 synthetic transcripts after >500 chars', () => {
    const { getLastAssistantText } = loadModule();
    const { parseMarker } = require('../../src/engine/dg-note');
    let recovered = 0;
    for (let i = 0; i < 20; i++) {
      const filler = 'Considered the change carefully and weighed the tradeoffs. '.repeat(10);
      expect(filler.length).toBeGreaterThan(500);
      const text = `${filler}[DG-NOTE ui_ux/filter] applied filter fix number ${i} to the results panel`;
      const entries = [
        { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'go ahead' }] } },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } },
      ];
      const filePath = path.join(tmpDir, `synthetic-${i}.jsonl`);
      writeJsonl(filePath, entries);
      const parsed = parseMarker(getLastAssistantText(filePath));
      if (parsed && parsed.nodeId === 'ui_ux/filter') recovered++;
    }
    expect(recovered).toBe(20);
  });
});

describe('findResponseAfter', () => {
  it('returns the first assistant text block after the anchor, not a later one', () => {
    const { findResponseAfter } = loadModule();
    const entries = [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'edit-1', name: 'Edit', input: {} }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'edit-1', is_error: false }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'FIRST response right after the anchor edit' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'edit-2', name: 'Edit', input: {} }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'edit-2', is_error: false }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'SECOND much later response block' }] } },
    ];
    const filePath = path.join(tmpDir, 'after.jsonl');
    writeJsonl(filePath, entries);
    expect(findResponseAfter(filePath, 'edit-1')).toBe('FIRST response right after the anchor edit');
  });

  it('skips tool_use-only assistant messages after the anchor and finds the next text block', () => {
    const { findResponseAfter } = loadModule();
    const entries = [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'edit-1', name: 'Edit', input: {} }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'edit-1' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'bash-1', name: 'Bash', input: {} }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'the verdict text that follows the tool calls' }] } },
    ];
    const filePath = path.join(tmpDir, 'skip.jsonl');
    writeJsonl(filePath, entries);
    expect(findResponseAfter(filePath, 'edit-1')).toBe('the verdict text that follows the tool calls');
  });

  it('does NOT return an assistant text block that precedes the anchor', () => {
    const { findResponseAfter } = loadModule();
    const entries = [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'reasoning written BEFORE the edit anchor' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'edit-1', name: 'Edit', input: {} }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'edit-1' }] } },
    ];
    const filePath = path.join(tmpDir, 'before.jsonl');
    writeJsonl(filePath, entries);
    expect(findResponseAfter(filePath, 'edit-1')).toBe(null);
  });

  it('returns the FULL untruncated text so an end-of-block marker survives', () => {
    const { findResponseAfter } = loadModule();
    const text = 'C'.repeat(600) + ' [DG-tag pivot] changed approach after the edit';
    const entries = [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'edit-1', name: 'Edit', input: {} }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } },
    ];
    const filePath = path.join(tmpDir, 'full.jsonl');
    writeJsonl(filePath, entries);
    const result = findResponseAfter(filePath, 'edit-1');
    expect(result).toContain('[DG-tag pivot]');
    expect(result.length).toBe(text.length);
  });

  it('finds the response when the anchor appears as a tool_use id', () => {
    const { findResponseAfter } = loadModule();
    const entries = [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'first I explain what I am going to change here' }, { type: 'tool_use', id: 'edit-1', name: 'Edit', input: {} }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'the follow-up assistant verdict block' }] } },
    ];
    const filePath = path.join(tmpDir, 'inline.jsonl');
    writeJsonl(filePath, entries);
    expect(findResponseAfter(filePath, 'edit-1')).toBe('the follow-up assistant verdict block');
  });

  it('returns null when the anchor id is not present', () => {
    const { findResponseAfter } = loadModule();
    const entries = [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'some assistant reasoning here that is long enough' }] } },
    ];
    const filePath = path.join(tmpDir, 'noanchor.jsonl');
    writeJsonl(filePath, entries);
    expect(findResponseAfter(filePath, 'missing-id')).toBe(null);
  });

  it('returns null for null path, missing file, or null anchor (non-fatal)', () => {
    const { findResponseAfter } = loadModule();
    expect(findResponseAfter(null, 'edit-1')).toBe(null);
    expect(findResponseAfter('/nonexistent/file.jsonl', 'edit-1')).toBe(null);
    const filePath = path.join(tmpDir, 'nullanchor.jsonl');
    writeJsonl(filePath, [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'edit-1', name: 'Edit', input: {} }, { type: 'text', text: 'hello there this is text' }] } }]);
    expect(findResponseAfter(filePath, null)).toBe(null);
  });

  it('ignores sidechain (subagent) text and returns the main-session reply', () => {
    const { findResponseAfter } = loadModule();
    const entries = [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'edit-1', name: 'Edit', input: {} }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'edit-1' }] } },
      { type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'Subagent analyzing the auth module for issues right now' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'the real main-session verdict about the edit' }] } },
    ];
    const filePath = path.join(tmpDir, 'sidechain.jsonl');
    writeJsonl(filePath, entries);
    expect(findResponseAfter(filePath, 'edit-1')).toBe('the real main-session verdict about the edit');
  });

  it('returns null when only sidechain text follows the anchor', () => {
    const { findResponseAfter } = loadModule();
    const entries = [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'edit-1', name: 'Edit', input: {} }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'edit-1' }] } },
      { type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'Subagent chatter that must not become the verdict' }] } },
    ];
    const filePath = path.join(tmpDir, 'sidechain-only.jsonl');
    writeJsonl(filePath, entries);
    expect(findResponseAfter(filePath, 'edit-1')).toBe(null);
  });

  it('does not cross-attribute: an edit whose reply is separated by a later edit returns null', () => {
    const { findResponseAfter } = loadModule();
    const entries = [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'edit-1', name: 'Edit', input: {} }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'edit-1' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'edit-2', name: 'Edit', input: {} }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'edit-2' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'verdict that is really about edit-2 only' }] } },
    ];
    const filePath = path.join(tmpDir, 'back-to-back.jsonl');
    writeJsonl(filePath, entries);
    expect(findResponseAfter(filePath, 'edit-1')).toBe(null);
    expect(findResponseAfter(filePath, 'edit-2')).toBe('verdict that is really about edit-2 only');
  });

  it('returns a short first reply instead of skipping ahead to a later block', () => {
    const { findResponseAfter } = loadModule();
    const entries = [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'edit-1', name: 'Edit', input: {} }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'edit-1' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'unrelated later block about the next task entirely' }] } },
    ];
    const filePath = path.join(tmpDir, 'short.jsonl');
    writeJsonl(filePath, entries);
    expect(findResponseAfter(filePath, 'edit-1')).toBe('Done.');
  });

  it('skips a non-edit tool_use (Bash) between anchor and reply without nulling out', () => {
    const { findResponseAfter } = loadModule();
    const entries = [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'edit-1', name: 'Edit', input: {} }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'edit-1' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'bash-1', name: 'Bash', input: {} }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'bash-1' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'verdict after running a verification command' }] } },
    ];
    const filePath = path.join(tmpDir, 'bash-between.jsonl');
    writeJsonl(filePath, entries);
    expect(findResponseAfter(filePath, 'edit-1')).toBe('verdict after running a verification command');
  });

  // KNOWN LIMITATION (documents behavior for the S4.1 post-edit wiring): a new
  // user turn between the anchor and the reply is NOT a boundary — "first text
  // after anchor" then returns the reply to the *new* message, cross-attributed
  // to the anchor edit. The S4 consumer must guard against a user turn between
  // the edit and the verdict; this primitive intentionally does not.
  it('known limitation: a user turn between anchor and reply is cross-attributed', () => {
    const { findResponseAfter } = loadModule();
    const entries = [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'edit-1', name: 'Edit', input: {} }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'edit-1' }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'actually, do something completely different now' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'reply to the NEW user message, not the edit' }] } },
    ];
    const filePath = path.join(tmpDir, 'user-interrupt.jsonl');
    writeJsonl(filePath, entries);
    expect(findResponseAfter(filePath, 'edit-1')).toBe('reply to the NEW user message, not the edit');
  });
});

describe('findResponseAfter — stopAtUserTurn guard (S4.1)', () => {
  it('with the guard, a user prompt between anchor and reply returns null (no cross-attribution)', () => {
    const { findResponseAfter } = loadModule();
    const entries = [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'edit-1', name: 'Edit', input: {} }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'edit-1' }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'actually, do something completely different now' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'reply to the NEW user message, not the edit' }] } },
    ];
    const filePath = path.join(tmpDir, 'guard-userturn.jsonl');
    writeJsonl(filePath, entries);
    expect(findResponseAfter(filePath, 'edit-1', { stopAtUserTurn: true })).toBe(null);
  });

  it('with the guard, a user prompt given as a bare string still triggers the guard', () => {
    const { findResponseAfter } = loadModule();
    const entries = [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'edit-1', name: 'Edit', input: {} }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'edit-1' }] } },
      { type: 'user', message: { role: 'user', content: 'plain string prompt from the human that interrupts' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'reply to the plain-string prompt, not the edit' }] } },
    ];
    const filePath = path.join(tmpDir, 'guard-string.jsonl');
    writeJsonl(filePath, entries);
    expect(findResponseAfter(filePath, 'edit-1', { stopAtUserTurn: true })).toBe(null);
  });

  it('with the guard, a bare tool_result (not a real user turn) still yields the reply', () => {
    const { findResponseAfter } = loadModule();
    const entries = [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'edit-1', name: 'Edit', input: {} }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'edit-1' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'bash-1', name: 'Bash', input: {} }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'bash-1' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '[DG-CONTINUE] verified the change with a command' }] } },
    ];
    const filePath = path.join(tmpDir, 'guard-toolresult.jsonl');
    writeJsonl(filePath, entries);
    expect(findResponseAfter(filePath, 'edit-1', { stopAtUserTurn: true })).toContain('[DG-CONTINUE]');
  });

  it('the guard is opt-in: default (no opts) behavior is unchanged', () => {
    const { findResponseAfter } = loadModule();
    const entries = [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'edit-1', name: 'Edit', input: {} }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'edit-1' }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'a new user prompt appears here mid stream' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'default cross-attributed reply stays as before' }] } },
    ];
    const filePath = path.join(tmpDir, 'guard-default.jsonl');
    writeJsonl(filePath, entries);
    expect(findResponseAfter(filePath, 'edit-1')).toBe('default cross-attributed reply stays as before');
  });
});

// S4.1 anchor recovery: the current edit's tool_use_id must be recovered from the
// transcript TAIL (last MAX_READ_BYTES), not the 4MB head — otherwise long sessions
// (the exact target of retrospective attribution) lose their anchor. And it must not
// depend on the tool_result being flushed yet (PostToolUse can fire before it).
describe('findLastEditToolUseId', () => {
  const editUse = (id, file) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Edit', input: { file_path: file } }] } });
  const toolResult = (id) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: false }] } });
  const bigText = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });

  it('returns null for null args', () => {
    const { findLastEditToolUseId } = loadModule();
    expect(findLastEditToolUseId(null, '/proj/app.js')).toBe(null);
    expect(findLastEditToolUseId('/x.jsonl', null)).toBe(null);
  });

  it('recovers the TAIL edit id on a >4MB transcript (head edit to the same file is ignored)', () => {
    const { findLastEditToolUseId } = loadModule();
    // Head: an early edit to app.js the 4MB-head scanner would return by mistake.
    const head = [editUse('head-edit', '/proj/app.js'), toolResult('head-edit')].map(e => JSON.stringify(e)).join('\n');
    // ~4.3MB of filler so the tail edit sits well beyond the 4MB head window.
    const filler = JSON.stringify(bigText('x'.repeat(4_300_000)));
    const tail = [editUse('tail-edit', '/proj/app.js'), toolResult('tail-edit')].map(e => JSON.stringify(e)).join('\n');
    const filePath = path.join(tmpDir, 'huge.jsonl');
    fs.writeFileSync(filePath, head + '\n' + filler + '\n' + tail + '\n');

    expect(findLastEditToolUseId(filePath, '/proj/app.js')).toBe('tail-edit');
  });

  it('recovers the id from the tool_use even when the tool_result is not yet written', () => {
    const { findLastEditToolUseId } = loadModule();
    // PostToolUse can fire before Claude Code flushes the tool_result line.
    const filePath = path.join(tmpDir, 'no-result.jsonl');
    writeJsonl(filePath, [editUse('cur-edit', '/proj/app.js')]);
    expect(findLastEditToolUseId(filePath, '/proj/app.js')).toBe('cur-edit');
  });

  it('returns the LAST matching edit for the file, ignoring other files', () => {
    const { findLastEditToolUseId } = loadModule();
    const filePath = path.join(tmpDir, 'multi.jsonl');
    writeJsonl(filePath, [
      editUse('a', '/proj/app.js'), toolResult('a'),
      editUse('b', '/proj/other.js'), toolResult('b'),
      editUse('c', '/proj/app.js'), toolResult('c'),
    ]);
    expect(findLastEditToolUseId(filePath, '/proj/app.js')).toBe('c');
    expect(findLastEditToolUseId(filePath, '/proj/other.js')).toBe('b');
  });

  it('returns null when the file was never edited', () => {
    const { findLastEditToolUseId } = loadModule();
    const filePath = path.join(tmpDir, 'none.jsonl');
    writeJsonl(filePath, [editUse('a', '/proj/app.js'), toolResult('a')]);
    expect(findLastEditToolUseId(filePath, '/proj/ghost.js')).toBe(null);
  });
});
