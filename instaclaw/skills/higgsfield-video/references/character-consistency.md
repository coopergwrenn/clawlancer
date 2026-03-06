# Character Consistency Guide

## Overview
Maintaining consistent characters across multiple video generations is one of the hardest challenges in AI video. This guide covers the three main approaches available through Muapi.ai.

## Method 1: Kling Elements (Recommended)

Kling 3.0 supports "Elements" — reference images that guide character appearance.

### Setup
1. Upload a clear reference image of the character
2. Get the element reference ID from the upload response
3. Pass `--elements-ref <ref_id>` to generation commands

### Workflow
```bash
# 1. Upload reference image
python3 higgsfield-generate.py upload-file --file character_ref.png --json
# Returns: {"file_url": "https://..."}

# 2. Create character profile
python3 higgsfield-character.py create \
  --name "Sheriff Dan" \
  --description "Rugged 50s cowboy with silver mustache, leather vest, tin star badge" \
  --ref-image "https://..." \
  --elements-ref "element_123" \
  --json

# 3. Generate with Elements
python3 higgsfield-generate.py text-to-video \
  --prompt "Sheriff Dan walks through a dusty saloon" \
  --model kling-3.0 \
  --elements-ref element_123 \
  --json
```

### Best Practices for Reference Images
- Clear, well-lit face/body shot
- Neutral expression
- Simple background
- High resolution (at least 512x512)
- Multiple angles help (front, 3/4, profile)

## Method 2: LoRA References

Some models support LoRA (Low-Rank Adaptation) references for fine-tuned character models.

### When to Use
- When you have a custom-trained LoRA model
- For branded characters that need pixel-perfect consistency
- When Elements alone aren't sufficient

### Workflow
```bash
# Create character with LoRA ref
python3 higgsfield-character.py create \
  --name "Brand Mascot" \
  --description "Cartoon fox with blue scarf" \
  --lora-ref "lora_abc123" \
  --json
```

## Method 3: Frame Forwarding (I2V Chaining)

Use the last frame of one generation as the first frame of the next.

### When to Use
- Multi-scene stories where characters must match exactly
- Continuing action from one clip to the next
- When neither Elements nor LoRA are available for the chosen model

### Workflow
```bash
# Scene 1: Generate initial video
python3 higgsfield-generate.py text-to-video \
  --prompt "A woman sits at a cafe reading a book" \
  --model kling-3.0 --json
# → output_url for scene 1

# Extract last frame (using FFmpeg)
ffmpeg -sseof -0.1 -i scene1.mp4 -frames:v 1 last_frame.png

# Upload last frame
python3 higgsfield-generate.py upload-file --file last_frame.png --json
# → file_url

# Scene 2: Use last frame as starting point
python3 higgsfield-generate.py image-to-video \
  --image <file_url> \
  --prompt "She looks up from her book and smiles" \
  --model kling-3.0 --json
```

### Limitations
- Slight drift over many scenes
- Works best with 2-5 scene chains
- Character may subtly change in clothing/accessories

## Character Profile System

The `higgsfield-character.py` script manages persistent character profiles:

### Storage
Characters are stored in `~/.openclaw/workspace/higgsfield/characters.json`

### Fields
```json
{
  "name": "Sheriff Dan",
  "description": "Rugged 50s cowboy with silver mustache...",
  "ref_images": [{"url": "...", "purpose": "primary_reference"}],
  "elements_refs": ["element_123"],
  "lora_refs": [],
  "style_notes": "Western, weathered, dusty",
  "generation_history": []
}
```

### Using Characters in Prompts
When using a character, always include their description in the prompt:
1. Retrieve: `python3 higgsfield-character.py use --name "Sheriff Dan" --json`
2. Prepend the `prompt_prefix` to your generation prompt
3. Include any `elements_refs` as `--elements-ref` flags

## Tips for Best Results

1. **Be specific**: Include age, ethnicity, clothing, distinguishing features
2. **Consistent clothing**: Describe the same outfit each time
3. **Consistent lighting**: Similar lighting conditions improve consistency
4. **Same model**: Don't switch models mid-story for the same character
5. **Prompt structure**: Put character description first, then action/scene
