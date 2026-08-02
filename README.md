<p align="center">
  <img src="https://img.shields.io/badge/🛡_DevGuard-Memory_%26_Self--Correction_for_Claude_Code-1a1a2e?style=for-the-badge&labelColor=0d0d1a" alt="DevGuard" />
</p>

<p align="center">
  <a href="https://github.com/Saksiper/devguard/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Saksiper/devguard/ci.yml?style=flat-square&label=CI&logo=github" alt="CI" /></a>
  <img src="https://img.shields.io/badge/tests-1389-brightgreen?style=flat-square" alt="Tests" />
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License" />
  <img src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node" />
  <img src="https://img.shields.io/badge/Claude_Code-plugin-7c3aed?style=flat-square" alt="Claude Code Plugin" />
</p>

<p align="center">
  <em>A memory and self-correction layer for Claude Code: it remembers your past decisions and nudges the agent when it starts going in circles.</em>
</p>

---

You've probably watched Claude undo a fix it made an hour ago, or loop on the same error three times. DevGuard is a quiet layer that notices and nudges. It does two things:

1. **Remembers decisions per feature.** When you come back to a part of the codebase you've worked on before, DevGuard surfaces the note it left last time (*"last time, filtering was made case-insensitive and sorted ascending"*) so the agent builds on the earlier decision instead of silently contradicting it.
2. **Interrupts repeating loops.** When the agent is about to retry a failing approach, re-apply a similar fix, or overwrite code that was written to fix an earlier bug, DevGuard injects a short message into its thinking: the *"wait, let me reconsider"* pause.

It's a **hook-based Claude Code plugin**. No edits are ever blocked, nothing leaves your machine, and it works with zero configuration. Real-time nudging works best in the **terminal**; Desktop records edits live too, and anything a hook misses is recovered from the transcript afterwards (see "Where It Works Best" below).

```
I'm DevGuard, a secondary mechanism set up by the user.

I noticed the following:
- You've tried increasing the setTimeout interval twice before.
  Both attempts resulted in ECONNREFUSED on port 5432.

If you agree: abandon this approach and try a different strategy.
If you disagree: explain your reasoning and proceed.
```

The agent reads this in its own thinking and either changes course or explains why it's continuing. A nudge, not a gate.

## ⚡ Quick Start

```bash
/plugin marketplace add Saksiper/devguard
/plugin install devguard@devguard-marketplace
```

Then start a new session. That's it. DevGuard needs one native module (SQLite) that the marketplace doesn't build, so on first launch it builds it itself: a one-time step (about 30 seconds) after which it is active in that same session. No manual `npm install`, no configuration.

> If the automatic build can't run (no network, or `npm` isn't on your PATH), DevGuard says so at session start and tells you the one command to run by hand. It never fails silently.

**Updating.** New versions ship to the marketplace. To pull one:

```bash
/plugin marketplace update          # refresh the catalog from GitHub
/plugin update devguard             # upgrade the installed plugin
```

Then restart Claude Code. Marketplace autoUpdate alone does not reliably refresh a plugin's bundled hooks (a known Claude Code limitation), so run the explicit update after each release.

## 🧠 Feature Memory

This is the layer that makes DevGuard more than a linter. As the agent works, DevGuard maps each edit to a **feature** (a "country" on a conceptual map, e.g. `ui_ux/filter`, `security/auth`) and keeps **one living note per feature**.

**How a note is born and grows:**

1. When you prompt about a feature DevGuard has seen, a `UserPromptSubmit` hook surfaces the current note into context: *"Respect this earlier decision and build on it."*
2. When the turn ends, a `Stop` hook reads the transcript and harvests the `[DG-NOTE ui_ux/filter] ...` line the agent was asked to leave. No manual command, no CLI call.
3. The new note **supersedes** the old one: exactly one "head" note per feature, with full history retained behind it.

So the memory is **captured automatically from the session and pushed back proactively** next time. It is not something you write by hand or remember to query. DevGuard also tracks **compliance**: after surfacing a note, it classifies the follow-up edit as `complied` / `ignored` / `superseded`, so the memory's actual influence is measurable, not assumed.

**The first note writes itself.** Step 2 above has a catch: on a brand-new file the agent hasn't left a marker yet, so there is nothing to surface (a cold start). DevGuard closes that gap with a small local model (Qwen3-1.7B). The first time a new file's feature appears, a detached background process reads the file and writes its lasting purpose as a low-confidence *seed* note, which a real `[DG-NOTE]` later supersedes. Nothing blocks, nothing leaves your machine; first use triggers a one-time ~1.3GB model download, and it is off with `seed_note_enabled: false`.

**How a prompt finds its feature:** there is no hardcoded keyword list. The resolver builds its vocabulary from the project's own notes and feature names, so it works in whatever language you write, tolerates word-form changes ("filtering" still reinforces `filter`), and only surfaces a note when the match evidence is strong. Every surfaced note records exactly which words triggered it, and a note whose source file has been deleted from the project retires automatically instead of resurfacing forever.

> **Honest scope:** auto-capture depends on the agent emitting the note it was prompted to leave. It's an *auto-harvested prompted marker*, not passive inference of intent. In practice the marker is left reliably, but it's not zero-effort magic.

A visual map of the whole graph (continents = domains, countries = features, layered notes as tooltips) can be generated with `node tools/dg-spheremap.js`.

## 🔍 Cycle Detection

Before every `Edit`/`Write`, a middleware pipeline checks for repetition, each stage catching what the previous might miss:

| # | Middleware | What it checks | Speed |
|---|-----------|---------------|-------|
| 1 | `cycle:error_hash` | Same error recurring this session | <1ms |
| 2 | `cycle:diff_match` | Similar code changes (Jaccard similarity) | <1ms |
| 3 | `cycle:test_repeat` | Same test failing repeatedly | <1ms |
| 4 | `protect:check` | Git-blame protection zones | <5ms |

> **Retired (2026-08):** a fourth stage, `cycle:embedding` (MiniLM semantic similarity), was removed after real-world ground truth: 0 true positives ever against 73 classified false positives. The honest history: it ran default-ON from April to July 2026 (that era produced all of its detections and every classified FP), was then gated opt-in and never fired again — every public release shipped with it off. What it aimed to catch overlaps `cycle:diff_match`. The embedding model itself stays — it powers feature clustering and the post-compact summary, just not a detector.

Detection is **warn-only** and section-aware: editing five different functions in one file won't trip the alarm; a single level only warns, and promotion to a stronger signal requires multiple independent levels agreeing.

### Protection Layer

Via git blame, DevGuard tracks **which lines were added for which fix**. If the agent is about to remove code written for a previous bug while working on something unrelated:

```
I noticed the following:
- The code at lines 42-48 was added to fix "XSS vulnerability in auth handler".
  You're now removing it to address a different issue.

If you agree: find an alternative that preserves the existing fix.
If you disagree: explain your reasoning and proceed.
```

## 🧩 How It Works

DevGuard is a **thinking trigger**, not a gatekeeper.

```
Blocking:  Detection → Block → Agent finds workaround → Protection bypassed → Zero value
DevGuard:  Detection → Context injection → Agent thinks → Better decision
```

The mechanism is Claude Code's `hookSpecificOutput.additionalContext`, which goes straight into the agent's extended thinking. DevGuard **pushes** the note or warning in unsolicited; it does not rely on the agent choosing to query anything. Everything is gated behind a single `intervention_enabled` flag (used as the control/treatment switch in the effectiveness measurement below).

## 🛡 Session Continuity

When Claude Code compacts its context (losing earlier work), DevGuard injects a structured summary: active issues, protected fixes, recent error patterns, and the files with the most edits. This also runs periodically (~every 20 edits) to keep the agent oriented. The summary is kept fresh: months-old issues and protection zones whose files no longer exist are filtered out instead of being repeated forever.

## 🖥 Where It Works Best

DevGuard is hook-based, and Claude Code dispatches hooks differently across surfaces:

| Surface | Real-time detection | Notes |
|---------|:-------------------:|-------|
| **Terminal Claude Code** | ✅ Full | Every edit passes through the pipeline *before* it happens; the thinking trigger and note-surfacing fire live. **This is where DevGuard is strongest.** |
| **Subagents (`Task` tool)** | ✅ Capture | A subagent's `Edit`/`Write` fires the same `PreToolUse`/`PostToolUse` hooks as the main thread (verified live; the payload even names the agent via `agent_id`/`agent_type`), so subagent work lands in memory as it happens. |
| **Claude Desktop (Code)** | 🟡 Capture | Documented — *"hooks and skills defined in settings apply to both"* ([Desktop docs](https://code.claude.com/docs/en/desktop)) — and verified live: Desktop dispatches `SessionStart`/`PostToolUse`, so edits are recorded and memory accumulates in real time. The pre-edit thinking trigger is not verified on Desktop, so treat live *prevention* as terminal-first. |
| **claude.ai/code (web)** | ❌ Not verified | No live hook verification yet; web sessions are recovered via transcript backfill below. |

### Transcript Backfill: the safety net

Hooks cover the surfaces above, so backfill is not how Desktop or subagent work gets recorded — it's the net under **everything a hook can miss**. DevGuard **replays missed edits from Claude Code's transcript logs**: on every terminal `SessionStart` it scans `~/.claude/projects/*.jsonl`, extracts the `Edit`/`Write`/`MultiEdit` calls no hook captured, and backfills them — attributed to the real project, idempotent (a per-transcript byte cursor plus a unique `tool_use_id` index), and bounded so startup stays fast.

**What it catches:** sessions from a surface that didn't dispatch hooks (web), a hook that errored or was killed mid-flight, and transcripts from before you installed DevGuard. **What it doesn't:** recovery is *retrospective*; real-time prevention remains terminal-first.

## ⚙️ Configuration

Create `devguard.config.yaml` in your project root (all settings optional):

```yaml
# Detection sensitivity
similarity_threshold: 0.70       # L2 Jaccard similarity threshold (0.0-1.0)
min_occurrences: 2               # Matches before first warning
window_size: 10                  # Recent changes to analyze

# Behavior
periodic_injection_interval: 20  # Edits between auto-summaries (0 = disable)
embedding_enabled: true          # Embedding infra: feature clustering + summaries
intervention_enabled: true       # false = passive (measure but inject nothing)
seed_note_enabled: true          # Auto-write a "purpose" note when a new file appears

# Adaptive intelligence
adaptive_threshold: true         # Thompson Sampling per-pattern learning
auto_promote_enabled: true       # Auto-adjust thresholds from feedback
```

When `seed_note_enabled` is on (the default), the first time a new file's feature is seen
DevGuard runs a small local model (Qwen3-1.7B) to write that file's lasting purpose as a
note. This happens in a **detached background process** (nothing blocks) and, like
everything else, stays on your machine. On first use it triggers a **one-time ~1.3GB model
download** (you get a one-time heads-up). To turn it off: `seed_note_enabled: false`, or the
env var `DEVGUARD_LLM_DISABLED=1` (or `DEVGUARD_OFFLINE=1` to stay fully offline).

## 📊 Commands

```bash
/devguard:devguard-stats      # Session and project statistics
/devguard:devguard-dogfood    # Review detection events (for plugin development)
/devguard:devguard-spheremap  # Interactive HTML map of the feature sphere
```

## 📈 Effectiveness

DevGuard measures itself on two separate axes, kept apart on purpose because they answer different questions.

### 1. Detection accuracy (controlled)

Across 12 controlled scenarios covering all detection levels, precision and recall are high. **Honest caveat:** these are *designed* scenarios. In real-world use, false positives do occur (historically, most notably the since-retired embedding-similarity detector flagging unrelated edits) and thresholds are tuned down as those are found. Treat the controlled numbers as "the detector fires on the patterns it's meant to," not as a real-world false-positive guarantee.

**Measured reality check** (first labeled dogfood batch, 2026-08: a deterministic 45-event sample of real detection logs): the cross-file embedding-similarity detector's real-world precision was **~0 on this sample**; its warnings fired on distinct forward-progress edits whose descriptions were naturally similar during focused work (most sampled FPs predate a June-2026 scoping fix; after that fix the detector fired only 11 more times in a single ~15-hour window — 4 classified FP, 0 TP — and no era ever produced a true positive). The protection detector produced the sample's one true positive overall. That evidence retired the embedding detector outright (2026-08, see the Cycle Detection section); the embedding model still powers feature clustering. Synthetic precision and real-world precision are different quantities; don't quote one as the other.

### 2. Intervention effectiveness (blind A/B)

Does the memory layer actually change the output? Measured with isolated `claude -p` pairs, one arm with DevGuard's memory surfaced (`intervention_enabled: true`) and one without, scored by a **blind, position-swapped LLM judge** that doesn't know which arm is which, across three task groups kept separate on purpose:

| Task group | Valid pairs | Memory-arm result |
|------------|-------------|-------------------|
| Synthetic showcase | 20 | **20 W** (saturated; see caveat) |
| Real-project tasks | 5 | **3 W / 1 L / 1 T** |
| Negative controls (harm probe) | 16 | 3 W / 4 L / 9 T; **no harm detected** |

**Synthetic showcase (20/20, Wilson 95% CI [0.84, 1.0]; consistency 3.0/3 vs 0.25/3).** Read this as a saturated benchmark: the 20 tasks are variants of just **three templates** (7 filter / 7 search / 6 auth), all shaped "extend a feature whose seeded note helps", and the judge is given the seeded decisions as context. The CI therefore overstates precision (the effective independent units are closer to the 3 template families), and 20/20 mostly proves the memory transport channel works, not that DevGuard wins 100% of real work.

**Real-project tasks (3/5).** Five tasks derived from a real production side project, same harness: the memory arm won 3, lost 1, tied 1 (consistency 3.0/3 vs 2.2/3). The honest signal: on realistic tasks a strong model often **infers project conventions without any note** (the no-memory arm scored 3/3 on three of five tasks). Memory helps most when conventions are non-obvious, and it does not always win.

**Negative controls (16 pairs, 8 tasks × 2 replicas).** These measure DevGuard's real risk (injecting a note at the wrong time) and are excluded from the win rates above by construction:
- *Irrelevant note* (6 pairs): an off-topic note is force-surfaced into the memory arm. Result: 1 W / 2 L / 3 T, functional tests 100% in both arms, cost and turns ~equal. No measurable harm, and the memory arm *not* winning here is itself evidence the judge isn't biased toward the note arm.
- *Misleading note* (6 pairs): the seeded note contradicts the task's current spec; following it is scored as failure. Result: the memory arm **resisted the stale note in 6/6 pairs** (3/3 current-spec consistency, judge 1 W / 0 L / 5 T) and finished in fewer turns than the control arm.
- *No note* (4 pairs): hooks on, empty memory. Turns identical (7.0 vs 7.0), cost overhead ~$0.03/task (~5%).

Framing: this is a **falsification probe at small n, not a powered comparison**: 4 decisive memory-arm losses vs 3 wins across 16 valid control pairs is noise around a null, with full functional-test parity. 11 additional control pairs errored on CLI usage limits mid-run; they are documented in the report and excluded from every metric.

**Honest caveats:** synthetic numbers measure the **memory channel**, not general coding quality; the judge sees the seeded decisions for showcase tasks; the misleading controls test the *easy* resistance case (the requirement change is stated in the prompt). Long-horizon real-world effect is still an open measurement; see the dogfood reality check above, including the embedding detector's ~0 real-world precision.

**Reproduce it yourself:** the harness, all 33 task definitions (including the 8 negative controls) and the merged run report (`tests/ab-harness/ab-effectiveness-report-n41.json`) live in this repo under `tests/ab-harness/`. Don't take the numbers on faith, run it.

## 🏗 Architecture

```
src/
├── hooks/                       # Claude Code hook entry points
│   ├── pre-edit.js              # 🔍 Cycle + protection pipeline (PreToolUse)
│   ├── post-edit.js             # 📝 Record changes, embeddings, feature node
│   ├── post-command.js          # 🔴 Capture errors, detect commits
│   ├── post-compact.js          # 💾 Session summary generation
│   ├── session-start.js         # 🚀 Init, cleanup, transcript backfill
│   ├── user-prompt-submit.js    # 💉 Surface feature notes + pending summaries
│   └── stop.js                  # 🧠 Harvest [DG-NOTE] markers into memory
├── engine/                      # Core logic modules
│   ├── db.js                    # SQLite (V17 migrations, multi-tenant)
│   ├── cycle-detector.js        # L1/L2 detection + test repeat
│   ├── embedding.js             # MiniLM-L6-v2 (local, lazy download)
│   ├── feature-classifier.js    # Edit → continent/country node (nearest-centroid)
│   ├── keyword-index.js         # Learned per-project vocabulary (prompt → feature)
│   ├── note-capture.js          # Transactional single-head note capture
│   ├── dg-note.js               # [DG-NOTE] marker format + hardened parse
│   ├── file-fingerprint.js      # Note staleness (source-file hash)
│   ├── protection.js            # Git blame-based fix tracking
│   ├── message-builder.js       # Thinking-trigger message formatting
│   ├── adaptive-threshold.js    # Thompson Sampling per-pattern
│   ├── sanitize.js              # 22+ secret patterns, Unicode NFKC
│   ├── backfill.js              # Replay missed edits from transcript logs
│   └── ...                      # config, blame-cache, normalize-path, etc.
├── cli/                         # stats.js, dogfood.js
└── tools/
    └── dg-spheremap.js          # Visual feature-graph (HTML): search / filter / neighbor nav
```

## 🔒 Security

- **Secret sanitization**: 22+ gitleaks patterns (API keys, JWTs, connection strings, tokens); all text is sanitized before it reaches the database
- **Marker hardening**: `[DG-NOTE]` markers inside fenced or quoted content are ignored, so text echoed from repo files cannot plant a persistent note or fake compliance
- **Unicode normalization**: NFKC + control character + zero-width character stripping
- **Path protection**: null-byte injection, NTFS ADS, UNC path, DOS device name rejection
- **Multi-tenant isolation**: every query is scoped to `project_path`; no cross-project data leakage
- **Local-only**: all data stays in a local SQLite database. Nothing leaves your machine.

## 🤝 Contributing

*A note on the why: I kept watching Claude Code contradict its own earlier decisions, and wanted a quiet second pair of eyes. DevGuard is free and MIT; if it helps you too, that's the whole goal. Issues and PRs welcome.*

```bash
git clone https://github.com/Saksiper/devguard.git
cd devguard
npm install
npm test          # full suite
npm run lint      # ESLint
```

Debug mode:
```bash
DEVGUARD_DEBUG=1  # Verbose stderr logging from all hooks
```

## License

MIT
