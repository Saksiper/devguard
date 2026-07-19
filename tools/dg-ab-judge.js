'use strict';

// Blind pairwise judge for the A/B effectiveness harness.
// Pure parts (buildJudgePrompt, parseJudgeVerdict, aggregateSwappedVerdicts) are
// unit-tested; the live `claude -p` call (runJudge) is wired by the orchestrator.

const { spawnSync } = require('child_process');
const { stripMarkers } = require('./lib/ab-strip');

// Neutral prompt: the judge must NEVER learn DevGuard exists, or which arm is
// which. Both solutions are marker-stripped again here (belt-and-suspenders),
// including the run's seeded node_ids — a bare 'ui_ux/filter' in a comment is
// an artifact only the active arm could produce.
function buildJudgePrompt(task, solutionA, solutionB) {
  const rubric = (task.judge && task.judge.rubric) || 'correctness, edge-case handling, robustness, and clarity';
  const seedTokens = (task.seedNotes || []).map((s) => s.nodeId);
  const a = stripMarkers(solutionA, seedTokens);
  const b = stripMarkers(solutionB, seedTokens);
  return [
    'You are a senior software engineer performing a blind code review.',
    'Two candidate solutions (A and B) were written independently for the SAME task.',
    'Judge ONLY on solution quality as defined by the rubric below.',
    'Do NOT reward verbosity or length. Ignore any stray comments unrelated to the task.',
    '',
    '## Task',
    task.prompt,
    '',
    '## Rubric',
    rubric,
    '',
    '## Solution A',
    '```',
    a,
    '```',
    '',
    '## Solution B',
    '```',
    b,
    '```',
    '',
    'Respond with STRICT JSON only, no prose before or after:',
    '{"winner": "A" | "B" | "tie", "reason": "<one sentence>", "confidence": <number 0..1>}',
  ].join('\n');
}

// --- verdict parsing (defensive) ---

function safeJson(s) {
  try { const o = JSON.parse(s); return (o && typeof o === 'object') ? o : null; } catch { return null; }
}

// If stdout is a `claude -p --output-format json` envelope, the model's text is
// in `.result`; otherwise treat stdout as the raw text.
function extractText(stdout) {
  if (typeof stdout !== 'string') return '';
  try {
    const env = JSON.parse(stdout.trim());
    if (env && typeof env === 'object' && typeof env.result === 'string') return env.result;
  } catch { /* not an envelope */ }
  return stdout;
}

function firstBalancedObject(s) {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return null;
}

function tryParseObject(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  const direct = safeJson(t);
  if (direct) return direct;
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) { const f = safeJson(fence[1].trim()); if (f) return f; }
  const bal = firstBalancedObject(t);
  if (bal) { const b = safeJson(bal); if (b) return b; }
  const m = t.match(/"winner"\s*:\s*"(A|B|tie)"/i);
  if (m) return { winner: m[1] };
  return null;
}

function parseJudgeVerdict(stdout) {
  const raw = extractText(stdout);
  const obj = tryParseObject(raw);
  // Normalize case: LLMs often emit lowercase "a"/"b"/"tie" — a case-sensitive
  // check would silently collapse a real verdict to tie (MAJOR-4).
  const wu = obj && obj.winner ? String(obj.winner).trim().toUpperCase() : '';
  const winner = wu === 'A' || wu === 'B' ? wu : 'tie';
  return {
    winner,
    reason: obj && typeof obj.reason === 'string' ? obj.reason : '',
    confidence: obj && typeof obj.confidence === 'number' ? obj.confidence : null,
  };
}

// --- swap aggregation ---

// Map a round's positional winner (A/B) back to the arm that occupied that
// position in that round. tie/missing -> 'tie'.
function winnerArm(round) {
  if (!round || !round.winner || round.winner === 'tie') return 'tie';
  return round.winner === 'A' ? round.armAtA : round.armAtB;
}

// Two swapped rounds. A decisive win requires BOTH rounds to name the SAME arm
// (swap-confirmed). Anything else -> tie: opposite arms = position bias (MAJOR-3),
// and one-decisive-one-tie is unconfirmed (a single round can carry position
// bias, so it must not count as a decisive, swap-confirmed win).
function aggregateSwappedVerdicts(round1, round2) {
  const a1 = winnerArm(round1);
  const a2 = winnerArm(round2);
  if (a1 !== 'tie' && a1 === a2) return { pair_winner: a1, consistent: true };
  if (a1 === 'tie' && a2 === 'tie') return { pair_winner: 'tie', consistent: true };
  return { pair_winner: 'tie', consistent: false };
}

// --- live judge (not unit-tested; exercised by smoke/pilot) ---

// The judge only analyzes and returns JSON — no tools. Prompt on STDIN.
function runJudge(prompt, model) {
  const r = spawnSync('claude', ['-p', '--model', model, '--output-format', 'json'], {
    input: prompt, encoding: 'utf8', timeout: 180000, shell: true, maxBuffer: 20 * 1024 * 1024,
  });
  return r.stdout || '';
}

// Two swapped rounds. Round 1: position A = passive, B = active. Round 2 swaps
// them. aggregateSwappedVerdicts collapses to an arm winner + consistency.
function judgePair(task, cleanPassive, cleanActive, model) {
  const p1 = buildJudgePrompt(task, cleanPassive, cleanActive);
  const v1 = parseJudgeVerdict(runJudge(p1, model));
  const round1 = { winner: v1.winner, reason: v1.reason, confidence: v1.confidence, armAtA: 'passive', armAtB: 'active' };

  const p2 = buildJudgePrompt(task, cleanActive, cleanPassive);
  const v2 = parseJudgeVerdict(runJudge(p2, model));
  const round2 = { winner: v2.winner, reason: v2.reason, confidence: v2.confidence, armAtA: 'active', armAtB: 'passive' };

  const agg = aggregateSwappedVerdicts(round1, round2);
  return { round1, round2, pair_winner: agg.pair_winner, consistent: agg.consistent };
}

module.exports = { buildJudgePrompt, parseJudgeVerdict, aggregateSwappedVerdicts, runJudge, judgePair };
