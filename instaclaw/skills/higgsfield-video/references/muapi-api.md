# Muapi.ai API Reference

## Proxy Routing (Platform-Provided)

Scripts talk to the InstaClaw proxy, NOT directly to muapi.ai:

**Base URL**: `{INSTACLAW_MUAPI_PROXY}/api/gateway/muapi` (e.g., `https://instaclaw.io/api/gateway/muapi`)

**Auth header**: `x-gateway-token: {GATEWAY_TOKEN}` (from `~/.openclaw/.env`)

The proxy handles:
1. Credit checking before each generation
2. Forwarding to Muapi with the platform API key
3. Credit deduction on success
4. Rate limiting and error handling

All endpoint paths below are relative — the scripts automatically prepend the proxy base URL.

## Direct Base URL (Legacy/Fallback)
`https://api.muapi.ai`

## Authentication (Legacy)
Direct requests use `x-api-key` header — but this is handled by the proxy now:
```
x-api-key: MUAPI_API_KEY  (platform-level, server-side only)
```

## Async Pattern
All generation endpoints follow the same pattern:
1. **Submit**: POST to generation endpoint → returns `request_id`
2. **Poll**: GET `/api/v1/requests/{request_id}` → returns status + output URL when done

## Response Normalization
Response structures vary by endpoint. Always check these fields in order:

### Request ID extraction:
1. `response.request_id`
2. `response.id`
3. `response.data.request_id`

### Output URL extraction:
1. `response.outputs[0]` (string) or `response.outputs[0].url`
2. `response.url` / `response.video_url` / `response.image_url`
3. `response.output.url`
4. `response.video.url` (effects endpoint)
5. `response.data.outputs[0]`

### Status values:
- **Success**: `completed`, `succeeded`, `done`
- **Failure**: `failed`, `error`, `cancelled`
- **Processing**: `processing`, `pending`, `submitted`, `queued`

## Endpoints

### Video Generation (Text-to-Video)

| Model | Endpoint |
|-------|----------|
| Kling 3.0 | POST `/api/v1/generate/video/kling/v3` |
| Kling 2.0 | POST `/api/v1/generate/video/kling/v2` |
| Kling 1.6 | POST `/api/v1/generate/video/kling` |
| Wan 2.2 | POST `/api/v1/generate/video/wan` |
| Wan 2.1 | POST `/api/v1/generate/video/wan/2.1` |
| Sora 2 | POST `/api/v1/generate/video/sora` |
| Veo 3 | POST `/api/v1/generate/video/veo3` |
| Veo 3.1 | POST `/api/v1/generate/video/veo3.1` |
| Veo 2 | POST `/api/v1/generate/video/veo2` |
| Seedance 2.0 | POST `/api/v1/generate/video/seedance` |
| Hailuo | POST `/api/v1/generate/video/hailuo` |
| Luma | POST `/api/v1/generate/video/luma` |
| Runway Gen4 | POST `/api/v1/generate/video/runway/gen4` |
| Pika 2.2 | POST `/api/v1/generate/video/pika` |
| PixVerse v4 | POST `/api/v1/generate/video/pixverse` |
| Hunyuan | POST `/api/v1/generate/video/hunyuan` |

**Common params:**
```json
{
  "prompt": "string (required)",
  "negative_prompt": "string",
  "duration": "5 | 10",
  "aspect_ratio": "16:9 | 9:16 | 1:1 | 4:3 | 3:4",
  "resolution": "720p | 1080p",
  "camera": "object (camera movement)",
  "seed": "integer",
  "cfg_scale": "float",
  "elements": [{"ref": "element_id"}]
}
```

### Image-to-Video

Append `/img2video` to most video endpoints. Example:
- Kling 3.0 I2V: POST `/api/v1/generate/video/kling/v3/img2video`
- Hailuo I2V: POST `/api/v1/generate/video/hailuo/i2v`

**Params:**
```json
{
  "image_url": "string (required)",
  "prompt": "string",
  "duration": "5 | 10",
  "aspect_ratio": "16:9 | 9:16 | 1:1"
}
```

### Image Generation

| Model | Endpoint |
|-------|----------|
| Flux Schnell | POST `/api/v1/generate/image/flux/schnell` |
| Flux Dev | POST `/api/v1/generate/image/flux/dev` |
| Flux Pro | POST `/api/v1/generate/image/flux/pro` |
| Ideogram 3 | POST `/api/v1/generate/image/ideogram/v3` |
| Recraft v3 | POST `/api/v1/generate/image/recraft/v3` |
| Seedream 4.5 | POST `/api/v1/generate/image/seedream` |
| GPT Image 1 | POST `/api/v1/generate/image/gpt-image-1` |

**Params:**
```json
{
  "prompt": "string (required)",
  "image_size": "square | landscape | portrait",
  "negative_prompt": "string",
  "seed": "integer",
  "num_images": "integer",
  "style": "string"
}
```

### Audio Generation

| Type | Endpoint |
|------|----------|
| Music (Suno) | POST `/api/v1/generate/audio/suno` |
| Music (Suno v4) | POST `/api/v1/generate/audio/suno/v4` |
| SFX (MMAudio) | POST `/api/v1/generate/audio/mmaudio` |
| Video-to-Audio | POST `/api/v1/generate/audio/video-to-audio` |
| Lip Sync | POST `/api/v1/generate/video/lipsync` |

### Video Editing

| Action | Endpoint |
|--------|----------|
| Effects | POST `/api/v1/generate/video/effects` |
| Extend | POST `/api/v1/generate/video/extend` |
| Translate | POST `/api/v1/generate/video/translate` |
| Style Transfer | POST `/api/v1/generate/video/style-transfer` |
| Upscale | POST `/api/v1/generate/video/upscale` |
| Face Swap | POST `/api/v1/generate/video/face-swap` |

### File Upload

POST `/api/v1/files/upload`
```json
{
  "file": "data:mime/type;base64,<data>",
  "filename": "string"
}
```

### Status Check

GET `/api/v1/requests/{request_id}`

Response:
```json
{
  "status": "completed|processing|failed",
  "outputs": [{"url": "..."}],
  "error": "string (if failed)"
}
```

## Rate Limits
- Varies by plan. Check headers: `X-RateLimit-Remaining`, `X-RateLimit-Reset`
- On 429: retry with exponential backoff (5s, 15s, 45s)

## Error Codes
| Code | Meaning |
|------|---------|
| 400 | Bad request (invalid params) |
| 401 | Invalid API key |
| 403 | Forbidden (insufficient plan) |
| 404 | Request not found |
| 429 | Rate limited |
| 500+ | Server error (retry) |
