# Sjinn AI Video Production Studio

```yaml
name: sjinn-video
version: 1.1.0
triggers:
  - video
  - animate
  - seedance
  - veo3
  - sora2
  - sjinn
  - tiktok video
  - youtube video
  - reel
  - product video
  - music video
  - podcast video
  - lip sync
  - make a video
  - turn this into a video
  - upscale video
  - add subtitles
dependencies:
  env:
    - GATEWAY_TOKEN
  tools:
    - curl
    - jq
```

## Overview

Sjinn is an AI video production platform providing access to **Seedance 2.0**, **Veo3**, **Sora2**, and a full creative pipeline. It uses a **dual API architecture**:

- **Agent API** — Submit a prompt, Sjinn's AI agent handles model selection, multi-shot composition, audio, and post-production automatically. Best for complex productions and when you want Sjinn to decide.
- **Tool API** — Direct access to specific models/tools for deterministic, single operations. Best when the user requests a specific model (Veo3, Sora2) or you need precise control.

**Billing:** All calls are proxied through the InstaClaw server. The agent never calls Sjinn directly — use the proxy endpoint with GATEWAY_TOKEN for authentication.

## Dependencies

- `GATEWAY_TOKEN` in `~/.openclaw/.env` (pre-deployed, platform-level)
- `curl` and `jq` (pre-installed on all VMs)
- No user setup required. If GATEWAY_TOKEN is missing: "Video generation isn't configured on your agent yet. Contact support to enable it."

---

## Tier 1: Core Video Generation

### Text-to-Video

**Flow:** User describes scene → Agent enhances prompt → Submit → Poll → Download → Send via Telegram

1. **Receive request** — User says "make a video of a sunset over Miami"
2. **Enhance the prompt** — Rewrite casual request into cinematic prompt with camera movements, lighting, atmosphere (see references/video-prompting.md)
3. **Confirm with user** — Show enhanced prompt + settings: "Here's my enhanced version — should I generate this?" (skip if user said "just do it")
4. **Choose API:**
   - If user specified a model (Veo3/Sora2) → **Tool API** with the matching tool_type
   - Otherwise → **Agent API** (lets Sjinn auto-select Seedance/best model)
5. **Submit:**

**Agent API (default):**
```bash
GATEWAY_TOKEN=$(grep GATEWAY_TOKEN ~/.openclaw/.env | cut -d= -f2)
RESPONSE=$(curl -s -X POST "https://instaclaw.io/api/gateway/sjinn?action=create" \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"api\": \"agent\", \"message\": \"$ENHANCED_PROMPT\", \"quality\": \"quality\"}")
CHAT_ID=$(echo "$RESPONSE" | jq -r '.data.chat_id')
```

**Tool API (when specific model requested):**
```bash
GATEWAY_TOKEN=$(grep GATEWAY_TOKEN ~/.openclaw/.env | cut -d= -f2)
RESPONSE=$(curl -s -X POST "https://instaclaw.io/api/gateway/sjinn?action=create" \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"api\": \"tool\", \"tool_type\": \"veo3-text-to-video-fast-api\", \"input\": {\"prompt\": \"$ENHANCED_PROMPT\", \"aspect_ratio\": \"16:9\"}}")
TASK_ID=$(echo "$RESPONSE" | jq -r '.data.task_id')
```

6. **Acknowledge:** "Generating your video now, this usually takes 2-5 minutes. I'll send it as soon as it's ready."
7. **Poll** — See Async Workflow section below
8. **Download** — `curl -sL "$CDN_URL" -o ~/workspace/videos/${SLUG}_$(date +%Y-%m-%d_%H-%M).mp4`
9. **Send via Telegram** — `sendVideo` (max 20MB reliable, 50MB hard limit). Include caption with prompt summary.
10. **Log** — Append to `~/memory/video-history.json`

### Image-to-Video

**Flow:** User sends photo → Save locally → Serve via Caddy → Submit URL to Tool API → Poll → Download → Send

1. User sends a photo via Telegram (with intent: "animate this", "make this move", "turn this into a video")
2. Save image to `~/workspace/tmp-media/` with unique name:
   ```bash
   UUID=$(cat /proc/sys/kernel/random/uuid)
   EXT="jpg"  # or png based on original
   cp /path/to/received/image.jpg ~/workspace/tmp-media/${UUID}.${EXT}
   ```
3. Serve via Caddy: `https://{hostname}/tmp-media/${UUID}.${EXT}`
4. Submit to Tool API (image-to-video requires Tool API):
   ```bash
   GATEWAY_TOKEN=$(grep GATEWAY_TOKEN ~/.openclaw/.env | cut -d= -f2)
   curl -s -X POST "https://instaclaw.io/api/gateway/sjinn?action=create" \
     -H "Authorization: Bearer $GATEWAY_TOKEN" \
     -H "Content-Type: application/json" \
     -d "{\"api\": \"tool\", \"tool_type\": \"veo3-image-to-video-fast-api\", \"input\": {\"prompt\": \"$PROMPT\", \"image_url\": \"https://${HOSTNAME}/tmp-media/${UUID}.${EXT}\"}}"
   ```
5. If Caddy not available: fallback to `curl -F "file=@image.jpg" https://transfer.sh/image.jpg` for temporary hosting
6. Poll, download, and send as with text-to-video

**If user sends image without video intent:** Ask "Would you like me to animate this photo into a video?"

### Quality Modes

| Mode | When to Use | Credits | Typical Time |
|------|-------------|---------|-------------|
| **quality** (default) | Final content, portfolio, posting | Higher | 3-8 min |
| **cheap** (fast) | Previews, drafts, testing prompts | Lower | 1-3 min |

- User says "quick video" / "just a draft" / "preview" → cheap mode
- User says "high quality" / "cinematic" / "final version" → quality mode
- If user is low on daily units → suggest cheap mode proactively

### Model Selection

| Trigger | API | Model | Duration | Audio |
|---------|-----|-------|----------|-------|
| No preference / auto | Agent API | Seedance 2.0 (auto) | Varies | Yes |
| "use Veo3" | Tool API | veo3-text-to-video-fast-api | 8s fixed | Yes |
| "use Sora2" | Tool API | sora2-text-to-video-api | 5s or 10s | Yes |
| "use Sora2 pro" | Tool API | sora2-text-to-video-api (mode: pro) | 5s or 10s | Yes |

---

## Tier 2: Advanced Production

### Multi-Shot Story Videos

Via **Agent API** with templates. User describes a story → Sjinn automatically scripts, storyboards, generates shots, and composes with transitions + audio.

```bash
GATEWAY_TOKEN=$(grep GATEWAY_TOKEN ~/.openclaw/.env | cut -d= -f2)
curl -s -X POST "https://instaclaw.io/api/gateway/sjinn?action=create" \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"api\": \"agent\", \"message\": \"$STORY_PROMPT\", \"template_id\": \"$TEMPLATE_ID\", \"quality\": \"quality\"}"
```

### Template IDs

| Template | ID | Use Case |
|----------|-----|----------|
| Veo3 Story Video | `9b371ec6-09a2-43d5-97c2-0aea79a12371` | Live-action consistent characters |
| Sora2 Story Video v2 | `de733710-fc66-4a2b-b53c-27b52c6c6f5e` | Anime/stylized consistent characters |
| Sora2 Extend | `d5db7e33-4ef6-4c6f-96be-b7e0a98f0706` | Extend existing Sora2 clip |
| Veo3 Extend | `1de0cc26-6bf9-4eed-a5a2-c62fe88aef52` | Extend existing Veo3 clip |
| Kids Short Video | `788acc9a-866b-4688-849e-7c7cfffaff54` | Children's content |
| Single Podcast | `071b3487-d689-4e9e-9125-f280fdb85e7a` | Single host podcast visual |
| Dual Podcast | `5d0cbc88-41d7-471a-88b3-7df276016de1` | Two hosts podcast visual |
| Music Video | `57a003c8-ea94-44a8-8e32-d2ec53ea780b` | Lyrics-synced music video |

### Platform-Specific Outputs

| Platform | Aspect Ratio | Duration | Style |
|----------|-------------|----------|-------|
| TikTok / Reels / Shorts | 9:16 | 15-60s | Fast cuts, trending |
| YouTube | 16:9 | 30s-5min | Cinematic |
| Instagram Feed | 1:1 or 4:5 | 15-30s | Clean, eye-catching |
| Twitter/X | 16:9 | 15-30s | Quick hook |
| Product Demo | 16:9 or 1:1 | 30-60s | Professional |
| Podcast | 16:9 | 1-5min | Talking head |

Auto-detect platform from user request ("make me a TikTok" → 9:16 vertical).

---

## Tier 3: Full Production Pipeline

Advanced tools available through Sjinn. See `references/video-production-pipeline.md` for complete details.

- **Image Generation** — Nano Banana, Nano Banana Pro, seedream 4.5, SJinn Image Edit
- **Audio Production** — TTS, background music, SFX, speech-to-text
- **Post-Production** — ffmpeg_full_compose (multi-clip), subtitles, lip sync, video upscaling, frame extraction, trimming

**Workflow example:** Generate character image → animate into video → add subtitles → add background music → compose final output.

---

## Async Workflow (CRITICAL)

Video generation takes 1-10+ minutes. This is NOT synchronous.

### Submit & Poll Loop

1. Receive request → enhance prompt → confirm with user
2. Submit to API → get `chat_id` (Agent API) or `task_id` (Tool API)
3. Acknowledge: "Generating your video now, 2-5 minutes."
4. **Poll loop:**

**Agent API:**
```bash
GATEWAY_TOKEN=$(grep GATEWAY_TOKEN ~/.openclaw/.env | cut -d= -f2)
while true; do
  RESULT=$(curl -s -X POST "https://instaclaw.io/api/gateway/sjinn?action=query" \
    -H "Authorization: Bearer $GATEWAY_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"api\": \"agent\", \"chat_id\": \"$CHAT_ID\"}")
  STATUS=$(echo "$RESULT" | jq -r '.data.status')
  if [ "$STATUS" = "1" ]; then break; fi  # 1 = completed
  sleep 15
done
VIDEO_URL=$(echo "$RESULT" | jq -r '.data.tool_results[-1].result[0]')
```

**Tool API:**
```bash
GATEWAY_TOKEN=$(grep GATEWAY_TOKEN ~/.openclaw/.env | cut -d= -f2)
while true; do
  RESULT=$(curl -s -X POST "https://instaclaw.io/api/gateway/sjinn?action=query" \
    -H "Authorization: Bearer $GATEWAY_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"api\": \"tool\", \"task_id\": \"$TASK_ID\"}")
  STATUS=$(echo "$RESULT" | jq -r '.data.status')
  if [ "$STATUS" = "1" ]; then break; fi   # 1 = completed
  if [ "$STATUS" = "-1" ]; then echo "FAILED"; break; fi  # -1 = failed
  sleep 15
done
VIDEO_URL=$(echo "$RESULT" | jq -r '.data.output.video_url')
```

### Polling Intervals & Timeouts

| Type | Poll Interval | Timeout |
|------|--------------|---------|
| Video generation | 15 seconds | 10 minutes |
| Image generation | 10 seconds | 5 minutes |
| Audio generation | 10 seconds | 5 minutes |

### Progress Updates

- **Immediately:** "Generating your video now. This usually takes 2-5 minutes. I'll send it as soon as it's ready."
- **At 2 min:** "Still working on your video. Complex scenes can take a few extra minutes."
- **At 5 min:** "Your video is taking a bit longer than usual. Almost there..."
- **At 10 min (timeout):** "Video generation timed out. This sometimes happens with complex prompts. Want me to try again with a simpler version?"

### Download & Deliver

```bash
FILENAME="${SLUG}_$(date +%Y-%m-%d_%H-%M).mp4"
curl -sL "$VIDEO_URL" -o ~/workspace/videos/$FILENAME
# Send via Telegram sendVideo (< 20MB reliable, < 50MB hard limit)
# If > 50MB: compress or send as document
```

---

## Pending Task Recovery

On session start, check `~/memory/video-history.json` for pending tasks:

```bash
PENDING=$(jq '.pending[]' ~/memory/video-history.json 2>/dev/null)
```

If pending tasks exist, query their status and retrieve completed results. Update the history file.

**video-history.json structure:**
```json
{
  "pending": [
    {
      "chat_id": "uuid",
      "task_id": "uuid-if-tool-api",
      "api": "agent|tool",
      "prompt": "enhanced prompt",
      "submitted_at": "ISO timestamp",
      "quality": "quality",
      "template_id": null
    }
  ],
  "completed": [
    {
      "chat_id": "uuid",
      "prompt": "enhanced prompt",
      "result_url": "https://cdn.sjinn.ai/...",
      "local_path": "~/workspace/videos/sunset_2026-02-25_14-30.mp4",
      "submitted_at": "ISO",
      "completed_at": "ISO",
      "generation_time_seconds": 180,
      "quality": "quality"
    }
  ]
}
```

---

## Credit Integration

### Daily Limits (enforced by proxy)

| Tier | Videos/day | Images+Audio/day |
|------|-----------|-----------------|
| Starter | 3 | 10 |
| Pro | 10 | 30 |
| Power | 30 | 100 |
| BYOK | 5 | 15 |

The proxy enforces these limits automatically. If you hit the limit, the proxy returns a 429 error with `video_limit_reached`.

### Budget Guardrails

**Before every generation:**
1. The proxy checks daily limits automatically
2. If the proxy returns 429 (`video_limit_reached`), tell the user: "You've hit your daily video limit. Resets at midnight."
3. If user is close to limit → suggest cheap mode proactively

---

## Error Handling

| Error Code | Meaning | User-Facing Response |
|------------|---------|---------------------|
| 429 (video_limit_reached) | Daily limit hit | "You've hit your daily video limit. Resets at midnight." |
| 503 (service_unavailable) | Sjinn at capacity | "Video generation is temporarily at capacity. Please try again later." |
| 401 | Invalid gateway token | "Video generation is temporarily unavailable. I'll let the team know." |
| 403 | Unauthorized | "Video generation is temporarily unavailable." |
| 404 | Resource not found | "That video task wasn't found. Let me try generating it again." |
| 500 | Internal server error | "The video service hit an error. Let me retry." |
| Timeout >10min | Generation too long | "Video generation timed out. Want me to try with a simpler prompt or cheap mode?" |
| Video >50MB | Too large for Telegram | Compress or send as document |
| Video 20-50MB | Large but sendable | Send with note: "Large file, may take a moment to load." |
| Network error | Download failed | Retry download 3 times with 10s delay |

---

## Quality Checklist

Before delivering any video, verify:

1. Prompt was enhanced with cinematic vocabulary (camera, lighting, atmosphere)
2. Correct API chosen (Agent vs Tool) based on user request
3. Async poll loop running with correct intervals (15s video, 10s image/audio)
4. Progress updates sent at 2min, 5min milestones
5. Timeout handled at 10min (video) or 5min (image/audio)
6. Video downloaded to ~/workspace/videos/ with descriptive filename
7. Video size checked before Telegram delivery (20MB/50MB thresholds)
8. Result logged to ~/memory/video-history.json
9. Pending task removed from pending array after completion

---

## References

- **API Reference:** `~/.openclaw/skills/sjinn-video/references/sjinn-api.md`
- **Prompt Enhancement Guide:** `~/.openclaw/skills/sjinn-video/references/video-prompting.md`
- **Full Production Pipeline:** `~/.openclaw/skills/sjinn-video/references/video-production-pipeline.md`
- **Setup Script:** `~/scripts/setup-sjinn-video.sh`
