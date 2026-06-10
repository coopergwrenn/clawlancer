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

1. Figure out the prompt + (for a NEW idea with no source image) plan to make an image first (see "Video needs a source image").
2. **Find the chat id.** It's in the conversation metadata of the user's message
   (`"chat_id": "telegram:5918081163"`). You'll pass it as `--chat-id`.
3. Tell them: *"Creating that now — usually 2 to 5 minutes. I'll send it right here when it's ready."*
4. Submit (note `--chat-id` — REQUIRED for video so the system can deliver it):
   ```bash
   python3 ~/.openclaw/skills/higgsfield-cloud/scripts/higgsfield-cloud.py generate \
     --kind video --quality fast --prompt "<vivid description>" --image-url "<url>" \
     --chat-id "<chat id from the conversation metadata>" --json
   ```
5. Read the `status`:
   - **`submitted`** → **you're done. Do NOT wait or poll.** The clip will arrive in the chat automatically. Just confirm it's rendering (you already told them in step 3). Move on / answer anything else.
   - **`no_chat_id`** → you forgot `--chat-id`. Re-run with it (the chat id is in the conversation metadata).
   - **`blocked`** (reason `free_exhausted` / `insufficient_credits`) → tell the user (see Free allowance).
   - **`busy`** → *"The video service is busy right now — let's try again in a few minutes."*
   - **`needs_image`** → make the image first (see below), then submit the video with that image URL.
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

## Video needs a source image (the text→image→video flow)

Every video model animates an **image**. If the user gave you a photo URL, use it.
If not ("make a video of a dragon"):
1. Make the image first: `generate --kind image --prompt "a dragon ..."` → get the `url`.
2. Animate it: `generate --kind video --image-url "<that url>" --chat-id "<id>" --prompt "the dragon breathes fire ..."`.
This uses **two** free generations (image + video) — counts double against the daily allowance.

## Picking the model

Pass `--kind` + `--quality`:
- **Image** → `--kind image` (fast, effectively free).
- **Video, default** → `--kind video --quality fast`. Use this unless they ask for more. Free within the daily allowance.
- **Video, higher quality** → `--quality hq`. **Premium / longer (~10s)** → `--quality premium`.

**Not available yet:** if the user names **Seedance, Veo, Sora, Runway, Wan, lip-sync/talking-avatar**, or asks for **clips longer than ~10s**, say it's *not available yet* and offer a standard clip or image instead.

## Free allowance (current phase)

Standard clips (fast) and images are **free** within a daily allowance; premium/HQ need credits, which **aren't purchasable yet**.
- **`free_exhausted`** → *"You've used today's free generations — they reset at midnight UTC. Want me to try again tomorrow?"*
- **`insufficient_credits`** (they asked for premium/HQ) → *"Premium clips need credits, which aren't available just yet. I can make you a standard clip right now for free — want that?"* then run `--quality fast`.

## Notes
- Be **specific** in prompts (subject, action, setting, lighting, style).
- Don't expose raw `request_id`s, slugs, or JSON to the user.
- Auth + endpoint + delivery are automatic (the script reads `GATEWAY_TOKEN`; the gate meters everything and delivers video via webhook). You don't manage keys or chat plumbing beyond passing `--chat-id` for video.
