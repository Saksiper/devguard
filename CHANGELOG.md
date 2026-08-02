# Changelog

All notable changes to DevGuard are documented here.

## 0.5.2

### Changed
- **Note capture now prefers the hook payload over re-parsing the transcript.**
  The `Stop` hook reads the turn's final assistant text from the payload's
  `last_assistant_message` field (present on Stop/SubagentStop as of recent
  Claude Code builds; CC's own docs point hooks at it) for both `[DG-NOTE]`
  capture and ack harvest. `SessionEnd` has no such field (measured absent in
  5/5 live runs) and older clients don't send it — those paths keep the
  transcript fallback, so nothing regresses on old versions.

### Fixed
- **Short final replies no longer mis-attribute the turn's answer.**
  `getLastAssistantText` silently skipped assistant replies under 10 characters
  ("DONE", "OK") and returned the PREVIOUS message as if it were the turn's
  answer — so an ack or note could be harvested from the wrong turn. Measured
  across 502 real transcripts: 11 divergences (2.19%), none of them the
  tool-call fragments the floor was presumed to protect against. The floor is
  gone; a DG marker is structurally longer than 10 characters, so no capture
  is lost by returning short finals.

### Removed
- **`cycle:embedding` detector retired.** Real-world ground truth settled it: the
  semantic-similarity detector produced 0 true positives against 73 classified
  false positives, ever (its warns fired on distinct forward-progress edits whose
  descriptions were naturally similar). Honest history: it ran default-ON from
  April 2026 to 2026-07-01 — all 639 of its detections and every classified FP
  come from that era — then was gated opt-in and never fired again; every public
  release shipped with it off. After the June-2026 same-file scoping fix it fired
  only 11 more times inside one ~15-hour window (4 classified FP, 0 TP) — a thin
  but zero-TP post-fix sample. Its target signal overlaps `cycle:diff_match`.
  Only the detector is gone — embeddings are still computed per edit and still
  power feature clustering and the post-compact summary. The retired config keys
  (`embedding_detector_enabled`, `embedding_similarity_threshold`) are now
  ignored if present in a user config.

## 0.5.1

### Changed
- **Feature notes are now asked to be short.** The instruction Claude receives when
  leaving or continuing a `[DG-NOTE]` now requests a single short sentence (aim under
  ~140 characters); the same brevity hint was added to the local seed-note prompt.
  On real usage, short notes are followed far more often than long ones, which get
  truncated at injection. Note wording only; the 300-character safety cap is unchanged.

## 0.5.0

### Added
- **Seed purpose-notes (cold-start fix).** When a new file's feature first appears,
  DevGuard now writes a one-sentence "lasting purpose" note for it using a small local
  model (Qwen3-1.7B). A fresh project starts accumulating memory from the very first
  edit instead of staying empty until you happen to leave a note yourself. Generation
  runs in a **detached background process** — nothing blocks your session, and, like
  everything else in DevGuard, it stays on your machine.
- `seed_note_enabled` config setting, **on by default**. Turn it off with
  `seed_note_enabled: false`, or the env vars `DEVGUARD_LLM_DISABLED=1` /
  `DEVGUARD_OFFLINE=1`.

### Heads-up
- On first use this triggers a **one-time ~1.3GB local model download**. DevGuard shows
  a one-time notice at session start before it happens. Set `DEVGUARD_LLM_DISABLED=1`
  (or `DEVGUARD_OFFLINE=1`) to skip it entirely.

## 0.4.1
- Fixed PostToolUseFailure capture: read `input.error` (the real measured payload), so
  failing commands are actually recorded.

## 0.4.0
- Self-healing install (auto-runs `npm install` on first launch when deps are missing)
  and a learning source-aware vocabulary. See git history for detail.
