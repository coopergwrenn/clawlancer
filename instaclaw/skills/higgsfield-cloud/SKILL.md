---
name: higgsfield-cloud
description: Make videos and images — the default path for ANY new video or image on this agent. Use whenever the user asks to make/create a video, clip, animation, or image, or to animate a photo. (For extending an EXISTING video, use higgsfield-video instead.)
---

# AI Video & Image Studio

Create videos and images for the user through the InstaClaw video gate. **Video and
image deliver differently — read this carefully:**

- **VIDEO is hands-off.** You **submit** it and tell the user it's rendering. The
  system sends the finished clip to their chat **on its own** when it's ready
  (1-5 min later) — **you do NOT wait for it, poll it, or send it yourself.** You
  pass the chat id at submit so the system knows where to deliver.
- **IMAGE is immediate.** The generator returns the image URL right away; **you**
  send the image (or use it as the first frame of a video).

## Hard rules — do not violate

1. **This skill is the ONLY path for new videos and images.** If a command here
   returns `blocked`, `busy`, or `error`, you **MUST NOT** retry the request on
   `higgsfield-video`, `sjinn-video`, or any other skill. Those are not
   substitutes — `higgsfield-video` is exclusively for extending an EXISTING
   video, never for making a new one.
2. **On `blocked`, tell the user the exact reason — do not invent one.** If the
   reason is `free_exhausted`, say the free videos for today are used up (they
   reset at midnight UTC). If it's `insufficient_credits`, say video credits
   aren't available yet. **Never** tell the user "the service is out / down /
   broken" — a `blocked` is a quota answer, not an outage. Report what actually
   happened, then stop.
3. **Never silently route around a failure.** Surfacing a real `blocked`/`error`
   to the user is correct behavior; quietly using a different skill to paper
   over it is not.

## VIDEO — "make me a video / clip / animation / animate this"

**Two paths, picked automatically by what you pass:**
- **No image (just a description)** → text-to-video. The model generates the
  **whole scene** in cinematic 16:9 widescreen. This is the default and the best
  look — use it whenever the user just describes a video. **You do NOT need to
  make an image first.**
- **The user gave you a photo (or you want to animate a specific image)** → pass
  `--image-url`. The model animates that frame (image-to-video).

Steps:
1. Figure out the prompt. If the user supplied a photo, grab its URL for `--image-url`; otherwise leave it off (text-to-video).
2. **Find the chat id.** It's in the conversation metadata of the user's message
   (`"chat_id": "telegram:5918081163"`). You'll pass it as `--chat-id`.
3. Tell them: *"Creating that now — usually 2 to 5 minutes. I'll send it right here when it's ready."*
4. Submit (note `--chat-id` — REQUIRED for video so the system can deliver it).
   Text-to-video (no image — the cinematic default):
   ```bash
   python3 ~/.openclaw/skills/higgsfield-cloud/scripts/higgsfield-cloud.py generate \
     --kind video --prompt "<vivid description of the whole scene>" \
     --chat-id "<chat id from the conversation metadata>" --json
   ```
   Animate a supplied photo (image-to-video — add `--image-url`):
   ```bash
   python3 ~/.openclaw/skills/higgsfield-cloud/scripts/higgsfield-cloud.py generate \
     --kind video --prompt "<what should happen>" --image-url "<photo url>" \
     --chat-id "<chat id from the conversation metadata>" --json
   ```
5. Read the `status`:
   - **`submitted`** → **you're done. Do NOT wait or poll.** The clip will arrive in the chat automatically. Just confirm it's rendering (you already told them in step 3). Move on / answer anything else.
   - **`no_chat_id`** → you forgot `--chat-id`. Re-run with it (the chat id is in the conversation metadata).
   - **`blocked`** (reason `free_exhausted` / `insufficient_credits`) → tell the user (see Free allowance).
   - **`busy`** → *"The video service is busy right now — let's try again in a few minutes."*
   - **`needs_image`** → you forced an image-to-video model by name but passed no image. Either drop `--image-url`/`--model` (so it uses text-to-video) or pass a `--image-url`.
   - **`error`** → *"Couldn't start that one — want me to try again?"*

**Never block waiting for a video, and never paste a raw status/request_id to the user.** The system delivers the finished video to the chat by itself.

## IMAGE — "make me an image / picture"

```bash
python3 ~/.openclaw/skills/higgsfield-cloud/scripts/higgsfield-cloud.py generate \
  --kind image --quality fast --prompt "<vivid description>" --json
```
Read the `status`:
- **`completed`** → **deliver the returned `url` as native inline media** (attach it so it shows in the chat; never a plain text link). The image is the deliverable.
- **`rendering`** → it's taking a few extra seconds; re-check once with `status --request-id <id> --json`, then deliver.
- **`failed` / `busy`** → tell the user and offer a retry.

## Text-to-video vs animate-a-photo

- **"Make a video of a dragon"** (no photo) → just submit `--kind video` with the
  description. Text-to-video generates the whole scene in true 16:9 widescreen.
  One generation. **No image step.**
- **"Animate this photo" / they gave you an image** → pass `--image-url`. The model
  animates that frame.
- **KNOWN LIMIT:** an image you generate here (`--kind image`, a "soul" frame) caps
  at about **4:3 landscape**, not full 16:9 — so animating a generated soul image
  produces a near-landscape clip, *not* true widescreen. For a cinematic 16:9 clip,
  prefer **text-to-video** (no image). Only go image-to-video when the user
  specifically wants *their* image moving.

## Picking the model

The script picks the model from your **input + `--quality`** automatically:
- **Image** → `--kind image` (fast, effectively free).
- **Video, no image (text-to-video)** → premium cinematic model (Kling 3.0),
  native 16:9. This is the default; just don't pass `--image-url`.
- **Video, with `--image-url` (animate a photo):**
  - default / `--quality premium` → Kling 3.0 (best motion).
  - `--quality standard` → Kling 2.6.
  - `--quality fast` → DoP-lite (cheapest, draws from the free allowance).

You normally don't pass `--model`; let input + quality decide. `--model` is a power-user override (an explicit image-to-video model with no `--image-url` returns `needs_image`).

**Not available yet:** if the user names **Seedance, Veo, Sora, Runway, Wan, lip-sync/talking-avatar**, or asks for **clips longer than ~10s**, say it's *not available yet* and offer a standard clip or image instead.

## Free allowance (current phase)

Images and **fast image-to-video** clips (`--image-url` + `--quality fast`) are
**free** within a daily allowance. The cinematic text-to-video default and the
premium image-to-video models need credits.
- **`free_exhausted`** → *"You've used today's free generations — they reset at midnight UTC. Want me to try again tomorrow?"*
- **`insufficient_credits`** → *"That one needs video credits, which aren't available just yet. I can make you a fast clip from a photo for free — want that?"* (if they have an image to animate, run with `--image-url --quality fast`).

## Notes
- Be **specific** in prompts (subject, action, setting, lighting, style).
- Don't expose raw `request_id`s, slugs, or JSON to the user.
- Auth + endpoint + delivery are automatic (the script reads `GATEWAY_TOKEN`; the gate meters everything and delivers video via webhook). You don't manage keys or chat plumbing beyond passing `--chat-id` for video.
