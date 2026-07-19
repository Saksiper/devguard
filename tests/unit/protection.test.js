import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);

let tmpDir;

function loadDb() {
  delete require.cache[require.resolve('../../src/engine/db')];
  delete require.cache[require.resolve('../../src/engine/sanitize')];
  delete require.cache[require.resolve('../../src/engine/debug-log')];
  return require('../../src/engine/db');
}

function loadProtection() {
  delete require.cache[require.resolve('../../src/engine/protection')];
  delete require.cache[require.resolve('../../src/engine/blame-cache')];
  delete require.cache[require.resolve('../../src/engine/debug-log')];
  return require('../../src/engine/protection');
}

function freshDb() {
  const db = loadDb();
  const proxy = db.getDb('/test/project');
  proxy.insertSession('test-session');
  return proxy;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-prot-test-'));
  process.env.CLAUDE_PLUGIN_DATA = tmpDir;
});

afterEach(() => {
  try { require('../../src/engine/db').closeDb(); } catch { /* cleanup */ }
  delete require.cache[require.resolve('../../src/engine/db')];
  delete require.cache[require.resolve('../../src/engine/sanitize')];
  delete require.cache[require.resolve('../../src/engine/debug-log')];
  delete require.cache[require.resolve('../../src/engine/protection')];
  delete require.cache[require.resolve('../../src/engine/blame-cache')];
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows lock */ }
});

describe('protection.js — hasProtectedCommit', () => {
  it('returns true when file has protection', () => {
    const proxy = freshDb();
    const { hasProtectedCommit } = loadProtection();
    const issueId = proxy.insertIssue({ title: 'OAuth fix' });
    const changeId = proxy.insertChange({ file: 'auth.js' });
    proxy.insertProtectedZone({
      issue_id: issueId, change_id: changeId, file: 'auth.js',
      protected_commit: 'a'.repeat(40), temp_protection: 0,
    });
    expect(hasProtectedCommit(proxy, 'auth.js')).toBe(true);
  });

  it('returns false when no protection exists', () => {
    const proxy = freshDb();
    const { hasProtectedCommit } = loadProtection();
    expect(hasProtectedCommit(proxy, 'noprotect.js')).toBe(false);
  });

  it('returns true for temp protection too', () => {
    const proxy = freshDb();
    const { hasProtectedCommit } = loadProtection();
    const issueId = proxy.insertIssue({ title: 'fix' });
    const changeId = proxy.insertChange({ file: 'temp.js' });
    proxy.insertProtectedZone({
      issue_id: issueId, change_id: changeId, file: 'temp.js', temp_protection: 1,
    });
    expect(hasProtectedCommit(proxy, 'temp.js')).toBe(true);
  });
});

describe('protection.js — checkProtection (temp zones)', () => {
  it('detects temp protection overlap', () => {
    const proxy = freshDb();
    const { checkProtection } = loadProtection();
    const issueId = proxy.insertIssue({ title: 'MCP timeout fix' });
    const changeId = proxy.insertChange({ file: 'pipeline.ts' });
    proxy.insertProtectedZone({
      issue_id: issueId, change_id: changeId, file: 'pipeline.ts',
      temp_lines_start: 10, temp_lines_end: 20, temp_protection: 1,
      reason: 'cleanSpawnEnv eklendi',
    });

    const result = checkProtection(proxy, 'pipeline.ts', [{ start: 15, end: 18 }], '/test');
    expect(result).not.toBeNull();
    expect(result.hit).toBe(true);
    expect(result.zones).toHaveLength(1);
    expect(result.zones[0].temp).toBe(true);
    expect(result.message).toContain('WARNING');
    expect(result.message).toContain('MCP timeout fix');
  });

  it('returns null when no overlap with temp zone', () => {
    const proxy = freshDb();
    const { checkProtection } = loadProtection();
    const issueId = proxy.insertIssue({ title: 'fix' });
    const changeId = proxy.insertChange({ file: 'pipeline.ts' });
    proxy.insertProtectedZone({
      issue_id: issueId, change_id: changeId, file: 'pipeline.ts',
      temp_lines_start: 10, temp_lines_end: 20, temp_protection: 1,
    });

    const result = checkProtection(proxy, 'pipeline.ts', [{ start: 25, end: 30 }], '/test');
    expect(result).toBeNull();
  });

  it('returns null for empty lineRanges', () => {
    const proxy = freshDb();
    const { checkProtection } = loadProtection();
    expect(checkProtection(proxy, 'any.js', [], '/test')).toBeNull();
    expect(checkProtection(proxy, 'any.js', null, '/test')).toBeNull();
  });
});

describe('protection.js — createTempProtection', () => {
  it('creates temp protection record', () => {
    const proxy = freshDb();
    const { createTempProtection } = loadProtection();
    const issueId = proxy.insertIssue({ title: 'OAuth fix' });
    const changeId = proxy.insertChange({ file: 'auth.js' });

    const id = createTempProtection(proxy, {
      issueId, changeId, file: 'auth.js',
      startLine: 10, endLine: 20, reason: 'Token refresh eklendi',
    });
    expect(id).toBeGreaterThan(0);

    const temps = proxy.getTempProtectionsForFile('auth.js');
    expect(temps).toHaveLength(1);
    expect(temps[0].temp_lines_start).toBe(10);
    expect(temps[0].temp_lines_end).toBe(20);
    expect(temps[0].reason).toBe('Token refresh eklendi');
  });
});

describe('protection.js — promoteProtection', () => {
  it('promotes temp to permanent protection', () => {
    const proxy = freshDb();
    const { createTempProtection, promoteProtection } = loadProtection();
    const issueId = proxy.insertIssue({ title: 'fix' });
    const changeId = proxy.insertChange({ file: 'auth.js' });

    createTempProtection(proxy, {
      issueId, changeId, file: 'auth.js', startLine: 5, endLine: 15,
    });

    const commitHash = 'c'.repeat(40);
    const promoted = promoteProtection(proxy, commitHash, ['auth.js']);
    expect(promoted).toBe(1);

    const commits = proxy.getProtectedCommitsForFile('auth.js');
    expect(commits).toContain(commitHash);
    expect(proxy.getTempProtectionsForFile('auth.js')).toHaveLength(0);
  });
});

describe('protection.js — formatProtectionMessage', () => {
  it('includes issue title and commit hash in permanent message', () => {
    const proxy = freshDb();
    const { checkProtection, createTempProtection } = loadProtection();
    const issueId = proxy.insertIssue({ title: 'OAuth expired' });
    const changeId = proxy.insertChange({ file: 'auth.js' });

    createTempProtection(proxy, {
      issueId, changeId, file: 'auth.js', startLine: 10, endLine: 20,
    });

    const result = checkProtection(proxy, 'auth.js', [{ start: 12, end: 15 }], '/test');
    expect(result).not.toBeNull();
    expect(result.message).toContain('OAuth expired');
    expect(result.message).toContain('not yet committed');
  });
});

describe('protection.js — same-issue exemption', () => {
  it('skips protection when activeIssueId matches zone issue (temp)', () => {
    const proxy = freshDb();
    const { checkProtection, createTempProtection } = loadProtection();
    const issueId = proxy.insertIssue({ title: 'OAuth fix' });
    const changeId = proxy.insertChange({ file: 'auth.js' });

    createTempProtection(proxy, {
      issueId, changeId, file: 'auth.js', startLine: 10, endLine: 20,
    });

    const result = checkProtection(proxy, 'auth.js', [{ start: 12, end: 15 }], '/test', issueId);
    expect(result).toBeNull();
  });

  it('warns when activeIssueId is different from zone issue (temp)', () => {
    const proxy = freshDb();
    const { checkProtection, createTempProtection } = loadProtection();
    const issueA = proxy.insertIssue({ title: 'OAuth fix' });
    const issueB = proxy.insertIssue({ title: 'MCP timeout' });
    const changeId = proxy.insertChange({ file: 'auth.js' });

    createTempProtection(proxy, {
      issueId: issueA, changeId, file: 'auth.js', startLine: 10, endLine: 20,
    });

    const result = checkProtection(proxy, 'auth.js', [{ start: 12, end: 15 }], '/test', issueB);
    expect(result).not.toBeNull();
    expect(result.hit).toBe(true);
  });

  it('warns when no activeIssueId provided (null)', () => {
    const proxy = freshDb();
    const { checkProtection, createTempProtection } = loadProtection();
    const issueId = proxy.insertIssue({ title: 'OAuth fix' });
    const changeId = proxy.insertChange({ file: 'auth.js' });

    createTempProtection(proxy, {
      issueId, changeId, file: 'auth.js', startLine: 10, endLine: 20,
    });

    const result = checkProtection(proxy, 'auth.js', [{ start: 12, end: 15 }], '/test', null);
    expect(result).not.toBeNull();
    expect(result.hit).toBe(true);
  });
});
