# Sjinn API Reference

All Sjinn calls are proxied through the InstaClaw server. The agent never calls Sjinn directly.

Proxy URL: `https://instaclaw.io/api/gateway/sjinn`
Auth: `Authorization: Bearer GATEWAY_TOKEN`
Content-Type: `application/json`

---

## Agent API

Best for: multi-shot stories, Seedance 2.0 (only accessible here), complex production, "let Sjinn decide the best model."

### Create Agent Task

```
POST https://instaclaw.io/api/gateway/sjinn?action=create

Body:
{
  "api": "agent",
  "message": "string — cinematic prompt describing the video",
  "template_id": "string — optional, from template table below",
  "quality": "quality" | "cheap"
}

Response:
{
  "success": true,
  "data": {
    "project_id": "uuid",
    "chat_id": "uuid"
  }
}
```

### Query Agent Task Status

```
POST https://instaclaw.io/api/gateway/sjinn?action=query

Body:
{
  "api": "agent",
  "chat_id": "uuid — from create response",
  "tool_names": ["ffmpeg_full_compose"]  // optional — filter for specific tool results
}

Response:
{
  "success": true,
  "data": {
    "status": 1 | 2,
    "tool_results": [
      {
        "name": "tool_name",
        "result": ["https://cdn.sjinn.ai/...video.mp4"]
      }
    ],
    "create_time": "ISO timestamp",
    "update_time": "ISO timestamp"
  }
}
```

**Status codes:**
- **1** = completed (all tools finished)
- **2** = running (still processing)

---

## Tool API

Best for: deterministic single operations, specific model control, image-to-video with known model.

### Create Tool Task

```
POST https://instaclaw.io/api/gateway/sjinn?action=create

Body:
{
  "api": "tool",
  "tool_type": "string — from tool_types table below",
  "input": {
    "prompt": "string",
    "image_url": "string — required for image-to-video and lip sync",
    "audio_url": "string — required for lip sync",
    "aspect_ratio": "16:9" | "9:16" | "1:1",
    "duration": 5 | 10,
    "mode": "standard" | "pro"
  }
}

Response:
{
  "success": true,
  "data": {
    "task_id": "uuid"
  }
}
```

### Query Tool Task Status

```
POST https://instaclaw.io/api/gateway/sjinn?action=query

Body:
{
  "api": "tool",
  "task_id": "uuid — from create response"
}

Response:
{
  "success": true,
  "data": {
    "status": -1 | 0 | 1,
    "output": {
      "video_url": "https://cdn.sjinn.ai/...mp4",
      "image_url": "https://cdn.sjinn.ai/...png"
    }
  }
}
```

**Status codes:**
- **-1** = failed
- **0** = processing
- **1** = completed

---

## Tool Types (7 confirmed)

### Video Generation

| tool_type | Input | Output | Credits | Notes |
|-----------|-------|--------|---------|-------|
| `veo3-text-to-video-fast-api` | prompt, aspect_ratio? (default 16:9) | video_url | 420 | 8s, with audio |
| `veo3-image-to-video-fast-api` | prompt, image_url, aspect_ratio? | video_url | 420 | 8s, animate image |
| `sora2-text-to-video-api` | prompt, aspect_ratio?, duration? (5\|10, default 10), mode? (standard\|pro) | video_url | 420 (std) / 2100 (pro) | With audio |
| `sora2-image-to-video-api` | prompt, image_url, aspect_ratio?, duration?, mode? | video_url | 420 (std) / 2100 (pro) | Animate image |

### Image Generation

| tool_type | Input | Output | Credits | Notes |
|-----------|-------|--------|---------|-------|
| `nano-banana-image-api` | prompt | image_url | 50 | Fast image gen |
| `nano-banana-image-pro-api` | prompt | image_url | 150 | Higher quality |

### Audio/Lip Sync

| tool_type | Input | Output | Credits | Notes |
|-----------|-------|--------|---------|-------|
| `image-lipsync-api` | image_url, audio_url | video_url | ~30/sec | Lip sync from still image |

**Note:** Seedance 2.0 has NO tool_type — it is ONLY accessible via the Agent API.

---

## Error Codes

| Code | Meaning | Handle |
|------|---------|--------|
| 200 | Success | Proceed normally |
| 429 | Daily limit reached | "You've hit your daily video limit. Resets at midnight." |
| 503 | Service at capacity | "Video generation is temporarily at capacity. Try again later." |
| 401 | Invalid gateway token | "Video unavailable, notifying team" |
| 403 | Unauthorized | "Video unavailable" |
| 404 | Resource not found | Retry or re-submit |
| 500 | Internal server error | Retry once, then report |

---

## Template IDs

| Template | ID | Best For |
|----------|-----|----------|
| Veo3 Story Video | `9b371ec6-09a2-43d5-97c2-0aea79a12371` | Live-action, consistent characters |
| Sora2 Story Video v2 | `de733710-fc66-4a2b-b53c-27b52c6c6f5e` | Anime/stylized, consistent characters |
| Sora2 Extend | `d5db7e33-4ef6-4c6f-96be-b7e0a98f0706` | Extend existing Sora2 clip |
| Veo3 Extend | `1de0cc26-6bf9-4eed-a5a2-c62fe88aef52` | Extend existing Veo3 clip |
| Kids Short Video | `788acc9a-866b-4688-849e-7c7cfffaff54` | Children's content |
| Single Podcast | `071b3487-d689-4e9e-9125-f280fdb85e7a` | Single host podcast visual |
| Dual Podcast | `5d0cbc88-41d7-471a-88b3-7df276016de1` | Two hosts podcast visual |
| Music Video | `57a003c8-ea94-44a8-8e32-d2ec53ea780b` | Lyrics-synced music video |

---

## Polling Patterns

### Decision Tree: Which API to Use?

```
User request
├── Specific model mentioned? (Veo3, Sora2)
│   └── YES → Tool API with matching tool_type
├── Image-to-video?
│   └── YES → Tool API (veo3-image-to-video-fast-api or sora2-image-to-video-api)
├── Multi-shot story / template needed?
│   └── YES → Agent API with template_id
├── Complex production (audio + subtitles + composition)?
│   └── YES → Agent API (handles pipeline automatically)
└── Simple text-to-video, no preference?
    └── Agent API (auto-selects Seedance/best model)
```

### Complete Workflow: Text-to-Video via Agent API

```bash
#!/bin/bash
# Text-to-video via Agent API (proxied through InstaClaw)
GATEWAY_TOKEN=$(grep GATEWAY_TOKEN ~/.openclaw/.env | cut -d= -f2)

# 1. Submit
RESPONSE=$(curl -s -X POST "https://instaclaw.io/api/gateway/sjinn?action=create" \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"api": "agent", "message": "Cinematic aerial drone shot descending over tropical coastline at golden hour. Sun melts into ocean, sky painted amber and violet. Gentle waves catch warm light. Camera pushes toward sun. 16:9 widescreen.", "quality": "quality"}')

CHAT_ID=$(echo "$RESPONSE" | jq -r '.data.chat_id')
echo "Submitted. chat_id: $CHAT_ID"

# 2. Poll (15s intervals, 10min timeout)
ELAPSED=0
while [ $ELAPSED -lt 600 ]; do
  RESULT=$(curl -s -X POST "https://instaclaw.io/api/gateway/sjinn?action=query" \
    -H "Authorization: Bearer $GATEWAY_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"api\": \"agent\", \"chat_id\": \"$CHAT_ID\"}")
  STATUS=$(echo "$RESULT" | jq -r '.data.status')
  if [ "$STATUS" = "1" ]; then
    echo "Completed!"
    VIDEO_URL=$(echo "$RESULT" | jq -r '.data.video_url')
    break
  fi
  sleep 15
  ELAPSED=$((ELAPSED + 15))
done

# 3. Download
curl -sL "$VIDEO_URL" -o ~/workspace/videos/sunset_$(date +%Y-%m-%d_%H-%M).mp4
```

### Complete Workflow: Image-to-Video via Tool API

```bash
#!/bin/bash
# Image-to-video via Tool API (Veo3, proxied through InstaClaw)
GATEWAY_TOKEN=$(grep GATEWAY_TOKEN ~/.openclaw/.env | cut -d= -f2)

IMAGE_URL="https://your-hostname.instaclaw.io/tmp-media/abc123.jpg"

# 1. Submit
RESPONSE=$(curl -s -X POST "https://instaclaw.io/api/gateway/sjinn?action=create" \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"api\": \"tool\", \"tool_type\": \"veo3-image-to-video-fast-api\", \"input\": {\"prompt\": \"Smooth dolly shot orbiting the product. Soft studio lighting with reflections. Camera pushes in to reveal detail.\", \"image_url\": \"$IMAGE_URL\", \"aspect_ratio\": \"16:9\"}}")

TASK_ID=$(echo "$RESPONSE" | jq -r '.data.task_id')
echo "Submitted. task_id: $TASK_ID"

# 2. Poll (15s intervals, 10min timeout)
ELAPSED=0
while [ $ELAPSED -lt 600 ]; do
  RESULT=$(curl -s -X POST "https://instaclaw.io/api/gateway/sjinn?action=query" \
    -H "Authorization: Bearer $GATEWAY_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"api\": \"tool\", \"task_id\": \"$TASK_ID\"}")
  STATUS=$(echo "$RESULT" | jq -r '.data.status')
  if [ "$STATUS" = "1" ]; then
    echo "Completed!"
    VIDEO_URL=$(echo "$RESULT" | jq -r '.data.video_url')
    break
  elif [ "$STATUS" = "-1" ]; then
    echo "FAILED"
    exit 1
  fi
  sleep 15
  ELAPSED=$((ELAPSED + 15))
done

# 3. Download
curl -sL "$VIDEO_URL" -o ~/workspace/videos/product_$(date +%Y-%m-%d_%H-%M).mp4
```
