'use strict';

const crypto = require('crypto');
const { execSync } = require('child_process');
const { readInput, respond } = require('../engine/hook-io');
const { debugLog, createTimer } = require('../engine/debug-log');
const { getDb, closeDb } = require('../engine/db');
const { sanitize } = require('../engine/sanitize');
const { promoteProtection } = require('../engine/protection');
const { flushAll } = require('../engine/blame-cache');
const { normalizePath } = require('../engine/normalize-path');
const { parseTestOutput } = require('../engine/test-parser');

const MAX_ERROR_LENGTH = 10240; // 10KB
const COMMIT_PATTERN = /\[[\w/.~@#-]+\s+([a-f0-9]{7,40})\]/;

function extractCommitHash(stdout) {
  if (!stdout) return null;
  const match = COMMIT_PATTERN.exec(stdout);
  return match ? match[1] : null;
}

function getCommittedFiles(shortHash, cwd) {
  try {
    const output = execSync(`git diff-tree --no-commit-id --name-only -r ${shortHash}`, {
      encoding: 'utf-8',
      cwd: cwd || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
    return output.trim().split('\n').filter(Boolean).map(f => normalizePath(f));
  } catch (err) {
    debugLog('post-command', 'Failed to get committed files', { error: String(err) });
    return [];
  }
}

function handleCommit(db, stdout, projectPath) {
  const shortHash = extractCommitHash(stdout);
  if (!shortHash) return;
  if (!/^[a-f0-9]{7,40}$/.test(shortHash)) return;

  debugLog('post-command', 'Commit detected', { hash: shortHash });

  try {
    const fullHash = execSync(`git rev-parse ${shortHash}`, {
      encoding: 'utf-8',
      cwd: projectPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    }).trim();

    if (!/^[a-f0-9]{40}$/.test(fullHash)) return;

    const files = getCommittedFiles(fullHash, projectPath);
    if (files.length > 0) {
      promoteProtection(db, fullHash, files);
    }
    flushAll(db);
    debugLog('post-command', 'Protection promoted, blame cache flushed', {
      hash: fullHash.substring(0, 7), fileCount: files.length,
    });
  } catch (err) {
    debugLog('post-command', 'Commit handling failed', { error: String(err) });
  }
}

function main() {
  const timer = createTimer('post-command');
  timer.start();

  try {
    const input = readInput();
    const { normalizeProjectPath } = require('../engine/normalize-path');
    const projectPath = normalizeProjectPath(input.cwd || process.cwd());
    // MEASURED (live, instrumented hook on both terminal and Desktop):
    //  - PostToolUse fires only on SUCCESS; payload is `input.tool_response`, an
    //    object {stdout, stderr, interrupted, …} with NO exit-code field.
    //  - PostToolUseFailure fires on a failed Bash command; the output is a STRING
    //    under `input.error` ("Exit code N\n<output>"), with `input.is_interrupt`
    //    true for a user Ctrl-C. There is NO tool_response/tool_output on failure.
    // The object tool_response/tool_output reads stay as defensive fallbacks.
    const eventName = input.hook_event_name;
    const raw = input.tool_response ?? input.tool_output ?? input.error ?? {};
    let exitCode; let stdout; let stderr;
    if (typeof raw === 'string') {
      const m = /^(?:Error:\s*)?Exit code (\d+)\r?\n?([\s\S]*)$/.exec(raw);
      exitCode = m ? Number(m[1]) : (eventName === 'PostToolUseFailure' || /^Error\b/.test(raw) ? 1 : 0);
      stdout = exitCode === 0 ? raw : '';
      stderr = exitCode === 0 ? '' : ((m && m[2]) || raw);
    } else {
      exitCode = raw.exitCode ?? raw.exit_code ?? (eventName === 'PostToolUseFailure' ? 1 : 0);
      stdout = raw.stdout || '';
      stderr = raw.stderr || '';
    }
    // A PostToolUseFailure invocation is a failure by definition, even if its
    // payload carries no parseable exit code — but a user interrupt (Ctrl-C) is
    // not a recurring error worth recording.
    const failed = (eventName === 'PostToolUseFailure' || exitCode !== 0) && !input.is_interrupt;

    if (!failed && stdout && extractCommitHash(stdout)) {
      const db = getDb(projectPath);
      handleCommit(db, stdout, projectPath);
      closeDb();
    }

    if (failed) {
      const combined = [stdout, stderr].join('\n').trim();
      if (combined) {
        const db = getDb(projectPath);
        // g2: payload session_id first; the newest row only as fallback.
        const latest = db.getLatestSession();
        const sessionId = input.session_id || (latest && latest.session_id) || null;

        if (sessionId) {
          const errorString = (stderr || combined).length > MAX_ERROR_LENGTH
            ? (stderr || combined).substring(0, MAX_ERROR_LENGTH)
            : (stderr || combined);
          const sanitized = sanitize(errorString);
          const errorHash = crypto.createHash('md5').update(sanitized).digest('hex');

          let testFramework = null;
          let testName = null;
          try {
            const parsed = parseTestOutput(stdout, stderr);
            if (parsed) {
              testFramework = parsed.framework;
              testName = parsed.failures.length > 0 ? parsed.failures[0].name : null;
              debugLog('post-command', 'Test failure parsed', { framework: testFramework, testName, count: parsed.failures.length });
            }
          } catch { /* non-fatal */ }

          db.insertErrorOutput({
            error_string: errorString,
            error_hash: errorHash,
            session_id: sessionId,
            test_framework: testFramework,
            test_name: testName,
          });

          debugLog('post-command', 'Error recorded', {
            hash: errorHash.substring(0, 8),
            length: errorString.length,
            exitCode,
            testFramework,
          });
        }
        closeDb();
      }
    }

    timer.elapsed('Completed');
    respond({});
  } catch (err) {
    debugLog('post-command', 'Error caught, failing gracefully', { error: String(err) });
    try { closeDb(); } catch { /* graceful */ }
    respond({});
  }
}

module.exports = { extractCommitHash, getCommittedFiles };

if (require.main === module) {
  main();
}
