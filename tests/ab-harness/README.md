# A/B harness

Runs paired live `claude -p` sessions on the same task — **passive** (DevGuard installed but not intervening) vs **active** (intervening) — and scores the two outputs with a blind pairwise judge. Task bank: `tasks.json` (cycle-mode, sphere-mode, ALES, and misleading negative controls). Reports land here as `ab-*.json`.

## Reading a report

- `summary.active_win_rate` is computed over `valid_pairs`, not `total_pairs` — `errored_pairs` are excluded, so always read both numbers together.
- Negative controls (`ctrl-*`) are supposed to show **no** active advantage. An active win there is a red flag, not a success.
- `proxy_means` are session-shape proxies (cycle warnings, change count, turns), not quality. Quality is the judge verdict.

## Compliance labels: when to distrust them

Note-compliance outcomes (`complied` / `ignored` / `superseded` / `lapsed`) come from two different places:

| Label | Written by | Means |
|---|---|---|
| `complied` | Stop / SessionEnd ack harvest | The reply acknowledged a surfaced note |
| `ignored` | `SessionEnd` → `finalizeNoteCompliance` | The session closed cleanly without acknowledging |
| `lapsed` | `SessionStart` → `finalizeStaleSessions` | The session never finalized; a later session swept it up hours afterwards |

**Rule: if a report contains `lapsed`, treat that run's compliance numbers with caution.** `lapsed` means `SessionEnd` did not finalize that session. Measured on CC 2.1.220 (2026-08-02): whether `SessionEnd` fires at all depends on how long the `Stop` hook holds the session open — a fast `Stop` can let `claude -p` exit before `SessionEnd` starts. So `lapsed` is the visible symptom of a skipped `SessionEnd`, and the ack/ignore split for that run is unreliable.

Reports produced so far (`ab-effectiveness-report-n41.json`, `ab-report-controls.json`) contain `complied` and `ignored` but **no** `lapsed` — i.e. `SessionEnd` did run in those batches and their compliance labels are trustworthy.
