---
name: "Higgsfield AI Video"
description: "AI video, image, and audio generation via 200+ models — included in your plan"
---

# Higgsfield AI Video Production

```yaml
name: higgsfield-video
version: "2.1.0"
updated: "2026-03-09"
author: InstaClaw
phase: production
triggers:
  keywords: [higgsfield, muapi, kling, wan, sora, veo, seedance, hailuo, luma, runway, pika, pixverse, hunyuan, flux, ideogram, recraft, text-to-video, image-to-video, t2v, i2v, ai video, generate video, make a video, create video, video generation, ai image, generate image]
  phrases: ["make me a video", "create a video of", "animate this image", "generate an image", "create a story video", "multi-shot video"]
  NOT: [the director, sjinn, motion graphics, remotion]
dependencies:
  tools: [python3]
```

---

## DO NOT IMPROVISE — MANDATORY RULES

**These rules are NON-NEGOTIABLE. Violating any rule is a critical failure.**

### Rule 0: ALWAYS Use Scripts
NEVER construct raw API calls, curl commands, or HTTP requests. ALWAYS use the provided Python scripts:
- `~/.openclaw/skills/higgsfield-video/scripts/higgsfield-generate.py` — Core generation
- `~/.openclaw/skills/higgsfield-video/scripts/higgsfield-character.py` — Character management
- `~/.openclaw/skills/higgsfield-video/scripts/higgsfield-story.py` — Multi-scene stories
- `~/.openclaw/skills/higgsfield-video/scripts/higgsfield-audio.py` — Audio generation
- `~/.openclaw/skills/higgsfield-video/scripts/higgsfield-edit.py` — Video editing
- `~/.openclaw/skills/higgsfield-video/scripts/higgsfield-status.py` — Job tracking
- `~/.openclaw/skills/higgsfield-video/scripts/higgsfield-setup.py` — Status & credit checks
- `~/.openclaw/skills/higgsfield-video/scripts/higgsfield-upload-telegram-image.py` — Telegram/local image → CDN URL

### Rule 1: Max 3 Retries Per Operation
If a generation fails 3 times, STOP and report the failure. Do NOT keep retrying indefinitely.

### Rule 2: Context Budget
Keep generation output under 50KB. Use `--json` flag and extract only relevant fields. Do NOT dump full API responses into the conversation.

### Rule 3: Error Classification
- **TRANSIENT** (retry): HTTP 429, 500, 502, 503, network timeouts → retry with backoff
- **PERMANENT** (stop): HTTP 400, 401, 403, invalid model → report error, do not retry
- **DANGEROUS** (escalate): Unexpected charges, wallet errors → stop immediately, alert user

### Rule 4: Pre-Generation Credit Check
Before ANY generation, check available credits:
```bash
python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-setup.py credits --type video --model kling-3.0 --duration 5 --json
```
Tell the user the cost: "This video will use about 80 credits. You have 420 remaining."

### Rule 5: Check Setup First
Before any generation, verify the gateway token is configured:
```bash
python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-setup.py status --json
```
If no gateway token, the skill is not properly installed.

---

## Credit System

Higgsfield is included in your plan. Generations consume credits from your daily pool (shared with LLM messages).

### Credit Weights

| Generation Type | Credits | Examples |
|----------------|---------|----------|
| **Images** | | |
| Fast (Flux Schnell) | 10 | Quick drafts, thumbnails |
| Standard (Flux Dev/Pro) | 20 | General images |
| Premium (Ideogram 3, Recraft, Seedream, GPT Image) | 40 | High-quality images |
| **Video** | | |
| Short video (5s) | 80 | Quick clips |
| Long video (10s) | 150 | Standard videos |
| Extended video (20s, Sora) | 250 | Long-form |
| Image-to-video (5s) | 100 | Animate an image |
| Image-to-video (10s) | 180 | Longer animation |
| **Audio** | | |
| Music (Suno) | 40 | Song generation |
| SFX (MMAudio) | 30 | Sound effects |
| Video-to-audio sync | 50 | Audio matching |
| Lip sync | 60 | Lip movement sync |
| **Editing** | | |
| Effects/style transfer | 60 | Visual effects |
| Extend video (generic) | 80 | Add duration via URL |
| Seedance 2.0 extend (5s) | 80 | Chain by request_id |
| Seedance 2.0 extend (10s) | 100 | Chain by request_id |
| Seedance 2.0 extend (15s) | 150 | Chain by request_id |
| Upscale | 50 | Resolution increase |
| Face swap | 100 | Face replacement |
| Translate | 80 | Language translation |
| **Multi-shot** | | |
| Story (3 scenes) | ~400 | Full story pipeline |

### Credit Exhaustion UX Rules

1. **Pre-gen check feels helpful**: "This video will use about 80 credits. You have 420 remaining." — informative, not gatekeeping
2. **Credit exhaustion leads with reset**: "Your credits reset at midnight" FIRST, then optionally mention packs with the exact URL: https://instaclaw.io/billing/credit-packs — clarify these are media credits, separate from daily message units
3. **Max 1 upsell per session**: Track via `~/.openclaw/workspace/higgsfield/session_upsell_shown`. Never nag
4. **No "you need to buy"**: Always frame as option, not requirement
5. **NEVER send users to /dashboard?buy=credits for Higgsfield credit issues** — those are LLM message credits, not media credits. Always use https://instaclaw.io/billing/credit-packs

---

## First Contact — Setup Check

If the user has never used Higgsfield before:
1. Check status: `python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-setup.py status --json`
2. If `gateway_token_configured: true` and `proxy_connected: true` → ready to go
3. If not → the skill needs reinstallation via https://instaclaw.io/dashboard/skills

---

## Commands Reference

### Core Generation

| Action | Command |
|--------|---------|
| Text-to-video (async, preferred) | `python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-generate.py text-to-video --prompt "..." --model kling-3.0 --submit-only --json` |
| Text-to-video (sync, short jobs) | `python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-generate.py text-to-video --prompt "..." --model kling-3.0 --json` |
| Image-to-video (async, preferred) | `python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-generate.py image-to-video --image <url> --prompt "..." --model kling-3.0 --submit-only --json` |
| Image-to-video (sync, short jobs) | `python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-generate.py image-to-video --image <url> --prompt "..." --model kling-3.0 --json` |
| Text-to-image | `python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-generate.py text-to-image --prompt "..." --model flux-schnell --json` |
| Check status | `python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-generate.py status --id <request_id> --json` |
| Upload file | `python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-generate.py upload-file --file <path> --json` |
| Upload Telegram image | `python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-upload-telegram-image.py --telegram-file-id <id> --json` |
| Upload local file to CDN | `python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-upload-telegram-image.py --file <path> --json` |

### Async Video Generation (PREFERRED for all video)

**ALWAYS use `--submit-only` for video generation.** Video takes 2-8 minutes depending on the model. Polling synchronously freezes the conversation and leaves the user in silence.

**The correct pattern:**

1. **Submit with `--submit-only`** — returns instantly with a `request_id`
```bash
python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-generate.py text-to-video \
  --prompt "A cowboy rides into the sunset" --model kling-3.0 --submit-only --json
# Returns: {"status": "submitted", "request_id": "abc-123", "message": "Job submitted..."}
```

2. **Immediately tell the user** — set expectations:
> "Your video is generating now (Kling 3.0, ~2-4 minutes). I'll check back shortly and deliver the link when it's ready."

3. **After ~3 minutes, check status:**
```bash
python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-generate.py status --id abc-123 --json
```

4. **If still processing**, wait another minute and check again. If completed, deliver the URL.

5. **Never leave the user in silence** during generation. Always tell them:
   - What model is being used
   - How long it typically takes
   - That you'll check back automatically

**When to use sync mode (no `--submit-only`):** Only for images (flux-schnell takes <10s) or when the user explicitly says "wait for it."

### Video Parameters

| Parameter | Values |
|-----------|--------|
| `--model` (video) | kling-3.0, kling-2.0, wan-2.2, wan-2.5, sora, sora-2, veo-3, veo-3.1, seedance-2.0, seedance-lite, seedance-pro, seedance-pro-fast, seedance-1.5-pro, seedance-1.5-pro-fast, hailuo, luma, runway, pixverse, hunyuan |
| `--model` (image) | flux-schnell, flux-dev, flux-pro, ideogram-3, ideogram-v3, recraft-v3, seedream-4.5, gpt-image-1, gpt-image-1.5, midjourney-v7, google-imagen4, hunyuan-image, wan-image |
| `--aspect-ratio` | 16:9, 9:16, 1:1, 4:3, 3:4 |
| `--duration` | 5, 10, 15 (seconds, model-dependent — Seedance 2.0 supports 15s) |
| `--resolution` | 720p, 1080p (model-dependent) |

### Setup & Credits

| Action | Command |
|--------|---------|
| Check status | `python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-setup.py status --json` |
| Credit check | `python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-setup.py credits --type video --model kling-3.0 --duration 5 --json` |
| Quick test | `python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-setup.py test --json` |

### Character System

| Action | Command |
|--------|---------|
| Create character | `python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-character.py create --name "..." --description "..." --ref-image <url> --json` |
| List characters | `python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-character.py list --json` |
| Use in generation | `python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-character.py use --name "..." --json` |
| Delete character | `python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-character.py delete --name "..." --json` |

### Story Mode (Multi-Scene)

| Action | Command |
|--------|---------|
| Plan story | `python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-story.py plan --outline "..." --scenes 3 --json` |
| Generate scenes | `python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-story.py generate --plan-file <path> --json` |
| Assemble video | `python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-story.py assemble --plan-file <path> --json` |
| Check status | `python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-story.py status --plan-file <path> --json` |

### Audio

| Action | Command |
|--------|---------|
| Generate music | `python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-audio.py music --prompt "..." --json` |
| Sound effects | `python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-audio.py sfx --prompt "..." --json` |
| Video-to-audio sync | `python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-audio.py sync --video <url> --json` |
| Lip sync | `python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-audio.py lipsync --video <url> --audio <url> --json` |

### Video Editing

| Action | Command |
|--------|---------|
| Apply effects | `python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-edit.py effects --video <url> --effect <name> --json` |
| Extend video (generic) | `python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-edit.py extend --video <url> --prompt "..." --json` |
| **Seedance 2.0 extend** | `python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-edit.py seedance-extend --request-id <id> --duration 5 --json` |
| Translate | `python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-edit.py translate --video <url> --target-lang <lang> --json` |
| Style transfer | `python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-edit.py style --video <url> --style "..." --json` |
| Upscale | `python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-edit.py upscale --video <url> --json` |
| Face swap | `python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-edit.py face-swap --video <url> --face-image <url> --json` |

### Job Tracking

| Action | Command |
|--------|---------|
| Check job | `python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-status.py check --id <request_id> --json` |
| Active jobs | `python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-status.py active --json` |
| Job history | `python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-status.py history --limit 10 --json` |

---

## Model Selection Logic

### Video Models — When to Use What

| Scenario | Best Model | Why |
|----------|-----------|-----|
| **General purpose, best quality** | kling-3.0 | Best overall quality, character consistency, Elements support |
| **Realistic humans/faces** | kling-3.0 | Superior face rendering, lip movement |
| **Anime/stylized content** | wan-2.2 | Excels at anime, illustration styles |
| **Cinematic/film look** | veo-3.1 | Google's latest, strong cinematic quality |
| **Fast iteration/drafts** | hailuo | Fast generation, good for testing ideas |
| **Maximum creativity** | sora-2 | Strong at surreal, abstract, artistic content |
| **Motion control** | seedance-2.0 | Good camera control, precise motion |
| **Budget-conscious** | pixverse-v4 | Lower cost, decent quality |
| **Image animation** | kling-3.0 | Best I2V with Elements for consistency |

### Seedance 2.0 Tiers

| Tier | Speed | Quality | Use Case |
|------|-------|---------|----------|
| seedance-lite | Fastest | Good | Quick drafts, iteration |
| seedance-pro | Fast | High | General production |
| seedance-pro-fast | Faster | High | Production with speed priority |
| seedance-1.5-pro | Medium | Very high | Premium quality |
| seedance-1.5-pro-fast | Faster | Very high | Premium with speed |
| seedance-2.0 | Medium | Best | Top quality, supports extend/chaining |

### Seedance 2.0 Infinite-Length Workflow

Seedance 2.0 supports **infinite-length video** via chained extensions. This is DIFFERENT from the generic `extend` command (which takes a video URL). Seedance extend takes a `request_id` and chains from the original generation.

**Step 1: Generate the initial video**
```bash
python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-generate.py text-to-video \
  --prompt "A cowboy rides into the sunset" --model seedance-2.0 --duration 5 --json
# Returns: { "request_id": "abc-123", "output_url": "https://..." }
```

**Step 2: Extend by request_id**
```bash
python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-edit.py seedance-extend \
  --request-id abc-123 --duration 5 --json
# Returns: { "request_id": "def-456", "output_url": "https://..." }
```

**Step 3: Chain again (infinite)**
```bash
python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-edit.py seedance-extend \
  --request-id def-456 --prompt "He dismounts and walks into the saloon" --duration 10 --json
# Returns: { "request_id": "ghi-789", "output_url": "https://..." }
```

**Key differences from generic extend:**
- `seedance-extend` uses `--request-id` (not `--video` URL)
- Each extension returns a new `request_id` for further chaining
- Supports `--quality high|basic` and `--duration 5|10|15`
- Optional `--prompt` to guide the extension direction
- Only works with Seedance 2.0 generations (not other models)

### Image Models

| Scenario | Best Model |
|----------|-----------|
| **Fast/cheap** | flux-schnell |
| **High quality** | flux-pro, ideogram-3 |
| **Photorealistic** | seedream-4.5, gpt-image-1 |
| **Design/illustration** | recraft-v3 |
| **General purpose** | flux-dev |

Reference: `~/.openclaw/skills/higgsfield-video/references/model-selection-guide.md`

---

## Character Consistency System

For consistent characters across multiple generations:

1. **Create a character** with reference image and description
2. **Use Kling Elements** (kling-3.0): Pass `--elements-ref` with uploaded reference
3. **LoRA references**: For custom-trained character models
4. **Frame forwarding**: Use last frame of Scene N as first frame of Scene N+1 (image-to-video)

Workflow:
```
1. Create character profile → higgsfield-character.py create
2. Get character data → higgsfield-character.py use --name "..." --json
3. Include elements/LoRA refs in generation → higgsfield-generate.py text-to-video --elements-ref <ref>
```

Reference: `~/.openclaw/skills/higgsfield-video/references/character-consistency.md`

---

## Cinema Controls

For cinematic video generation, use prompt engineering with camera specifications:

- **Camera bodies**: ARRI Alexa 35, RED V-RAPTOR, Sony VENICE 2, Blackmagic URSA
- **Lenses**: Cooke S7/i, Zeiss Supreme Prime, Canon CN-E, Panavision Primo 70
- **Focal lengths**: 24mm (wide), 35mm (standard), 50mm (portrait), 85mm (telephoto)
- **Aperture**: f/1.4 (shallow DOF), f/2.8 (balanced), f/5.6 (deep focus)
- **Camera movements**: dolly in/out, crane up/down, steadicam tracking, handheld

Example prompt enhancement:
> "A cowboy walking into a saloon. Shot on ARRI Alexa 35, Cooke S7/i 50mm at f/2, dolly tracking shot, golden hour, film grain"

Reference: `~/.openclaw/skills/higgsfield-video/references/cinema-controls.md`

---

## Story Mode — Multi-Shot Pipeline

1. **Plan**: `higgsfield-story.py plan --outline "A cowboy's journey..." --scenes 5`
2. **Edit**: Customize scene prompts in the generated plan file
3. **Generate**: `higgsfield-story.py generate --plan-file <path>`
4. **Assemble**: `higgsfield-story.py assemble --plan-file <path>` (requires FFmpeg)

For character consistency in stories:
- Create character first
- Add `elements_ref` to each scene in the plan file
- Use frame-forwarding between scenes (use I2V with last frame of previous scene)

Reference: `~/.openclaw/skills/higgsfield-video/references/storytelling-patterns.md`

---

## Audio Integration

- **Background music**: `higgsfield-audio.py music --prompt "epic western soundtrack"`
- **Sound effects**: `higgsfield-audio.py sfx --prompt "gunshot ricochet"`
- **Video-synced audio**: `higgsfield-audio.py sync --video <url>` (AI-generated audio matching video)
- **Lip sync**: `higgsfield-audio.py lipsync --video <url> --audio <url>`

---

## Telegram Image Uploads (IMPORTANT)

When a user sends you an image in Telegram and asks you to animate it, edit it, or use it as a reference:

**The image-to-video command handles this automatically.** If you pass a Telegram `file_id` or local file path as `--image`, the script auto-detects it, downloads from Telegram, uploads to Muapi CDN, and uses the resulting URL. No extra steps needed:

```bash
# Telegram file_id — auto-resolved
python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-generate.py image-to-video \
  --image "AgACAgIAAxkBAAI..." --prompt "make this dance" --json

# Local file path — auto-resolved
python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-generate.py image-to-video \
  --image "/tmp/user-photo.jpg" --prompt "cinematic zoom in" --json

# HTTPS URL — passed through directly (no upload needed)
python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-generate.py image-to-video \
  --image "https://example.com/photo.jpg" --prompt "animate" --json
```

**For other commands** (editing, face-swap, style transfer) that need an image URL, use the standalone upload script first:

```bash
# Upload a Telegram image and get the CDN URL
python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-upload-telegram-image.py \
  --telegram-file-id "AgACAgIAAxkBAAI..." --json
# Output: { "status": "uploaded", "url": "https://cdn.muapi.ai/..." }

# Upload a local file
python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-upload-telegram-image.py \
  --file "/tmp/user-photo.jpg" --json
```

Then pass the returned `url` to the editing command as `--video` or `--face-image`.

**How it works behind the scenes:**
1. Telegram `file_id` → `GET /bot{token}/getFile` → `GET /file/bot{token}/{path}` → raw bytes
2. Raw bytes → `POST /api/v1/upload_file` (multipart FormData via proxy) → public CDN URL
3. CDN URL → passed to I2V/editing endpoint as `image_url` or `images_list`

---

## Telegram Delivery

After generation completes, if the user has Telegram configured:
1. Download the output URL
2. Send via Telegram using the existing Telegram integration
3. Include generation details (model, prompt summary)

---

## Safety Rails

1. **No NSFW content**: Do not generate explicit, violent, or harmful content
2. **No deepfakes**: Do not generate face-swap content without clear consent context
3. **No impersonation**: Do not generate content impersonating real people
4. **Credit awareness**: Always check credits before generation and inform the user
5. **Rate limiting**: Respect API rate limits, use retry with backoff

---

## Error Handling

1. **Gateway token missing**: Skill needs reinstallation via https://instaclaw.io/dashboard/skills
2. **Insufficient credits**: "Your credits reset at midnight — or grab a Higgsfield credit pack at https://instaclaw.io/billing/credit-packs to keep going (these are separate from your daily message credits)."
3. **Model unavailable**: Fall back to next-best model in the same category
4. **Generation failed**: Retry up to 3 times with exponential backoff
5. **Timeout**: Report timeout, suggest checking status later with request ID
6. **Network error**: Retry with backoff, suggest checking connectivity

Reference: `~/.openclaw/skills/higgsfield-video/references/safety-patterns.md`

---

## File Paths

| File | Path |
|------|------|
| SKILL.md | `~/.openclaw/skills/higgsfield-video/SKILL.md` |
| Setup script | `~/.openclaw/skills/higgsfield-video/scripts/higgsfield-setup.py` |
| Generate script | `~/.openclaw/skills/higgsfield-video/scripts/higgsfield-generate.py` |
| Character script | `~/.openclaw/skills/higgsfield-video/scripts/higgsfield-character.py` |
| Story script | `~/.openclaw/skills/higgsfield-video/scripts/higgsfield-story.py` |
| Audio script | `~/.openclaw/skills/higgsfield-video/scripts/higgsfield-audio.py` |
| Edit script | `~/.openclaw/skills/higgsfield-video/scripts/higgsfield-edit.py` |
| Status script | `~/.openclaw/skills/higgsfield-video/scripts/higgsfield-status.py` |
| Telegram upload | `~/.openclaw/skills/higgsfield-video/scripts/higgsfield-upload-telegram-image.py` |
| API reference | `~/.openclaw/skills/higgsfield-video/references/muapi-api.md` |
| Model guide | `~/.openclaw/skills/higgsfield-video/references/model-selection-guide.md` |
| Cinema controls | `~/.openclaw/skills/higgsfield-video/references/cinema-controls.md` |
| Characters | `~/.openclaw/workspace/higgsfield/characters.json` |
| Jobs | `~/.openclaw/workspace/higgsfield/jobs.json` |
| Stories | `~/.openclaw/workspace/higgsfield/stories/` |
| Session upsell | `~/.openclaw/workspace/higgsfield/session_upsell_shown` |

---

## Quality Checklist

Before delivering any generated content:
- [ ] Output URL is accessible and valid
- [ ] Content matches the user's request
- [ ] No NSFW or policy-violating content
- [ ] Credit cost was communicated before generation
- [ ] Telegram delivery attempted (if configured)
