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

It's a **hook-based Claude Code plugin**. No edits are ever blocked, nothing leaves your machine, and it works with zero configuration. Real-time nudging works best in the **terminal**; Desktop and web sessions are recovered retrospectively (see "Where It Works Best" below).

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

## 🧠 Feature Memory

This is the layer that makes DevGuard more than a linter. As the agent works, DevGuard maps each edit to a **feature** (a "country" on a conceptual map, e.g. `ui_ux/filter`, `security/auth`) and keeps **one living note per feature**.

**How a note is born and grows:**

1. When you prompt about a feature DevGuard has seen, a `UserPromptSubmit` hook surfaces the current note into context: *"Respect this earlier decision and build on it."*
2. When the turn ends, a `Stop` hook reads the transcript and harvests the `[DG-NOTE ui_ux/filter] ...` line the agent was asked to leave. No manual command, no CLI call.
3. The new note **supersedes** the old one: exactly one "head" note per feature, with full history retained behind it.

So the memory is **captured automatically from the session and pushed back proactively** next time. It is not something you write by hand or remember to query. DevGuard also tracks **compliance**: after surfacing a note, it classifies the follow-up edit as `complied` / `ignored` / `superseded`, so the memory's actual influence is measurable, not assumed.

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
| 4 | `cycle:embedding` | Semantic similarity: "increase timeout" ≈ "extend retry interval" (MiniLM cosine) | <1ms* |
| 5 | `protect:check` | Git-blame protection zones | <5ms |

*\*Pre-computed vectors read from SQLite. The embedding model only loads in PostToolUse (async, off the hot path), never in the pre-edit hook.*

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
| **Claude Desktop (Code)** | 🟡 Capture | Current Desktop builds dispatch `SessionStart`/`PostToolUse` (verified live), so edits are recorded and memory accumulates in real time. The pre-edit thinking trigger is not verified on Desktop, so treat live *prevention* as terminal-first. |
| **claude.ai/code (web)** | ❌ Not verified | No live hook verification yet; web sessions are recovered via transcript backfill below. |

### Transcript Backfill: recovering the blind spots

So non-terminal work isn't invisible, DevGuard **replays missed edits from Claude Code's transcript logs**. On every terminal `SessionStart` it scans `~/.claude/projects/*.jsonl` (Desktop, web, and subagent sessions included), extracts the `Edit`/`Write`/`MultiEdit` calls no hook captured, and backfills them: attributed to the real project, idempotent (a per-transcript byte cursor plus a unique `tool_use_id` index), and bounded so startup stays fast.

**What this buys you:** cycle history, memory, and stats stay complete across terminal/Desktop switches. **What it doesn't:** recovery is *retrospective*; real-time prevention remains terminal-only.

## ⚙️ Configuration

Create `devguard.config.yaml` in your project root (all settings optional):

```yaml
# Detection sensitivity
similarity_threshold: 0.70       # L2/L3 similarity threshold (0.0-1.0)
min_occurrences: 2               # Matches before first warning
window_size: 10                  # Recent changes to analyze

# Behavior
periodic_injection_interval: 20  # Edits between auto-summaries (0 = disable)
embedding_enabled: true          # Enable L3 semantic detection
intervention_enabled: true       # false = passive (measure but inject nothing)

# Adaptive intelligence
adaptive_threshold: true         # Thompson Sampling per-pattern learning
auto_promote_enabled: true       # Auto-adjust thresholds from feedback
```

## 📊 Commands

```bash
/devguard:devguard-stats      # Session and project statistics
/devguard:devguard-dogfood    # Review detection events (for plugin development)
/devguard:devguard-spheremap  # Interactive HTML map of the feature sphere
```

## 📈 Effectiveness

DevGuard measures itself on two separate axes, kept apart on purpose because they answer different questions.

### 1. Detection accuracy (controlled)

Across 12 controlled scenarios covering all detection levels, precision and recall are high. **Honest caveat:** these are *designed* scenarios. In real-world use, false positives do occur (most notably cross-file embedding similarity flagging unrelated edits) and thresholds are tuned down as those are found. Treat the controlled numbers as "the detector fires on the patterns it's meant to," not as a real-world false-positive guarantee.

### 2. Intervention effectiveness (blind A/B)

Does the memory layer actually change the output? Measured with **20 synthetic feature-extension tasks**, each run twice in isolated `claude -p` sessions, one with DevGuard's memory surfaced (`intervention_enabled: true`) and one without, then scored by a **blind, position-swapped LLM judge** that doesn't know which arm is which.

| Metric | Result |
|--------|--------|
| Memory-arm win rate | **20 / 20** (Wilson 95% CI **[0.84, 1.0]**) |
| Decision consistency | memory **3.0 / 3** vs control **0.25 / 3** |
| Prior note surfaced | 20 / 20 valid pairs |
| Functional test pass | memory 100% · control 95% |

**Honest caveats:** this is a *synthetic* benchmark of the **memory channel** (does surfacing a prior decision make the agent honor it?), not a proxy for general coding quality. The strongest evidence is the mechanical consistency/surfaced numbers; the win rate should be read knowing the judge is given the seeded decisions as context. It is not a substitute for long-horizon real-world usage, which is an ongoing measurement via the dogfood tooling.

**Reproduce it yourself:** the full A/B harness and all 20 task definitions live in this repo under `tests/ab-harness/`. Don't take the number on faith, run it.

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
│   ├── cycle-detector.js        # L1-L3 detection + test repeat
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
