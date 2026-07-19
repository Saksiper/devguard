import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const HOOK_PATH = path.resolve(__dirname, '../../src/hooks/session-start.js');

let tmpDir;
let projectDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-session-test-'));
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-project-'));
});

afterEach(() => {
  for (const dir of [tmpDir, projectDir]) {
    if (dir && fs.existsSync(dir)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
  }
});

function runSessionStart(cwd, pluginData, sessionId) {
  const payload = { cwd: cwd || projectDir };
  if (sessionId) payload.session_id = sessionId;
  const input = JSON.stringify(payload);
  try {
    const stdout = execFileSync('node', [HOOK_PATH], {
      input,
      encoding: 'utf-8',
      timeout: 20000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: pluginData || tmpDir,
        DEVGUARD_DEBUG: '0',
      },
    });
    return { stdout, exitCode: 0 };
  } catch (err) {
    return { stdout: err.stdout || '', stderr: err.stderr || '', exitCode: err.status };
  }
}

function loadDb() {
  delete require.cache[require.resolve('../../src/engine/db')];
  delete require.cache[require.resolve('../../src/engine/sanitize')];
  delete require.cache[require.resolve('../../src/engine/debug-log')];
  return require('../../src/engine/db');
}

describe('session-start.js', () => {
  it('creates a session record in DB', () => {
    const result = runSessionStart();
    expect(result.exitCode).toBe(0);

    process.env.CLAUDE_PLUGIN_DATA = tmpDir;
    const db = loadDb();
    const proxy = db.getDb(projectDir);
    const session = proxy.getLatestSession();
    expect(session).not.toBeNull();
    expect(session.session_id).toMatch(/^[0-9a-f]{8}-/);
    expect(session.project_path).toBe(projectDir.replace(/\\/g, '/'));
    db.closeDb();
    delete process.env.CLAUDE_PLUGIN_DATA;
  });

  it('uses input.session_id from Claude Code when provided', () => {
    const realSid = 'e439d9d0-35c4-45f1-a7a3-cafbd6537071';
    const result = runSessionStart(undefined, undefined, realSid);
    expect(result.exitCode).toBe(0);

    process.env.CLAUDE_PLUGIN_DATA = tmpDir;
    const db = loadDb();
    const proxy = db.getDb(projectDir);
    const session = proxy.getLatestSession();
    expect(session.session_id).toBe(realSid);
    db.closeDb();
    delete process.env.CLAUDE_PLUGIN_DATA;
  });

  it('shows onboarding message on first session', () => {
    const result = runSessionStart();
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput).toBeDefined();
    expect(output.hookSpecificOutput.additionalContext).toContain('DevGuard active. Cycle detection and protection monitoring enabled.');
  });

  it('does not show onboarding on second session', () => {
    runSessionStart();
    const result2 = runSessionStart();
    expect(result2.exitCode).toBe(0);
    const output = JSON.parse(result2.stdout);
    const hasOnboarding = output.hookSpecificOutput?.additionalContext?.includes('DevGuard active');
    expect(hasOnboarding).toBeFalsy();
  });

  it('suppresses onboarding banner when intervention is disabled (passive A/B control arm)', () => {
    // In the passive/control arm the banner would tell Claude it is being watched
    // (Hawthorne effect) and contaminate the A/B comparison. It must stay silent.
    fs.writeFileSync(path.join(projectDir, 'devguard.config.yaml'), 'intervention_enabled: false\n');
    const result = runSessionStart();
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    const hasOnboarding = output.hookSpecificOutput?.additionalContext?.includes('DevGuard active');
    expect(hasOnboarding).toBeFalsy();
  });

  it.skipIf(process.platform !== 'win32')('does NOT clean a project whose drive root is unreachable', () => {
    // An unplugged USB drive / disconnected network share must not look like a
    // deleted project — that would silently wipe the project's entire history.
    const ghostRoot = ['Q', 'R', 'T', 'V', 'W', 'X', 'Y', 'Z']
      .map((l) => `${l}:/`).find((r) => !fs.existsSync(r));
    expect(ghostRoot).toBeTruthy(); // all 8 letters mapped would be a bizarre machine
    const ghostProject = `${ghostRoot}devguard-ghost/proj`;

    runSessionStart(ghostProject);
    runSessionStart(projectDir);

    process.env.CLAUDE_PLUGIN_DATA = tmpDir;
    const db = loadDb();
    const proxy = db.getDb(ghostProject);
    expect(proxy.getLatestSession()).not.toBeNull();
    db.closeDb();
    delete process.env.CLAUDE_PLUGIN_DATA;
  });

  it('cleans up orphan projects (deleted directories)', () => {
    // Create a session for a project that will be deleted
    const orphanDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-orphan-'));
    runSessionStart(orphanDir);

    // Delete the orphan directory
    fs.rmSync(orphanDir, { recursive: true, force: true });

    // Run session-start for the real project — orphan should be cleaned
    runSessionStart(projectDir);

    process.env.CLAUDE_PLUGIN_DATA = tmpDir;
    const db = loadDb();
    const proxy = db.getDb(orphanDir);
    expect(proxy.getLatestSession()).toBeNull();
    db.closeDb();
    delete process.env.CLAUDE_PLUGIN_DATA;
  });

  it('cleans old blame cache entries', () => {
    // First run creates DB
    runSessionStart();

    // Insert an old blame cache entry directly
    process.env.CLAUDE_PLUGIN_DATA = tmpDir;
    const db = loadDb();
    const raw = db.openDb();
    const normalizedProject = projectDir.replace(/\\/g, '/');
    raw.prepare(
      "INSERT INTO blame_cache (project_path, file_path, commit_hash, blame_data, created_at) VALUES (?, ?, ?, ?, datetime('now', '-10 days'))"
    ).run(normalizedProject, 'old.js', 'oldcommit', '{}');
    raw.prepare(
      "INSERT INTO blame_cache (project_path, file_path, commit_hash, blame_data) VALUES (?, ?, ?, ?)"
    ).run(normalizedProject, 'new.js', 'newcommit', '{}');
    db.closeDb();
    delete require.cache[require.resolve('../../src/engine/db')];
    delete process.env.CLAUDE_PLUGIN_DATA;

    // Run session-start again — should clean old entries
    runSessionStart();

    process.env.CLAUDE_PLUGIN_DATA = tmpDir;
    const db2 = loadDb();
    const proxy = db2.getDb(projectDir);
    expect(proxy.getBlameCache('old.js', 'oldcommit')).toBeNull();
    expect(proxy.getBlameCache('new.js', 'newcommit')).not.toBeNull();
    db2.closeDb();
    delete process.env.CLAUDE_PLUGIN_DATA;
  });

  it('gracefully handles DB errors (exits 0)', () => {
    // Use an invalid path for CLAUDE_PLUGIN_DATA
    const result = runSessionStart(projectDir, '/nonexistent/deeply/nested/path/that/should/fail');
    // Should not crash — graceful fail → exit 0
    expect(result.exitCode).toBe(0);
  });

  it('handles empty stdin {} (no cwd) — falls back to process.cwd()', () => {
    // Send empty JSON via stdin — session-start should use process.cwd() fallback
    const input = JSON.stringify({});
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
        },
      });
      const output = JSON.parse(stdout);
      // Should succeed (exit 0) and produce valid output
      expect(output).toBeDefined();
    } catch (err) {
      // Even if it errors, exit code should be 0 (graceful fail)
      expect(err.status).toBe(0);
    }

    // Verify a session was created with process.cwd() as project_path
    process.env.CLAUDE_PLUGIN_DATA = tmpDir;
    const db = loadDb();
    const cwd = process.cwd();
    const proxy = db.getDb(cwd);
    const session = proxy.getLatestSession();
    expect(session).not.toBeNull();
    expect(session.project_path).toBe(cwd.replace(/\\/g, '/'));
    db.closeDb();
    delete process.env.CLAUDE_PLUGIN_DATA;
  });
});
