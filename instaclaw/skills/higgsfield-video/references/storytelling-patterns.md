# Storytelling Patterns — Multi-Shot Video Production

## Overview
The story pipeline (`higgsfield-story.py`) enables multi-scene video production with consistent characters and narrative flow.

## Pipeline Stages

### 1. Planning
```bash
python3 higgsfield-story.py plan \
  --outline "A cowboy discovers a mysterious artifact in the desert" \
  --scenes 5 \
  --model kling-3.0 \
  --aspect-ratio 16:9 \
  --json
```

This creates a plan file at `~/.openclaw/workspace/higgsfield/stories/story_<timestamp>.json`.

### 2. Scene Customization
Edit the plan file to customize each scene's prompt:

```json
{
  "scenes": [
    {
      "scene_number": 1,
      "prompt": "Wide establishing shot: A lone cowboy rides through Monument Valley at golden hour. Shot on ARRI Alexa 35, 24mm, crane shot slowly descending.",
      "duration": "5",
      "status": "pending"
    },
    {
      "scene_number": 2,
      "prompt": "Medium shot: The cowboy dismounts and notices something glowing behind a rock formation. Dolly in, 50mm, dust particles in volumetric light.",
      "duration": "5",
      "status": "pending"
    }
  ]
}
```

### 3. Generation
```bash
python3 higgsfield-story.py generate --plan-file <path> --json
```
- Generates each scene sequentially
- Saves progress after each scene (resumable on failure)
- Updates plan file with request IDs and output URLs

### 4. Assembly
```bash
python3 higgsfield-story.py assemble --plan-file <path> --json
```
- Downloads all completed scenes
- Concatenates with FFmpeg
- Outputs final video

## Scene Decomposition Patterns

### Narrative Arc (3-5 scenes)
1. **Establishing** — Wide shot, set the scene
2. **Development** — Character action, building tension
3. **Climax** — Key moment, dramatic angle
4. **Resolution** — Outcome, emotional beat
5. **Closing** — Final wide or detail shot

### Product Demo (3-4 scenes)
1. **Hero shot** — Product beauty shot
2. **Feature A** — Close-up demonstration
3. **Feature B** — Another angle/feature
4. **Call to action** — Final composition with branding

### Social Media Story (3 scenes)
1. **Hook** — Eye-catching opening (1-2s feel)
2. **Content** — Main message/action
3. **CTA** — Call to action, logo, end card

## Character Consistency in Stories

### Method A: Elements (Best)
Add `elements_ref` to each scene in the plan file:
```json
{
  "scene_number": 1,
  "prompt": "...",
  "elements_ref": ["element_123"]
}
```

### Method B: Frame Forwarding
After generating Scene N:
1. Extract last frame
2. Upload as reference
3. Use I2V for Scene N+1

### Method C: Consistent Prompting
Include identical character description in every scene prompt:
- Same clothing, hair, accessories
- Same lighting conditions
- Same model (don't switch mid-story)

## Aspect Ratio Guidelines

| Platform | Ratio | Use Case |
|----------|-------|----------|
| YouTube | 16:9 | Standard horizontal video |
| TikTok/Reels | 9:16 | Vertical short-form |
| Instagram Post | 1:1 | Square format |
| Instagram Story | 9:16 | Vertical |
| Cinema | 16:9 or wider | Cinematic content |

## Tips

1. **Write prompts cinematically**: Include camera movements, lighting, lens choices
2. **Maintain visual continuity**: Same time of day, weather, color palette across scenes
3. **Use transitions**: Plan for how scenes connect (match cut, fade, etc.)
4. **Keep scenes short**: 5s per scene works best for consistency
5. **Review before assembly**: Check each scene before concatenating
6. **Audio last**: Add music/SFX after visual assembly
