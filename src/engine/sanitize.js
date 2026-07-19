'use strict';

const SANITIZE_PATTERNS = [
  // --- Existing patterns ---
  [/sk-[a-zA-Z0-9]{20,}/g, '[REDACTED_API_KEY]'],
  [/eyJ[a-zA-Z0-9_-]{10,}(?:\.[a-zA-Z0-9_-]+)+/g, '[REDACTED_JWT]'],
  [/postgres(?:ql)?:\/\/[^\s"']+/g, '[REDACTED_CONN_STRING]'],
  [/mongodb(\+srv)?:\/\/[^\s"']+/g, '[REDACTED_CONN_STRING]'],
  [/rediss?:\/\/[^\s"']+/g, '[REDACTED_CONN_STRING]'],
  [/mysql:\/\/[^\s"']+/g, '[REDACTED_CONN_STRING]'],
  [/(?<![a-zA-Z0-9_-])[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}(?![a-zA-Z0-9_-])/g, '[REDACTED_TOKEN]'],

  // --- P1.1: Cloud provider keys (gitleaks-based) ---
  [/AKIA[0-9A-Z]{16}/g, '[REDACTED_AWS_KEY]'],
  [/AIza[a-zA-Z0-9_-]{35}/g, '[REDACTED_GCP_KEY]'],
  [/ghp_[a-zA-Z0-9]{36}/g, '[REDACTED_GITHUB_PAT]'],
  [/gho_[a-zA-Z0-9]{36}/g, '[REDACTED_GITHUB_TOKEN]'],
  [/ghu_[a-zA-Z0-9]{36}/g, '[REDACTED_GITHUB_TOKEN]'],
  [/ghs_[a-zA-Z0-9]{36}/g, '[REDACTED_GITHUB_TOKEN]'],
  [/github_pat_[a-zA-Z0-9]{22}_[a-zA-Z0-9]{59}/g, '[REDACTED_GITHUB_PAT]'],
  [/sk_live_[a-zA-Z0-9]{24,}/g, '[REDACTED_STRIPE_KEY]'],
  [/sk_test_[a-zA-Z0-9]{24,}/g, '[REDACTED_STRIPE_KEY]'],
  [/rk_live_[a-zA-Z0-9]{24,}/g, '[REDACTED_STRIPE_KEY]'],
  [/rk_test_[a-zA-Z0-9]{24,}/g, '[REDACTED_STRIPE_KEY]'],
  [/xox[bpars]-[a-zA-Z0-9-]{10,}/g, '[REDACTED_SLACK_TOKEN]'],
  [/SG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43}/g, '[REDACTED_SENDGRID_KEY]'],
  [/npm_[a-zA-Z0-9]{36}/g, '[REDACTED_NPM_TOKEN]'],
  [/pypi-[a-zA-Z0-9_-]{50,}/g, '[REDACTED_PYPI_TOKEN]'],
  [/-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]'],
  [/AC[a-f0-9]{32}/g, '[REDACTED_TWILIO_SID]'],
  [/SK[a-f0-9]{32}/g, '[REDACTED_TWILIO_KEY]'],
  [/sq0[a-z]{3}-[a-zA-Z0-9_-]{22,}/g, '[REDACTED_SQUARE_TOKEN]'],
  [/glpat-[a-zA-Z0-9_-]{20,}/g, '[REDACTED_GITLAB_PAT]'],
  [/dop_v1_[a-f0-9]{64}/g, '[REDACTED_DIGITALOCEAN_TOKEN]'],
  [/hf_[a-zA-Z0-9]{34}/g, '[REDACTED_HF_TOKEN]'],

  // --- P1.2: Environment variable values in error output ---
  [/(AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY|GITHUB_TOKEN|GITLAB_TOKEN|SLACK_TOKEN|DATABASE_URL|DB_PASSWORD|SECRET_KEY|PRIVATE_KEY|API_SECRET|CLIENT_SECRET|ENCRYPTION_KEY|HEROKU_API_KEY|SENDGRID_API_KEY|TWILIO_AUTH_TOKEN|STRIPE_SECRET_KEY|NPM_TOKEN|PYPI_TOKEN|HF_TOKEN)=[^\s]{8,}/g, '$1=[REDACTED_ENV]'],
];

const UNICODE_CONTROL_RE = /[\p{Cf}\p{Co}\p{Cn}]/gu;
const ZERO_WIDTH_RE = /[\u200B-\u200F\uFEFF\u202A-\u202E\u2060-\u2064\u00AD]/g;

function sanitizeUnicode(text) {
  if (!text || typeof text !== 'string') return text;
  let result = text;
  for (let i = 0; i < 3; i++) {
    const prev = result;
    result = result.normalize('NFKC');
    result = result.replace(UNICODE_CONTROL_RE, '');
    result = result.replace(ZERO_WIDTH_RE, '');
    if (result === prev) break;
  }
  return result;
}

function sanitize(text) {
  if (text === null) return null;
  if (text === undefined) return undefined;
  let str = typeof text === 'string' ? text : String(text);
  str = sanitizeUnicode(str);
  for (const [pattern, replacement] of SANITIZE_PATTERNS) {
    str = str.replace(pattern, replacement);
  }
  return str;
}

module.exports = { sanitize, sanitizeUnicode };
