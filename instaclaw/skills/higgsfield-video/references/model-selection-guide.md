# Model Selection Guide

## Decision Tree

```
User wants video generation?
+-- Realistic humans/faces? -> Kling 3.0 (kling-v3.0-pro-text-to-video)
+-- Anime/stylized? -> Wan 2.2 (wan2.2-text-to-video)
+-- Cinematic/film look? -> Veo 3.1 (veo3.1-text-to-video)
+-- Fast draft/iteration? -> Hailuo (minimax-hailuo-2.3-pro-t2v)
+-- Surreal/artistic? -> Sora 2 (openai-sora-2-text-to-video)
+-- Precise motion control? -> Seedance 2.0 (seedance-v2.0-t2v)
+-- Budget-conscious? -> PixVerse (pixverse-v5.5-t2v)
+-- Image animation (I2V)? -> Kling 3.0 (kling-v3.0-pro-image-to-video)
+-- General purpose? -> Kling 3.0

User wants image generation?
+-- Fast/cheap? -> Flux Schnell (flux-schnell-image)
+-- High quality general? -> Ideogram 3 (ideogram-v3-t2i)
+-- Photorealistic? -> Seedream 4.5 (bytedance-seedream-v4.5) or GPT Image (gpt4o-text-to-image)
+-- Design/illustration? -> Recraft v3 (reve-text-to-image)
+-- General purpose? -> Flux Dev (flux-dev-image)
```

## Video Models — Detailed Comparison

### Kling 3.0 (Recommended Default)
- **Endpoint**: `kling-v3.0-pro-text-to-video` (T2V), `kling-v3.0-pro-image-to-video` (I2V)
- **Strengths**: Best overall quality, character consistency via Elements, face rendering, lip movement
- **Weaknesses**: Slower generation, higher cost
- **Best for**: Professional content, character-driven videos, I2V
- **Duration**: 5s, 10s
- **Resolution**: Up to 1080p

### Wan 2.2
- **Endpoint**: `wan2.2-text-to-video` (T2V), `wan2.2-image-to-video` (I2V)
- **Strengths**: Anime/illustration excellence, creative styles, fast
- **Weaknesses**: Less realistic for photorealistic content
- **Best for**: Anime, stylized content, artistic videos
- **Duration**: 5s
- **Resolution**: Up to 1080p

### Sora 2
- **Endpoint**: `openai-sora-2-text-to-video` (T2V), `openai-sora-2-image-to-video` (I2V, imageField: images_list)
- **Strengths**: Creative, surreal content, unique motion, text rendering
- **Weaknesses**: Can be unpredictable
- **Best for**: Artistic, experimental, abstract content
- **Duration**: 5-20s
- **Resolution**: Up to 1080p

### Veo 3 / Veo 3.1
- **Endpoint**: `veo3-text-to-video` / `veo3.1-text-to-video` (T2V), `veo3-image-to-video` (I2V, imageField: images_list)
- **Strengths**: Strong cinematic quality, good motion, consistent quality
- **Weaknesses**: Less character consistency than Kling
- **Best for**: Cinematic, film-look content, landscapes
- **Duration**: 5-8s
- **Resolution**: Up to 1080p

### Seedance 2.0
- **Endpoint**: `seedance-v2.0-t2v` (T2V), `seedance-v2.0-i2v` (I2V, imageField: images_list)
- **Strengths**: Good camera control, precise motion, reliable
- **Weaknesses**: Middle-tier quality
- **Best for**: Controlled motion, camera movements, dance/action
- **Duration**: 5s
- **Resolution**: Up to 1080p

### Hailuo
- **Endpoint**: `minimax-hailuo-2.3-pro-t2v` (T2V), `minimax-hailuo-2.3-pro-i2v` (I2V)
- **Strengths**: Fast generation, good quality/speed ratio
- **Weaknesses**: Less detailed than top-tier models
- **Best for**: Quick iterations, drafts, testing ideas
- **Duration**: 5s
- **Resolution**: Up to 720p

### Luma
- **Endpoint**: `ltx-2-pro-text-to-video`
- **Strengths**: Dreamy quality, good at slow motion, artistic
- **Weaknesses**: Sometimes inconsistent
- **Best for**: Dream sequences, atmospheric content
- **Duration**: 5s

### Runway
- **Endpoint**: `runway-text-to-video` (T2V), `runway-image-to-video` (I2V)
- **Strengths**: Good motion, reliable
- **Weaknesses**: Cost, less creative than others
- **Best for**: Professional, controlled content

### PixVerse
- **Endpoint**: `pixverse-v5.5-t2v`
- **Strengths**: Budget-friendly, decent quality
- **Best for**: High-volume, cost-effective content

### Hunyuan
- **Endpoint**: `hunyuan-text-to-video` (T2V), `hunyuan-image-to-video` (I2V)
- **Strengths**: Open-source foundation, good baseline
- **Best for**: Standard video generation

## Image Models — Detailed Comparison

### Flux Schnell
- **Endpoint**: `flux-schnell-image`
- **Speed**: Fastest (~2-5s)
- **Quality**: Good
- **Best for**: Thumbnails, quick drafts, testing prompts

### Flux Dev
- **Endpoint**: `flux-dev-image`
- **Speed**: Moderate (~10-15s)
- **Quality**: High
- **Best for**: General purpose, balanced speed/quality

### Ideogram 3
- **Endpoint**: `ideogram-v3-t2i`
- **Speed**: Moderate
- **Quality**: Excellent, especially text in images
- **Best for**: Posters, signage, text-heavy images

### Recraft v3
- **Endpoint**: `reve-text-to-image`
- **Speed**: Moderate
- **Quality**: Excellent for design
- **Best for**: Illustrations, icons, design assets

### Seedream 4.5
- **Endpoint**: `bytedance-seedream-v4.5`
- **Speed**: Moderate
- **Quality**: Photorealistic
- **Best for**: Product photos, realistic portraits

### GPT Image 1
- **Endpoint**: `gpt4o-text-to-image`
- **Speed**: Moderate
- **Quality**: Strong photorealism and instruction following
- **Best for**: Complex scene composition, photorealistic content

### Midjourney v7
- **Endpoint**: `midjourney-v7-text-to-image`
- **Speed**: Moderate
- **Quality**: Excellent artistic quality
- **Best for**: Creative, artistic images

### Google Imagen 4
- **Endpoint**: `google-imagen4`
- **Speed**: Moderate
- **Quality**: High fidelity
- **Best for**: General high-quality images

## Fallback Chains

If the primary model fails, fall back in order:

**Video**: Kling 3.0 -> Veo 3.1 -> Seedance 2.0 -> Hailuo
**Anime**: Wan 2.2 -> Kling 3.0 -> PixVerse
**Image**: Flux Dev -> Flux Schnell -> Ideogram 3
**I2V**: Kling 3.0 -> Seedance 2.0 -> Runway
