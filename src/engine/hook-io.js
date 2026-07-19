'use strict';

const fs = require('fs');

/**
 * Read JSON input from stdin.
 * Returns parsed object or empty object on any error.
 * @returns {import('./types.js').DevGuardHookInput}
 */
function readInput() {
  try {
    const raw = fs.readFileSync(0, 'utf-8').trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return parsed;
  } catch (_) {
    return {};
  }
}

/**
 * Write JSON response to stdout and exit with code 0.
 * @param {object} output
 */
function respond(output) {
  try {
    const safe = (output !== null && typeof output === 'object' && !Array.isArray(output))
      ? output
      : {};
    process.stdout.write(JSON.stringify(safe));
  } catch (_) {
    process.stdout.write('{}');
  }
  process.exit(0);
}

/**
 * Inject additionalContext into Claude's context and exit with code 0.
 * Claude Code rejects hookSpecificOutput without hookEventName (exit 1, context dropped).
 * @param {string} additionalContext
 * @param {string} [hookEventName] e.g. 'PreToolUse', 'SessionStart', 'UserPromptSubmit'
 */
function context(additionalContext, hookEventName) {
  const hookSpecificOutput = { additionalContext };
  if (hookEventName) hookSpecificOutput.hookEventName = hookEventName;
  respond({ hookSpecificOutput });
}

/**
 * Allow the tool call to proceed. Exits with code 0.
 * @param {string} [hookEventName] e.g. 'PreToolUse'
 */
function allow(hookEventName) {
  const hookSpecificOutput = { permissionDecision: 'allow' };
  if (hookEventName) hookSpecificOutput.hookEventName = hookEventName;
  respond({ hookSpecificOutput });
}

module.exports = { readInput, respond, context, allow };
