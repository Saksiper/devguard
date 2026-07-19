import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { stripMarkers } = require('../../tools/lib/ab-strip');

describe('ab-strip: stripMarkers (judge leak sanitization)', () => {
  it('removes a [DG-NOTE] marker together with its note text', () => {
    const out = stripMarkers('Done. [DG-NOTE ui_ux/filter] fixed the filter default behavior');
    expect(out).not.toMatch(/DG-NOTE/);
    expect(out).toContain('Done.');
  });

  it('removes [DG-CONTINUE], [DG-PIVOT], [DG-PAUSE] tags', () => {
    const out = stripMarkers('progress [DG-CONTINUE] then [DG-PIVOT] and [DG-PAUSE]');
    expect(out).not.toMatch(/\[DG-/);
  });

  it('removes the "── DevGuard Feature Note ──" header line', () => {
    const out = stripMarkers('── DevGuard Feature Note ──\nPrior note for feature X\ncode here');
    expect(out).not.toMatch(/DevGuard/);
    expect(out).toContain('code here');
  });

  it('removes any line that mentions DevGuard (echoed guidance)', () => {
    const out = stripMarkers('line1\nthis loop was flagged by DevGuard as risky\nline3');
    expect(out).not.toMatch(/DevGuard/i);
    expect(out).toContain('line1');
    expect(out).toContain('line3');
  });

  it('preserves legitimate task words (loop, retry) that are NOT DevGuard tokens', () => {
    const code = 'function retryWithBackoff() {\n  for (;;) { /* loop */ }\n}';
    expect(stripMarkers(code)).toBe(code);
  });

  it('leaves normal code completely untouched', () => {
    const code = 'const x = 1;\nreturn x + 2;';
    expect(stripMarkers(code)).toBe(code);
  });

  it('strips an inline marker but keeps the code on that line', () => {
    const out = stripMarkers('const rate = ms / 1000; // [DG-NOTE perf/rate] unit fix');
    expect(out).toContain('const rate = ms / 1000;');
    expect(out).not.toMatch(/DG-NOTE/);
  });

  it('returns non-string input unchanged (defensive)', () => {
    expect(stripMarkers(null)).toBe(null);
    expect(stripMarkers(undefined)).toBe(undefined);
  });

  // MAJOR-1: leak vectors the happy-path missed.
  it('strips a marker whose closing ] is on a later line (multi-line marker)', () => {
    const out = stripMarkers('// [DG-NOTE this note wraps\n// onto a second line]\nconst x = 1;');
    expect(out).not.toMatch(/DG-NOTE/);
    expect(out).toContain('const x = 1;');
  });

  it('strips echoed DevGuard guidance phrasing without the literal token', () => {
    const a = stripMarkers('// respecting the prior note for feature auth, we keep the default\ncode();');
    expect(a.toLowerCase()).not.toContain('prior note');
    const b = stripMarkers('// per the feature note above, defaulting to show-all\ncode();');
    expect(b.toLowerCase()).not.toContain('feature note');
  });

  it('strips a node-echoed ack tag ([DG-CONTINUE ui_ux/filter] form) with its reason', () => {
    const out = stripMarkers('done();\n[DG-CONTINUE ui_ux/filter] kept the tokenized search as decided');
    expect(out).not.toMatch(/\[DG-/);
    expect(out).not.toContain('ui_ux/filter');
    expect(out).not.toContain('tokenized search');
    expect(out).toContain('done();');
  });

  it('a wrapped ack reason cannot leak its continuation line to the judge', () => {
    // The CTA asks for a single sentence, but a model may wrap the reason onto the
    // next line; only the active arm can produce that trailing prose.
    const out = stripMarkers('done();\n[DG-CONTINUE ui_ux/filter] kept the tokenized\nsearch as decided earlier');
    expect(out).not.toMatch(/\[DG-/);
    expect(out).not.toContain('search as decided earlier');
    expect(out).toContain('done();');
  });

  it('a line-anchored ack block strips through to the end of the reply', () => {
    const out = stripMarkers(
      'const x = 1;\n[DG-CONTINUE ui_ux/filter] followed\nthe note precisely\n[DG-NOTE ui_ux/filter] extended it'
    );
    expect(out).not.toMatch(/\[DG-/);
    expect(out).not.toContain('the note precisely');
    expect(out).not.toContain('extended it');
    expect(out).toContain('const x = 1;');
  });
});
