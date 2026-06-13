# CLOSED: legacy video-prompt recovery (2026-06-12) — do not re-chase

**TL;DR for any future terminal:** video rows created before 2026-06-12 have no
`metadata.prompt` and most never will. The investigation is COMPLETE — every
recoverable prompt has been recovered. Do not re-run this hunt.

## What was recoverable, and what was done

- **7 prompts recovered verbatim** from vm-050's agent session transcripts
  (temporal request-id↔prompt pairing; written with
  `prompt_source: "vm_transcript_backfill_2026-06-12"`). Two more candidates
  were compaction-truncated ("a dragon ...") and deliberately NOT written —
  never write uncertain data as a user's verbatim words.

## Why the rest is permanently unrecoverable (all paths exhausted)

1. **Higgsfield does NOT echo prompts.** Probed live via
   `/api/admin/backfill-video-prompts` (probe mode, recursive prompt-field
   finder): the status response is exactly
   `{status, request_id, status_url, cancel_url, video}`. No prompt field
   anywhere at any depth.
2. **VM transcripts were compacted.** strip-thinking's own Rule-22/30
   machinery (tool-result truncation + turn dropping) removed most of the
   June 8-11 invocation history; only 119 higgsfield-bearing lines survived,
   yielding the 7 pairs above.
3. **The fox A/B/C/D arms and the crab-sweep renders were harness-submitted**
   (direct gate calls from a Claude terminal session whose transcript was
   itself compacted away). They never touched any VM transcript.
4. **Vercel runtime logs expired** (hours-scale retention; rows were days old).
5. **Telegram bot history is not API-readable** (bots cannot fetch past
   messages).

## The forward path (why this never recurs)

- The gate persists `metadata.prompt` on every render since main `ae3c62d6`
  (2026-06-12) — proven live on render `f1ef8134` ("a lighthouse keeper waving
  from the balcony at dawn"): prompt stored, searchable on prod minutes after
  settling.
- `/api/videos`'s hydration loop also opportunistically picks up a prompt if
  Higgsfield ever starts echoing one (defensive no-op today).
- The UI tells the truth: promptless rows show no overlay/quote (all prompt UI
  is conditional), and a zero-result search surfaces
  "N of your older videos were made before prompts were saved" via the API's
  `unsearchable_count`.

## Operational footnote

`/api/admin/backfill-video-prompts` (X-Admin-Key) remains deployed and
idempotent — useful only if a new prompt source ever materializes. Gotcha for
anyone scripting against admin routes: the admin key is base64 with a trailing
`=`; `cut -d= -f2` silently truncates it. Use a regex env loader.
