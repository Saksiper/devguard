# Changelog

All notable changes to DevGuard are documented here.

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
