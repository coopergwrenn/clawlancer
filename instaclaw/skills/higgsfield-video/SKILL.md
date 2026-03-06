---
name: "Higgsfield AI Video"
description: "AI video, image, and audio generation via 200+ models (Muapi.ai gateway)"
---

# Higgsfield AI Video Production

```yaml
name: higgsfield-video
version: "1.0.0"
updated: "2026-03-06"
author: InstaClaw
phase: production
triggers:
  keywords: [higgsfield, muapi, kling, wan, sora, veo, seedance, hailuo, luma, runway, pika, pixverse, hunyuan, flux, ideogram, recraft, text-to-video, image-to-video, t2v, i2v, ai video, generate video, make a video, create video, video generation, ai image, generate image]
  phrases: ["make me a video", "create a video of", "animate this image", "generate an image", "create a story video", "multi-shot video"]
  NOT: [the director, sjinn, motion graphics, remotion]
dependencies:
  env: [MUAPI_API_KEY]
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
- `~/.openclaw/skills/higgsfield-video/scripts/higgsfield-setup.py` — API key management

### Rule 1: Max 3 Retries Per Operation
If a generation fails 3 times, STOP and report the failure. Do NOT keep retrying indefinitely.

### Rule 2: Context Budget
Keep generation output under 50KB. Use `--json` flag and extract only relevant fields. Do NOT dump full API responses into the conversation.

### Rule 3: Error Classification
- **TRANSIENT** (retry): HTTP 429, 500, 502, 503, network timeouts → retry with backoff
- **PERMANENT** (stop): HTTP 400, 401, 403, invalid model → report error, do not retry
- **DANGEROUS** (escalate): Unexpected charges, wallet errors → stop immediately, alert user

### Rule 4: Confirm Before Expensive Operations
Before generating video (costs credits): confirm the prompt, model, and settings with the user. Images are cheaper — confirm only if the user hasn't specified clearly.

### Rule 5: Check Setup First
Before any generation, verify the API key is configured:
```bash
python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-setup.py status --json
```
If no key is found, guide the user through setup.

---

## First Contact — Setup Flow

If the user has never used Higgsfield before:
1. Check status: `python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-setup.py status --json`
2. If no API key: Ask user for their Muapi.ai API key (get one at https://muapi.ai)
3. Store key: `python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-setup.py setup --key <KEY>`
4. Validate: `python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-setup.py test --json`

---

## Commands Reference

### Core Generation

| Action | Command |
|--------|---------|
| Text-to-video | `python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-generate.py text-to-video --prompt "..." --model kling-3.0 --json` |
| Image-to-video | `python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-generate.py image-to-video --image <url> --prompt "..." --model kling-3.0 --json` |
| Text-to-image | `python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-generate.py text-to-image --prompt "..." --model flux-schnell --json` |
| Check status | `python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-generate.py status --id <request_id> --json` |
| Upload file | `python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-generate.py upload-file --file <path> --json` |

### Video Parameters

| Parameter | Values |
|-----------|--------|
| `--model` (video) | kling-3.0, kling-2.0, wan-2.2, sora-2, veo-3, veo-3.1, seedance-2.0, hailuo, luma, runway-gen4, pika-2.2, pixverse-v4, hunyuan |
| `--model` (image) | flux-schnell, flux-dev, flux-pro, ideogram-3, recraft-v3, seedream-4.5, gpt-image-1 |
| `--aspect-ratio` | 16:9, 9:16, 1:1, 4:3, 3:4 |
| `--duration` | 5, 10 (seconds, model-dependent) |
| `--resolution` | 720p, 1080p (model-dependent) |

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
| Extend video | `python3 ~/.openclaw/skills/higgsfield-video/scripts/higgsfield-edit.py extend --video <url> --prompt "..." --json` |
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
4. **Credit awareness**: Warn users about credit costs before expensive operations
5. **Rate limiting**: Respect API rate limits, use retry with backoff

---

## Error Handling

1. **API key invalid**: Guide user to https://muapi.ai for a new key
2. **Insufficient credits**: Alert user, suggest checking balance at muapi.ai
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
| API reference | `~/.openclaw/skills/higgsfield-video/references/muapi-api.md` |
| Model guide | `~/.openclaw/skills/higgsfield-video/references/model-selection-guide.md` |
| Cinema controls | `~/.openclaw/skills/higgsfield-video/references/cinema-controls.md` |
| Characters | `~/.openclaw/workspace/higgsfield/characters.json` |
| Jobs | `~/.openclaw/workspace/higgsfield/jobs.json` |
| Stories | `~/.openclaw/workspace/higgsfield/stories/` |
| API key | `~/.openclaw/.env` (MUAPI_API_KEY) |

---

## Quality Checklist

Before delivering any generated content:
- [ ] Output URL is accessible and valid
- [ ] Content matches the user's request
- [ ] No NSFW or policy-violating content
- [ ] Credit cost was communicated
- [ ] Telegram delivery attempted (if configured)
