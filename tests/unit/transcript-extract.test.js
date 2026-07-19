import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
let tmpDir;

beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-extract-')); });
afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows WAL */ } });

function loadModule() {
  for (const m of ['../../src/engine/transcript-parser', '../../src/engine/normalize-path', '../../src/engine/debug-log']) {
    delete require.cache[require.resolve(m)];
  }
  return require('../../src/engine/transcript-parser');
}

function writeJsonl(filePath, entries) {
  const lines = entries.map(e => JSON.stringify(e)).join('\n');
  fs.writeFileSync(filePath, lines);
}

function appendJsonl(filePath, entries) {
  const lines = entries.map(e => JSON.stringify(e)).join('\n');
  fs.appendFileSync(filePath, '\n' + lines);
}

const CWD_WIN = 'C:\\Users\\umut_\\proj';
const FILE_POSIX = '/c/Users/umut_/proj/src/index.js';
const FILE_WIN_EXPECTED = 'C:/Users/umut_/proj/src/index.js';
const PROJECT_EXPECTED = 'C:/Users/umut_/proj';

function assistantEdit(id, name, input, extra = {}) {
  return {
    type: 'assistant',
    cwd: CWD_WIN,
    timestamp: '2026-06-21T10:00:00Z',
    sessionId: 'sess-1',
    version: '1.0.0',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    ...extra,
  };
}

function userResult(toolUseId, isError) {
  const item = { type: 'tool_result', tool_use_id: toolUseId };
  if (isError) item.is_error = true;
  return { type: 'user', message: { role: 'user', content: [item] } };
}

describe('extractEdits', () => {
  // Windows path-form semantics ('/c/Users' -> 'C:/Users'); on Linux these inputs
  // are correctly rejected by normalizePath, so the assertion is win32-only.
  it.skipIf(process.platform !== 'win32')('extracts Edit and Write with normalized POSIX -> Windows paths and correct fields', () => {
    const { extractEdits } = loadModule();
    const entries = [
      assistantEdit('e1', 'Edit', {
        file_path: FILE_POSIX,
        old_string: 'const a = 1;',
        new_string: 'const a = 2;',
      }),
      userResult('e1', false),
      assistantEdit('w1', 'Write', {
        file_path: FILE_POSIX,
        content: 'module.exports = {};',
      }),
      userResult('w1', false),
    ];
    const fp = path.join(tmpDir, 't.jsonl');
    writeJsonl(fp, entries);

    const { edits, bytesRead } = extractEdits(fp);
    expect(edits).toHaveLength(2);
    expect(bytesRead).toBe(fs.statSync(fp).size);

    const edit = edits[0];
    expect(edit.tool_use_id).toBe('e1');
    expect(edit.action).toBe('Edit');
    expect(edit.file).toBe(FILE_WIN_EXPECTED);
    expect(edit.project_path).toBe(PROJECT_EXPECTED);
    expect(edit.description).toBe('const a = 2;');
    expect(edit.diff_text).toBe('const a = 1; => const a = 2;');
    expect(edit.timestamp).toBe('2026-06-21T10:00:00Z');
    expect(edit.isSidechain).toBe(false);
    expect(edit.session_id).toBe('sess-1');
    expect(edit.version).toBe('1.0.0');
    expect(edit.resolved).toBe(true);

    const write = edits[1];
    expect(write.action).toBe('Write');
    expect(write.file).toBe(FILE_WIN_EXPECTED);
    expect(write.description).toBe('module.exports = {};');
    expect(write.diff_text).toBe('module.exports = {};');
  });

  it.skipIf(process.platform !== 'win32')('handles file_path already in Windows form', () => {
    const { extractEdits } = loadModule();
    const entries = [
      assistantEdit('e1', 'Edit', {
        file_path: 'C:\\Users\\umut_\\proj\\src\\index.js',
        old_string: 'x',
        new_string: 'y',
      }),
      userResult('e1', false),
    ];
    const fp = path.join(tmpDir, 't.jsonl');
    writeJsonl(fp, entries);
    const { edits } = extractEdits(fp);
    expect(edits).toHaveLength(1);
    expect(edits[0].file).toBe(FILE_WIN_EXPECTED);
  });

  it('EXCLUDES a failed edit (tool_result is_error:true)', () => {
    const { extractEdits } = loadModule();
    const entries = [
      assistantEdit('ok', 'Edit', { file_path: FILE_POSIX, old_string: 'a', new_string: 'b' }),
      userResult('ok', false),
      assistantEdit('bad', 'Edit', { file_path: FILE_POSIX, old_string: 'c', new_string: 'd' }),
      userResult('bad', true),
    ];
    const fp = path.join(tmpDir, 't.jsonl');
    writeJsonl(fp, entries);
    const { edits } = extractEdits(fp);
    expect(edits.map(e => e.tool_use_id)).toEqual(['ok']);
  });

  it('INCLUDES a successful edit (tool_result without is_error)', () => {
    const { extractEdits } = loadModule();
    const entries = [
      assistantEdit('ok', 'Edit', { file_path: FILE_POSIX, old_string: 'a', new_string: 'b' }),
      userResult('ok', false),
    ];
    const fp = path.join(tmpDir, 't.jsonl');
    writeJsonl(fp, entries);
    const { edits } = extractEdits(fp);
    expect(edits).toHaveLength(1);
    expect(edits[0].resolved).toBe(true);
  });

  it('EXCLUDES an orphan edit (result not in window yet) and pins the cursor before it', () => {
    const { extractEdits } = loadModule();
    const entries = [
      assistantEdit('ok', 'Edit', { file_path: FILE_POSIX, old_string: 'a', new_string: 'b' }),
      userResult('ok', false),
      assistantEdit('orphan', 'Edit', { file_path: FILE_POSIX, old_string: 'c', new_string: 'd' }),
    ];
    const fp = path.join(tmpDir, 't.jsonl');
    writeJsonl(fp, entries);
    const { edits, bytesRead } = extractEdits(fp);
    // only the resolved edit is imported; the orphan is held back for a later pass
    expect(edits.map(e => e.tool_use_id)).toEqual(['ok']);
    // cursor stops BEFORE the orphan line (not at EOF) so it is re-read next pass
    expect(bytesRead).toBeLessThan(fs.statSync(fp).size);
  });

  it('split-window: an edit whose FAILING result arrives in a later pass is never imported', () => {
    const { extractEdits } = loadModule();
    const fp = path.join(tmpDir, 't.jsonl');
    // Pass A: only the tool_use exists so far (result not yet flushed to disk)
    writeJsonl(fp, [
      assistantEdit('e1', 'Edit', { file_path: FILE_POSIX, old_string: 'a', new_string: 'b' }),
    ]);
    const passA = extractEdits(fp);
    expect(passA.edits).toHaveLength(0); // orphan held back, not imported as success

    // Pass B: the failing result is appended; resuming must still exclude it
    fs.appendFileSync(fp, '\n' + JSON.stringify(userResult('e1', true)));
    const passB = extractEdits(fp, passA.bytesRead);
    expect(passB.edits).toHaveLength(0); // failed edit excluded — never recorded
  });

  it('flags isSidechain:true edits', () => {
    const { extractEdits } = loadModule();
    const entries = [
      assistantEdit('s1', 'Edit', { file_path: FILE_POSIX, old_string: 'a', new_string: 'b' }, { isSidechain: true }),
      userResult('s1', false),
    ];
    const fp = path.join(tmpDir, 't.jsonl');
    writeJsonl(fp, entries);
    const { edits } = extractEdits(fp);
    expect(edits).toHaveLength(1);
    expect(edits[0].isSidechain).toBe(true);
  });

  it('fromOffset: incremental read returns only new edits and advances bytesRead', () => {
    const { extractEdits } = loadModule();
    const fp = path.join(tmpDir, 't.jsonl');
    const first = [
      assistantEdit('a1', 'Edit', { file_path: FILE_POSIX, old_string: '1', new_string: '2' }),
      userResult('a1', false),
      assistantEdit('a2', 'Edit', { file_path: FILE_POSIX, old_string: '3', new_string: '4' }),
      userResult('a2', false),
    ];
    writeJsonl(fp, first);

    const r1 = extractEdits(fp, 0);
    expect(r1.edits.map(e => e.tool_use_id)).toEqual(['a1', 'a2']);
    expect(r1.bytesRead).toBe(fs.statSync(fp).size);

    appendJsonl(fp, [
      assistantEdit('a3', 'Write', { file_path: FILE_POSIX, content: 'new file body' }),
      userResult('a3', false),
    ]);

    const r2 = extractEdits(fp, r1.bytesRead);
    expect(r2.edits.map(e => e.tool_use_id)).toEqual(['a3']);
    expect(r2.bytesRead).toBeGreaterThan(r1.bytesRead);
    expect(r2.bytesRead).toBe(fs.statSync(fp).size);
  });

  it('fromOffset at EOF returns no edits but cursor stays at file size', () => {
    const { extractEdits } = loadModule();
    const fp = path.join(tmpDir, 't.jsonl');
    writeJsonl(fp, [
      assistantEdit('a1', 'Edit', { file_path: FILE_POSIX, old_string: '1', new_string: '2' }),
      userResult('a1', false),
    ]);
    const r1 = extractEdits(fp, 0);
    const r2 = extractEdits(fp, r1.bytesRead);
    expect(r2.edits).toHaveLength(0);
    expect(r2.bytesRead).toBe(r1.bytesRead);
  });

  it('skips malformed lines without throwing', () => {
    const { extractEdits } = loadModule();
    const fp = path.join(tmpDir, 't.jsonl');
    const good = JSON.stringify(assistantEdit('g1', 'Edit', { file_path: FILE_POSIX, old_string: 'a', new_string: 'b' }));
    const goodResult = JSON.stringify(userResult('g1', false));
    fs.writeFileSync(fp, good + '\n{not json}\n' + goodResult);
    const { edits } = extractEdits(fp);
    expect(edits).toHaveLength(1);
    expect(edits[0].tool_use_id).toBe('g1');
  });

  it('MultiEdit with missing edits[] does not throw', () => {
    const { extractEdits } = loadModule();
    const fp = path.join(tmpDir, 't.jsonl');
    writeJsonl(fp, [
      assistantEdit('m1', 'MultiEdit', { file_path: FILE_POSIX }),
      userResult('m1', false),
    ]);
    const { edits } = extractEdits(fp);
    expect(edits).toHaveLength(1);
    expect(edits[0].action).toBe('MultiEdit');
    expect(edits[0].description).toBe('0 edits');
    expect(edits[0].diff_text).toBe('');
  });

  it('MultiEdit with edits[] summarizes count and joins diffs', () => {
    const { extractEdits } = loadModule();
    const fp = path.join(tmpDir, 't.jsonl');
    writeJsonl(fp, [
      assistantEdit('m1', 'MultiEdit', {
        file_path: FILE_POSIX,
        edits: [
          { old_string: 'a', new_string: 'b' },
          { old_string: 'c', new_string: 'd' },
        ],
      }),
      userResult('m1', false),
    ]);
    const { edits } = extractEdits(fp);
    expect(edits[0].description).toBe('2 edits');
    expect(edits[0].diff_text).toBe('a => b\nc => d');
  });

  it('handles missing input gracefully', () => {
    const { extractEdits } = loadModule();
    const fp = path.join(tmpDir, 't.jsonl');
    writeJsonl(fp, [
      { type: 'assistant', cwd: CWD_WIN, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'n1', name: 'Edit' }] } },
      userResult('n1', false),
    ]);
    const { edits } = extractEdits(fp);
    expect(edits).toHaveLength(1);
    expect(edits[0].description).toBe('edit');
    expect(edits[0].file).toBe(undefined);
  });

  it('returns empty for null / missing path', () => {
    const { extractEdits } = loadModule();
    expect(extractEdits(null)).toEqual({ edits: [], bytesRead: 0 });
    expect(extractEdits(path.join(tmpDir, 'nope.jsonl'))).toEqual({ edits: [], bytesRead: 0 });
  });
});

describe('parseTranscript regression', () => {
  it('still returns {reasoning, confidence} unchanged', () => {
    const { parseTranscript } = loadModule();
    const fp = path.join(tmpDir, 'r.jsonl');
    writeJsonl(fp, [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'I will refactor the token validation logic to handle expired tokens correctly.' }] } },
    ]);
    const result = parseTranscript(fp);
    expect(Object.keys(result).sort()).toEqual(['confidence', 'reasoning']);
    expect(result.reasoning).toContain('token validation');
    expect(typeof result.confidence).toBe('number');
  });
});
