import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const statsPath = path.resolve(__dirname, '../../src/cli/stats.js');

let tmpDir;

function loadDb() {
  delete require.cache[require.resolve('../../src/engine/db')];
  delete require.cache[require.resolve('../../src/engine/sanitize')];
  delete require.cache[require.resolve('../../src/engine/debug-log')];
  return require('../../src/engine/db');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-stats-test-'));
  process.env.CLAUDE_PLUGIN_DATA = tmpDir;
});

afterEach(() => {
  try {
    const db = require('../../src/engine/db');
    db.closeDb();
  } catch { /* cleanup */ }
  delete require.cache[require.resolve('../../src/engine/db')];
  delete require.cache[require.resolve('../../src/engine/sanitize')];
  delete require.cache[require.resolve('../../src/engine/debug-log')];
  delete process.env.CLAUDE_PLUGIN_DATA;
  if (tmpDir && fs.existsSync(tmpDir)) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Windows: WAL/SHM files may still be locked briefly
    }
  }
});

function runStats(args, env = {}) {
  try {
    const stdout = execFileSync('node', [statsPath, ...args], {
      encoding: 'utf-8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DEVGUARD_DEBUG: '0',
        CLAUDE_PLUGIN_DATA: tmpDir,
        ...env,
      },
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err) {
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      exitCode: err.status ?? 1,
    };
  }
}

describe('stats.js — argument validation', () => {
  it('exits with code 1 and outputs Usage: when --project is not provided', () => {
    const result = runStats([]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Usage:');
  });

  it('exits with code 1 when only --session is provided without --project', () => {
    const result = runStats(['--session']);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Usage:');
  });
});

describe('stats.js — empty DB', () => {
  it('outputs table with all zeros and does not crash', () => {
    // Initialize DB so stats.js can open it
    const db = loadDb();
    db.getDb(tmpDir);
    db.closeDb();

    const result = runStats(['--project', tmpDir]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('DevGuard Statistics');
    expect(result.stdout).toContain('| Session count');
    // All counts should be 0
    expect(result.stdout).toMatch(/Session count\s*\|\s*0/);
    expect(result.stdout).toMatch(/Total changes\s*\|\s*0/);
    expect(result.stdout).toMatch(/Active issues\s*\|\s*0/);
    expect(result.stdout).toMatch(/Protected zones\s*\|\s*0/);
  });
});

describe('stats.js — with data', () => {
  it('outputs correct counts in table format', () => {
    const db = loadDb();
    const proxy = db.getDb(tmpDir);

    proxy.insertSession('session-abc123');
    proxy.insertChange({ file: 'src/app.js', session_id: 'session-abc123', description: 'fix bug' });
    proxy.insertChange({ file: 'src/app.js', session_id: 'session-abc123', description: 'fix bug 2' });
    proxy.insertChange({ file: 'src/index.js', session_id: 'session-abc123', description: 'add feature' });
    proxy.insertIssue({ title: 'Auth bug', status: 'open' });
    proxy.insertIssue({ title: 'Closed issue', status: 'closed' });
    db.closeDb();

    const result = runStats(['--project', tmpDir]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('DevGuard Statistics');
    // 1 session
    expect(result.stdout).toMatch(/Session count\s*\|\s*1/);
    // 3 changes
    expect(result.stdout).toMatch(/Total changes\s*\|\s*3/);
    // 1 open issue
    expect(result.stdout).toMatch(/Active issues\s*\|\s*1/);
    // Top files section should appear
    expect(result.stdout).toContain('src/app.js');
  });

  it('shows open issues section when open issues exist', () => {
    const db = loadDb();
    const proxy = db.getDb(tmpDir);

    proxy.insertSession('session-issues');
    proxy.insertIssue({ title: 'Login fails', status: 'open' });
    proxy.insertIssue({ title: 'Memory leak', status: 'open' });
    db.closeDb();

    const result = runStats(['--project', tmpDir]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Active Issues');
    expect(result.stdout).toContain('Login fails');
    expect(result.stdout).toContain('Memory leak');
  });

  it('shows protected zones section when zones exist', () => {
    const db = loadDb();
    const proxy = db.getDb(tmpDir);

    proxy.insertSession('session-zones');
    const issueId = proxy.insertIssue({ title: 'Auth issue', status: 'open' });
    const changeId = proxy.insertChange({ file: 'auth.js', session_id: 'session-zones', description: 'fix' });
    proxy.insertProtectedZone({ issue_id: issueId, change_id: changeId, file: 'auth.js', reason: 'critical fix' });
    db.closeDb();

    const result = runStats(['--project', tmpDir]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Protected zones\s*\|\s*1/);
    expect(result.stdout).toContain('Protected Files');
    expect(result.stdout).toContain('auth.js');
  });
});

describe('stats.js — --session filter', () => {
  it('shows only current session data with --session flag', () => {
    const db = loadDb();
    const proxy = db.getDb(tmpDir);

    // Old session with many changes
    proxy.insertSession('old-session');
    for (let i = 0; i < 10; i++) {
      proxy.insertChange({ file: `old-file-${i}.js`, session_id: 'old-session', description: `old ${i}` });
    }

    // New session with 2 changes
    proxy.insertSession('new-session');
    proxy.insertChange({ file: 'new-file.js', session_id: 'new-session', description: 'new change' });
    proxy.insertChange({ file: 'new-file.js', session_id: 'new-session', description: 'new change 2' });
    db.closeDb();

    const result = runStats(['--project', tmpDir, '--session']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Latest Session');
    // Should show only 2 changes (current session), not 12
    expect(result.stdout).toMatch(/Total changes\s*\|\s*2/);
  });

  it('outputs message and exits cleanly when no session exists', () => {
    // Empty DB — no sessions
    const db = loadDb();
    db.getDb(tmpDir);
    db.closeDb();

    const result = runStats(['--project', tmpDir, '--session']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No active session found');
  });
});

describe('stats.js — Turkish characters', () => {
  it('handles Turkish characters in issue title without crash', () => {
    const db = loadDb();
    const proxy = db.getDb(tmpDir);

    proxy.insertSession('session-turkish');
    proxy.insertIssue({ title: 'Giriş sisteminde çökme sorunu — Türkçe karakterler', status: 'open' });
    db.closeDb();

    const result = runStats(['--project', tmpDir]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('DevGuard Statistics');
    expect(result.stdout).toContain('Active Issues');
  });
});
