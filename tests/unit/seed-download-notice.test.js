import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);

let modelDir, savedModelDir, savedDisabled, savedOffline;

function loadStart() {
  delete require.cache[require.resolve('../../src/engine/llm-note')];
  delete require.cache[require.resolve('../../src/hooks/session-start')];
  return require('../../src/hooks/session-start');
}

beforeEach(() => {
  modelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-model-'));
  savedModelDir = process.env.DEVGUARD_MODEL_DIR;
  savedDisabled = process.env.DEVGUARD_LLM_DISABLED;
  savedOffline = process.env.DEVGUARD_OFFLINE;
  process.env.DEVGUARD_MODEL_DIR = modelDir;
  delete process.env.DEVGUARD_LLM_DISABLED;
  delete process.env.DEVGUARD_OFFLINE;
});
afterEach(() => {
  const restore = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  restore('DEVGUARD_MODEL_DIR', savedModelDir);
  restore('DEVGUARD_LLM_DISABLED', savedDisabled);
  restore('DEVGUARD_OFFLINE', savedOffline);
  if (modelDir && fs.existsSync(modelDir)) { try { fs.rmSync(modelDir, { recursive: true, force: true }); } catch { /* ignore */ } }
});

describe('maybeSeedDownloadNotice', () => {
  it('returns a one-time notice and writes a sentinel on first run', () => {
    const { maybeSeedDownloadNotice } = loadStart();
    const msg = maybeSeedDownloadNotice({ seed_note_enabled: true });
    expect(msg).toBeTruthy();
    expect(msg).toContain('1.3GB');
    expect(fs.existsSync(path.join(modelDir, '.seed_download_notified'))).toBe(true);
  });

  it('is silent on the second run (sentinel already written)', () => {
    const { maybeSeedDownloadNotice } = loadStart();
    expect(maybeSeedDownloadNotice({ seed_note_enabled: true })).toBeTruthy();
    expect(maybeSeedDownloadNotice({ seed_note_enabled: true })).toBeNull();
  });

  it('is silent when seed_note_enabled is false', () => {
    const { maybeSeedDownloadNotice } = loadStart();
    expect(maybeSeedDownloadNotice({ seed_note_enabled: false })).toBeNull();
  });

  it('is silent when DEVGUARD_LLM_DISABLED=1', () => {
    process.env.DEVGUARD_LLM_DISABLED = '1';
    const { maybeSeedDownloadNotice } = loadStart();
    expect(maybeSeedDownloadNotice({ seed_note_enabled: true })).toBeNull();
  });

  it('is silent when the model is already downloaded', () => {
    fs.mkdirSync(path.join(modelDir, 'onnx-community', 'Qwen3-1.7B-ONNX'), { recursive: true });
    const { maybeSeedDownloadNotice } = loadStart();
    expect(maybeSeedDownloadNotice({ seed_note_enabled: true })).toBeNull();
  });
});
