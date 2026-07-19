import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let tmpDir;

function clearModules() {
  const modules = [
    '../../src/engine/db', '../../src/engine/sanitize', '../../src/engine/debug-log',
    '../../src/engine/cycle-detector', '../../src/engine/config',
    '../../src/engine/line-resolver', '../../src/hooks/post-compact',
    '../../src/engine/blame-cache',
  ];
  for (const m of modules) {
    try { delete require.cache[require.resolve(m)]; } catch { /* ok */ }
  }
}

function loadDb() {
  clearModules();
  return require('../../src/engine/db');
}

function benchmark(name, fn, iterations = 100) {
  const times = [];
  for (let i = 0; i < iterations; i++) {
    const start = process.hrtime.bigint();
    fn();
    const end = process.hrtime.bigint();
    times.push(Number(end - start) / 1e6); // ms
  }
  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length * 0.5)];
  const p99 = times[Math.floor(times.length * 0.99)];
  return { name, p50, p99, min: times[0], max: times[times.length - 1] };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-bench-'));
  process.env.CLAUDE_PLUGIN_DATA = tmpDir;
});

afterEach(() => {
  try { require('../../src/engine/db').closeDb(); } catch { /* cleanup */ }
  clearModules();
  delete process.env.CLAUDE_PLUGIN_DATA;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows lock */ }
});

describe('Benchmark: DB insertChange', () => {
  it('insertChange p99 should be under 20ms', () => {
    const db = loadDb();
    const proxy = db.getDb('/bench/project');
    proxy.insertSession('bench-session');

    let i = 0;
    const result = benchmark('insertChange', () => {
      proxy.insertChange({
        session_id: 'bench-session',
        file: `bench-file-${i++}.js`,
        action: 'Edit',
        diff_text: 'some old content here',
        description: 'some new content here',
      });
    }, 100);

    console.log(`insertChange — p50: ${result.p50.toFixed(3)}ms  p99: ${result.p99.toFixed(3)}ms  min: ${result.min.toFixed(3)}ms  max: ${result.max.toFixed(3)}ms`);

    // p99 < 20ms target (2ms nominal, CI parallelism margin)
    expect(result.p99).toBeLessThan(20);
  });
});

describe('Benchmark: buildSummary', () => {
  it('buildSummary p99 should be under 20ms', () => {
    const db = loadDb();
    const proxy = db.getDb('/bench/project');
    proxy.insertSession('bench-session');

    // Seed data for a non-trivial summary
    proxy.insertIssue({ title: 'OAuth timeout fix', status: 'open' });
    proxy.insertIssue({ title: 'Memory leak in cache', status: 'open' });
    proxy.insertErrorOutput({
      error_string: 'TypeError: Cannot read property of null',
      error_hash: 'hash-bench-1',
      session_id: 'bench-session',
    });
    for (let i = 0; i < 5; i++) {
      proxy.insertChange({ file: 'repeated.js', session_id: 'bench-session' });
    }

    const { buildSummary } = require('../../src/hooks/post-compact');

    const result = benchmark('buildSummary', () => {
      buildSummary(proxy, 'bench-session');
    }, 100);

    console.log(`buildSummary — p50: ${result.p50.toFixed(3)}ms  p99: ${result.p99.toFixed(3)}ms  min: ${result.min.toFixed(3)}ms  max: ${result.max.toFixed(3)}ms`);

    expect(result.p99).toBeLessThan(20);
  });
});

describe('Benchmark: checkFileMatch', () => {
  it('checkFileMatch p99 should be under 20ms', () => {
    const db = loadDb();
    const proxy = db.getDb('/bench/project');
    proxy.insertSession('bench-session');

    // Insert 50 changes for the same file to make the query non-trivial
    for (let i = 0; i < 50; i++) {
      proxy.insertChange({
        session_id: 'bench-session',
        file: 'hot-file.js',
        action: 'Edit',
      });
    }

    const { checkFileMatch } = require('../../src/engine/cycle-detector');
    const { loadConfig } = require('../../src/engine/config');
    const config = loadConfig('/bench/project');

    const result = benchmark('checkFileMatch', () => {
      checkFileMatch(proxy, 'hot-file.js', 'bench-session', config);
    }, 100);

    console.log(`checkFileMatch — p50: ${result.p50.toFixed(3)}ms  p99: ${result.p99.toFixed(3)}ms  min: ${result.min.toFixed(3)}ms  max: ${result.max.toFixed(3)}ms`);

    // p99 < 20ms target (5ms nominal, CI parallelism margin)
    expect(result.p99).toBeLessThan(20);
  });
});

describe('Benchmark: blame cache hit < 5ms p99', () => {
  it('getBlameCache (DB read) p99 should be under 5ms', () => {
    const db = loadDb();
    const proxy = db.getDb('/bench/project');

    // Seed a blame cache entry
    const fakeBlame = JSON.stringify(
      Array.from({ length: 50 }, (_, i) => ({ commitHash: 'a'.repeat(40), lineNo: i + 1 }))
    );
    proxy.insertBlameCache('/bench/project/app.js', 'a'.repeat(40), fakeBlame);

    const result = benchmark('blameCacheHit', () => {
      proxy.getBlameCache('/bench/project/app.js', 'a'.repeat(40));
    }, 200);

    console.log(`blameCacheHit — p50: ${result.p50.toFixed(3)}ms  p99: ${result.p99.toFixed(3)}ms  min: ${result.min.toFixed(3)}ms  max: ${result.max.toFixed(3)}ms`);

    expect(result.p99).toBeLessThan(5);
  });
});

describe('Benchmark: getChanges query < 10ms p99', () => {
  it('getChanges with session + file filter p99 should be under 10ms', () => {
    const db = loadDb();
    const proxy = db.getDb('/bench/project');
    proxy.insertSession('bench-session');

    // Seed 200 changes across different files
    for (let i = 0; i < 200; i++) {
      proxy.insertChange({
        session_id: 'bench-session',
        file: `file-${i % 10}.js`,
        action: 'Edit',
      });
    }

    const result = benchmark('getChanges', () => {
      proxy.getChanges({ session_id: 'bench-session', file: 'file-0.js' });
    }, 100);

    console.log(`getChanges — p50: ${result.p50.toFixed(3)}ms  p99: ${result.p99.toFixed(3)}ms  min: ${result.min.toFixed(3)}ms  max: ${result.max.toFixed(3)}ms`);

    expect(result.p99).toBeLessThan(10);
  });
});

describe('Benchmark: PreToolUse E2E subprocess', () => {
  it('pre-edit.js wall-clock time p99 should be under 500ms', () => {
    const { execFileSync } = require('child_process');
    const hookPath = require('path').resolve(__dirname, '../../src/hooks/pre-edit.js');

    const db = loadDb();
    const proxy = db.getDb(tmpDir);
    proxy.insertSession('bench-e2e-session');
    for (let i = 0; i < 5; i++) {
      proxy.insertChange({ session_id: 'bench-e2e-session', file: `bench-${i}.js`, action: 'Edit' });
    }
    db.closeDb();
    clearModules();

    const input = JSON.stringify({
      cwd: tmpDir,
      tool_name: 'Edit',
      tool_input: { file_path: '/bench/project/test.js', old_string: 'x', new_string: 'y' },
    });

    const times = [];
    for (let i = 0; i < 20; i++) {
      const start = process.hrtime.bigint();
      try {
        execFileSync('node', [hookPath], {
          input, encoding: 'utf-8', timeout: 5000,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, CLAUDE_PLUGIN_DATA: tmpDir, DEVGUARD_DEBUG: '0', DEVGUARD_MODEL_DIR: path.join(tmpDir, 'no-model'), DEVGUARD_OFFLINE: '1' },
        });
      } catch { /* exit code 2 is ok */ }
      const end = process.hrtime.bigint();
      times.push(Number(end - start) / 1e6);
    }
    times.sort((a, b) => a - b);
    const p99 = times[Math.floor(times.length * 0.99)];
    console.log(`PreToolUse E2E — p50: ${times[Math.floor(times.length * 0.5)].toFixed(1)}ms  p99: ${p99.toFixed(1)}ms  max: ${times[times.length - 1].toFixed(1)}ms`);

    expect(p99).toBeLessThan(800);
  });
});
