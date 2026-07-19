import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const PRE_EDIT_PATH = path.resolve(__dirname, '../../src/hooks/pre-edit.js');
const POST_EDIT_PATH = path.resolve(__dirname, '../../src/hooks/post-edit.js');
const POST_COMMAND_PATH = path.resolve(__dirname, '../../src/hooks/post-command.js');

let tmpDir;
let projectDir;

function loadModules() {
  delete require.cache[require.resolve('../../src/engine/db')];
  delete require.cache[require.resolve('../../src/engine/sanitize')];
  delete require.cache[require.resolve('../../src/engine/debug-log')];
  delete require.cache[require.resolve('../../src/engine/cycle-detector')];
  delete require.cache[require.resolve('../../src/engine/config')];
  return {
    db: require('../../src/engine/db'),
    cd: require('../../src/engine/cycle-detector'),
    config: require('../../src/engine/config'),
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-integ-'));
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-project-'));
  process.env.CLAUDE_PLUGIN_DATA = tmpDir;
});

afterEach(() => {
  try { require('../../src/engine/db').closeDb(); } catch { /* cleanup */ }
  delete require.cache[require.resolve('../../src/engine/db')];
  delete require.cache[require.resolve('../../src/engine/sanitize')];
  delete require.cache[require.resolve('../../src/engine/debug-log')];
  delete require.cache[require.resolve('../../src/engine/cycle-detector')];
  delete require.cache[require.resolve('../../src/engine/config')];
  delete process.env.CLAUDE_PLUGIN_DATA;
  for (const dir of [tmpDir, projectDir]) {
    if (dir && fs.existsSync(dir)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
  }
});

const DEFAULT_CONFIG = {
  similarity_threshold: 0.85,
  window_size: 10,
  min_occurrences: 2,
  block_threshold: 3,
  cooldown_actions: 5,
  max_entries: 10000,
};

describe('Integration: Scenario 1 — 3x same diff + same error', () => {
  it('error_hash + diff_match both warn after 3 identical edits + errors', () => {
    const { db, cd } = loadModules();
    const proxy = db.getDb(projectDir);
    proxy.insertSession('sess-1');

    for (let i = 0; i < 3; i++) {
      proxy.insertChange({ file: 'app.js', session_id: 'sess-1', diff_text: 'const x = broken();' });
      proxy.insertErrorOutput({ error_string: 'TypeError: broken is not a function', error_hash: 'hash-broken', session_id: 'sess-1' });
    }

    const errorResult = cd.checkErrorHash(proxy, 'sess-1', DEFAULT_CONFIG);
    expect(errorResult.decision).toBe('warn');
    expect(errorResult.matches).toHaveLength(3);

    const diffResult = cd.checkDiffMatch(proxy, 'const x = broken();', 'sess-1', DEFAULT_CONFIG);
    expect(diffResult.decision).toBe('warn');
    expect(diffResult.matches).toHaveLength(3);
  });
});

describe('Integration: Scenario 2 — different files, same error', () => {
  it('error hash match triggers even when file is new', () => {
    const { db, cd } = loadModules();
    const proxy = db.getDb(projectDir);
    proxy.insertSession('sess-1');

    proxy.insertChange({ file: 'a.js', session_id: 'sess-1' });
    proxy.insertChange({ file: 'b.js', session_id: 'sess-1' });
    proxy.insertChange({ file: 'c.js', session_id: 'sess-1' });

    for (let i = 0; i < 3; i++) {
      proxy.insertErrorOutput({ error_string: 'ECONNREFUSED', error_hash: 'hash-conn', session_id: 'sess-1' });
    }

    const errorResult = cd.checkErrorHash(proxy, 'sess-1', DEFAULT_CONFIG);
    expect(errorResult.decision).toBe('warn');
  });
});

describe('Integration: Scenario 3 — same file, different errors → silent (file_match removed)', () => {
  it('no warning when only "same file" signal exists (file_match removed v0.2.2)', () => {
    const { db, cd } = loadModules();
    const proxy = db.getDb(projectDir);
    proxy.insertSession('sess-1');

    for (let i = 0; i < 3; i++) {
      proxy.insertChange({ file: 'app.js', session_id: 'sess-1' });
      proxy.insertErrorOutput({ error_string: `error-${i}`, error_hash: `hash-${i}`, session_id: 'sess-1' });
    }

    // Latest error hash is 'hash-2' (appeared once) → skip
    const errorResult = cd.checkErrorHash(proxy, 'sess-1', DEFAULT_CONFIG);
    expect(errorResult.decision).toBe('skip');
    // file_match removed → no other warn signal
  });
});

describe('Integration: Scenario 4 — diff match verification', () => {
  it('identical diff_text entries produce similarity 1.0 and trigger match', () => {
    const { db, cd } = loadModules();
    const proxy = db.getDb(projectDir);
    proxy.insertSession('sess-1');

    const code = 'const value = getData();\nreturn value.map(x => x.id);';
    proxy.insertChange({ file: 'a.js', session_id: 'sess-1', diff_text: code });
    proxy.insertChange({ file: 'b.js', session_id: 'sess-1', diff_text: code });

    const sim = cd.jaccardSimilarity(code, code);
    expect(sim).toBe(1.0);

    const result = cd.checkDiffMatch(proxy, code, 'sess-1', DEFAULT_CONFIG);
    expect(result.decision).toBe('warn');
    expect(result.matches).toHaveLength(2);
    expect(result.matches[0].similarity).toBe(1.0);
  });

  it('slightly different diffs still match above threshold', () => {
    const { db, cd } = loadModules();
    const proxy = db.getDb(projectDir);
    proxy.insertSession('sess-1');

    // 1 token differs out of ~14 unique → Jaccard ~0.87
    const code1 = 'const value = getData() let result = value.map(x => x.id) if (result.length > 0) console.log(value)';
    const code2 = 'const value = getData() let result = value.map(x => x.id) if (result.length > 0) console.log(output)';

    const sim = cd.jaccardSimilarity(code1, code2);
    expect(sim).toBeGreaterThan(0.85);

    proxy.insertChange({ file: 'a.js', session_id: 'sess-1', diff_text: code1 });
    proxy.insertChange({ file: 'b.js', session_id: 'sess-1', diff_text: code1 });

    const result = cd.checkDiffMatch(proxy, code2, 'sess-1', DEFAULT_CONFIG);
    expect(result.decision).toBe('warn');
  });
});

describe('Integration: Scenario 5 — end-to-end hook smoke test', () => {
  function runHook(hookPath, inputObj) {
    const input = JSON.stringify(inputObj);
    try {
      const stdout = execFileSync('node', [hookPath], {
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

  it('full cycle: post-edit × 3 + post-command × 3 → pre-edit blocks', () => {
    // First, create a session
    const { db } = loadModules();
    const proxy = db.getDb(projectDir);
    proxy.insertSession('integration-sess');
    db.closeDb();

    // Simulate 3 rounds of edit + error
    for (let i = 0; i < 3; i++) {
      // post-edit records the change
      runHook(POST_EDIT_PATH, {
        cwd: projectDir,
        tool_name: 'Edit',
        tool_input: {
          file_path: '/project/app.js',
          old_string: 'const x = broken();',
          new_string: `const x = fix_attempt_${i}();`,
        },
        tool_response: {},
      });

      // post-command records the error
      runHook(POST_COMMAND_PATH, {
        cwd: projectDir,
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        tool_response: {
          exitCode: 1,
          stderr: 'TypeError: broken is not a function',
          stdout: '',
        },
      });
    }

    // Verify DB state
    const { db: db2 } = loadModules();
    const proxy2 = db2.getDb(projectDir);
    expect(proxy2.getChanges()).toHaveLength(3);
    expect(proxy2.getErrorOutputs()).toHaveLength(3);
    db2.closeDb();

    // Now pre-edit should detect the cycle
    const result = runHook(PRE_EDIT_PATH, {
      cwd: projectDir,
      tool_name: 'Edit',
      tool_input: {
        file_path: '/project/app.js',
        old_string: 'const x = broken();',
        new_string: 'const x = another_attempt();',
      },
    });

    // DevGuard never blocks — should warn (exit 0 + additionalContext)
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput?.additionalContext).toBeDefined();
    expect(output.hookSpecificOutput.additionalContext).toContain('DevGuard');
  });

  it('no cycle when files and errors are all different', () => {
    const { db } = loadModules();
    const proxy = db.getDb(projectDir);
    proxy.insertSession('integration-sess');
    db.closeDb();

    // 3 different files, 3 different errors
    for (let i = 0; i < 3; i++) {
      runHook(POST_EDIT_PATH, {
        cwd: projectDir,
        tool_name: 'Edit',
        tool_input: {
          file_path: `/project/file${i}.js`,
          old_string: `old-${i}`,
          new_string: `new-${i}`,
        },
        tool_response: {},
      });
      runHook(POST_COMMAND_PATH, {
        cwd: projectDir,
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        tool_response: {
          exitCode: 1,
          stderr: `Error type ${i}: unique-${i}`,
          stdout: '',
        },
      });
    }

    // pre-edit for a new file with new content → should allow
    const result = runHook(PRE_EDIT_PATH, {
      cwd: projectDir,
      tool_name: 'Edit',
      tool_input: {
        file_path: '/project/brand-new.js',
        old_string: 'completely different',
        new_string: 'something else',
      },
    });

    expect(result.exitCode).toBe(0);
  });

  it('path exclusion: edit on .claude/ file does NOT create change in DB', () => {
    const { db } = loadModules();
    const proxy = db.getDb(projectDir);
    proxy.insertSession('exclude-sess');
    db.closeDb();

    // post-edit a file inside .claude/ directory — should be skipped entirely
    const excludedFile = path.join(projectDir, '.claude', 'settings.local.json').replace(/\\/g, '/');
    runHook(POST_EDIT_PATH, {
      cwd: projectDir,
      tool_name: 'Edit',
      tool_input: {
        file_path: excludedFile,
        old_string: 'old-config',
        new_string: 'new-config',
      },
      tool_response: {},
    });

    // Also attempt a real-code edit to confirm normal flow still works
    const realFile = path.join(projectDir, 'src', 'app.js').replace(/\\/g, '/');
    runHook(POST_EDIT_PATH, {
      cwd: projectDir,
      tool_name: 'Edit',
      tool_input: {
        file_path: realFile,
        old_string: 'old',
        new_string: 'new',
      },
      tool_response: {},
    });

    // DB should have exactly 1 change — the real-code one, not the .claude/ one
    const { db: db2 } = loadModules();
    const proxy2 = db2.getDb(projectDir);
    const allChanges = proxy2.getChanges();
    expect(allChanges).toHaveLength(1);
    expect(allChanges[0].file).toContain('src/app.js');
    db2.closeDb();
  });

  it('cooldown: consecutive identical-diff edits do not flood detection_log', { timeout: 60000 }, () => {
    // After v0.2.2 (file_match removed), use diff_match repetition to trigger the cooldown path.
    const { db } = loadModules();
    const proxy = db.getDb(projectDir);
    proxy.insertSession('flood-sess');
    db.closeDb();

    const appFile = path.join(projectDir, 'Component.tsx').replace(/\\/g, '/');
    const repeat = 'function bug() { return retry(timeout); }';

    // 7 consecutive edit cycles (post-edit → pre-edit) with same diff body
    for (let i = 0; i < 7; i++) {
      runHook(POST_EDIT_PATH, {
        cwd: projectDir,
        tool_name: 'Edit',
        tool_input: {
          file_path: appFile,
          old_string: repeat,
          new_string: `new-${i}`,
        },
        tool_response: {},
      });
      if (i < 6) {
        const start = Date.now();
        while (Date.now() - start < 1100) { /* wait */ }
      }
      runHook(PRE_EDIT_PATH, {
        cwd: projectDir,
        tool_name: 'Edit',
        tool_input: {
          file_path: appFile,
          old_string: repeat,
          new_string: `next-${i}`,
        },
      });
    }

    // With cooldown=3 default: diff_match warn fires at ~edits 1, 4, 7
    const { db: db2 } = loadModules();
    const proxy2 = db2.getDb(projectDir);
    const allDetections = proxy2.getDetections({ session_id: 'flood-sess' });
    const diffEntries = allDetections.filter(d => d.middleware_id === 'cycle:diff_match');
    db2.closeDb();
    expect(diffEntries.length).toBeLessThanOrEqual(4);
    expect(diffEntries.length).toBeGreaterThanOrEqual(1);
  });

  it('path exclusion: pre-edit on MEMORY.md returns allow without running pipeline', () => {
    const { db } = loadModules();
    const proxy = db.getDb(projectDir);
    proxy.insertSession('mem-sess');
    // Pre-seed 5 edits on MEMORY.md-looking file (but hook should skip before reading DB)
    for (let i = 0; i < 5; i++) {
      proxy.insertChange({ file: '/project/MEMORY.md', session_id: 'mem-sess' });
    }
    db.closeDb();

    const result = runHook(PRE_EDIT_PATH, {
      cwd: projectDir,
      tool_name: 'Edit',
      tool_input: {
        file_path: '/project/MEMORY.md',
        old_string: 'a',
        new_string: 'b',
      },
    });

    // No warn context — response should be empty {}
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput).toBeUndefined();
  });
});
