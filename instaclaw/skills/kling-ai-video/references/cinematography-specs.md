# Cinematography Specs Reference

Quick reference for camera systems, lenses, movement, lighting, color science, and depth of field used in Kling AI prompts.

## Camera Systems

| Camera | Sensor | Known For | Best For |
|--------|--------|-----------|----------|
| **ARRI Alexa 35** | Super 35 ALEV 4 | Industry standard color science, natural skin tones, wide dynamic range | Narrative film, high-end commercials |
| **ARRI Alexa 65** | Large format 65mm | Epic scale, shallow DOF, resolving power | Landscapes, IMAX-style establishing shots |
| **RED Komodo 6K** | Super 35 VV | Compact body, high frame rate, sharp detail | Run-and-gun, documentary, action |
| **RED V-Raptor** | VV 8K | Maximum resolution, fast readout | High-detail product shots, slow motion |
| **Sony Venice 2** | Full-frame 8.6K | Dual base ISO (800/3200), excellent low-light | Night scenes, interiors, low-light work |
| **Blackmagic URSA Mini Pro 12K** | Super 35 | Affordable cinema, Blackmagic color science | Independent film, tight budgets |

**Usage in prompts:** Always pair camera body with a specific lens. "Shot on ARRI Alexa 35" alone is incomplete — add "with Cooke S4/i 50mm" or similar.

## Lens Reference

| Focal Length | Category | Character | Use Cases |
|-------------|----------|-----------|-----------|
| **14mm** | Ultra-wide | Extreme distortion, dramatic perspective, huge DOF | Architectural interiors, forced perspective, VFX plates |
| **18mm** | Super-wide | Wide perspective with less distortion, environmental | Landscape establishing shots, real estate interiors |
| **24mm** | Wide | Natural wide view, slight perspective exaggeration | Walk-and-talk tracking shots, environmental portraits |
| **35mm** | Standard wide | The workhorse — wide enough for context, tight enough for intimacy | Documentary, dialogue scenes, steadicam work |
| **50mm** | Normal | Closest to human eye perspective, neutral rendering | Interviews, medium shots, product photography |
| **85mm** | Short telephoto | Classic portrait lens, flattering compression, beautiful bokeh | Portraits, close-ups, over-the-shoulder shots |
| **100mm macro** | Macro | Extreme close-up with 1:1 magnification, paper-thin DOF | Product detail, texture, food, insects, small objects |
| **135mm** | Telephoto | Strong compression, isolates subjects, smooth bokeh | Emotional close-ups, crowd isolation, voyeuristic feel |
| **200mm** | Long telephoto | Extreme compression, stacks planes, heat shimmer visible | Sports, wildlife, surveillance aesthetic, heat distortion |

### Lens Families (for prompt specificity)

| Family | Character | Notes |
|--------|-----------|-------|
| **Cooke S4/i** | Warm, smooth, "Cooke Look" — gentle roll-off | Industry favorite for narrative. Oval bokeh at edges. |
| **Zeiss Supreme Prime** | Clean, sharp, modern — neutral rendering | Pairs well with Sony Venice. Very low distortion. |
| **Panavision Primo 70** | Large format, immersive, cinematic weight | The Alexa 65 pairing. Used on major features. |
| **Sigma Art** | Sharp wide open, accessible, slight clinical feel | Great value. Popular on RED cameras. |
| **Canon K-35** | Vintage, warm flares, soft halation on highlights | Vintage rehoused look. Organic, imperfect. |
| **Kowa Anamorphic** | Oval bokeh, horizontal flares, 2.39:1 widescreen squeeze | Anamorphic look. Blue streak flares. Classic cinema. |

## Camera Movement Types

| Movement | Physical Rig | Quality | When to Use |
|----------|-------------|---------|-------------|
| **Static / Locked** | Tripod, sticks | Rock solid, no movement, deliberate framing | Interviews, tension, composed tableaux, product hero |
| **Pan** | Tripod head, fluid head | Horizontal rotation on axis, smooth arc | Following lateral movement, reveals, landscape scans |
| **Tilt** | Tripod head | Vertical rotation on axis | Revealing height (buildings, people standing), top-to-bottom reveals |
| **Dolly** | Track + dolly, dana dolly | Forward/backward translation, parallax shift | Push-in for emphasis, pull-out for reveal, dialogue approach |
| **Truck** | Track + dolly, lateral | Side-to-side translation parallel to subject | Walking alongside, lateral tracking of movement |
| **Crane / Jib** | Crane arm, Technocrane | Vertical translation + arc, sweeping overhead | Establishing shots, rising reveals, overhead descents |
| **Steadicam** | Steadicam rig, body-mounted | Floating, smooth, organic micro-drift, following | Walk-and-talk, following through spaces, long takes |
| **Handheld** | Shoulder-mounted or freehand | Intentional shake, documentary feel, urgent energy | Documentary, action, emotional intensity, verité |
| **Drone** | DJI Inspire, FPV | Aerial perspective, impossible angles, sweeping | Establishing aerials, landscape reveals, tracking from above |

**Physics reminder:** Real camera moves have inertia. A dolly eases in and eases out. A crane settles at the top of its arc. A handheld operator breathes. Always describe the physical quality, not just direction.

## Lighting Styles

| Style | Description | Key-to-Fill Ratio | Mood |
|-------|-------------|-------------------|------|
| **Natural / Available** | Whatever light exists in the environment — sun, windows, overhead fixtures | Varies | Authentic, documentary, observational |
| **Practical** | Light sources visible in frame — lamps, screens, candles, neon signs | Varies | Immersive, motivated, naturalistic narrative |
| **Rembrandt** | Key light at 45-degree angle, small triangle of light on shadow-side cheek | 4:1 to 8:1 | Classic dramatic portrait, film noir, moody |
| **Split** | Light hitting exactly half the face, other half in shadow | 8:1+ | High drama, duality, mystery, thriller |
| **Butterfly / Paramount** | Key directly above and in front, shadow under nose | 2:1 to 3:1 | Glamour, beauty, classic Hollywood, fashion |
| **Broad** | Key light illuminates the side of face turned toward camera | 2:1 to 4:1 | Open, welcoming, commercial, corporate |
| **Backlight / Rim** | Light behind subject, creating edge highlight separation | N/A (accent) | Separation from background, ethereal, halo effect |

**In Kling prompts:** Never write "studio lighting" or "professional lighting." Always specify the source: "late afternoon sun through west windows" or "warm Edison bulb desk lamp casting hard shadows across paperwork."

## Color Science: Film Stocks

| Stock | ISO | Balance | Character | Best For |
|-------|-----|---------|-----------|----------|
| **Kodak Vision3 50D** | 50 | Daylight (5500K) | Ultra-fine grain, rich saturation, deep blacks | Bright exteriors, golden hour, product |
| **Kodak Vision3 200T** | 200 | Tungsten (3200K) | Moderate grain, natural tones, balanced | General-purpose interiors, documentary |
| **Kodak Vision3 500T** | 500 | Tungsten (3200K) | Visible grain structure, warm shadows, pushed contrast | Low light, night scenes, moody interiors |
| **Fuji Eterna 400T** | 400 | Tungsten (3200K) | Clean skin tones, subtle warm cast, fine grain for speed | Interviews, dialogue, skin-critical scenes |
| **Kodak Ektachrome 100D** | 100 | Daylight | Reversal (slide) film, vivid saturation, high contrast | Stylized flashbacks, music videos, bold color |

### Push/Pull Processing

- **Pushed one stop** — Increases grain, deepens contrast, lifts shadow detail. More dramatic.
- **Pulled one stop** — Reduces contrast, softer look, more pastel tones. More ethereal.

Include in prompt: "Kodak Vision3 500T pushed one stop" for a specific, repeatable look.

## Depth of Field Guide

| Aperture | DOF Character | Bokeh Quality | Use Case |
|----------|--------------|---------------|----------|
| **T1.3 - T1.5** | Paper-thin DOF, only eyes in focus | Maximum bokeh, large soft discs | Hero portraits, dramatic isolation |
| **T2.0 - T2.8** | Shallow, subject sharp, background soft | Smooth bokeh, manageable focus | Standard narrative close-ups, interviews |
| **T4.0** | Moderate, subject + nearby context sharp | Mild bokeh, background readable | Medium shots, two-person dialogue |
| **T5.6 - T8** | Deep, most of frame in focus | Minimal bokeh, environment sharp | Wide establishing, architectural, landscape |
| **T11 - T16** | Maximum DOF, near to infinity sharp | No bokeh, everything rendered | Documentary wide, deep staging, Wes Anderson |

### Bokeh Character by Lens

- **Cooke S4/i** — Smooth, warm, oval at edges (cat-eye vignetting)
- **Zeiss Supreme** — Clean circles, neutral, very even across frame
- **Kowa Anamorphic** — Stretched ovals (2x squeeze), distinctive cinema look
- **Canon K-35** — Busy bokeh with slight swirl, vintage character
- **Leica Summilux-C** — Exceptionally smooth, round highlights, minimal fringing

### DOF Formula (Conceptual)

Shallower DOF = wider aperture + longer focal length + closer subject distance + larger sensor.

For maximum subject isolation in a Kling prompt: "Sony Venice 2 with Zeiss Supreme 85mm T1.5, wide open, subject at 4 feet, full-frame sensor — razor-thin depth of field isolates the subject against a wash of creamy out-of-focus color."
