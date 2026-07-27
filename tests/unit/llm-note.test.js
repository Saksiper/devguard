import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

function loadLlmNote() {
  delete require.cache[require.resolve('../../src/engine/llm-note')];
  delete require.cache[require.resolve('../../src/engine/debug-log')];
  return require('../../src/engine/llm-note');
}

let savedDisabled;
beforeEach(() => {
  savedDisabled = process.env.DEVGUARD_LLM_DISABLED;
  delete process.env.DEVGUARD_LLM_DISABLED;
});
afterEach(() => {
  if (savedDisabled === undefined) delete process.env.DEVGUARD_LLM_DISABLED;
  else process.env.DEVGUARD_LLM_DISABLED = savedDisabled;
});

describe('stripThink', () => {
  it('removes a <think>...</think> block and trims to the answer', () => {
    const { stripThink } = loadLlmNote();
    const raw = '<think>\nLet me analyze.\n</think>\nManages replay game state.';
    expect(stripThink(raw)).toBe('Manages replay game state.');
  });

  it('removes an empty /no_think think block', () => {
    const { stripThink } = loadLlmNote();
    expect(stripThink('<think>\n\n</think>\nParses PGN move text into a move list.')).toBe(
      'Parses PGN move text into a move list.'
    );
  });

  it('strips stray unclosed think tags', () => {
    const { stripThink } = loadLlmNote();
    expect(stripThink('</think> Renders the board component.')).toBe('Renders the board component.');
  });

  it('returns empty string for non-string input', () => {
    const { stripThink } = loadLlmNote();
    expect(stripThink(null)).toBe('');
    expect(stripThink(undefined)).toBe('');
    expect(stripThink(42)).toBe('');
  });
});

describe('buildMessages', () => {
  it('produces a system+user chat pair carrying /no_think, the file path and the code', () => {
    const { buildMessages } = loadLlmNote();
    const msgs = buildMessages('src/pgn.ts', 'export function parseGame(){}');
    expect(Array.isArray(msgs)).toBe(true);
    expect(msgs[0].role).toBe('system');
    expect(msgs[1].role).toBe('user');
    expect(msgs[1].content).toContain('/no_think');
    expect(msgs[1].content).toContain('src/pgn.ts');
    expect(msgs[1].content).toContain('parseGame');
  });
});

describe('isLlmEnabled', () => {
  it('is false when DEVGUARD_LLM_DISABLED=1', () => {
    process.env.DEVGUARD_LLM_DISABLED = '1';
    const { isLlmEnabled } = loadLlmNote();
    expect(isLlmEnabled()).toBe(false);
  });

  it('is true when the kill-switch is unset', () => {
    const { isLlmEnabled } = loadLlmNote();
    expect(isLlmEnabled()).toBe(true);
  });
});

describe('generatePurpose', () => {
  it('returns null and never calls the generator when disabled', async () => {
    process.env.DEVGUARD_LLM_DISABLED = '1';
    const { generatePurpose } = loadLlmNote();
    const gen = vi.fn(async () => 'should not run');
    const result = await generatePurpose({ file: 'a.js', code: 'x', _generate: gen });
    expect(result).toBeNull();
    expect(gen).not.toHaveBeenCalled();
  });

  it('returns null when no generator is available (dependency missing)', async () => {
    const { generatePurpose } = loadLlmNote();
    const result = await generatePurpose({ file: 'a.js', code: 'x', _generate: null });
    expect(result).toBeNull();
  });

  it('returns the stripped single-sentence purpose from the generator', async () => {
    const { generatePurpose } = loadLlmNote();
    const gen = vi.fn(async () => '<think>\n</think>\nCoordinates Stockfish analysis for a replay.');
    const result = await generatePurpose({ file: 'src/engine.ts', code: 'const x=1', _generate: gen });
    expect(result).toBe('Coordinates Stockfish analysis for a replay.');
    expect(gen).toHaveBeenCalledOnce();
  });

  it('returns null when the generator yields only whitespace/think', async () => {
    const { generatePurpose } = loadLlmNote();
    const gen = vi.fn(async () => '<think>hmm</think>   \n  ');
    const result = await generatePurpose({ file: 'a.js', code: 'x', _generate: gen });
    expect(result).toBeNull();
  });

  it('returns null (no throw) when the generator throws', async () => {
    const { generatePurpose } = loadLlmNote();
    const gen = vi.fn(async () => { throw new Error('model boom'); });
    await expect(generatePurpose({ file: 'a.js', code: 'x', _generate: gen })).resolves.toBeNull();
  });

  it('returns null for empty code without calling the generator', async () => {
    const { generatePurpose } = loadLlmNote();
    const gen = vi.fn(async () => 'nope');
    const result = await generatePurpose({ file: 'a.js', code: '', _generate: gen });
    expect(result).toBeNull();
    expect(gen).not.toHaveBeenCalled();
  });

  it('clips a multi-sentence generation down to the first sentence (AC: ONE sentence)', async () => {
    const { generatePurpose } = loadLlmNote();
    const gen = vi.fn(async () => '<think>\n</think>\nManages replay state. It also parses PGN.');
    const result = await generatePurpose({ file: 'a.js', code: 'x', _generate: gen });
    expect(result).toBe('Manages replay state.');
  });
});

describe('extractText (real generator output parsing)', () => {
  it('pulls the assistant turn content from a chat-messages generated_text', () => {
    const { extractText } = loadLlmNote();
    const out = [{ generated_text: [
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
      { role: 'assistant', content: 'The answer.' },
    ] }];
    expect(extractText(out)).toBe('The answer.');
  });

  it('handles generated_text being a plain string', () => {
    const { extractText } = loadLlmNote();
    expect(extractText([{ generated_text: 'plain string out' }])).toBe('plain string out');
  });

  it('returns empty string for an empty output array', () => {
    const { extractText } = loadLlmNote();
    expect(extractText([])).toBe('');
  });

  it('returns empty string when the assistant content is non-string', () => {
    const { extractText } = loadLlmNote();
    expect(extractText([{ generated_text: [{ role: 'assistant', content: null }] }])).toBe('');
  });

  it('returns empty string for null/undefined output', () => {
    const { extractText } = loadLlmNote();
    expect(extractText(null)).toBe('');
    expect(extractText(undefined)).toBe('');
  });
});

describe('_loadWithRetry (corrupt-cache recovery)', () => {
  it('returns on first success without clearing the cache', async () => {
    const { _loadWithRetry } = loadLlmNote();
    const clear = vi.fn();
    const r = await _loadWithRetry(async () => 'gen', clear);
    expect(r).toBe('gen');
    expect(clear).not.toHaveBeenCalled();
  });

  it('clears the cache and retries once when the first load fails', async () => {
    const { _loadWithRetry } = loadLlmNote();
    let n = 0;
    const clear = vi.fn();
    const r = await _loadWithRetry(async () => { if (n++ === 0) throw new Error('corrupt'); return 'gen2'; }, clear);
    expect(r).toBe('gen2');
    expect(clear).toHaveBeenCalledOnce();
  });

  it('propagates the error when the retry also fails', async () => {
    const { _loadWithRetry } = loadLlmNote();
    const clear = vi.fn();
    await expect(_loadWithRetry(async () => { throw new Error('still corrupt'); }, clear)).rejects.toThrow('still corrupt');
  });
});

describe('firstSentence', () => {
  it('keeps only the first sentence', () => {
    const { firstSentence } = loadLlmNote();
    expect(firstSentence('One thing. Two things.')).toBe('One thing.');
  });

  it('leaves a single comma-rich sentence intact', () => {
    const { firstSentence } = loadLlmNote();
    const s = 'Provides a state interface for replay, handling parsing, navigation, and seeking.';
    expect(firstSentence(s)).toBe(s);
  });

  it('returns text unchanged when there is no sentence terminator', () => {
    const { firstSentence } = loadLlmNote();
    expect(firstSentence('no period here')).toBe('no period here');
  });

  it('returns empty string for empty input', () => {
    const { firstSentence } = loadLlmNote();
    expect(firstSentence('')).toBe('');
  });
});
