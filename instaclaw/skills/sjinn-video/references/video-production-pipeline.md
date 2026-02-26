# Video Production Pipeline — All Sjinn Tools

Complete reference for all tools available through Sjinn's platform, organized by category.

---

## Image Generation

| Tool | Access | Credits | Description |
|------|--------|---------|-------------|
| Nano Banana | Tool API: `nano-banana-image-api` | 50 | Fast image generation from text prompt |
| Nano Banana Pro | Tool API: `nano-banana-image-pro-api` | 150 | Higher quality image generation |
| SJinn Image Edit | Agent API | Varies | Reference-based image generation/editing |
| seedream 4.5 | Agent API | Varies | High-quality image gen (Google DeepMind) |

**Use cases:**
- Generate character images → then animate into video (image-to-video pipeline)
- Create thumbnails for YouTube/social media
- Product mockup images
- Storyboard frames before video generation

---

## Video Generation

| Tool | Access | Credits | Duration | Audio |
|------|--------|---------|----------|-------|
| Seedance 2.0 | Agent API only (no tool_type) | ~150-420 | Varies | Yes |
| Veo3 Text-to-Video | Tool API: `veo3-text-to-video-fast-api` | 420 | 8s | Yes |
| Veo3 Image-to-Video | Tool API: `veo3-image-to-video-fast-api` | 420 | 8s | Yes |
| Sora2 Text-to-Video | Tool API: `sora2-text-to-video-api` | 420/2100 | 5s or 10s | Yes |
| Sora2 Image-to-Video | Tool API: `sora2-image-to-video-api` | 420/2100 | 5s or 10s | Yes |

**Note:** Seedance 2.0 (ByteDance) is the newest and often highest-quality model, but can only be accessed via Agent API where Sjinn auto-selects it.

---

## Audio Production

Available through **Agent API** (Sjinn's agent orchestrates these automatically in multi-shot productions):

| Tool | Description |
|------|-------------|
| Text-to-Speech (TTS) | Generate voiceover from text with automatic voice selection |
| Music Generation | Create background music from text prompt (genre, mood, tempo) |
| Sound Effects (SFX) | Generate specific sound effects for video |
| Speech-to-Text | Transcribe audio/video to text (for subtitles) |

**Tip:** For standalone TTS, the Voice & Audio Production skill (tts-openai.sh) may be more suitable. Use Sjinn audio tools when producing video content that needs integrated audio.

---

## Post-Production

Available through **Agent API** (auto-orchestrated in multi-shot productions):

| Tool | Description |
|------|-------------|
| `ffmpeg_full_compose` | Combine multiple clips, audio tracks, background music into final video |
| `Add_Subtitle_For_Video` | Auto-generate and burn subtitles into video |
| `add_audio_effect_to_video` | Add sound effects to existing video |
| `video_lip_sync` | Sync lip movements to audio (best for real human subjects) |
| `ImageLipSyncTool` | Generate lip-synced video from still image + audio (single or dual character) |
| `video_frame_extraction` | Extract first/last frame from video |
| `video_trim` | Trim video to specific duration |
| Video upscaling | Increase resolution of generated video |

**Image Lip Sync** is available via Tool API: `image-lipsync-api` (~30 credits/sec)
- Input: `image_url` (still image of face) + `audio_url` (speech audio)
- Output: Video of the face speaking the audio with synced lip movements

---

## Workflow Recipes

### 1. Podcast Video

**Single Host:**
```
Agent API + template: 071b3487-d689-4e9e-9125-f280fdb85e7a (Single Podcast)
Message: "Create a podcast intro video. Host: [name], Topic: [topic]. Professional studio setting."
```

**Dual Host:**
```
Agent API + template: 5d0cbc88-41d7-471a-88b3-7df276016de1 (Dual Podcast)
Message: "Create a dual podcast video. Host 1: [name], Host 2: [name]. Topic: [topic]."
```

### 2. Music Video

```
Agent API + template: 57a003c8-ea94-44a8-8e32-d2ec53ea780b (Music Video)
Message: "Create a music video for this song. Lyrics: [lyrics]. Style: [genre]. Visual mood: [mood]."
```

The Sjinn agent will:
1. Analyze lyrics for scene breaks
2. Generate matching visuals for each section
3. Sync transitions to beat/rhythm
4. Compose final video with the music

### 3. Product Demo

**Step-by-step with Tool API:**
1. Generate product image (if no photo): `nano-banana-image-pro-api`
2. Animate product: `veo3-image-to-video-fast-api` with product photo
3. Add subtitles via Agent API: `Add_Subtitle_For_Video`

**All-in-one with Agent API:**
```
Message: "Create a 30-second product demo video for [product]. Show the product from multiple angles with smooth camera movements. Professional, clean, premium feel. Add subtle background music. 16:9 widescreen."
```

### 4. Multi-Shot Story Video

**Veo3 (live-action):**
```
Agent API + template: 9b371ec6-09a2-43d5-97c2-0aea79a12371 (Veo3 Story Video)
Message: "Create a 4-scene story: [Scene 1 description]. [Scene 2]. [Scene 3]. [Scene 4]. Maintain character consistency throughout."
```

**Sora2 (anime/stylized):**
```
Agent API + template: de733710-fc66-4a2b-b53c-27b52c6c6f5e (Sora2 Story Video v2)
Message: "Create an anime story: [description]. Maintain consistent art style and character design across all scenes."
```

### 5. Character-Consistent Series

Use story templates (Veo3 or Sora2) to maintain character consistency across multiple videos:

1. First video: describe characters in detail (appearance, clothing, features)
2. Subsequent videos: reference same character descriptions
3. Template handles consistency automatically

```
Message: "Character: Sarah, 28, red hair in a ponytail, green jacket, confident smile. Scene: Sarah walks into a bustling coffee shop and orders her usual. Cinematic, warm tones."
```

### 6. Lip Sync Video from Image

Using Tool API `image-lipsync-api`:

1. Prepare still image of a face (from user photo or generated)
2. Prepare audio (from TTS or user-provided audio file)
3. Host both files via Caddy:
   - `https://{hostname}/tmp-media/{uuid}.jpg`
   - `https://{hostname}/tmp-media/{uuid}.mp3`
4. Submit to `image-lipsync-api`:
   ```json
   {
     "tool_type": "image-lipsync-api",
     "input": {
       "image_url": "https://hostname/tmp-media/face.jpg",
       "audio_url": "https://hostname/tmp-media/speech.mp3"
     }
   }
   ```
5. Poll → download → deliver

### 7. Video Extension

Extend an existing video clip:

**Veo3 Extend:**
```
Agent API + template: 1de0cc26-6bf9-4eed-a5a2-c62fe88aef52
Message: "Extend this video: [description of original + what should happen next]"
```

**Sora2 Extend:**
```
Agent API + template: d5db7e33-4ef6-4c6f-96be-b7e0a98f0706
Message: "Extend this video: [description of original + continuation]"
```

---

## Pipeline Composition

For complex productions, the Agent API handles tool orchestration automatically. A single prompt like:

> "Create a 60-second product launch video for a smartwatch. Show the watch from multiple angles, add voiceover explaining features, include background music, and burn in subtitles. End with the brand logo. 16:9 for YouTube."

...will trigger Sjinn to internally use: image generation → video generation → TTS → music gen → ffmpeg_full_compose → Add_Subtitle_For_Video → final output.

You do NOT need to call each tool manually. The Agent API handles the pipeline. Use Tool API only when you need direct control over a specific step.
