'use strict';

// Central JSDoc typedefs for the two external-shape boundaries where the shape is
// NOT under our control: the hook stdin payload (Claude Code) and the parsed
// transcript. These are the spots where a wrong field name passes every happy-path
// test yet fails live (e.g. the real prompt field is `prompt`, not `user_input`).
// Editor autocomplete only — no build step, no type enforcement (that is a separate
// opt-in). Reference a type from any .js via `import('./types.js').TypeName` in JSDoc.

/**
 * Raw hook payload parsed from stdin by hook-io.readInput().
 * Claude Code delivers a superset of these per hook event, and readInput() returns
 * {} on any parse error, so EVERY field is optional — always guard before use.
 *
 * @typedef {Object} DevGuardHookInput
 * @property {string} [session_id]      Claude Code session id (use this; never generate one).
 * @property {string} [cwd]             Absolute working directory of the session.
 * @property {string} [transcript_path] Path to the session transcript JSONL.
 * @property {string} [hook_event_name] e.g. 'PreToolUse', 'PostToolUse', 'UserPromptSubmit'.
 * @property {string} [tool_name]       Tool being invoked, e.g. 'Edit', 'Write'.
 * @property {DevGuardToolInput} [tool_input]  Arguments of the tool call.
 * @property {*} [tool_response]        Tool result payload (PostToolUse only).
 * @property {string} [prompt]          User prompt text (UserPromptSubmit only).
 */

/**
 * Edit/Write tool arguments as seen inside DevGuardHookInput.tool_input.
 * @typedef {Object} DevGuardToolInput
 * @property {string} [file_path]  Target file path (POSIX or Windows form).
 * @property {string} [old_string] Pre-edit text (Edit).
 * @property {string} [new_string] Post-edit text (Edit/Write).
 */

/**
 * One resolved edit extracted from a transcript by transcript-parser.extractEdits().
 * @typedef {Object} TranscriptEdit
 * @property {string} tool_use_id
 * @property {string} action           Tool name, e.g. 'Edit'.
 * @property {string} file             normalizePath(posixToWindows(file_path)).
 * @property {string} project_path
 * @property {string} description
 * @property {string} diff_text
 * @property {string|null} timestamp
 * @property {boolean} isSidechain
 * @property {string|null} session_id
 * @property {string|null} version
 * @property {boolean} resolved
 */

/**
 * @typedef {Object} ExtractEditsResult
 * @property {TranscriptEdit[]} edits
 * @property {number} bytesRead        Cursor offset to persist for the next incremental pass.
 */

/**
 * Assistant reasoning recovered from the last assistant block by parseTranscript().
 * @typedef {Object} ParseTranscriptResult
 * @property {string} reasoning        Truncated reasoning text.
 * @property {number} confidence
 */

module.exports = {};
