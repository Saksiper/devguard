import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { formatInstruction, formatFeatureSection, parseMarker, parseAckTags } = require('../../src/engine/dg-note');

describe('dg-note formatFeatureSection (S2.A)', () => {
  it('with head note: wraps the instruction under a labeled header, header first', () => {
    const s = formatFeatureSection('ui_ux/filter', 'Made the filter case-insensitive.');
    expect(s).toContain('DevGuard Feature Note');
    expect(s).toContain('Made the filter case-insensitive.');
    expect(s).toContain('[DG-NOTE ui_ux/filter]');
    expect(s.indexOf('DevGuard Feature Note')).toBeLessThan(s.indexOf('Made the filter'));
  });

  it('no head note: suppresses the header, returns the bare leave-a-note instruction', () => {
    const s = formatFeatureSection('ui_ux/filter', null);
    expect(s).not.toContain('DevGuard Feature Note');
    expect(s).toContain('[DG-NOTE ui_ux/filter]');
    expect(s.toLowerCase()).toContain('no prior note');
  });

  it('empty-string head note is treated as no head note (no header)', () => {
    const s = formatFeatureSection('security/auth', '');
    expect(s).not.toContain('DevGuard Feature Note');
    expect(s).toContain('[DG-NOTE security/auth]');
  });

  it('stale head note: appends a re-verify warning after the instruction', () => {
    const s = formatFeatureSection('ui_ux/filter', 'Made the filter case-insensitive.', { stale: true });
    expect(s).toContain('DevGuard Feature Note');
    expect(s).toContain('Made the filter case-insensitive.');
    expect(s).toContain('[DG-NOTE ui_ux/filter]');
    expect(s.toLowerCase()).toContain('re-verify');
    expect(s.toLowerCase()).toContain('source file changed');
  });

  it('fresh (non-stale) head note: no re-verify warning', () => {
    const s = formatFeatureSection('ui_ux/filter', 'Made the filter case-insensitive.', { stale: false });
    expect(s.toLowerCase()).not.toContain('re-verify');
  });

  it('default (no opts) behaves as non-stale — backward compatible', () => {
    const s = formatFeatureSection('ui_ux/filter', 'Made the filter case-insensitive.');
    expect(s.toLowerCase()).not.toContain('re-verify');
  });

  it('stale flag is ignored when there is no head note (nothing to re-verify)', () => {
    const s = formatFeatureSection('ui_ux/filter', null, { stale: true });
    expect(s).not.toContain('DevGuard Feature Note');
    expect(s.toLowerCase()).not.toContain('re-verify');
  });
});

describe('dg-note formatInstruction', () => {
  it('no prior note: instructs to leave a past-tense marker for the node', () => {
    const msg = formatInstruction('ui_ux/filter', null);
    expect(msg).toContain('[DG-NOTE ui_ux/filter]');
    expect(msg.toLowerCase()).toContain('past-tense');
    expect(msg.toLowerCase()).toContain('finish');
    // English (production language), single-sentence rule mentioned
    expect(msg.toLowerCase()).toContain('single');
  });

  it('with prior note: surfaces it and asks to respect + layer a new marker', () => {
    const prior = 'Made the filter case-insensitive because users expected Ankara and ankara to match.';
    const msg = formatInstruction('ui_ux/filter', prior);
    expect(msg).toContain(prior);
    expect(msg.toLowerCase()).toContain('respect');
    expect(msg).toContain('[DG-NOTE ui_ux/filter]');
  });

  it('empty-string prior is treated as no prior', () => {
    const msg = formatInstruction('security/auth', '');
    expect(msg).toContain('[DG-NOTE security/auth]');
    expect(msg.toLowerCase()).not.toContain('respect');
  });
});

describe('dg-note formatInstruction — past-tense/no-future rule (S3.1.3)', () => {
  it('no-prior branch forbids future plans/intentions and scopes to this edit', () => {
    const msg = formatInstruction('ui_ux/filter', null);
    expect(msg.toLowerCase()).toContain('this edit');
    expect(msg.toLowerCase()).toContain('do not write future');
  });

  it('prior branch forbids future plans/intentions and scopes to this edit', () => {
    const msg = formatInstruction('ui_ux/filter', 'earlier decision text');
    expect(msg.toLowerCase()).toContain('this edit');
    expect(msg.toLowerCase()).toContain('do not write future');
  });
});

describe('dg-note formatInstruction — ack CTA (compliance anchor)', () => {
  it('prior branch requests a node-echoed ack tag alongside the DG-NOTE marker', () => {
    const msg = formatInstruction('ui_ux/filter', 'prior decision text');
    expect(msg).toContain('[DG-CONTINUE ui_ux/filter]');
    expect(msg).toContain('[DG-PIVOT ui_ux/filter]');
    expect(msg).toContain('[DG-PAUSE ui_ux/filter]');
    expect(msg).toContain('[DG-NOTE ui_ux/filter]');
    // The two-line block reads ack first, note second.
    expect(msg.indexOf('[DG-CONTINUE ui_ux/filter]')).toBeLessThan(msg.indexOf('[DG-NOTE ui_ux/filter]'));
  });

  it('the CTA template itself parses back to the node (S3.1.4 symmetry)', () => {
    const tags = parseAckTags(formatInstruction('security/auth', 'prior note.'));
    expect(tags.length).toBeGreaterThan(0);
    expect(tags[0].outcome).toBe('dg_continue');
    expect(tags[0].nodeToken).toBe('security/auth');
  });

  it('no-prior branch does not request an ack tag (nothing to comply with)', () => {
    const msg = formatInstruction('ui_ux/filter', null);
    expect(msg).not.toContain('[DG-CONTINUE');
    expect(msg).not.toContain('[DG-PIVOT');
    expect(msg).not.toContain('[DG-PAUSE');
  });
});

describe('dg-note formatInstruction — marker template still parses (S3.1.4)', () => {
  it('no-prior instruction still exposes a parseable DG-NOTE marker for the node', () => {
    const parsed = parseMarker(formatInstruction('ui_ux/filter', null));
    expect(parsed).not.toBeNull();
    expect(parsed.nodeId).toBe('ui_ux/filter');
  });

  it('prior instruction still exposes a parseable DG-NOTE marker for the node', () => {
    const parsed = parseMarker(formatInstruction('security/auth', 'prior note.'));
    expect(parsed).not.toBeNull();
    expect(parsed.nodeId).toBe('security/auth');
  });
});

describe('dg-note parseMarker', () => {
  it('valid marker at end of reply: returns nodeId + trimmed text', () => {
    const reply =
      'I refactored the filter and added tests.\n\n' +
      '[DG-NOTE ui_ux/filter] Made the filter case-insensitive so Ankara and ankara match.';
    const res = parseMarker(reply);
    expect(res).toEqual({
      nodeId: 'ui_ux/filter',
      text: 'Made the filter case-insensitive so Ankara and ankara match.',
    });
  });

  it('marker mid-text is still parsed', () => {
    const reply =
      'Here is the note: [DG-NOTE security/auth] Hardened the login flow.\nThen I ran the suite.';
    const res = parseMarker(reply);
    expect(res.nodeId).toBe('security/auth');
    expect(res.text).toBe('Hardened the login flow.');
  });

  it('no marker: returns null', () => {
    expect(parseMarker('Just a plain reply with no marker.')).toBeNull();
  });

  it('invalid node_id: returns null', () => {
    expect(parseMarker('[DG-NOTE bogus/zone] Did something.')).toBeNull();
  });

  it('multiple markers: returns the last one', () => {
    const reply =
      '[DG-NOTE ui_ux/filter] First change here.\n' +
      'More work...\n' +
      '[DG-NOTE security/auth] Last change here.';
    const res = parseMarker(reply);
    expect(res.nodeId).toBe('security/auth');
    expect(res.text).toBe('Last change here.');
  });

  it('two markers on the same line: returns the last one (not merged)', () => {
    const reply = 'Summary: [DG-NOTE ui_ux/filter] one. [DG-NOTE security/auth] two.';
    const res = parseMarker(reply);
    expect(res.nodeId).toBe('security/auth');
    expect(res.text).toBe('two.');
  });

  it('tolerates whitespace inside the marker brackets', () => {
    const res = parseMarker('[DG-NOTE ui_ux/filter ] kept it simple.');
    expect(res).toEqual({ nodeId: 'ui_ux/filter', text: 'kept it simple.' });
  });

  it('keeps a valid marker even when an invalid [DG-NOTE] quote follows it', () => {
    const reply = '[DG-NOTE ui_ux/filter] Real note. (see also [DG-NOTE old/zone])';
    const res = parseMarker(reply);
    expect(res.nodeId).toBe('ui_ux/filter');
  });

  it('returns null for a bare marker with no note text', () => {
    expect(parseMarker('[DG-NOTE ui_ux/filter]')).toBeNull();
    expect(parseMarker('[DG-NOTE ui_ux/filter]    ')).toBeNull();
  });
});

describe('dg-note parseAckTags', () => {
  it('parses a node-echoed CONTINUE tag with reason', () => {
    const res = parseAckTags('[DG-CONTINUE ui_ux/filter] Kept the tokenized-AND search as decided.');
    expect(res).toEqual([
      {
        outcome: 'dg_continue',
        nodeToken: 'ui_ux/filter',
        reason: 'Kept the tokenized-AND search as decided.',
      },
    ]);
  });

  it('parses node-echoed PIVOT and PAUSE tags', () => {
    expect(parseAckTags('[DG-PIVOT security/auth] Switched to session tokens.')[0]).toEqual({
      outcome: 'dg_pivot',
      nodeToken: 'security/auth',
      reason: 'Switched to session tokens.',
    });
    expect(parseAckTags('[DG-PAUSE ui_ux/search] Need to read the indexer first.')[0]).toEqual({
      outcome: 'dg_pause',
      nodeToken: 'ui_ux/search',
      reason: 'Need to read the indexer first.',
    });
  });

  it('parses the legacy echo-less form with a null nodeToken', () => {
    const res = parseAckTags('[DG-CONTINUE] Proceeding with the current approach.');
    expect(res).toEqual([
      { outcome: 'dg_continue', nodeToken: null, reason: 'Proceeding with the current approach.' },
    ]);
  });

  it('is case-insensitive on the tag word', () => {
    const res = parseAckTags('[dg-continue ui_ux/filter] kept it.');
    expect(res[0].outcome).toBe('dg_continue');
    expect(res[0].nodeToken).toBe('ui_ux/filter');
  });

  it('reason stops at the end of the line', () => {
    const res = parseAckTags('[DG-CONTINUE ui_ux/filter] Followed the note.\nUnrelated next line.');
    expect(res[0].reason).toBe('Followed the note.');
  });

  it('reason stops before a following DG marker on the same line', () => {
    const res = parseAckTags('[DG-CONTINUE ui_ux/filter] Followed it. [DG-NOTE ui_ux/filter] Added sorting.');
    expect(res[0].reason).toBe('Followed it.');
  });

  it('returns all tags in order when the reply has several', () => {
    const res = parseAckTags(
      '[DG-CONTINUE ui_ux/filter] Kept filter decision.\n[DG-PIVOT security/auth] Diverged on auth.'
    );
    expect(res).toHaveLength(2);
    expect(res[0].outcome).toBe('dg_continue');
    expect(res[1].outcome).toBe('dg_pivot');
    expect(res[1].nodeToken).toBe('security/auth');
  });

  it('does not validate the node token (caller validates)', () => {
    const res = parseAckTags('[DG-CONTINUE bogus/zone] whatever.');
    expect(res[0].nodeToken).toBe('bogus/zone');
  });

  it('a bare tag with no reason yields an empty reason', () => {
    const res = parseAckTags('[DG-CONTINUE ui_ux/filter]');
    expect(res[0].reason).toBe('');
  });

  it('returns [] when there is no ack tag or input is not a string', () => {
    expect(parseAckTags('Plain reply. [DG-NOTE ui_ux/filter] A note, not an ack.')).toEqual([]);
    expect(parseAckTags(null)).toEqual([]);
    expect(parseAckTags(undefined)).toEqual([]);
  });

  it('does not match look-alike words such as [DG-CONTINUED]', () => {
    expect(parseAckTags('[DG-CONTINUED] not a tag')).toEqual([]);
  });

  it('tolerates whitespace before the closing bracket', () => {
    const res = parseAckTags('[DG-CONTINUE ui_ux/filter ] kept it.');
    expect(res[0].nodeToken).toBe('ui_ux/filter');
    expect(res[0].reason).toBe('kept it.');
  });
});
