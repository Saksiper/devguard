'use strict';

// Seed-note purpose generator (cold-start fix, SEED-COLDSTART-2026-07-25 · T1).
// Produces ONE English sentence describing a file's lasting purpose, using a small
// local LLM (Qwen3-1.7B ONNX via @huggingface/transformers). The heavy runtime is an
// OPTIONAL dependency and loaded lazily; when it (or the kill-switch) is absent the
// module is a silent no-op that returns null — it never throws into the caller.

const path = require('path');
const os = require('os');
const { debugLog } = require('./debug-log');

const MODEL_ID = 'onnx-community/Qwen3-1.7B-ONNX';

let _generator = null;
let _loadFailed = false;

function isLlmEnabled() {
  return process.env.DEVGUARD_LLM_DISABLED !== '1';
}

// Qwen3 emits a <think>...</think> preamble even under /no_think (empty block).
// Strip it (and any stray tags) and trim down to the answer.
function stripThink(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
  s = s.replace(/<\/?think>/gi, '');
  return s.trim();
}

// Pull the model's text out of @huggingface/transformers text-generation output.
// Chat-messages input yields [{ generated_text: [...messages, {role:'assistant', content}] }];
// a plain-string variant is also tolerated. Any unexpected shape -> '' (never throws).
function extractText(out) {
  const gen = out && out[0] && out[0].generated_text;
  if (Array.isArray(gen)) {
    const last = gen[gen.length - 1];
    return last && typeof last.content === 'string' ? last.content : '';
  }
  return typeof gen === 'string' ? gen : '';
}

// Clip to the first sentence so a purpose stays ONE sentence even if the model
// runs on or max_new_tokens truncates mid-thought (review M1).
function firstSentence(s) {
  if (!s) return '';
  return s.split(/(?<=[.!?])\s/)[0];
}

function buildMessages(file, code) {
  const system =
    "You are a code analysis assistant. Reply with EXACTLY ONE concise English sentence " +
    "describing the file's lasting purpose — what it exists to do — not what is currently " +
    "being edited, added or tested. No preamble, no markdown, no code.";
  const user = `/no_think\nFile: ${file}\n\n\`\`\`\n${code}\n\`\`\``;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

function getModelDir() {
  return process.env.DEVGUARD_MODEL_DIR || path.join(os.homedir(), '.devguard', 'models');
}

// Lazily build the real Qwen3 generator. Returns an async (messages)=>string, or null
// if the optional dependency / model is unavailable (never throws).
async function _loadGenerator() {
  if (_generator) return _generator;
  if (_loadFailed) return null;
  try {
    const { pipeline, env } = require('@huggingface/transformers');
    env.cacheDir = getModelDir();
    env.allowLocalModels = true;
    env.allowRemoteModels = !process.env.DEVGUARD_OFFLINE;
    const pipe = await pipeline('text-generation', MODEL_ID, { dtype: 'q4' });
    _generator = async (messages) => {
      const out = await pipe(messages, { max_new_tokens: 128, do_sample: false });
      return extractText(out);
    };
    return _generator;
  } catch (err) {
    _loadFailed = true;
    debugLog('llm-note', 'generator load failed', { error: String(err) });
    return null;
  }
}

// generatePurpose({file, code}) -> Promise<string|null>
// _generate is a dependency-injection seam for tests: a function is used as-is,
// null models "generator unavailable", undefined loads the real one.
async function generatePurpose({ file, code, _generate } = {}) {
  if (!isLlmEnabled()) return null;
  if (!code || typeof code !== 'string') return null;
  const gen = _generate !== undefined ? _generate : await _loadGenerator();
  if (typeof gen !== 'function') return null;
  try {
    const raw = await gen(buildMessages(file || 'unknown', code));
    return firstSentence(stripThink(raw)) || null;
  } catch (err) {
    debugLog('llm-note', 'generatePurpose failed', { error: String(err) });
    return null;
  }
}

function _resetForTest() {
  _generator = null;
  _loadFailed = false;
}

module.exports = {
  generatePurpose,
  stripThink,
  firstSentence,
  extractText,
  buildMessages,
  isLlmEnabled,
  getModelDir,
  MODEL_ID,
  _resetForTest,
};
