# Skill: Kling AI Cinematic Video Prompting

## Metadata

```yaml
name: kling-ai-video
version: 1.0.0
updated: 2026-02-22
author: InstaClaw
triggers:
  keywords: [kling, cinematic, video prompt, film, photorealistic, scene, camera, footage]
  phrases: ["create a kling prompt", "cinematic video", "write a video prompt", "film this scene", "photorealistic video"]
  NOT: [remotion, motion graphics, template]
```

## Overview

Kling AI generates photorealistic video from text prompts. Unlike Remotion (which builds motion graphics from code), Kling produces footage that looks like it was captured by a real camera crew. This skill teaches prompt engineering for cinematic output — how to describe scenes so Kling renders them with film-grade realism instead of generic AI slop.

**This skill is documentation only, no code or scripts.** The agent uses these prompt patterns when a user requests cinematic or photorealistic video content through Kling AI.

## Dependencies

- Kling AI account with credits (https://klingai.com)
- No local software required — generation happens via Kling's platform
- No API keys stored on VM

## Core Philosophy: Photorealism Over CGI

Kling excels at real-world footage, not animated graphics. The fundamental rule: **never describe anything that looks "digital" or "rendered."** Every element in a Kling prompt should be something a physical camera could photograph in the real world.

Think like a cinematographer, not a 3D artist. You are describing what a camera sees on a film set — not what a computer generates in a viewport.

| Approach | Result |
|----------|--------|
| "A glowing neon orb floating in space" | Generic AI look, clearly synthetic |
| "Sunlight refracting through a dusty glass sphere on a weathered oak table, shot on 35mm" | Photorealistic, tactile, cinematic |

## Prompt Structure: 6 Required Elements

Every Kling prompt must contain all six elements. Missing any one of them degrades the output from cinematic to amateur.

### Template

```
[1. Subject/Scene Description]
[2. Camera System]
[3. Camera Movement]
[4. Lighting]
[5. Color & Grade]
[6. Atmosphere]
```

### Element Breakdown

**1. Subject/Scene Description** — Physical, tangible, real-world subjects. Describe surfaces, materials, textures. What would you see if you walked onto this set?

**2. Camera System** — Specific camera body and lens. This controls the entire look of the footage. Example: "shot on ARRI Alexa with Cooke S4/i 50mm" or "RED Komodo with Sigma Art 35mm f/1.4".

**3. Camera Movement** — How the camera physically moves through space: dolly push-in, crane ascending, steadicam tracking, handheld shake, locked tripod. Movement has physics — specify inertia, settling, organic drift.

**4. Lighting** — Natural, practical, or motivated sources only. Never say "studio lighting." Say "late afternoon sun filtering through venetian blinds" or "warm practicals from a desk lamp with a bare Edison bulb." Light comes from somewhere specific.

**5. Color & Grade** — Reference real film stocks or LUT styles. "Kodak Vision3 500T color science" or "teal-and-orange blockbuster grade" or "bleach bypass desaturated look." This controls the emotional tone.

**6. Atmosphere** — Environmental particles that make scenes feel real: dust motes in light beams, morning haze, breath vapor in cold air, rain on windows, pollen floating. Empty air looks fake.

## Real Examples

### Example 1: Primordial Ocean (Cinematic Nature)

```
A vast primordial ocean stretching to the horizon under a turbulent sky.
Massive dark storm clouds churn overhead, backlit by shafts of pale golden
light breaking through gaps in the cloud cover. The ocean surface is dark
teal-green, heaving with deep rolling swells. Whitecaps form and dissolve
across the frame. No land visible — only endless water and sky.

Shot on ARRI Alexa 65 with Panavision Primo 70 40mm lens. Wide
establishing shot, locked on a stabilized head mounted to the bow of a
vessel, with subtle organic drift from ocean swell. Slow push-in over 5
seconds.

Natural overcast light with dramatic crepuscular rays piercing the cloud
layer. Wet atmosphere scatters the backlight into soft volumetric shafts.
The water surface catches specular highlights from the breaks in cloud
cover.

Kodak Vision3 500T color science. Cool shadows with desaturated blue-green
in the midtones. Highlights roll off warmly where sunlight breaks through.
Lifted blacks, filmic grain structure visible in the sky.

Heavy marine atmosphere — salt spray hangs in the air, fine mist reduces
contrast on the horizon line, moisture droplets occasionally catch light
in the foreground. Wind-driven sea spray streaks across the lower frame.
```

### Example 2: Palo Alto VC Office (Indoor Business)

```
Interior of a Sand Hill Road venture capital office, late afternoon. A
partner in her mid-40s sits behind a clean walnut desk reviewing a pitch
deck on a matte-screen laptop. Behind her, floor-to-ceiling windows reveal
a manicured courtyard with California live oaks. The desk surface shows
everyday wear — a ring stain from a coffee cup, scattered Post-it notes
with handwritten figures, a Montblanc pen resting on a leather portfolio.

Shot on Sony Venice 2 with Zeiss Supreme Prime 40mm T1.5, wide open.
Shallow depth of field renders the background courtyard into a soft,
painterly blur. Medium shot, locked tripod with imperceptible micro-drift
from building vibration.

Late afternoon California sunlight enters through the west-facing windows,
casting long warm rectangles across the hardwood floor. Practical fill
from a brushed-nickel desk lamp with a warm-white LED. The laptop screen
provides a cool edge light on the subject's face from below.

Fuji Eterna 400T color science. Warm midtones, clean skin rendering with
subtle peach tones. Shadows hold detail without crushing. Gentle highlight
roll-off on the window light, no clipping.

Dust motes drift slowly through the window light shafts. The faintest
haze of afternoon warmth softens the background. A barely visible
reflection of courtyard foliage plays across the glass desktop surface.
```

## Five Principles of Photorealistic Prompting

### 1. Describe What a Camera Would See

Not what a render engine would produce. Cameras capture light bouncing off physical surfaces. Describe reflections, refractions, caustics, shadows — the behavior of real photons hitting real materials.

**Bad:** "A beautiful sunset over mountains"
**Good:** "Late sun at golden hour grazing the eastern face of granite peaks, warm light catching exposed quartz veins in the rock face, long shadows filling the valleys below"

### 2. Every Surface Needs Imperfection

Perfection is the hallmark of CGI. Real objects have dust, scratches, fingerprints, wear patterns, patina, water stains, UV fading. A "clean" surface still has micro-texture. Describe the history written on surfaces.

**Bad:** "A shiny new car"
**Good:** "A recently washed black sedan with fine water spots drying on the hood, a thin film of pollen along the windshield base, micro-swirl marks from machine polishing visible in the clear coat"

### 3. Use Lens-Specific Vocabulary

The lens shapes everything. Reference bokeh character (smooth vs nervous vs swirly), depth of field behavior, lens flare quality, chromatic aberration on high-contrast edges. Different lenses render the same scene completely differently.

**Bad:** "Blurry background"
**Good:** "Shallow depth of field with creamy bokeh from the Cooke S4 rendering background highlights as soft warm discs with gentle cat-eye vignetting at frame edges"

### 4. Reference Real Film Stocks and Color Science

Kling responds to specific color science references. Name real film stocks (Kodak Vision3 500T, Fuji Eterna 400T, Kodak Vision3 50D) or real color workflows (ACES, DaVinci Resolve Film Look). This anchors the color grade in a known aesthetic instead of leaving it to chance.

**Bad:** "Warm colors"
**Good:** "Kodak Vision3 500T tungsten-balanced stock, pushed one stop — rich warm shadows, elevated grain in the midtones, highlight roll-off that holds skin detail through overexposure"

### 5. Movement Should Have Physics

Camera movement in real life has mass and momentum. A dolly push-in has subtle acceleration and deceleration. A handheld operator breathes. A crane has a pendulum arc. A steadicam has a floating micro-drift. Specify the physical quality of movement, not just direction.

**Bad:** "Camera moves forward"
**Good:** "Slow dolly push-in on rails, easing in over 2 seconds with subtle mechanical settling at the end of travel, the kind of controlled creep you get from a geared head"

## Aesthetic Styles

| Style | Description | Camera | Lighting | Color |
|-------|-------------|--------|----------|-------|
| **Documentary** | Observational, naturalistic, unposed | Handheld with stabilization, longer lenses (85-135mm) to compress distance | Available light, practicals only, no modification | Neutral grade, natural skin tones, Kodak Vision3 200T |
| **Commercial** | Polished, aspirational, hero-lit products | Dolly/slider, controlled moves, 35-50mm primes wide open | Key + fill + rim, soft sources, negative fill for contrast | Clean and saturated, lifted shadows, perfect skin, ACES workflow |
| **Cinematic** | Dramatic, atmospheric, narrative tension | Crane + steadicam, epic scale moves, anamorphic lenses | Motivated practicals, strong contrast ratios (4:1+), volumetric haze | Teal-orange grade, crushed blacks, film grain, Kodak 500T pushed |
| **Music Video** | Stylized, bold, high-energy | Quick cuts between static and dynamic, dutch angles, macro inserts | Mixed color temperature practicals, neon, hard backlight | Heavy grade, split toning, high saturation accents, cross-process look |

## Kling AI Output Specs

| Parameter | Value |
|-----------|-------|
| Max resolution | 1080p (1920x1080) |
| Duration options | 5 seconds, 10 seconds |
| Aspect ratios | 16:9, 9:16, 1:1 |
| Generation time | 2-8 minutes per clip |
| Credits per generation | Varies by mode (Standard vs Professional) |
| Professional mode | Higher consistency, better prompt adherence |
| Camera control | Available in Professional mode — set start/end camera positions |
| Image-to-video | Upload a reference frame as generation starting point |

**Always use Professional mode for client work.** Standard mode is for quick tests only.

## 9-Step Workflow: Concept to Delivery

1. **Brief intake** — What is the scene? Who is the audience? What emotion should the viewer feel? What is this footage for (ad, social, website hero)?

2. **Reference gathering** — Find 2-3 real film/commercial frames that match the desired look. Identify the camera, lighting, and grade used in each reference.

3. **Scene design** — Define the physical environment, subjects, props, surfaces, and their conditions (new, worn, wet, dusty). Build the set in your mind.

4. **Camera selection** — Choose camera body and lens based on the desired look. Wide open prime for shallow DOF and bokeh? Anamorphic for cinematic flare and oval bokeh? Telephoto for compression?

5. **Movement choreography** — Design the camera move. What does the audience discover as the camera moves? Where does focus shift? How does the framing evolve?

6. **Lighting design** — Place light sources that exist in the physical scene. Every light needs a motivation — a window, a lamp, a screen, a fire, the sun. Describe quality (hard/soft), color temperature (warm/cool), and direction.

7. **Prompt assembly** — Combine all six elements into a single prompt. Read it back and ask: "Could a real camera crew shoot this exactly as described?" If yes, submit.

8. **Generation and review** — Generate 2-3 variants. Evaluate for: photorealism, prompt adherence, motion quality, temporal consistency. Select the best candidate.

9. **Iteration or delivery** — If no variant meets the bar, identify what failed (usually lighting or movement) and adjust the prompt. If a variant works, deliver at the appropriate resolution and aspect ratio.

## Common Mistakes with Corrections

| Mistake | Why It Fails | Correction |
|---------|-------------|------------|
| "3D rendered scene" | Tells Kling to make CGI | "Shot on 35mm film" or specify a real camera system |
| "Beautiful lighting" | Too vague, Kling guesses | "Late afternoon sun at 15-degree angle from camera left, warm practicals filling shadows" |
| "4K ultra HD" | Kling outputs 1080p max, irrelevant descriptor | Remove — specify camera system instead, which implies quality |
| "Hyper-realistic" | Paradoxically produces more AI-looking results | Describe specific real-world details (texture, wear, dust) instead |
| No atmosphere specified | Scene looks like a vacuum, sterile and fake | Add particles: dust, haze, moisture, fog, pollen, smoke |
| "Camera zooms in" | Zoom =/= dolly, produces cheap look | "Dolly push-in on rails" for the cinematic version of forward movement |
| Generic color description | "Warm tones" gives inconsistent results | Reference specific film stock: "Kodak Vision3 500T color science" |
| Perfect/clean surfaces | Screams computer-generated | Add imperfections: scratches, dust, fingerprints, wear, patina |
| No lens specified | Kling defaults to generic wide look | Always specify: "Cooke S4/i 50mm" or "Zeiss Supreme Prime 35mm T1.5" |

## Quality Checklist

Run before submitting any Kling prompt:

- [ ] All 6 required elements present (subject, camera system, movement, lighting, color/grade, atmosphere)
- [ ] Camera system specifies both body and lens (not just "cinematic camera")
- [ ] Lighting sources are physically motivated (not "studio lighting" or "perfect lighting")
- [ ] At least one surface imperfection described (dust, wear, scratches, moisture)
- [ ] Film stock or color science referenced by name (not just "warm" or "cool")
- [ ] Camera movement has physical quality (inertia, settling, drift — not just direction)
- [ ] Atmosphere contains particles or environmental effects (not empty air)
- [ ] Prompt reads like a shot description from a DP, not a request to a render engine

## Integration with Other Skills

| Skill | Relationship |
|-------|-------------|
| **Remotion Video (Skill 1)** | Kling generates footage clips; Remotion composites them with text overlays, logos, and motion graphics |
| **Brand Asset Extraction (Skill 8)** | Brand colors inform Kling's color grade; brand environment informs scene design |
| **Social Media (Skill 9)** | Kling clips cut to 9:16 for Reels/TikTok, 1:1 for feed posts |

## Files

- `~/.openclaw/skills/kling-ai-video/SKILL.md` — This file (the complete skill)
- `~/.openclaw/skills/kling-ai-video/references/cinematography-specs.md` — Camera systems, lens, lighting, and color science reference
