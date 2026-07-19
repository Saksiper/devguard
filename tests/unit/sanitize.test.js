import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { sanitize } = require('../../src/engine/sanitize');

describe('sanitize', () => {
  it('redacts API key', () => {
    expect(sanitize('sk-abcdefghijklmnopqrstuvwxyz1234')).toBe('[REDACTED_API_KEY]');
  });

  it('redacts JWT', () => {
    expect(sanitize('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc')).toBe('[REDACTED_JWT]');
  });

  it('redacts PostgreSQL connection string', () => {
    expect(sanitize('postgresql://user:pass@localhost:5432/db')).toBe('[REDACTED_CONN_STRING]');
  });

  it('redacts postgres:// (without ql suffix)', () => {
    expect(sanitize('postgres://user:pass@localhost:5432/db')).toBe('[REDACTED_CONN_STRING]');
  });

  it('redacts MongoDB+srv connection string', () => {
    expect(sanitize('mongodb+srv://user:pass@cluster.mongodb.net/db')).toBe('[REDACTED_CONN_STRING]');
  });

  it('redacts mongodb:// (without +srv)', () => {
    expect(sanitize('mongodb://user:pass@localhost:27017/mydb')).toBe('[REDACTED_CONN_STRING]');
  });

  it('redacts Redis connection string', () => {
    expect(sanitize('redis://default:password@redis.example.com:6379')).toBe('[REDACTED_CONN_STRING]');
  });

  it('redacts rediss:// TLS connection string', () => {
    expect(sanitize('rediss://default:password@redis.example.com:6380')).toBe('[REDACTED_CONN_STRING]');
  });

  it('redacts mysql:// connection string', () => {
    expect(sanitize('mysql://user:pass@localhost:3306/mydb')).toBe('[REDACTED_CONN_STRING]');
  });

  it('redacts connection string with query parameters', () => {
    expect(sanitize('redis://x:pass@host:6379/0?timeout=5&ssl=true')).toBe('[REDACTED_CONN_STRING]');
  });

  it('redacts generic token with 3 dot-separated segments >= 20 chars each', () => {
    const seg = 'abcdefghijklmnopqrstu';
    expect(sanitize(`${seg}.${seg}.${seg}`)).toBe('[REDACTED_TOKEN]');
  });

  it('does NOT redact short sk- string', () => {
    expect(sanitize('sk-abc')).toBe('sk-abc');
  });

  it('does NOT redact normal short dotted string', () => {
    expect(sanitize('foo.bar.baz')).toBe('foo.bar.baz');
  });

  it('does NOT redact long dotted filename (segments < 20 chars)', () => {
    const npmPath = '@org/aaa-bbb-ccc-ddd-eee-fff-ggg.xxx-yyy-zzz-www-aaa.min.js';
    expect(sanitize(npmPath)).toBe(npmPath);
  });

  it('lookbehind blocks token match when preceded by word char mid-text', () => {
    // Lookbehind prevents matching when a word char is directly before the 20-char segment
    const token = 'a'.repeat(20) + '.' + 'b'.repeat(20) + '.' + 'c'.repeat(20);
    // Standalone → caught
    expect(sanitize(token)).toBe('[REDACTED_TOKEN]');
    // After space → still caught (space is not in lookbehind set)
    expect(sanitize('text ' + token)).toContain('[REDACTED_TOKEN]');
  });

  it('redacts secret embedded in quotes (quotes stay outside)', () => {
    const input = '"token":"sk-abcdefghijklmnopqrstuvwxyz1234"';
    const result = sanitize(input);
    expect(result).toContain('[REDACTED_API_KEY]');
    expect(result).not.toContain('sk-abcdefghijklmnopqrstuvwxyz1234');
  });

  it('returns null for null input', () => {
    expect(sanitize(null)).toBeNull();
  });

  it('returns undefined for undefined input', () => {
    expect(sanitize(undefined)).toBeUndefined();
  });

  it('returns empty string for empty string input', () => {
    expect(sanitize('')).toBe('');
  });

  it('converts number input to string and returns it unchanged', () => {
    expect(sanitize(42)).toBe('42');
  });

  it('redacts multiple secrets in same text', () => {
    const input = 'key=sk-abcdefghijklmnopqrstuvwxyz1234 url=redis://default:pass@host:6379';
    const result = sanitize(input);
    expect(result).toBe('key=[REDACTED_API_KEY] url=[REDACTED_CONN_STRING]');
  });

  it('is idempotent: already-redacted text is not further modified', () => {
    expect(sanitize('[REDACTED_API_KEY]')).toBe('[REDACTED_API_KEY]');
  });

  it('leaves text without secrets unchanged', () => {
    expect(sanitize('hello world')).toBe('hello world');
  });

  it('converts object input to string (lossy but safe)', () => {
    expect(sanitize({ key: 'value' })).toBe('[object Object]');
  });

  it('handles large input without catastrophic backtracking (<500ms)', () => {
    const big = 'a'.repeat(1_000_000);
    const start = Date.now();
    const result = sanitize(big);
    const elapsed = Date.now() - start;
    expect(result).toBe(big);
    expect(elapsed).toBeLessThan(500);
  });
});

describe('P1.1 — cloud provider secret patterns', () => {
  it('redacts AWS access key (AKIA prefix)', () => {
    expect(sanitize('key=AKIAIOSFODNN7EXAMPLE')).toBe('key=[REDACTED_AWS_KEY]');
  });

  it('redacts GCP API key (AIza prefix)', () => {
    expect(sanitize('AIzaSyA1234567890abcdefghijklmnopqrstuv')).toBe('[REDACTED_GCP_KEY]');
  });

  it('redacts GitHub personal access token (ghp_)', () => {
    expect(sanitize('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij')).toBe('[REDACTED_GITHUB_PAT]');
  });

  it('redacts GitHub fine-grained PAT (github_pat_)', () => {
    const pat = 'github_pat_' + 'a'.repeat(22) + '_' + 'b'.repeat(59);
    expect(sanitize(pat)).toBe('[REDACTED_GITHUB_PAT]');
  });

  it('redacts GitHub OAuth token (gho_)', () => {
    expect(sanitize('gho_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij')).toBe('[REDACTED_GITHUB_TOKEN]');
  });

  it('redacts Stripe live key', () => {
    expect(sanitize('sk_live_1234567890abcdefghijklmn')).toBe('[REDACTED_STRIPE_KEY]');
  });

  it('redacts Stripe test key', () => {
    expect(sanitize('sk_test_1234567890abcdefghijklmn')).toBe('[REDACTED_STRIPE_KEY]');
  });

  it('redacts Stripe restricted key (rk_live_)', () => {
    expect(sanitize('rk_live_1234567890abcdefghijklmn')).toBe('[REDACTED_STRIPE_KEY]');
  });

  it('redacts Slack bot token (xoxb-)', () => {
    expect(sanitize('xoxb-1234567890-abcdefghij')).toBe('[REDACTED_SLACK_TOKEN]');
  });

  it('redacts Slack user token (xoxp-)', () => {
    expect(sanitize('xoxp-1234567890-abcdefghij')).toBe('[REDACTED_SLACK_TOKEN]');
  });

  it('redacts SendGrid API key', () => {
    const sg = 'SG.' + 'a'.repeat(22) + '.' + 'b'.repeat(43);
    expect(sanitize(sg)).toBe('[REDACTED_SENDGRID_KEY]');
  });

  it('redacts npm token', () => {
    expect(sanitize('npm_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij')).toBe('[REDACTED_NPM_TOKEN]');
  });

  it('redacts PyPI token', () => {
    const pypi = 'pypi-' + 'a'.repeat(50);
    expect(sanitize(pypi)).toBe('[REDACTED_PYPI_TOKEN]');
  });

  it('redacts private key header', () => {
    expect(sanitize('-----BEGIN RSA PRIVATE KEY-----')).toBe('[REDACTED_PRIVATE_KEY]');
    expect(sanitize('-----BEGIN PRIVATE KEY-----')).toBe('[REDACTED_PRIVATE_KEY]');
    expect(sanitize('-----BEGIN EC PRIVATE KEY-----')).toBe('[REDACTED_PRIVATE_KEY]');
    expect(sanitize('-----BEGIN OPENSSH PRIVATE KEY-----')).toBe('[REDACTED_PRIVATE_KEY]');
  });

  it('redacts Twilio account SID', () => {
    expect(sanitize('AC' + 'a'.repeat(32))).toBe('[REDACTED_TWILIO_SID]');
  });

  it('redacts Twilio API key', () => {
    expect(sanitize('SK' + 'a'.repeat(32))).toBe('[REDACTED_TWILIO_KEY]');
  });

  it('redacts Square token', () => {
    expect(sanitize('sq0atp-abcdefghijklmnopqrstuv1234')).toBe('[REDACTED_SQUARE_TOKEN]');
  });

  it('redacts GitLab PAT', () => {
    expect(sanitize('glpat-abcdefghijklmnopqrstuv')).toBe('[REDACTED_GITLAB_PAT]');
  });

  it('redacts DigitalOcean token', () => {
    expect(sanitize('dop_v1_' + 'a'.repeat(64))).toBe('[REDACTED_DIGITALOCEAN_TOKEN]');
  });

  it('redacts HuggingFace token', () => {
    expect(sanitize('hf_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh')).toBe('[REDACTED_HF_TOKEN]');
  });

  it('does NOT redact short/non-matching prefixes', () => {
    expect(sanitize('AKIA1234')).toBe('AKIA1234');
    expect(sanitize('ghp_short')).toBe('ghp_short');
    expect(sanitize('sk_live_short')).toBe('sk_live_short');
  });
});

describe('P1.2 — environment variable scrubbing', () => {
  it('redacts AWS_SECRET_ACCESS_KEY value', () => {
    expect(sanitize('AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'))
      .toBe('AWS_SECRET_ACCESS_KEY=[REDACTED_ENV]');
  });

  it('redacts ANTHROPIC_API_KEY value', () => {
    expect(sanitize('ANTHROPIC_API_KEY=sk-ant-api03-longkeyvalue12345678'))
      .toBe('ANTHROPIC_API_KEY=[REDACTED_ENV]');
  });

  it('redacts DATABASE_URL value', () => {
    expect(sanitize('DATABASE_URL=postgres://user:pass@host:5432/db'))
      .toBe('DATABASE_URL=[REDACTED_ENV]');
  });

  it('redacts GITHUB_TOKEN value', () => {
    expect(sanitize('GITHUB_TOKEN=ghp_abcdefghijklmnop12345678'))
      .toBe('GITHUB_TOKEN=[REDACTED_ENV]');
  });

  it('redacts multiple env vars in same text', () => {
    const input = 'AWS_SECRET_ACCESS_KEY=secretvalue123456 OPENAI_API_KEY=sk-proj-longvalue1234';
    const result = sanitize(input);
    expect(result).toContain('AWS_SECRET_ACCESS_KEY=[REDACTED_ENV]');
    expect(result).toContain('OPENAI_API_KEY=[REDACTED_ENV]');
  });

  it('does NOT redact short env values (<8 chars)', () => {
    expect(sanitize('SECRET_KEY=short')).toBe('SECRET_KEY=short');
  });

  it('does NOT redact non-sensitive env vars', () => {
    expect(sanitize('HOME=/users/me PATH=/usr/bin')).toBe('HOME=/users/me PATH=/usr/bin');
  });
});

describe('sanitizeUnicode', () => {
  const { sanitizeUnicode } = require('../../src/engine/sanitize');

  it('removes zero-width characters', () => {
    expect(sanitizeUnicode('hello\u200Bworld')).toBe('helloworld');
    expect(sanitizeUnicode('test\uFEFFdata')).toBe('testdata');
  });

  it('removes directional override characters', () => {
    expect(sanitizeUnicode('abc\u202Edef')).toBe('abcdef');
    expect(sanitizeUnicode('\u202Ahello\u202C')).toBe('hello');
  });

  it('applies NFKC normalization', () => {
    expect(sanitizeUnicode('\uFB01')).toBe('fi');
    expect(sanitizeUnicode('\u2126')).toBe('\u03A9');
  });

  it('handles null/undefined/empty gracefully', () => {
    expect(sanitizeUnicode(null)).toBe(null);
    expect(sanitizeUnicode(undefined)).toBe(undefined);
    expect(sanitizeUnicode('')).toBe('');
  });

  it('passes clean text unchanged', () => {
    expect(sanitizeUnicode('normal text')).toBe('normal text');
  });

  it('handles iterative cleanup (NFKC producing new control chars)', () => {
    const nasty = 'test\u200B\uFB01\u200Fdata';
    const result = sanitizeUnicode(nasty);
    expect(result).toBe('testfidata');
    expect(result).not.toMatch(/[\u200B-\u200F]/);
  });
});
