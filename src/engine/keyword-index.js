'use strict';

// Per-project, model-free read-resolver. Builds a token index from the project's
// OWN noted nodes (node_id + note text) and resolves a prompt to a node by rare-term
// overlap — free (~0ms), unlike the embedding resolver's ~680ms cold model load.
// It ONLY returns a node when confident: the top node must clear a floor AND beat
// the runner-up by a margin. Ambiguous/weak matches return null so the caller can
// defer to the embedding fallback rather than surface a vocabulary-neighbour's note
// (measured: two exam-question nodes both mentioning 'topic' tie at margin 1.0).

// Pure function words (EN + TR) — meaningless in ANY position, including feature
// names. Turkish is included because notes are written in the session language
// (measured live: 'yeni'/'için'/'bir' alone drew false surfaces in a small index
// where every token has df=1).
const FUNC_WORDS_SRC =
  'the a an of to in for on by and or is are be it its this that these those with as at from into ' +
  'there no not do so per any when else which what ' +
  'you your they them then than has have was were will would should can could must also only just about ' +
  'için gibi kadar göre sonra önce şimdi ama ancak fakat çünkü yani ise değil daha çok pek hiç her hem ' +
  'ile bir iki onu bunu şunu ona buna şuna onun bunun şunun ben sen biz siz bana sana beni seni ' +
  'evet hayır tamam lütfen olan olarak oldu olur olsun var yok yeni şey yap yaz ' +
  'nasıl neden niye hangi nerede zaten belki galiba sadece yine ayrıca';

// Dev-prose noise — words that carry no signal in note PROSE ("export the function
// that returns…") but are perfectly legitimate as feature NAMES ('ui_ux/export').
// Only the prose index filters these; the name-matching bootstrap must not.
const PROSE_NOISE_SRC =
  'new file implement return export function questions question answer answers based check iterate ' +
  'until correct after implementing verify behavior writing running string number array map label each ' +
  'given side both may combine every returns null record';

const FUNC_WORDS = new Set(FUNC_WORDS_SRC.split(/\s+/));
const STOP = new Set((FUNC_WORDS_SRC + ' ' + PROSE_NOISE_SRC).split(/\s+/));

// Unicode-aware word class: any letter or digit in any script. The old
// ASCII+Turkish-only class mangled accented Latin ('diseño' -> 'dise') and
// produced nothing for Cyrillic/CJK — a non-EN/TR user's vocabulary must
// tokenize identically on both sides of the match (note text and prompt).
const WORD_RE = /[\p{L}\p{N}]{3,}/gu;

function tokens(s) {
  return (String(s || '').toLowerCase().match(WORD_RE) || []).filter((t) => !STOP.has(t));
}

// Name-grade tokenizer: drops only pure function words, keeps dev-prose words —
// a feature legitimately named 'export' or 'map' must stay nameable.
function nameTokens(s) {
  return (String(s || '').toLowerCase().match(WORD_RE) || []).filter((t) => !FUNC_WORDS.has(t));
}

// Pure: build { nodes: Map<node_id, Set<token>>, df: {token: docFreq},
// nameTokens: Map<node_id, Set<token>> } from [{ node_id, text }]. Notes on the
// same node merge into one token set; nameTokens holds only the node-id-derived
// tokens (the feature's own name — higher-signal than note prose).
function buildIndex(docs) {
  const nodes = new Map();
  const nameTokens = new Map();
  for (const d of docs || []) {
    if (!d || !d.node_id) continue;
    const set = nodes.get(d.node_id) || new Set();
    for (const t of tokens(String(d.node_id).replace(/[/_-]/g, ' ') + ' ' + (d.text || ''))) set.add(t);
    nodes.set(d.node_id, set);
    if (!nameTokens.has(d.node_id)) {
      nameTokens.set(d.node_id, new Set(tokens(String(d.node_id).replace(/[/_-]/g, ' '))));
    }
  }
  const df = {};
  for (const set of nodes.values()) for (const t of set) df[t] = (df[t] || 0) + 1;
  return { nodes, df, nameTokens };
}

// F1a: character n-grams for fuzzy (morphology-tolerant) matching — 'filtreleme'
// reinforces the name token 'filtre'. Latin/Cyrillic only: CJK bigram collision
// behavior is unmeasured, so CJK tokens are excluded by design (F1b, default-off).
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CHAR_GRAM_N = 4;
const CHAR_GRAM_MIN_JACCARD = 0.34;

function charGrams(token) {
  const g = new Set();
  for (let i = 0; i + CHAR_GRAM_N <= token.length; i++) g.add(token.slice(i, i + CHAR_GRAM_N));
  return g;
}

function gramJaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  return inter / (a.size + b.size - inter);
}

// F5a source weights. exact_prose stays 1.0: the July noise-fix floor/margin were
// calibrated with uniform weights — down-weighting prose is a measured recalibration,
// not a default change. char_gram is a FUZZY source: it reinforces score only and can
// NEVER satisfy the evidence gate (panel verdict — a fuzzy source alone must not
// surface). Setting any weight to 0 is a kill-switch: that source's contributions
// vanish without a code revert.
const DEFAULT_WEIGHTS = Object.freeze({ exact_name: 1.0, exact_prose: 1.0, char_gram: 0.3 });

function mergeWeights(weights) {
  const w = { ...DEFAULT_WEIGHTS };
  for (const k of Object.keys(weights || {})) {
    if (typeof weights[k] === 'number') w[k] = weights[k];
  }
  return w;
}

// Pure: score prompt tokens by summed rarity (1/df) per node with source-aware
// weights, then gate on confidence. Returns { nodeId, evidence } where evidence
// lists every contribution of the winning node as { token, source, w, contrib } —
// the raw material for the Faz-2 re-ranker (F5b) and for debugging any surface
// ("which word triggered this?"). nodeId is null unless: top >= floor AND
// runner-up/top < margin AND the EXACT evidence is real (>= 2 distinct exact
// matches, OR one exact match that NAMES the feature). Fuzzy contributions never
// count toward that gate.
function resolveIndexDetailed(index, promptText, marginThreshold = 0.75, floor = 0.3, weights) {
  const w = mergeWeights(weights);
  const pt = new Set(tokens(promptText));
  if (!index || !index.nodes || !index.nodes.size || !pt.size) return { nodeId: null, evidence: [] };

  // Precompute prompt-token grams once (fuzzy source only, non-CJK).
  const promptGrams = new Map();
  if (w.char_gram > 0) {
    for (const t of pt) {
      if (!CJK_RE.test(t)) promptGrams.set(t, charGrams(t));
    }
  }

  let topId = null, topScore = -1, secondScore = 0, topHits = 0, topNameHit = false, topEvidence = [];
  for (const [nodeId, set] of index.nodes) {
    let s = 0, hits = 0, nameHit = false;
    const evidence = [];
    const names = index.nameTokens && index.nameTokens.get(nodeId);
    for (const t of pt) {
      if (!set.has(t)) continue;
      const isName = !!(names && names.has(t));
      const weight = isName ? w.exact_name : w.exact_prose;
      if (weight <= 0) continue; // kill-switched source contributes nothing, gate included
      const contrib = weight / (index.df[t] || 1);
      s += contrib;
      hits += 1;
      if (isName) nameHit = true;
      evidence.push({ token: t, source: isName ? 'exact_name' : 'exact_prose', w: weight, contrib });
    }
    // Fuzzy reinforcement: prompt tokens with no exact hit, compared against NAME
    // tokens only (small, high-signal sets). Best jaccard per prompt token.
    if (w.char_gram > 0 && names && names.size) {
      for (const [t, grams] of promptGrams) {
        if (set.has(t)) continue; // already exact
        let bestJ = 0, bestName = null;
        for (const n of names) {
          if (CJK_RE.test(n)) continue;
          const j = gramJaccard(grams, charGrams(n));
          if (j > bestJ) { bestJ = j; bestName = n; }
        }
        if (bestJ >= CHAR_GRAM_MIN_JACCARD) {
          const contrib = w.char_gram * bestJ / (index.df[bestName] || 1);
          s += contrib;
          evidence.push({ token: t, matched: bestName, source: 'char_gram', w: w.char_gram, contrib });
        }
      }
    }
    if (s > topScore) {
      secondScore = topScore; topScore = s; topId = nodeId;
      topHits = hits; topNameHit = nameHit; topEvidence = evidence;
    } else if (s > secondScore) { secondScore = s; }
  }
  if (topScore < floor) return { nodeId: null, evidence: [] };           // weak signal
  if (topHits < 2 && !topNameHit) return { nodeId: null, evidence: [] }; // fuzzy/stray alone -> defer
  const margin = topScore > 0 ? secondScore / topScore : 1;
  if (margin >= marginThreshold) return { nodeId: null, evidence: [] };  // ambiguous -> defer
  return { nodeId: topId, evidence: topEvidence };
}

function resolveIndex(index, promptText, marginThreshold = 0.75, floor = 0.3, weights) {
  return resolveIndexDetailed(index, promptText, marginThreshold, floor, weights).nodeId;
}

// DB-backed convenience for the UserPromptSubmit hook. Builds the index from the
// project's notes each call (all string ops; no model). Caller passes the margin.
function resolveByProjectIndexDetailed(db, promptText, marginThreshold = 0.75, floor = 0.3, weights) {
  // Optional layer: any failure (e.g. a db without getNotes) returns null so
  // resolution falls through to the embedding layer rather than breaking.
  try {
    const notes = db.getNotes({ limit: 5000 });
    if (!notes || !notes.length) return { nodeId: null, evidence: [] };
    // Head layers only: the surface SHOWS the head note, so relevance must be judged
    // against what would be shown. Superseded layers accumulate weeks of dead
    // vocabulary (measured live: bookkeeping tokens in dead layers drew surfaces
    // for prompts unrelated to the head).
    const heads = notes.filter((n) => n.superseded_by === null || n.superseded_by === undefined);
    if (!heads.length) return { nodeId: null, evidence: [] };
    const index = buildIndex(heads.map((n) => ({ node_id: n.node_id, text: n.note_text })));
    return resolveIndexDetailed(index, promptText, marginThreshold, floor, weights);
  } catch {
    return { nodeId: null, evidence: [] };
  }
}

function resolveByProjectIndex(db, promptText, marginThreshold = 0.75, floor = 0.3, weights) {
  return resolveByProjectIndexDetailed(db, promptText, marginThreshold, floor, weights).nodeId;
}

// Learned bootstrap vocabulary — replaces the old hardcoded demo keyword map.
// The candidates are the project's OWN feature nodes (rows assignFeature created
// from real edits), so the vocabulary grows per-project over time instead of
// firing on generic words in any repo. A prompt "names" a feature only when it
// contains ALL name tokens of that feature's country (stopword-filtered, word
// boundaries via the tokenizer). The caller uses this solely to nudge a first
// note onto a note-LESS feature; features with notes are the index's job above.
function resolveBootstrapFeature(db, promptText) {
  try {
    const feats = db.getAllFeatures();
    if (!feats || !feats.length) return null;
    const pt = new Set(nameTokens(promptText));
    if (!pt.size) return null;
    let best = null;
    let bestLen = 0;
    for (const f of feats) {
      const name = nameTokens(String(f.country || '').replace(/[/_-]/g, ' '));
      if (!name.length) continue;
      if (!name.every((t) => pt.has(t))) continue;
      const len = name.join('').length; // most specific (longest) name wins ties
      if (len > bestLen) { best = f.node_id; bestLen = len; }
    }
    return best;
  } catch {
    return null; // optional layer: a db without getAllFeatures must not break resolution
  }
}

module.exports = {
  tokens, buildIndex, resolveIndex, resolveIndexDetailed,
  resolveByProjectIndex, resolveByProjectIndexDetailed, resolveBootstrapFeature,
};
