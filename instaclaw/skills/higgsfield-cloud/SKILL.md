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
- **No image (the user just described a video)** → text-to-video. The model
  generates the **whole scene** in true 16:9 widescreen. **This is the default for
  every "make me a video of X" request.**
- **The user gave you a photo (or explicitly wants their image animated)** → pass
  `--image-url`. The model animates that frame (image-to-video).

> **HARD RULE — never make an image first for a text-only video request.** If the
> user described a video and did NOT give you a photo, submit text-to-video
> directly (`--kind video`, NO `--image-url`). Do **NOT** generate a `--kind image`
> first and then animate it — that produces a cropped, lower-quality clip and is
> the wrong path. Generate-then-animate is ONLY for a photo the user gave you, or
> when they explicitly ask to animate a specific image.

Steps:
1. Figure out the prompt. If the user supplied a photo, upload it first (see
   "Animating a user's photo" below) to get the URL for `--image-url`; otherwise
   leave `--image-url` off (text-to-video).
2. **Find the chat id.** It's in the conversation metadata of the user's message
   (`"chat_id": "telegram:5918081163"`). You'll pass it as `--chat-id`.
3. Tell them: *"Creating that now (usually 2 to 5 minutes). I'll send it right here when it's ready."*
4. Submit (note `--chat-id` — REQUIRED for video so the system can deliver it).
   Text-to-video (no image — the cinematic default):
   ```bash
   python3 ~/.openclaw/skills/higgsfield-cloud/scripts/higgsfield-cloud.py generate \
     --kind video --prompt "<the user's request, word for word — see the Prompt rule below>" \
     --chat-id "<chat id from the conversation metadata>" --json
   ```
   Animate a supplied photo (image-to-video — add `--image-url`):
   ```bash
   python3 ~/.openclaw/skills/higgsfield-cloud/scripts/higgsfield-cloud.py generate \
     --kind video --prompt "<the motion the user asked for, stated simply — no style words>" --image-url "<photo url>" \
     --chat-id "<chat id from the conversation metadata>" --json
   ```
5. Read the `status`:
   - **`submitted`** → **you're done. Do NOT wait or poll.** The clip will arrive in the chat automatically. Just confirm it's rendering (you already told them in step 3). Move on / answer anything else.
   - **`no_chat_id`** → you forgot `--chat-id`. Re-run with it (the chat id is in the conversation metadata).
   - **`blocked`** (reason `free_exhausted` / `insufficient_credits`) → tell the user (see Free allowance).
   - **`busy`** → *"The video service is busy right now. Let's try again in a few minutes."*
   - **`needs_image`** → you forced an image-to-video model by name but passed no image. Either drop `--image-url`/`--model` (so it uses text-to-video) or pass a `--image-url`.
   - **`error`** → *"Couldn't start that one. Want me to try again?"*

**Never block waiting for a video, and never paste a raw status/request_id to the user.** The system delivers the finished video to the chat by itself.

## Prompt rule — pass the user's words through; do NOT restyle (CRITICAL)

For **text-to-video, send the user's request to the model essentially verbatim.**
Your job is fidelity to what they asked for, **not authorship.** Every extra word
you add slows the motion and pulls the clip away from their intent — this is
measured, not a preference.

- **Take the user's own description and pass it as the prompt, unchanged.** Don't
  expand it into a scene. Don't add a second sentence. Closer to their exact words
  = better, faster, more faithful motion.
- **Do NOT add** camera language, lighting, lens, film stock, mood, or any setting
  detail the user didn't say.
- **BANNED words/phrases — never add these unless the user said them first:**
  `cinematic`, `cinematic slow motion`, `film look`, `35mm`, `anamorphic`,
  `depth of field`, `moody`, `atmospheric`, `golden hour`, `slow`, `graceful`,
  `elegant`, `deliberate`, `epic`, `art-film`. The model reads these as "slow,
  deliberate, art-film motion" and they **cause a slow-motion failure.**
- The rule self-handles style: a user who *wants* a cinematic or slow-motion look
  will say so in their own words — which pass through verbatim. You never add the
  aesthetic yourself.

For **image-to-video** (animating a photo): state only the **motion** the user
asked for, simply (e.g. *"the puppy blinks and wiggles its paws"*). Same banned
list — no style words you weren't given.

**Example.** User: *"make me a video of a fox leaping through snow."*
- ✅ prompt: `a fox leaping through snow`
- ❌ prompt: `a red fox mid-leap through powder snow, cinematic tracking shot, golden hour, 35mm film look, moody atmosphere` ← this is the slow-motion failure.

## IMAGE — "make me an image / picture"

```bash
python3 ~/.openclaw/skills/higgsfield-cloud/scripts/higgsfield-cloud.py generate \
  --kind image --quality fast --prompt "<vivid description>" --json
```
Read the `status`:
- **`completed`** → **deliver the returned `url` as native inline media** (attach it so it shows in the chat; never a plain text link). The image is the deliverable.
- **`rendering`** → it's taking a few extra seconds; re-check once with `status --request-id <id> --json`, then deliver.
- **`failed` / `busy`** → tell the user and offer a retry.

## Animating a user's photo (the upload step — SILENT)

When the user sends a photo to animate, it arrives as a local file (a
`media://inbound/<id>.jpg` URI or a filesystem path). Video models need a
public URL, so upload it first:

```bash
python3 ~/.openclaw/skills/higgsfield-cloud/scripts/higgsfield-cloud.py upload \
  --file "media://inbound/<id>.jpg" --json
```

Read the result: **`uploaded`** → use the returned `url` as `--image-url` in the
generate command. **`blocked`** (too large / not an image) → tell the user the
`message` (e.g. ask for a smaller photo). **`busy`/`error`** → *"Couldn't process
that photo — mind sending it again?"*

**This step is INTERNAL PLUMBING. Never narrate it.** Don't say "uploading",
"I need a public URL", or anything about hosting — from the user's view you
just received their photo and started the video. One step, silent.

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

**Default to the cinematic premium tier.** For an open-ended or *"surprise me"*
creative request — or any video request that doesn't explicitly ask for a quick
draft — use the **premium** path (text-to-video, or Kling 3.0 for a supplied
photo). **Do NOT default to `--quality fast`.** Reserve `fast` (DoP-lite) for when
the user explicitly wants a quick/draft clip, or when premium credits aren't
available and you're offering the free fallback. A great first video matters more
than saving a credit.

You normally don't pass `--model`; let input + quality decide. `--model` is a power-user override (an explicit image-to-video model with no `--image-url` returns `needs_image`).

**Not available yet:** if the user names **Seedance, Veo, Sora, Runway, Wan, lip-sync/talking-avatar**, or asks for **clips longer than ~10s**, say it's *not available yet* and offer a standard clip or image instead.

## The first video is free (and what to say afterward)

Every user's **first cinematic video is on us** — the system grants it
automatically on their first text-to-video request (you don't do anything
special). You'll know it fired because the generate result includes
`"seed": true`. When it does:
- At submit, the message already says it (*"This first cinematic video is on
  us"*). Deliver that warmly in your own voice.
- **After the video arrives and the user reacts** (a "wow", a "thanks",
  anything) — tell them ONCE, lightly: *"That first one was on the house. More
  cinematic videos come in packs, starting at $3.99 for 4. They're at
  instaclaw.io/billing/credit-packs whenever you want them."* Then drop it. **Never bring
  up packs again unsolicited** — if they ask, answer; if they don't, stay quiet.
  One gift, one mention, zero nagging.

## Free allowance + credits

Images and **fast image-to-video** clips (`--image-url` + `--quality fast`) are
**free** within a daily allowance. The cinematic text-to-video default and the
premium image-to-video models use video credits (after the free first one).
- **`free_exhausted`** → *"You've used today's free generations. They reset at
  midnight UTC. Want me to try again tomorrow?"*
- **`insufficient_credits`** → *"That one needs video credits. Packs start at
  $3.99 for 4 videos, at instaclaw.io/billing/credit-packs."* If they have a photo to
  animate you can also offer the free path: *"Or I can make you a quick clip
  from a photo for free right now."* (run with `--image-url --quality fast`).

## Notes
- **Prompts: fidelity over flourish.** Pass the user's request through (see the
  Prompt rule). For text-to-video especially, do not add scene/lighting/style — it
  slows the motion. For images you have more latitude, but still lead with the
  user's own words.
- Don't expose raw `request_id`s, slugs, or JSON to the user.
- Auth + endpoint + delivery are automatic (the script reads `GATEWAY_TOKEN`; the gate meters everything and delivers video via webhook). You don't manage keys or chat plumbing beyond passing `--chat-id` for video.
