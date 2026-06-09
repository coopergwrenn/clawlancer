---
name: higgsfield-cloud
description: Generate AI videos and images (Higgsfield Cloud). Use when the user asks to make/create a video, clip, animation, or image, or to animate a photo.
---

# AI Video & Image Studio

Create videos and images for the user through the InstaClaw video gate. You
**submit, wait, and deliver the result here in the conversation** — there's no
separate inbox; when it's done you just send it.

## The flow (always)

1. Figure out **what** they want (image vs video) and **how** (see Model picking).
2. Tell them it's starting: *"Creating that now — it usually takes 2–5 minutes. I'll send it right here when it's ready."*
3. Run the generator (it submits and waits for completion):
   ```bash
   python3 ~/.openclaw/skills/higgsfield-cloud/scripts/higgsfield-cloud.py generate \
     --kind video --quality fast --prompt "<vivid description>" --image-url "<url>" --json
   ```
4. Read the exit + JSON and act:
   - **`status: completed`** → send the `url` to the user (deliver the video/image in your reply).
   - **`status: failed` / `nsfw`** → *"That one didn't render this time — want me to tweak the idea and try again?"* (nsfw: *"I couldn't make that one — let's adjust it and retry."*)
   - **`status: timeout`** → *"Still rendering — give me a moment."* then re-check:
     `... higgsfield-cloud.py status --request-id <id> --json`
   - **`status: blocked` / `needs_image`** → read `message` and follow it (below).

## Picking the model (G8)

Pass `--kind` + `--quality`; the script maps to the right Cloud model.

- **Image** → `--kind image`. (Fast, effectively free.)
- **Video, default** → `--kind video --quality fast` — the standard clip. **Use this unless they ask for more.** Free within the daily allowance.
- **Video, higher quality (short)** → `--quality hq`.
- **Video, premium / longer (~10s)** → `--quality premium`.
- You can also pass `--model <name>` explicitly (`lite`, `hq`, `kling`, `soul`).

**Not available yet** — if the user names **Seedance, Veo, Sora, Runway, Wan, lip-sync/talking-avatar**, or asks for **clips longer than ~10s**: say it's *not available yet* and offer a standard clip or image instead. Don't pretend it works.

## Video needs a source image (important)

Every video model animates an **image** (image→video). So:
- They gave you a photo / image URL → animate it: `--kind video --image-url "<url>"`.
- **No image** ("make a video of a dragon") → make the **image first**, then animate it:
  1. *"I'll create the image first, then bring it to life."*
  2. `generate --kind image --prompt "a dragon ..."` → get the image `url`.
  3. `generate --kind video --image-url "<that url>" --prompt "the dragon breathes fire ..."`.

## Free allowance (current phase)

Today, **standard clips (fast) and images are free** within a daily allowance.
Premium/HQ clips will need credits, which **aren't purchasable yet**.

- **`blocked` with reason `free_exhausted`** → *"You've used today's free generations — they reset at midnight UTC. Want me to try again tomorrow, or tweak something now?"*
- **`blocked` with reason `insufficient_credits`** (they asked for premium/HQ) → *"Premium clips need credits, which aren't available just yet — but I can make you a standard clip right now for free. Want that?"* then run `--quality fast`.

Default to the **free** options; mention premium only as *coming soon*. Don't promise paid generation.

## Notes

- Be **specific** in prompts (subject, action, setting, lighting, style) — it makes the output far better.
- Don't expose raw `request_id`s, slugs, or JSON to the user — just deliver the result or a clear, friendly status.
- Auth + endpoint are automatic (the script reads `GATEWAY_TOKEN`; the gate meters everything). You don't manage keys.
