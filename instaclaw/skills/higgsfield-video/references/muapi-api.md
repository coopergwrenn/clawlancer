# Muapi.ai API Reference (Verified)

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

## Verified API Patterns (from muapi.js source)

```
Base URL:    https://api.muapi.ai
Auth:        x-api-key: {key}
Submit:      POST /api/v1/{endpoint}                        → { request_id: "..." }
Poll:        GET  /api/v1/predictions/{request_id}/result   → { status, outputs, ... }
Upload:      POST /api/v1/upload_file                       (FormData multipart, NO Content-Type header)

Endpoint resolution:  model.endpoint || model.id
Image field:          model.imageField || 'image_url'
```

## Async Pattern

All generation endpoints follow the same pattern:
1. **Submit**: POST `/api/v1/{endpoint}` → returns `request_id`
2. **Poll**: GET `/api/v1/predictions/{request_id}/result` → returns status + output URL when done

## Response Normalization

Response structures vary by endpoint. Always check these fields in order:

### Request ID extraction:
1. `response.request_id`
2. `response.id`
3. `response.data.request_id`

### Output URL extraction (5-level fallback):
1. `response.outputs[0]` (string) or `response.outputs[0].url`
2. `response.url` / `response.video_url` / `response.image_url`
3. `response.output.url`
4. `response.video.url` (effects endpoints)
5. `response.image.url`

### Status values:
- **Success**: `completed`, `succeeded`, `success`
- **Failure**: `failed`, `error`
- **Processing**: `processing`, `pending`, `submitted`, `queued`

### Poll timing:
- Images: 60 attempts x 2s = 2 min
- Videos: 120 attempts x 2s = 4 min

## File Upload

POST `/api/v1/upload_file` — **multipart FormData** (NOT base64 JSON)

```python
# Python example — do NOT set Content-Type header manually
boundary = f"----FormBoundary{int(time.time()*1000)}"
body = (
    f"--{boundary}\r\n"
    f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
    f"Content-Type: {mime_type}\r\n\r\n"
).encode() + file_bytes + f"\r\n--{boundary}--\r\n".encode()
```

Response: `{ "url": "https://..." }` or `{ "file_url": "..." }` or `{ "data": { "url": "..." } }`

## Endpoints — Video Generation (Text-to-Video)

| User Model Name | Muapi Endpoint |
|----------------|----------------|
| Kling 3.0 | `kling-v3.0-pro-text-to-video` |
| Kling 2.0 | `kling-v2.5-turbo-pro-t2v` |
| Wan 2.2 | `wan2.2-text-to-video` |
| Wan 2.5 | `wan2.5-text-to-video` |
| Sora 2 | `openai-sora-2-text-to-video` |
| Veo 3 | `veo3-text-to-video` |
| Veo 3.1 | `veo3.1-text-to-video` |
| Seedance 2.0 | `seedance-v2.0-t2v` |
| Hailuo | `minimax-hailuo-2.3-pro-t2v` |
| Luma | `ltx-2-pro-text-to-video` |
| Runway | `runway-text-to-video` |
| PixVerse | `pixverse-v5.5-t2v` |
| Hunyuan | `hunyuan-text-to-video` |

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

## Endpoints — Image-to-Video

Each I2V model has a specific `imageField` — some use `image_url`, others use `images_list`:

| User Model Name | Muapi Endpoint | imageField |
|----------------|----------------|------------|
| Kling 3.0 I2V | `kling-v3.0-pro-image-to-video` | `image_url` |
| Wan 2.2 I2V | `wan2.2-image-to-video` | `image_url` |
| Veo 3 I2V | `veo3-image-to-video` | `images_list` |
| Runway I2V | `runway-image-to-video` | `image_url` |
| Hailuo I2V | `minimax-hailuo-2.3-pro-i2v` | `image_url` |
| Seedance I2V | `seedance-v2.0-i2v` | `images_list` |
| Sora I2V | `openai-sora-2-image-to-video` | `images_list` |
| Hunyuan I2V | `hunyuan-image-to-video` | `image_url` |

**IMPORTANT**: When `imageField` is `images_list`, send the image URL as an array:
```json
{ "images_list": ["https://..."], "prompt": "..." }
```
When `imageField` is `image_url`, send as a string:
```json
{ "image_url": "https://...", "prompt": "..." }
```

## Endpoints — Image Generation

| User Model Name | Muapi Endpoint |
|----------------|----------------|
| Flux Schnell | `flux-schnell-image` |
| Flux Dev | `flux-dev-image` |
| Flux Pro | `flux-dev-image` |
| Ideogram 3 | `ideogram-v3-t2i` |
| Recraft v3 | `reve-text-to-image` |
| Seedream 4.5 | `bytedance-seedream-v4.5` |
| GPT Image 1 | `gpt4o-text-to-image` |
| GPT Image 1.5 | `gpt-image-1.5` |
| Midjourney v7 | `midjourney-v7-text-to-image` |
| Google Imagen 4 | `google-imagen4` |
| Hunyuan Image | `hunyuan-image-3.0` |
| Wan Image | `wan2.5-text-to-image` |

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

## Endpoints — Audio Generation

Audio endpoints not verified from Open-Higgsfield-AI source (only image/video models present).
These are best-guess flat names following the same `/api/v1/{endpoint}` pattern:

| Type | Endpoint |
|------|----------|
| Music (Suno) | `suno-create-music` |
| Music (Suno v4) | `suno-v4-create-music` |
| SFX (MMAudio) | `mmaudio-sfx` |
| Video-to-Audio | `video-to-audio-sync` |
| Lip Sync | `lipsync-video` |

## Endpoints — Video Editing

| Action | Endpoint | Notes |
|--------|----------|-------|
| Effects (WanAI) | `generate_wan_ai_effects` | Unified endpoint, use `name` param for preset |
| Upscale | `ai-image-upscale` | |
| Face Swap | `ai-image-face-swap` | |
| Style Transfer | `higgsfield-soul-image-to-image` | |
| Extend | `video-extend` | |
| Translate | `video-translate` | |

### Effects endpoint — `name` parameter

The `generate_wan_ai_effects` endpoint uses a `name` parameter to select the effect preset:
```json
{
  "image_url": "https://...",
  "prompt": "description",
  "name": "Claw Zoom In"
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
