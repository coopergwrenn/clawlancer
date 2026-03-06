# Model Selection Guide

## Decision Tree

```
User wants video generation?
├── Realistic humans/faces? → Kling 3.0
├── Anime/stylized? → Wan 2.2
├── Cinematic/film look? → Veo 3.1
├── Fast draft/iteration? → Hailuo
├── Surreal/artistic? → Sora 2
├── Precise motion control? → Seedance 2.0
├── Budget-conscious? → PixVerse v4
├── Image animation (I2V)? → Kling 3.0
└── General purpose? → Kling 3.0

User wants image generation?
├── Fast/cheap? → Flux Schnell
├── High quality general? → Flux Pro or Ideogram 3
├── Photorealistic? → Seedream 4.5 or GPT Image 1
├── Design/illustration? → Recraft v3
└── General purpose? → Flux Dev
```

## Video Models — Detailed Comparison

### Kling 3.0 (Recommended Default)
- **Strengths**: Best overall quality, character consistency via Elements, face rendering, lip movement
- **Weaknesses**: Slower generation, higher cost
- **Best for**: Professional content, character-driven videos, I2V
- **Duration**: 5s, 10s
- **Resolution**: Up to 1080p

### Wan 2.2
- **Strengths**: Anime/illustration excellence, creative styles, fast
- **Weaknesses**: Less realistic for photorealistic content
- **Best for**: Anime, stylized content, artistic videos
- **Duration**: 5s
- **Resolution**: Up to 1080p

### Sora 2
- **Strengths**: Creative, surreal content, unique motion, text rendering
- **Weaknesses**: Can be unpredictable
- **Best for**: Artistic, experimental, abstract content
- **Duration**: 5-20s
- **Resolution**: Up to 1080p

### Veo 3 / Veo 3.1
- **Strengths**: Strong cinematic quality, good motion, consistent quality
- **Weaknesses**: Less character consistency than Kling
- **Best for**: Cinematic, film-look content, landscapes
- **Duration**: 5-8s
- **Resolution**: Up to 1080p

### Seedance 2.0
- **Strengths**: Good camera control, precise motion, reliable
- **Weaknesses**: Middle-tier quality
- **Best for**: Controlled motion, camera movements, dance/action
- **Duration**: 5s
- **Resolution**: Up to 1080p

### Hailuo
- **Strengths**: Fast generation, good quality/speed ratio
- **Weaknesses**: Less detailed than top-tier models
- **Best for**: Quick iterations, drafts, testing ideas
- **Duration**: 5s
- **Resolution**: Up to 720p

### Luma
- **Strengths**: Dreamy quality, good at slow motion, artistic
- **Weaknesses**: Sometimes inconsistent
- **Best for**: Dream sequences, atmospheric content
- **Duration**: 5s

### Runway Gen4
- **Strengths**: Good motion, reliable
- **Weaknesses**: Cost, less creative than others
- **Best for**: Professional, controlled content

### Pika 2.2
- **Strengths**: Fun effects, good for short clips
- **Best for**: Social media clips, quick content

### PixVerse v4
- **Strengths**: Budget-friendly, decent quality
- **Best for**: High-volume, cost-effective content

### Hunyuan
- **Strengths**: Open-source foundation, good baseline
- **Best for**: Standard video generation

## Image Models — Detailed Comparison

### Flux Schnell
- **Speed**: Fastest (~2-5s)
- **Quality**: Good
- **Best for**: Thumbnails, quick drafts, testing prompts

### Flux Dev
- **Speed**: Moderate (~10-15s)
- **Quality**: High
- **Best for**: General purpose, balanced speed/quality

### Flux Pro
- **Speed**: Slower (~15-30s)
- **Quality**: Highest Flux tier
- **Best for**: Professional images, marketing content

### Ideogram 3
- **Speed**: Moderate
- **Quality**: Excellent, especially text in images
- **Best for**: Posters, signage, text-heavy images

### Recraft v3
- **Speed**: Moderate
- **Quality**: Excellent for design
- **Best for**: Illustrations, icons, design assets

### Seedream 4.5
- **Speed**: Moderate
- **Quality**: Photorealistic
- **Best for**: Product photos, realistic portraits

### GPT Image 1
- **Speed**: Moderate
- **Quality**: Strong photorealism and instruction following
- **Best for**: Complex scene composition, photorealistic content

## Fallback Chains

If the primary model fails, fall back in order:

**Video**: Kling 3.0 → Veo 3.1 → Seedance 2.0 → Hailuo
**Anime**: Wan 2.2 → Kling 3.0 → PixVerse v4
**Image**: Flux Pro → Flux Dev → Flux Schnell
**I2V**: Kling 3.0 → Seedance 2.0 → Runway Gen4
