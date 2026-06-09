---
name: higgsfield-cloud
description: Generate AI videos and images (Higgsfield Cloud). Use when the user asks to make/create a video, clip, animation, or image, or to animate a photo.
---

# AI Video & Image Studio

Create videos and images for the user through the InstaClaw video gate. You
**submit, wait, then deliver the finished clip as native inline media in this
chat** (attach it so it plays directly; never a plain text link). There's no
separate inbox; you send the media yourself when it's ready.

## The flow (always)

1. Figure out **what** they want (image vs video) and **how** (see Model picking).
2. Tell them it's starting: *"Creating that now. It usually takes 2 to 5 minutes, and I'll send it right here when it's ready."*
3. Run the generator (it submits and waits for completion):
   ```bash
   python3 ~/.openclaw/skills/higgsfield-cloud/scripts/higgsfield-cloud.py generate \
     --kind video --quality fast --prompt "<vivid description>" --image-url "<url>" --json
   ```
4. Read the exit + JSON and act on the `status` field:
   - **`completed`** → **deliver the clip as native inline media** (see "Delivering the clip" below): attach the returned `url` as a video/image so it plays directly in the chat. **Never** paste the `url` as a plain text link.
   - **`failed` / `nsfw`** → *"That one didn't render this time. Want me to tweak the idea and try again?"* (nsfw: *"I couldn't make that one. Let's adjust it and retry."*)
   - **`timeout`** → *"Still rendering, give me a moment."* then re-check with:
     `... higgsfield-cloud.py status --request-id <id> --json` (if it's still rendering after a couple of re-checks over ~10 min, tell them it's taking unusually long and to try again later).
   - **`busy`** → the service is at capacity: *"The video service is busy right now. Let's try again in a few minutes."*
   - **`blocked` / `needs_image`** → read `message` and follow it (see below).

## Delivering the clip (do this every time)

When `status` is `completed`, deliver the `url` as **native inline media**, never as a link:
- Send the `url` as an **attached video** (clips) or **image** (images) so it **plays/shows directly in the chat**. Your message tool takes a media URL and renders it as real inline media. This is the **default and required** delivery here.
- A short caption is fine ("Here's your clip."). The **media itself** is the deliverable.
- **Never** post the raw `url` as plain text and consider it delivered. A link is not a delivery. The only time a link is acceptable is the explicit fallback message the script returns when native attachment is impossible (e.g. an oversized file), and even then prefer attaching.

## Picking the model (G8)

Pass `--kind` + `--quality`; the script maps to the right Cloud model.

- **Image** → `--kind image`. (Fast, effectively free.)
- **Video, default** → `--kind video --quality fast`, the standard clip. **Use this unless they ask for more.** Free within the daily allowance.
- **Video, higher quality (short)** → `--quality hq`.
- **Video, premium / longer (~10s)** → `--quality premium`.
- You can also pass `--model <name>` explicitly (`lite`, `hq`, `kling`, `soul`).

**Not available yet:** if the user names **Seedance, Veo, Sora, Runway, Wan, lip-sync/talking-avatar**, or asks for **clips longer than ~10s**, say it's *not available yet* and offer a standard clip or image instead. Don't pretend it works, and don't promise a length we can't deliver.

## Video needs a source image (important)

Every video model animates an **image** (image to video). So:
- They gave you a photo / image URL → animate it: `--kind video --image-url "<url>"`.
- **No image** ("make a video of a dragon") → make the **image first**, then animate it:
  1. *"I'll create the image first, then bring it to life."*
  2. `generate --kind image --prompt "a dragon ..."` → get the image `url`.
  3. `generate --kind video --image-url "<that url>" --prompt "the dragon breathes fire ..."`.
  Note this uses **two** free generations (the image and the video), so it counts double against the daily free allowance.

## Free allowance (current phase)

Today, **standard clips (fast) and images are free** within a daily allowance.
Premium/HQ clips will need credits, which **aren't purchasable yet**.

- **`blocked`, reason `free_exhausted`** → *"You've used today's free generations. They reset at midnight UTC. Want me to try again tomorrow, or tweak something now?"*
- **`blocked`, reason `insufficient_credits`** (they asked for premium/HQ) → *"Premium clips need credits, which aren't available just yet. I can make you a standard clip right now for free. Want that?"* then run `--quality fast`.

Default to the **free** options; mention premium only as *coming soon*. Don't promise paid generation.

## Notes

- Be **specific** in prompts (subject, action, setting, lighting, style). It makes the output far better.
- Don't expose raw `request_id`s, slugs, or JSON to the user. Just deliver the result or a clear, friendly status.
- Auth + endpoint are automatic (the script reads `GATEWAY_TOKEN`; the gate meters everything). You don't manage keys.
