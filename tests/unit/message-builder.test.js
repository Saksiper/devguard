import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  buildRichMessage,
  buildDirectiveBlock,
  buildErrorHashSection,
  buildDiffMatchSection,
  buildTestRepeatSection,
  buildEmbeddingSection,
  buildProtectionSection,
  truncate,
  formatTime,
  MAX_MESSAGE_LEN,
} = require('../../src/engine/message-builder');

function makeDb(overrides = {}) {
  return {
    getChangeHistory: () => [],
    getChangesByIds: () => [],
    getErrorsByIds: () => [],
    getChangeById: () => null,
    getErrorOutputs: () => [],
    ...overrides,
  };
}

describe('truncate', () => {
  it('returns null for empty input', () => {
    expect(truncate(null, 80)).toBeNull();
    expect(truncate('', 80)).toBeNull();
  });

  it('truncates long text', () => {
    const long = 'a'.repeat(100);
    expect(truncate(long, 80).length).toBe(80);
  });

  it('strips newlines', () => {
    expect(truncate('line1\nline2', 80)).toBe('line1 line2');
  });

  it('returns short text as-is', () => {
    expect(truncate('hello', 80)).toBe('hello');
  });
});

describe('formatTime', () => {
  it('formats ISO timestamp', () => {
    expect(formatTime('2026-04-04T14:22:00.000Z')).toMatch(/\d{2}:\d{2}/);
  });

  it('returns ? for null', () => {
    expect(formatTime(null)).toBe('?');
  });

  it('returns ? for invalid date', () => {
    expect(formatTime('not-a-date')).toMatch(/\?|\d{2}:\d{2}/);
  });
});

// buildFileMatchSection removed in v0.2.2 — see [[file_match useless]] memory.

describe('buildErrorHashSection', () => {
  it('builds rich message with error details', () => {
    const db = makeDb({
      getErrorOutputs: () => [
        { id: 1, error_string: 'ECONNREFUSED 127.0.0.1:5432', change_id: 10, timestamp: '2026-04-04T14:22:00Z' },
        { id: 2, error_string: 'ECONNREFUSED 127.0.0.1:5432', change_id: 11, timestamp: '2026-04-04T14:25:00Z' },
      ],
      getChangesByIds: (_ids) => [
        { id: 10, description: 'add setTimeout retry', file: 'app.js' },
        { id: 11, description: 'increase timeout to 3000ms', file: 'app.js' },
      ],
    });
    const result = {
      type: 'error_hash',
      matches: [
        { id: 1, error_hash: 'abc12345', timestamp: '2026-04-04T14:22:00Z' },
        { id: 2, error_hash: 'abc12345', timestamp: '2026-04-04T14:25:00Z' },
      ],
      message: 'fallback',
    };

    const section = buildErrorHashSection(db, 'sess1', result);
    expect(section).toContain('Recurring error:');
    expect(section).toContain('ECONNREFUSED');
    expect(section).toContain('Attempt 1');
    expect(section).toContain('add setTimeout retry');
    expect(section).toContain('Same approach has not worked');
  });

  it('prefers claude_verdict over description for attempt text', () => {
    const db = makeDb({
      getErrorOutputs: () => [
        { id: 1, error_string: 'ECONNREFUSED 127.0.0.1:5432', change_id: 10, timestamp: '2026-04-04T14:22:00Z' },
      ],
      getChangesByIds: (_ids) => [
        { id: 10, claude_verdict: 'I retried the connection but the DB port is closed', description: 'add setTimeout retry', file: 'app.js' },
      ],
    });
    const result = {
      type: 'error_hash',
      matches: [{ id: 1, error_hash: 'abc12345', timestamp: '2026-04-04T14:22:00Z' }],
      message: 'fallback',
    };

    const section = buildErrorHashSection(db, 'sess1', result);
    expect(section).toContain('the DB port is closed');
    expect(section).not.toContain('add setTimeout retry');
  });

  it('falls back on empty matches', () => {
    const db = makeDb();
    expect(buildErrorHashSection(db, 'sess1', { matches: [], message: 'fb' })).toBe('fb');
  });
});

describe('buildDiffMatchSection', () => {
  it('builds rich message with matched changes', () => {
    const db = makeDb({
      getChangesByIds: () => [
        { id: 1, description: 'const jwt = require("jsonwebtoken")', file: 'auth.js' },
        { id: 2, description: 'import jwt from "jsonwebtoken"', file: 'auth.js' },
      ],
    });
    const result = {
      type: 'diff_match',
      matches: [
        { id: 1, file: 'auth.js', similarity: 0.84 },
        { id: 2, file: 'auth.js', similarity: 0.80 },
      ],
      message: 'fallback',
    };

    const section = buildDiffMatchSection(db, 'sess1', result);
    expect(section).toContain('Similar changes:');
    expect(section).toContain('2 similar edits attempted:');
    expect(section).toContain('%84');
  });

  it('prefers claude_verdict over description', () => {
    const db = makeDb({
      getChangesByIds: () => [
        { id: 1, claude_verdict: 'swapped require for ESM import', description: 'import jwt from "jsonwebtoken"', file: 'auth.js' },
      ],
    });
    const result = {
      type: 'diff_match',
      matches: [{ id: 1, file: 'auth.js', similarity: 0.84 }],
      message: 'fallback',
    };

    const section = buildDiffMatchSection(db, 'sess1', result);
    expect(section).toContain('swapped require for ESM import');
    expect(section).not.toContain('import jwt from');
  });
});

describe('buildTestRepeatSection', () => {
  it('builds rich message with test error details', () => {
    const db = makeDb({
      getErrorsByIds: () => [
        { id: 1, error_string: 'jwt.verify is not a function', test_framework: 'vitest', test_name: 'should validate token' },
        { id: 2, error_string: 'jwt.verify is not a function', test_framework: 'vitest', test_name: 'should validate token' },
      ],
    });
    const result = {
      type: 'test_repeat',
      matches: [
        { id: 1, test_name: 'should validate token', timestamp: '2026-04-04T15:10:00Z' },
        { id: 2, test_name: 'should validate token', timestamp: '2026-04-04T15:14:00Z' },
      ],
      message: 'fallback',
    };

    const section = buildTestRepeatSection(db, 'sess1', result);
    expect(section).toContain('Test failure (should validate token, vitest):');
    expect(section).toContain('should validate token');
    expect(section).toContain('jwt.verify is not a function');
    expect(section).toContain('2 failures:');
  });
});

describe('buildEmbeddingSection', () => {
  it('builds rich message with similar pair descriptions', () => {
    const db = makeDb({
      getChangesByIds: () => [
        { id: 1, description: 'add retry with setTimeout', file: 'app.js' },
        { id: 2, description: 'implement retry logic with delay', file: 'app.js' },
      ],
    });
    const result = {
      type: 'embedding_match',
      matches: [{ a: 1, b: 2, similarity: 0.87 }],
      message: 'fallback',
    };

    const section = buildEmbeddingSection(db, 'sess1', result);
    expect(section).toContain('Semantic similarity:');
    expect(section).toContain('add retry with setTimeout');
    expect(section).toContain('implement retry logic with delay');
    expect(section).toContain('%87');
  });

  it('prefers claude_verdict over description for each pair side', () => {
    const db = makeDb({
      getChangesByIds: () => [
        { id: 1, claude_verdict: 'verdict for A side', description: 'add retry with setTimeout', file: 'app.js' },
        { id: 2, claude_verdict: 'verdict for B side', description: 'implement retry logic with delay', file: 'app.js' },
      ],
    });
    const result = {
      type: 'embedding_match',
      matches: [{ a: 1, b: 2, similarity: 0.87 }],
      message: 'fallback',
    };

    const section = buildEmbeddingSection(db, 'sess1', result);
    expect(section).toContain('verdict for A side');
    expect(section).toContain('verdict for B side');
    expect(section).not.toContain('add retry with setTimeout');
  });
});

describe('buildProtectionSection', () => {
  it('builds rich message with original fix context', () => {
    const db = makeDb({
      getChangeById: () => ({
        id: 5,
        description: 'const pool = new Pool({connectionTimeoutMillis: 5000})',
        file: 'db.js',
      }),
    });
    const result = {
      type: 'protection',
      matches: [{
        reason: 'ECONNREFUSED on startup',
        protected_commit: 'a1b2c3d4e5f6',
        change_id: 5,
      }],
      message: 'fallback',
    };

    const section = buildProtectionSection(db, 'sess1', result);
    expect(section).toContain('ECONNREFUSED on startup');
    expect(section).toContain('a1b2c3d');
    expect(section).toContain('const pool = new Pool');
    expect(section).toContain('Original fix:');
  });

  it('works without change_id', () => {
    const db = makeDb();
    const result = {
      type: 'protection',
      matches: [{ reason: 'fix', protected_commit: null, change_id: null }],
      message: 'fb',
    };
    const section = buildProtectionSection(db, 'sess1', result);
    expect(section).toContain('fix');
    expect(section).toContain('WARNING:');
  });
});

describe('buildDirectiveBlock (S3.1)', () => {
  it('emits a single REQUIRED header carrying all three DG tags (S3.1.2)', () => {
    const text = buildDirectiveBlock(false).join('\n');
    const headers = (text.match(/REQUIRED: Start your next reply/g) || []).length;
    expect(headers).toBe(1);
    expect(text).toContain('[DG-CONTINUE]');
    expect(text).toContain('[DG-PIVOT]');
    expect(text).toContain('[DG-PAUSE]');
    expect(text).not.toContain('preserve the existing fix');
  });

  it('adds the protection preserve-fix clause only when hasProtection', () => {
    expect(buildDirectiveBlock(true).join('\n')).toContain('preserve the existing fix');
  });

  it('every directive line sits AT or AFTER the CTA_MARKER header (truncation-safe)', () => {
    const lines = buildDirectiveBlock(true);
    // The header IS the marker; no directive line may precede it.
    expect(lines[0]).toContain('REQUIRED: Start your next reply');
  });

  it('buildRichMessage routes its CTA through the shared builder — one header, no drift (S3.1.2)', () => {
    const db = makeDb();
    const results = [{ type: 'file_match', matches: [], message: 'x' }];
    const msg = buildRichMessage(db, 'sess1', results, 'warn', null, null, []);
    expect((msg.match(/REQUIRED: Start your next reply/g) || []).length).toBe(1);
    for (const line of buildDirectiveBlock(false)) {
      expect(msg).toContain(line.trim());
    }
  });

  it('keeps the FULL directive block intact when message exceeds MAX_MESSAGE_LEN (S3.1)', () => {
    const db = makeDb();
    const results = [{ type: 'file_match', matches: [], message: 'z'.repeat(3000) }];
    const msg = buildRichMessage(db, 'sess1', results, 'warn', null, null, []);
    expect(msg.length).toBeLessThanOrEqual(MAX_MESSAGE_LEN);
    for (const line of buildDirectiveBlock(false)) {
      expect(msg).toContain(line.trim());
    }
  });
});

describe('buildRichMessage', () => {
  it('returns null for empty results', () => {
    const db = makeDb();
    expect(buildRichMessage(db, 'sess1', [], 'none', null, null, [])).toBeNull();
  });

  it('builds full rich message with multiple results', () => {
    const db = makeDb({
      getChangeHistory: () => [
        { id: 1, description: 'first try', timestamp: '2026-04-04T14:00:00Z' },
      ],
      getErrorOutputs: () => [
        { id: 1, error_string: 'Error: fail', change_id: null },
      ],
    });
    const results = [
      {
        type: 'file_match',
        matches: [{ file: 'app.js' }, { file: 'app.js' }],
        message: 'fb1',
        decision: 'warn',
        level: 1,
        confidence: 0.6,
      },
      {
        type: 'error_hash',
        matches: [{ error_hash: 'abcd1234' }, { error_hash: 'abcd1234' }],
        message: 'fb2',
        decision: 'warn',
        level: 1,
        confidence: 0.6,
      },
    ];

    const msg = buildRichMessage(db, 'sess1', results, 'warn', null, null, []);
    expect(msg).toContain("I'm DevGuard");
    expect(msg).toContain('REQUIRED: Start your next reply');
    expect(msg).toContain('[DG-CONTINUE]');
  });

  it('uses protection header for protection results', () => {
    const db = makeDb();
    const results = [
      { type: 'protection', matches: [{ reason: 'fix bug' }], message: 'warning', decision: 'warn' },
    ];
    const msg = buildRichMessage(db, 'sess1', results, 'warn', null, null, []);
    expect(msg).toContain("I'm DevGuard");
    expect(msg).toContain('REQUIRED: Start your next reply');
    expect(msg).toContain('[DG-CONTINUE]');
  });

  it('truncates message exceeding MAX_MESSAGE_LEN', () => {
    const db = makeDb({
      getChangeHistory: () => Array.from({ length: 5 }, (_, i) => ({
        id: i + 1,
        description: 'x'.repeat(200),
        timestamp: '2026-04-04T14:00:00Z',
      })),
      getErrorOutputs: () => Array.from({ length: 5 }, (_, i) => ({
        id: i + 1, error_string: 'e'.repeat(200), change_id: null,
      })),
      getChangesByIds: () => Array.from({ length: 5 }, (_, i) => ({
        id: i + 1, description: 'd'.repeat(200), file: 'f.js',
      })),
    });
    const results = [
      { type: 'file_match', matches: Array.from({ length: 5 }, () => ({ file: 'f.js' })), message: 'fb1' },
      { type: 'error_hash', matches: Array.from({ length: 5 }, () => ({ error_hash: 'aaaa' })), message: 'fb2' },
      { type: 'diff_match', matches: Array.from({ length: 5 }, (_, i) => ({ id: i + 1, file: 'f.js', similarity: 0.8 })), message: 'fb3' },
    ];
    const msg = buildRichMessage(db, 'sess1', results, 'warn', null, null, []);
    expect(msg.length).toBeLessThanOrEqual(MAX_MESSAGE_LEN);
  });

  it('integrates cognitive label and challenge question', () => {
    const db = makeDb({
      getChangeHistory: () => [{ id: 1, description: 'test', timestamp: '2026-04-04T14:00:00Z' }],
    });
    const results = [
      { type: 'file_match', matches: [{ file: 'a.js' }, { file: 'a.js' }], message: 'fb', confidence: 0.8 },
    ];
    const mockLabel = () => 'cognitive label here';
    const mockQuestion = () => 'challenge question here';

    const msg = buildRichMessage(db, 'sess1', results, 'warn', mockLabel, mockQuestion, []);
    expect(msg).toContain('cognitive label here');
    expect(msg).toContain('challenge question here');
  });

  it('falls back to original message on builder error', () => {
    const db = makeDb({
      getChangeHistory: () => { throw new Error('boom'); },
    });
    const results = [
      { type: 'file_match', matches: [{ file: 'a.js' }], message: 'original fallback msg' },
    ];
    const msg = buildRichMessage(db, 'sess1', results, 'warn', null, null, []);
    expect(msg).toContain('original fallback msg');
  });

  it('keeps the message within MAX_MESSAGE_LEN and preserves the FULL CTA when over budget', () => {
    const db = makeDb();
    // file_match is not in SECTION_BUILDERS, so its message is emitted verbatim
    // via the else-branch (unbounded) — forces the over-budget truncation path.
    const results = [{ type: 'file_match', matches: [], message: 'z'.repeat(2000) }];
    const msg = buildRichMessage(db, 'sess1', results, 'warn', null, null, []);
    expect(msg.length).toBeLessThanOrEqual(MAX_MESSAGE_LEN);
    expect(msg).toContain('REQUIRED: Start your next reply');
    expect(msg).toContain('[DG-CONTINUE]');
    expect(msg).toContain('[DG-PIVOT]');
    expect(msg).toContain('[DG-PAUSE]');
  });
});

describe('buildRichMessage — context summary sits BEFORE the CTA (C1 budget order)', () => {
  const CFG = { context_summary_enabled: true, context_summary_confidence_threshold: 0.1 };
  const changesOf = (n) => Array.from({ length: n }, (_, i) => ({
    id: i + 1, file: `f${i}.js`, description: 'approach detail '.repeat(15) + i,
    timestamp: '2026-07-01T10:00:00Z',
  }));

  it('the summary appears before the directive block, never after it', () => {
    const db = makeDb({ getChanges: () => changesOf(4), getErrorOutputs: () => [] });
    const results = [{ type: 'file_match', matches: [], message: 'm', confidence: 0.9 }];
    const msg = buildRichMessage(db, 'sess1', results, 'warn', null, null, [], CFG);
    const sumIdx = msg.indexOf('Session summary:');
    expect(sumIdx).toBeGreaterThan(-1);
    expect(sumIdx).toBeLessThan(msg.indexOf('REQUIRED: Start your next reply'));
  });

  it('over budget: the boilerplate summary is what gets cut — cap holds, directive and detection survive', () => {
    const db = makeDb({ getChanges: () => changesOf(60), getErrorOutputs: () => [] });
    const results = [{ type: 'file_match', matches: [], message: 'detection-anchor-msg', confidence: 0.9 }];
    const msg = buildRichMessage(db, 'sess1', results, 'warn', null, null, [], CFG);
    expect(msg.length).toBeLessThanOrEqual(MAX_MESSAGE_LEN);
    for (const line of buildDirectiveBlock(false)) {
      expect(msg).toContain(line.trim());
    }
    expect(msg).toContain('detection-anchor-msg');
  });
});
