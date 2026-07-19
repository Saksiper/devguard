import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { normalizePath } = require('../../src/engine/normalize-path');
const HOOK_PATH = path.resolve(__dirname, '../../src/hooks/post-edit.js');

let tmpDir;
let projectDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-postedit-test-'));
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-project-'));
});

afterEach(() => {
  for (const dir of [tmpDir, projectDir]) {
    if (dir && fs.existsSync(dir)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
  }
});

function loadDb() {
  delete require.cache[require.resolve('../../src/engine/db')];
  delete require.cache[require.resolve('../../src/engine/sanitize')];
  delete require.cache[require.resolve('../../src/engine/debug-log')];
  return require('../../src/engine/db');
}

function ensureSession() {
  process.env.CLAUDE_PLUGIN_DATA = tmpDir;
  const db = loadDb();
  const proxy = db.getDb(projectDir);
  proxy.insertSession('test-session');
  db.closeDb();
  delete require.cache[require.resolve('../../src/engine/db')];
  delete process.env.CLAUDE_PLUGIN_DATA;
}

function runPostEdit(inputObj) {
  const input = JSON.stringify(inputObj);
  try {
    const stdout = execFileSync('node', [HOOK_PATH], {
      input,
      encoding: 'utf-8',
      timeout: 20000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: tmpDir,
        DEVGUARD_DEBUG: '0',
        DEVGUARD_MODEL_DIR: path.join(tmpDir, 'no-model'),
        DEVGUARD_OFFLINE: '1',
      },
    });
    return { stdout, exitCode: 0 };
  } catch (err) {
    return { stdout: err.stdout || '', stderr: err.stderr || '', exitCode: err.status };
  }
}

function getChanges() {
  process.env.CLAUDE_PLUGIN_DATA = tmpDir;
  const db = loadDb();
  const proxy = db.getDb(projectDir);
  const changes = proxy.getChanges();
  db.closeDb();
  delete require.cache[require.resolve('../../src/engine/db')];
  delete process.env.CLAUDE_PLUGIN_DATA;
  return changes;
}

// Run an arbitrary read/write against the same on-disk DB the hook uses.
function withDb(fn) {
  process.env.CLAUDE_PLUGIN_DATA = tmpDir;
  const db = loadDb();
  const proxy = db.getDb(projectDir);
  const out = fn(proxy);
  db.closeDb();
  delete require.cache[require.resolve('../../src/engine/db')];
  delete process.env.CLAUDE_PLUGIN_DATA;
  return out;
}

function writeJsonl(filePath, entries) {
  fs.writeFileSync(filePath, entries.map(e => JSON.stringify(e)).join('\n'));
}

const NP = normalizePath;
const editUse = (id, file) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Edit', input: { file_path: file } }] } });
const toolResult = (id) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: false }] } });
const asstText = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const userText = (text) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });

describe('post-edit.js', () => {
  it('records change for Edit tool', () => {
    ensureSession();
    runPostEdit({
      cwd: projectDir,
      tool_name: 'Edit',
      tool_input: {
        file_path: '/project/app.js',
        old_string: 'const x = 1;',
        new_string: 'const x = 2;',
      },
      tool_response: {},
    });
    const changes = getChanges();
    expect(changes).toHaveLength(1);
    expect(changes[0].file).toBe(normalizePath('/project/app.js'));
    expect(changes[0].diff_text).toBe('const x = 1;');
    expect(changes[0].action).toBe('Edit');
    expect(changes[0].session_id).toBe('test-session');
  });

  it('records change for Write tool with null diff_text', () => {
    ensureSession();
    runPostEdit({
      cwd: projectDir,
      tool_name: 'Write',
      tool_input: {
        file_path: '/project/new-file.js',
        // Write tool has no old_string
      },
      tool_response: {},
    });
    const changes = getChanges();
    expect(changes).toHaveLength(1);
    expect(changes[0].file).toBe(normalizePath('/project/new-file.js'));
    expect(changes[0].diff_text).toBeNull();
    expect(changes[0].action).toBe('Write');
  });

  it('does not record when file_path is missing', () => {
    ensureSession();
    runPostEdit({
      cwd: projectDir,
      tool_name: 'Edit',
      tool_input: {},
      tool_response: {},
    });
    const changes = getChanges();
    expect(changes).toHaveLength(0);
  });

  it('sanitizes secrets in diff_text (via db layer)', () => {
    ensureSession();
    runPostEdit({
      cwd: projectDir,
      tool_name: 'Edit',
      tool_input: {
        file_path: '/project/config.js',
        old_string: 'const key = "sk-abcdefghijklmnopqrstuvwxyz1234";',
        new_string: 'const key = process.env.API_KEY;',
      },
      tool_response: {},
    });
    const changes = getChanges();
    expect(changes).toHaveLength(1);
    expect(changes[0].diff_text).toContain('[REDACTED_API_KEY]');
    expect(changes[0].diff_text).not.toContain('sk-abcdefghijklmnopqrstuvwxyz1234');
  });

  it('records multiple edits as separate changes', () => {
    ensureSession();
    for (let i = 0; i < 3; i++) {
      runPostEdit({
        cwd: projectDir,
        tool_name: 'Edit',
        tool_input: {
          file_path: `/project/file${i}.js`,
          old_string: `old-${i}`,
          new_string: `new-${i}`,
        },
        tool_response: {},
      });
    }
    const changes = getChanges();
    expect(changes).toHaveLength(3);
  });

  it('exits 0 on invalid input (graceful fail)', () => {
    const result = runPostEdit({});
    expect(result.exitCode).toBe(0);
  });

  it('exits 0 when no session exists', () => {
    const result = runPostEdit({
      cwd: projectDir,
      tool_name: 'Edit',
      tool_input: { file_path: '/project/app.js', old_string: 'x', new_string: 'y' },
      tool_response: {},
    });
    expect(result.exitCode).toBe(0);
    const changes = getChanges();
    expect(changes).toHaveLength(0);
  });

  it('defaults tool_name to Edit when missing', () => {
    ensureSession();
    runPostEdit({
      cwd: projectDir,
      tool_input: { file_path: '/project/app.js', old_string: 'x', new_string: 'y' },
      tool_response: {},
    });
    const changes = getChanges();
    expect(changes).toHaveLength(1);
    expect(changes[0].action).toBe('Edit');
  });

  it('sanitizes secrets in new_string (description field)', () => {
    ensureSession();
    runPostEdit({
      cwd: projectDir,
      tool_name: 'Edit',
      tool_input: {
        file_path: '/project/config.js',
        old_string: 'const key = process.env.API_KEY;',
        new_string: 'const key = "sk-abcdefghijklmnopqrstuvwxyz1234";',
      },
      tool_response: {},
    });
    const changes = getChanges();
    expect(changes).toHaveLength(1);
    expect(changes[0].description).toContain('[REDACTED_API_KEY]');
    expect(changes[0].description).not.toContain('sk-abcdefghijklmnopqrstuvwxyz1234');
  });

  it('truncates large old_string to 10KB', () => {
    ensureSession();
    const bigString = 'x'.repeat(20000);
    runPostEdit({
      cwd: projectDir,
      tool_name: 'Edit',
      tool_input: {
        file_path: '/project/big.js',
        old_string: bigString,
        new_string: 'small',
      },
      tool_response: {},
    });
    const changes = getChanges();
    expect(changes).toHaveLength(1);
    expect(changes[0].diff_text.length).toBeLessThanOrEqual(10240);
  });
});

describe('post-edit.js — F1 node_id is written UNCONDITIONALLY (degraded paths)', () => {
  // The runPostEdit harness already points DEVGUARD_MODEL_DIR at an empty dir with
  // DEVGUARD_OFFLINE=1, so loadModel FAILS — this is the "model-load-fails" variant.
  it('model-load-fails (embeddings enabled, model unavailable) -> node_id set, embedding NULL', () => {
    ensureSession();
    runPostEdit({
      cwd: projectDir,
      tool_name: 'Edit',
      tool_input: {
        file_path: '/project/auth.js',
        old_string: 'x',
        new_string: 'function login() { return jwt; }',
      },
      tool_response: {},
    });
    const changes = getChanges();
    expect(changes).toHaveLength(1);
    expect(changes[0].node_id).not.toBeNull();
    expect(changes[0].node_id.startsWith('security/')).toBe(true);
    // loadModel failed -> no embedding was ever encoded/stored.
    expect(changes[0].description_embedding).toBeNull();
  });

  it('embedding_enabled:false -> node_id set from continent heuristic, model never loaded', () => {
    // Write a project config disabling embeddings. computeEmbedding is then never
    // called, so loadModel is never invoked; node_id must STILL be written.
    fs.writeFileSync(path.join(projectDir, 'devguard.config.yaml'), 'embedding_enabled: false\n');
    ensureSession();
    runPostEdit({
      cwd: projectDir,
      tool_name: 'Edit',
      tool_input: {
        file_path: '/project/report.js',
        old_string: 'x',
        new_string: 'run a sql migration query',
      },
      tool_response: {},
    });
    const changes = getChanges();
    expect(changes).toHaveLength(1);
    expect(changes[0].node_id).not.toBeNull();
    expect(changes[0].node_id.startsWith('data/')).toBe(true);
    // Proof loadModel was not invoked: no embedding was produced.
    expect(changes[0].description_embedding).toBeNull();
  });
});

describe('post-edit.js — S4.1 retrospective verdict attribution', () => {
  function runEdit(transcriptPath, filePath = '/project/app.js') {
    return runPostEdit({
      cwd: projectDir,
      tool_name: 'Edit',
      session_id: 'test-session',
      transcript_path: transcriptPath,
      tool_input: { file_path: filePath, old_string: 'a', new_string: 'b' },
      tool_response: {},
    });
  }

  it('STEP 1: recovers THIS edit tool_use_id from the transcript and persists it on the change', () => {
    ensureSession();
    const tr = path.join(tmpDir, 'step1.jsonl');
    writeJsonl(tr, [editUse('cur-edit', '/project/app.js'), toolResult('cur-edit')]);
    runEdit(tr);
    const cur = getChanges().find(c => c.tool_use_id === 'cur-edit');
    expect(cur).toBeTruthy();
    expect(cur.file).toBe(NP('/project/app.js'));
  });

  it('STEP 2: captures a prior edit verdict retrospectively and records dg_pivot outcome', () => {
    ensureSession();
    const priorId = withDb(p => {
      const id = p.insertChange({ session_id: 'test-session', file: NP('/project/prior.js'), action: 'Edit', tool_use_id: 'prior-edit', description: 'x' });
      p.insertDetection({ session_id: 'test-session', file: NP('/project/prior.js'), decision: 'warn', middleware_id: 'm1' });
      // Under the decoupled design, the prior's OWN post-edit links its detection at
      // insert time; seed that here so cur's linkDetectionsToChange doesn't scoop m1.
      p.linkDetectionsToChange('test-session', id, NP('/project/prior.js'));
      return id;
    });
    const tr = path.join(tmpDir, 'step2.jsonl');
    writeJsonl(tr, [
      editUse('prior-edit', '/project/prior.js'),
      toolResult('prior-edit'),
      asstText('[DG-PIVOT] Changed approach after reconsidering the retry logic tradeoffs.'),
      editUse('cur-edit', '/project/app.js'),
      toolResult('cur-edit'),
    ]);
    runEdit(tr);
    const { prior, cur, dets } = withDb(p => ({
      prior: p.getChanges({ session_id: 'test-session' }).find(c => c.id === priorId),
      cur: p.getChanges({ session_id: 'test-session' }).find(c => c.tool_use_id === 'cur-edit'),
      dets: p.getDetections({ session_id: 'test-session' }),
    }));
    expect(prior.claude_verdict).toContain('[DG-PIVOT]');
    expect(cur).toBeTruthy();
    expect(cur.claude_verdict).toBeNull();
    const det = dets.find(d => d.middleware_id === 'm1');
    expect(det.next_change_outcome).toBe('dg_pivot');
    expect(Number(det.next_change_id)).toBe(Number(priorId));
  });

  it('STEP 3: user-turn guard suppresses cross-attribution (prior verdict stays null)', () => {
    ensureSession();
    const priorId = withDb(p => p.insertChange({ session_id: 'test-session', file: NP('/project/prior.js'), action: 'Edit', tool_use_id: 'prior-edit' }));
    const tr = path.join(tmpDir, 'step3.jsonl');
    writeJsonl(tr, [
      editUse('prior-edit', '/project/prior.js'),
      toolResult('prior-edit'),
      userText('actually do something completely different now please'),
      asstText('[DG-PIVOT] reply that is really about the new prompt, not the edit'),
      editUse('cur-edit', '/project/app.js'),
      toolResult('cur-edit'),
    ]);
    runEdit(tr);
    const prior = withDb(p => p.getChanges({ session_id: 'test-session' }).find(c => c.id === priorId));
    expect(prior.claude_verdict).toBeNull();
  });

  it('anchor absent in transcript -> no verdict, exit 0, current change still recorded', () => {
    ensureSession();
    const priorId = withDb(p => p.insertChange({ session_id: 'test-session', file: NP('/project/ghost.js'), action: 'Edit', tool_use_id: 'ghost-edit' }));
    const tr = path.join(tmpDir, 'absent.jsonl');
    writeJsonl(tr, [editUse('cur-edit', '/project/app.js'), toolResult('cur-edit')]);
    const r = runEdit(tr);
    expect(r.exitCode).toBe(0);
    const { prior, cur } = withDb(p => ({
      prior: p.getChanges({ session_id: 'test-session' }).find(c => c.id === priorId),
      cur: p.getChanges({ session_id: 'test-session' }).find(c => c.tool_use_id === 'cur-edit'),
    }));
    expect(prior.claude_verdict).toBeNull();
    expect(cur).toBeTruthy();
  });

  it('anchoring on the current edit (reply not yet present) -> null verdict, no regression-crash', () => {
    ensureSession();
    const tr = path.join(tmpDir, 'current.jsonl');
    writeJsonl(tr, [editUse('cur-edit', '/project/app.js'), toolResult('cur-edit')]);
    const r = runEdit(tr);
    expect(r.exitCode).toBe(0);
    const cur = withDb(p => p.getChanges({ session_id: 'test-session' }).find(c => c.tool_use_id === 'cur-edit'));
    expect(cur).toBeTruthy();
    expect(cur.claude_verdict).toBeNull();
  });

  it('retro attribution does NOT score note compliance (owned by the Stop/SessionEnd ack harvest)', () => {
    ensureSession();
    // Even the old path's ideal case — prior edit node matches the surfaced note's
    // node and the reply carries a DG tag — must not emit a compliance event here:
    // a mid-session 'ignored'/'complied' would permanently block (dedup) the ack
    // harvest's own verdict for this session.
    const noteId = withDb(p => {
      const id = p.insertChange({ session_id: 'test-session', file: NP('/project/prior.js'), action: 'Edit', tool_use_id: 'prior-edit' });
      p.updateChangeNodeId(id, 'security/auth');
      const nid = p.insertNote({ session_id: 'test-session', file: NP('/project/prior.js'), node_id: 'security/auth', source: 'sphere', confidence_level: 2, note_text: 'guard the token refresh path' });
      p.insertNoteEvent({ note_id: nid, session_id: 'test-session', event_type: 'surfaced' });
      return nid;
    });
    const tr = path.join(tmpDir, 'no-retro-compliance.jsonl');
    writeJsonl(tr, [
      editUse('prior-edit', '/project/prior.js'),
      toolResult('prior-edit'),
      asstText('[DG-CONTINUE] kept the token guard in place as advised'),
      editUse('cur-edit', '/project/app.js'),
      toolResult('cur-edit'),
    ]);
    runEdit(tr);
    const { prior, decided } = withDb(p => ({
      prior: p.getChanges({ session_id: 'test-session' }).find(c => c.tool_use_id === 'prior-edit'),
      decided: p.getNoteEvents({ note_id: noteId })
        .filter(e => ['complied', 'ignored', 'superseded'].includes(e.event_type)),
    }));
    expect(prior.claude_verdict).toContain('[DG-CONTINUE]'); // verdict capture still works
    expect(decided).toHaveLength(0); // note left surfaced-only for the ack harvest
  });
});

describe('post-edit.js — S4.1 session-close flush (terminal edit gets a verdict)', () => {
  const STOP_HOOK = path.resolve(__dirname, '../../src/hooks/stop.js');
  const SESSION_END_HOOK = path.resolve(__dirname, '../../src/hooks/session-end.js');

  function runHook(hookPath, inputObj) {
    try {
      execFileSync('node', [hookPath], {
        input: JSON.stringify(inputObj),
        encoding: 'utf-8',
        timeout: 20000,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, CLAUDE_PLUGIN_DATA: tmpDir, DEVGUARD_DEBUG: '0', DEVGUARD_OFFLINE: '1' },
      });
      return 0;
    } catch (err) {
      return err.status ?? 1;
    }
  }

  function runEdit(transcriptPath, filePath = '/project/app.js') {
    return runPostEdit({
      cwd: projectDir,
      tool_name: 'Edit',
      session_id: 'test-session',
      transcript_path: transcriptPath,
      tool_input: { file_path: filePath, old_string: 'a', new_string: 'b' },
      tool_response: {},
    });
  }

  it('Stop flush attributes a verdict to the single/terminal edit (no subsequent post-edit)', () => {
    ensureSession();
    const tr = path.join(tmpDir, 'terminal.jsonl');
    // At PostToolUse time only the edit + its tool_result exist; the reply is not written yet.
    writeJsonl(tr, [editUse('cur-edit', '/project/app.js'), toolResult('cur-edit')]);
    runEdit(tr);

    // The verdict cannot be captured on this post-edit (its own reply isn't in the transcript).
    let cur = getChanges().find(c => c.tool_use_id === 'cur-edit');
    expect(cur).toBeTruthy();
    expect(cur.claude_verdict).toBeNull();

    // Session ends: the final reply is now present. Stop hook must flush it retro-actively.
    writeJsonl(tr, [
      editUse('cur-edit', '/project/app.js'),
      toolResult('cur-edit'),
      asstText('[DG-CONTINUE] finished the change and it holds up'),
    ]);
    const exit = runHook(STOP_HOOK, { cwd: projectDir, session_id: 'test-session', transcript_path: tr });
    expect(exit).toBe(0);

    cur = getChanges().find(c => c.tool_use_id === 'cur-edit');
    expect(cur.claude_verdict).toContain('[DG-CONTINUE]');
  });

  it('SessionEnd flush also attributes the terminal edit verdict', () => {
    ensureSession();
    const tr = path.join(tmpDir, 'terminal-se.jsonl');
    writeJsonl(tr, [editUse('cur-edit', '/project/app.js'), toolResult('cur-edit')]);
    runEdit(tr);
    writeJsonl(tr, [
      editUse('cur-edit', '/project/app.js'),
      toolResult('cur-edit'),
      asstText('[DG-PIVOT] reconsidered and changed the approach'),
    ]);
    const exit = runHook(SESSION_END_HOOK, { cwd: projectDir, session_id: 'test-session', transcript_path: tr });
    expect(exit).toBe(0);
    const cur = getChanges().find(c => c.tool_use_id === 'cur-edit');
    expect(cur.claude_verdict).toContain('[DG-PIVOT]');
  });

  // g2 regression: under concurrent headless 'claude -p', getLatestSession() returns
  // the highest-id (WRONG) session. The flush must be driven by input.session_id, not
  // by getLatestSession, or the terminal edit of the intended session never flushes.
  // The pending change is seeded DIRECTLY under sess-a (bypassing post-edit main(),
  // whose own getLatestSession usage at :185 is out of scope) to isolate the flush.
  it('Stop flush is driven by input.session_id, not getLatestSession (g2)', () => {
    // sess-a owns the pending edit; sess-b is inserted LATER so getLatestSession() -> sess-b.
    withDb(p => {
      p.insertSession('sess-a');
      p.insertSession('sess-b');
      p.insertChange({ session_id: 'sess-a', file: NP('/project/app.js'), action: 'Edit', tool_use_id: 'a-edit' });
    });
    const tr = path.join(tmpDir, 'g2-stop.jsonl');
    writeJsonl(tr, [
      editUse('a-edit', '/project/app.js'),
      toolResult('a-edit'),
      asstText('[DG-CONTINUE] finished the change and it holds up'),
    ]);
    const exit = runHook(STOP_HOOK, { cwd: projectDir, session_id: 'sess-a', transcript_path: tr });
    expect(exit).toBe(0);

    const cur = getChanges().find(c => c.tool_use_id === 'a-edit');
    expect(cur.session_id).toBe('sess-a');
    expect(cur.claude_verdict).toContain('[DG-CONTINUE]');
  });

  it('SessionEnd flush is driven by input.session_id, not getLatestSession (g2)', () => {
    withDb(p => {
      p.insertSession('sess-a');
      p.insertSession('sess-b');
      p.insertChange({ session_id: 'sess-a', file: NP('/project/app.js'), action: 'Edit', tool_use_id: 'a-edit' });
    });
    const tr = path.join(tmpDir, 'g2-se.jsonl');
    writeJsonl(tr, [
      editUse('a-edit', '/project/app.js'),
      toolResult('a-edit'),
      asstText('[DG-PIVOT] reconsidered and changed the approach'),
    ]);
    const exit = runHook(SESSION_END_HOOK, { cwd: projectDir, session_id: 'sess-a', transcript_path: tr });
    expect(exit).toBe(0);
    const cur = getChanges().find(c => c.tool_use_id === 'a-edit');
    expect(cur.claude_verdict).toContain('[DG-PIVOT]');
  });
});

describe('post-edit.js — extractIssueTitle', () => {
  function loadPostEdit() {
    delete require.cache[require.resolve('../../src/hooks/post-edit')];
    delete require.cache[require.resolve('../../src/engine/line-resolver')];
    delete require.cache[require.resolve('../../src/engine/protection')];
    delete require.cache[require.resolve('../../src/engine/blame-cache')];
    delete require.cache[require.resolve('../../src/engine/debug-log')];
    return require('../../src/hooks/post-edit');
  }

  it('extracts title from Error: prefix', () => {
    const { extractIssueTitle } = loadPostEdit();
    expect(extractIssueTitle('Error: OAuth token expired')).toBe('OAuth token expired');
  });

  it('extracts title from TypeError: prefix', () => {
    const { extractIssueTitle } = loadPostEdit();
    expect(extractIssueTitle('TypeError: Cannot read property of null')).toBe('Cannot read property of null');
  });

  it('uses first line of multi-line error', () => {
    const { extractIssueTitle } = loadPostEdit();
    expect(extractIssueTitle('ECONNREFUSED\n  at Socket.connect')).toBe('ECONNREFUSED');
  });

  it('returns null for empty/null input', () => {
    const { extractIssueTitle } = loadPostEdit();
    expect(extractIssueTitle(null)).toBeNull();
    expect(extractIssueTitle('')).toBeNull();
  });

  it('truncates to 100 chars', () => {
    const { extractIssueTitle } = loadPostEdit();
    const longError = 'x'.repeat(200);
    const result = extractIssueTitle(longError);
    expect(result.length).toBeLessThanOrEqual(100);
  });

  it('QA #8: special characters in error string are preserved (sanitize handles)', () => {
    const { extractIssueTitle } = loadPostEdit();
    const result = extractIssueTitle('Error: it\'s "broken" & <bad>');
    expect(result).toBe('it\'s "broken" & <bad>');
  });
});

describe('post-edit.js — QA #2: handleIssueLifecycle', () => {
  function loadDb() {
    delete require.cache[require.resolve('../../src/engine/db')];
    delete require.cache[require.resolve('../../src/engine/sanitize')];
    delete require.cache[require.resolve('../../src/engine/debug-log')];
    return require('../../src/engine/db');
  }

  function loadPostEditModule() {
    delete require.cache[require.resolve('../../src/hooks/post-edit')];
    delete require.cache[require.resolve('../../src/engine/line-resolver')];
    delete require.cache[require.resolve('../../src/engine/protection')];
    delete require.cache[require.resolve('../../src/engine/blame-cache')];
    delete require.cache[require.resolve('../../src/engine/debug-log')];
    delete require.cache[require.resolve('../../src/engine/db')];
    delete require.cache[require.resolve('../../src/engine/sanitize')];
    return require('../../src/hooks/post-edit');
  }

  let dbTmpDir;
  beforeEach(() => {
    dbTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-pe-issue-'));
    process.env.CLAUDE_PLUGIN_DATA = dbTmpDir;
  });
  afterEach(() => {
    try { require('../../src/engine/db').closeDb(); } catch { /* cleanup */ }
    delete require.cache[require.resolve('../../src/engine/db')];
    delete require.cache[require.resolve('../../src/engine/sanitize')];
    delete require.cache[require.resolve('../../src/engine/debug-log')];
    delete require.cache[require.resolve('../../src/hooks/post-edit')];
    delete require.cache[require.resolve('../../src/engine/line-resolver')];
    delete require.cache[require.resolve('../../src/engine/protection')];
    delete require.cache[require.resolve('../../src/engine/blame-cache')];
    delete process.env.CLAUDE_PLUGIN_DATA;
    try { fs.rmSync(dbTmpDir, { recursive: true, force: true }); } catch { /* Windows */ }
  });

  it('creates new issue from recent error and links change', () => {
    const db = loadDb();
    const proxy = db.getDb('/test/project');
    proxy.insertSession('s1');
    proxy.insertErrorOutput({ error_string: 'Error: OAuth token expired', error_hash: 'abc', session_id: 's1' });
    const changeId = proxy.insertChange({ file: 'auth.js', session_id: 's1' });

    const { handleIssueLifecycle } = loadPostEditModule();
    const issueId = handleIssueLifecycle(proxy, 's1', 'auth.js', changeId);
    expect(issueId).not.toBeNull();

    const issues = proxy.getIssues({ status: 'open' });
    const created = issues.find(i => i.title === 'OAuth token expired');
    expect(created).toBeDefined();
    expect(Number(created.fix_change_id)).toBe(Number(changeId));
  });

  it('links change to existing open issue with same title', () => {
    const db = loadDb();
    const proxy = db.getDb('/test/project');
    proxy.insertSession('s1');
    const existingIssueId = proxy.insertIssue({ title: 'OAuth token expired', status: 'open' });
    proxy.insertErrorOutput({ error_string: 'Error: OAuth token expired', error_hash: 'abc', session_id: 's1' });
    const changeId = proxy.insertChange({ file: 'auth.js', session_id: 's1' });

    const { handleIssueLifecycle } = loadPostEditModule();
    const issueId = handleIssueLifecycle(proxy, 's1', 'auth.js', changeId);
    expect(Number(issueId)).toBe(Number(existingIssueId));
  });

  it('returns null when no recent errors', () => {
    const db = loadDb();
    const proxy = db.getDb('/test/project');
    proxy.insertSession('s1');
    const changeId = proxy.insertChange({ file: 'auth.js', session_id: 's1' });

    const { handleIssueLifecycle } = loadPostEditModule();
    expect(handleIssueLifecycle(proxy, 's1', 'auth.js', changeId)).toBeNull();
  });
});

describe('post-edit.js — tool_use_id from hook input', () => {
  it('uses input.tool_use_id directly as the change anchor (no transcript needed)', () => {
    ensureSession();
    runPostEdit({
      cwd: projectDir,
      tool_name: 'Edit',
      tool_input: { file_path: '/project/direct.js', old_string: 'a', new_string: 'b' },
      tool_response: {},
      tool_use_id: 'toolu_direct_payload_1',
    });
    const changes = getChanges();
    expect(changes).toHaveLength(1);
    expect(changes[0].tool_use_id).toBe('toolu_direct_payload_1');
  });
});

describe('post-edit.js — Write tool payload (content field)', () => {
  it('records description from content so Write edits are visible to embedding/FTS/diff-match', () => {
    ensureSession();
    runPostEdit({
      cwd: projectDir,
      session_id: 'test-session',
      tool_name: 'Write',
      tool_input: { file_path: '/project/w.js', content: 'const freshlyWritten = 42;' },
      tool_response: {},
      tool_use_id: 'toolu_write_content_1',
    });
    const changes = getChanges();
    expect(changes).toHaveLength(1);
    expect(changes[0].description).toContain('const freshlyWritten = 42;');
  });
});

describe('post-edit.js — session attribution (g2)', () => {
  it('attributes the change to the payload session_id, not the newest session', () => {
    ensureSession(); // 'test-session'
    withDb((proxy) => proxy.insertSession('newer-concurrent-session'));
    runPostEdit({
      cwd: projectDir,
      session_id: 'test-session',
      tool_name: 'Edit',
      tool_input: { file_path: '/project/attr.js', old_string: 'a', new_string: 'b' },
      tool_response: {},
      tool_use_id: 'toolu_attr_1',
    });
    const changes = getChanges();
    expect(changes).toHaveLength(1);
    expect(changes[0].session_id).toBe('test-session');
  });
});

describe('post-edit.js — duplicate tool_use_id (backfill collision)', () => {
  it('reuses the already-imported row instead of inserting a NULL-anchor duplicate', () => {
    ensureSession();
    withDb((proxy) => proxy.insertChange({
      file: '/project/dup.js', session_id: 'test-session', action: 'Edit',
      tool_use_id: 'toolu_dup_1', source: 'transcript_backfill',
    }));
    runPostEdit({
      cwd: projectDir,
      session_id: 'test-session',
      tool_name: 'Edit',
      tool_input: { file_path: '/project/dup.js', old_string: 'a', new_string: 'b' },
      tool_response: {},
      tool_use_id: 'toolu_dup_1',
    });
    const changes = getChanges();
    expect(changes).toHaveLength(1); // no second row
    expect(changes[0].tool_use_id).toBe('toolu_dup_1');
  });
});
