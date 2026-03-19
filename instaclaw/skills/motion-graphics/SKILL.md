---
name: motion-graphics
description: >-
  Create programmatic animated videos, explainers, product demos, and social content using Remotion + React. Use when the user asks for video animation, motion graphics, demo videos, promo videos, animated explainers, product launch videos, or branded video content. NOT for AI-generated realistic video — use sjinn-video for that.
---
# Motion Graphics Skill

Create professional animated videos, explainers, product demos, and social content using code-driven motion graphics. This is NOT AI-generated video — this is programmatic animation with full creative control.

## Metadata

```yaml
name: motion-graphics
version: 2.3.0
updated: 2026-02-27
author: InstaClaw
triggers:
  keywords: [video, animation, motion graphics, demo video, promo video, marketing video, render video, product demo, social media video, branded content, explainer video, remotion, tiktok video, reel, product launch video, pitch deck video, animated explainer, animated content]
  phrases: ["create a video", "make a demo video", "render a promo", "build a marketing video", "product demo video", "social media video", "branded video", "make me a reel", "product launch video", "explainer video", "pitch deck video", "motion graphics", "animated explainer"]
  NOT: [watch video, play video, stream, download video, screen recording, AI video, generate realistic video]
```

## What This Is (and What to Use Instead)

**Motion Graphics** = programmatic animation built as **code** using React + Remotion + animation libraries. Every frame is a React component. Every animation is a function.

**This skill is for:** Animated text, kinetic typography, UI animations, product demos, explainers, social ads, pitch deck videos, branded content, data visualization.

**This skill is NOT for:** Realistic AI-generated footage (people, landscapes, cinematic scenes). For that, use **The Director** skill (sjinn-video) which uses AI models like Veo3, Seedance 2.0, and Sora2.

Why Motion Graphics:

- **100% brand fidelity** — exact hex colors, exact fonts, exact logos. Not "close enough" — exact.
- **Surgical editing** — change one word, one color, one timing value without re-rendering the entire video. Scene 3's background is wrong? Change one hex code. Done.
- **Deterministic output** — same code = same video every time. No "roll the dice and hope the AI gets it right this time."
- **Full creative control** — you control every frame, every easing curve, every millisecond of timing. Nothing is left to chance.
- **Infinite iterations at near-zero cost** — each edit + render cycle takes 30-90 seconds. You can iterate 20 times in the time it takes an AI video tool to generate one clip.
- **Zero credits consumed** — unlike AI video generation, motion graphics cost nothing to render.

## Dependencies

- Node.js + npm (pre-installed on VM snapshot)
- Remotion packages: `remotion`, `@remotion/cli`, `@remotion/bundler`
- Animation libraries: `framer-motion@11`, `gsap@3.12`, `@react-spring/web`
- 3D (optional): `three`, `@react-three/fiber`
- FFmpeg (pre-installed on VM snapshot)
- Template: `assets/template-basic/` (working Remotion project, renders out of the box)

Install all animation libs during project setup:
```bash
npm i framer-motion@11 gsap@3.12 @react-spring/web three @react-three/fiber
```

---

## Section 1: Pre-Flight Checklist

**ALWAYS gather this information before writing a single line of code.** Skipping pre-flight is the #1 cause of wasted iterations.

### Required Information

| Question | Why It Matters | Example |
|----------|---------------|---------|
| **Purpose** | Determines structure, pacing, tone | Product launch, explainer, social ad, demo, pitch deck video, testimonial compilation |
| **Platform** | Determines aspect ratio and duration constraints | TikTok/Reels (9:16), YouTube (16:9), Instagram feed (1:1), website hero (16:9 loop) |
| **Duration** | Determines scene count and pacing | 15s (social), 30s (standard), 45-60s (explainer), 60-90s (demo) |
| **Brand assets** | Logo files, hex colors, font names, design system, reference videos/websites | "Our website is example.com, brand colors are #1a1a2e and #e94560" |
| **Tone** | Determines animation style and pacing | Professional, playful, cinematic, high-energy, minimal, premium, techy |
| **Key messages** | The actual copy that appears on screen | "Ship 10x faster", "Try free for 14 days", "Join 50,000+ teams" |
| **CTA** | What the viewer should do after watching | Visit URL, download app, sign up, follow account, swipe up |

### If the user provides a website URL

Use `browser` evaluate to extract brand assets automatically:
1. **Fonts:** Query computed styles on `body, h1-h3, p, button, .hero, [class*="title"]` — extract fontFamily, fontWeight, fontSize, letterSpacing
2. **Colors:** Iterate all elements, collect backgroundColor and color values, sort by frequency, take top 8
3. **Logos:** Query `img[alt*="logo" i]`, `[class*="logo"] img`, `header img/svg`, `nav img/svg` — collect src, dimensions

Save results to `brand-config.json` with typography (heading/body/mono families + weights), colors (primary/secondary/accent/background/text), and logo paths (white/dark/icon variants).

### Logo Contrast Rule (Critical)

| Background | Logo Variant | Result |
|-----------|-------------|--------|
| Dark (#0f1419) | White logo | Visible |
| Dark (#0f1419) | Dark/black logo | INVISIBLE — never do this |
| Light (#f5f3ee) | Dark logo | Visible |
| Light (#f5f3ee) | White logo | INVISIBLE — never do this |

This was learned the hard way. Always verify logo contrast before rendering.

---

## Prompt Enhancement

**ALWAYS expand vague prompts into detailed technical specs BEFORE creating a storyboard.** This is the single biggest quality driver. A detailed spec means the first render is 80% right instead of 20% right.

### The Process

When a user gives a vague brief like "make a promo video for my app":

**Step 1: Research.** Look at their website/brand for colors, fonts, style, copy, tone. Use the brand extraction scripts from Section 1.

**Step 2: Expand into a scene-by-scene technical spec.** Every scene must have:
- **Duration** — exact start/end timestamps
- **Visual** — what's on screen, exact positioning
- **Text** — exact copy, font, size, weight, letter-spacing, color
- **Animation** — specific type with specific parameters (spring stiffness/damping, easing curve name, duration)
- **Transition** — how this scene connects to the next, with duration
- **Audio** — sync points if voiceover/music is involved

**Step 3: Present the expanded spec to the user for approval.** Do NOT write code until they approve.

### Example Expansion

User says: *"make a promo for my SaaS product"*

Agent expands to:

```
EXPANDED BRIEF — [Product Name] Promo Video
Duration: 30s | Aspect: 16:9 (1920x1080) | FPS: 30

Scene 1 (0:00–0:03) — HOOK
  Background: Solid #0A0A0A
  Text: "[Product Name]" — Inter Bold 72px, #FFFFFF, letter-spacing: -0.02em
    Animation: Blur-to-sharp (filter: blur(20px) → blur(0)) over 0.8s, ease-out
  Text: "[Tagline]" — Inter Regular 24px, rgba(255,255,255,0.7)
    Animation: Slide up from y:30px, 0.3s delay after title
    Spring: { stiffness: 120, damping: 14 }
  Transition to Scene 2: Cross-fade over 0.4s

Scene 2 (0:03–0:10) — FEATURES
  Background: Linear gradient 135deg from #0A0A0A to #12121A
  Layout: 3 feature cards, horizontal stack, centered
  Each card: 280x160px, background rgba(255,255,255,0.05),
    backdrop-filter: blur(12px), border: 1px solid rgba(255,255,255,0.1),
    border-radius: 16px
  Card icon: 32px, brand accent color, scales in with overshoot spring
    Spring: { stiffness: 200, damping: 10 }
  Card title: Inter SemiBold 18px, #FFFFFF
  Card body: Inter Regular 14px, rgba(255,255,255,0.6)
  Stagger: 0.15s between cards (4.5 frames at 30fps)
  Subtle float: Each card oscillates y ±3px over 3s, ease: sine.inOut
  Transition to Scene 3: Wipe-right over 0.5s

Scene 3 (0:10–0:18) — PRODUCT DEMO
  Background: #0A0A0A
  Product screenshot: Real UI capture, 1200x800px, centered
    Animation: Slides in from right (x: 100px → 0) with parallax
    Spring: { stiffness: 100, damping: 18 }
  Shadow: 0 20px 60px rgba(0,0,0,0.5) behind screenshot
  Subtle parallax: Background gradient shifts 5% left as screenshot enters
  Transition to Scene 4: Cross-fade over 0.4s

Scene 4 (0:18–0:25) — SOCIAL PROOF
  Background: #0A0A0A
  Counter: "[Number]+" — Inter Bold 64px, brand accent color
    Animation: Counts from 0 to target over 1.5s
    Spring: { stiffness: 40, damping: 30 }
    Font-variant-numeric: tabular-nums
  Label: "[Metric]" — Inter Regular 20px, rgba(255,255,255,0.7)
    Animation: Fade in 0.3s after counter completes
  Customer quote: "[Quote]" — Inter Regular Italic 18px, rgba(255,255,255,0.5)
    Animation: Fade in + slide up from y:20px, 0.5s after label
  Transition to Scene 5: Cross-fade over 0.3s

Scene 5 (0:25–0:30) — CTA
  Background: Gradient from #0A0A0A to brand primary at 10% opacity
  CTA text: "[CTA Copy]" — Inter Bold 48px, #FFFFFF
    Animation: Scale up from 0.9 to 1.0 with spring, then subtle pulse
    Pulse: scale oscillates 1.0 → 1.02 → 1.0 over 2s, sine easing
  URL: "[url]" — Inter Regular 20px, brand accent
    Animation: Fade in 0.5s after CTA, from y:10px
  Logo: Bottom-right corner, white variant, 120px wide
    Animation: Already present from Scene 4 (persistent)
  Glow: Box-shadow 0 0 60px rgba(brand, 0.2) behind CTA text
```

This level of detail means:
- The user can approve the creative direction before any code is written
- The first code iteration will be close to final
- Iteration becomes surgical — "change Scene 2 stagger to 0.2s" instead of "I don't like it, try again"

### Expansion Checklist

Before presenting the expanded brief, verify:
- [ ] Every scene has exact colors (hex values, not "dark blue")
- [ ] Every text element has font family, size, weight, and color
- [ ] Every animation has a specific type and parameters
- [ ] Transitions between ALL scenes are specified
- [ ] Total duration adds up correctly
- [ ] Layout positions are described (centered, left-aligned, grid, etc.)

---

## Section 2: Storyboard Structure

**ALWAYS create a storyboard and present it to the user for approval BEFORE writing any code.** This is non-negotiable. Changing a storyboard takes 30 seconds. Changing code takes 30 minutes.

### Scene Structure Template

```
Scene 1 (0:00–0:03) — HOOK
  Visual: [What's on screen — bold text, dramatic reveal, product shot]
  Text: [Exact copy that appears]
  Animation: [How it enters — scale up from center, slide from left, typewriter]
  Audio: [If applicable — beat drop, whoosh, silence]

Scene 2 (0:03–0:08) — SETUP
  Visual: [Introduce the product/concept/problem]
  Text: [Copy]
  Animation: [Entrance + exit transitions]
  Transition from Scene 1: [Cross-fade, wipe, cut, zoom]

Scene 3 (0:08–0:18) — VALUE / FEATURES
  Visual: [Show what it does, why it matters, key features]
  Text: [Feature bullets, stats, key messages]
  Animation: [Staggered reveals, icon animations, counter animations]
  Transition from Scene 2: [Type]

Scene 4 (0:18–0:25) — PROOF / DEMO
  Visual: [Social proof, live demo, screenshot, testimonial, stat]
  Text: [Quote, metric, evidence]
  Animation: [Screenshot slide-in, counter animation, quote fade]
  Transition from Scene 3: [Type]

Scene 5 (0:25–0:30) — CTA
  Visual: [Clear call to action, logo, URL]
  Text: [CTA copy — "Try free", "Get started", "Visit site"]
  Animation: [CTA pulses or glows, URL fades in below, logo present]
  Transition from Scene 4: [Type]
```

### Pre-Built Storyboards by Video Type

**Product Launch (30s):**
1. (0–3s) HOOK: Product name + tagline animate in large on dark background. Bold, confident.
2. (3–10s) FEATURES: 3 key features animate in as icon + text pairs with stagger delay (0.5s between each).
3. (10–18s) DEMO: Product screenshot/UI slides in with subtle parallax. Show the real product.
4. (18–25s) PROOF: Social proof — customer quote with attribution, or animated stat counter ("50,000+ users").
5. (25–30s) CTA: CTA text pulses with glow effect. URL fades in below. Logo anchored in corner.

**Explainer (45s):**
1. (0–3s) HOOK: Question that identifies the problem — "Tired of [pain point]?"
2. (3–10s) PROBLEM: Visualize the pain — red X marks, frustrated icons, messy UI mockup.
3. (10–20s) SOLUTION: Introduce the product as the answer. Clean UI, green checkmarks, smooth transitions.
4. (20–35s) HOW IT WORKS: 3-step breakdown. Step 1 → Step 2 → Step 3 with numbered icons and brief text.
5. (35–45s) CTA: "Get started free" + URL + logo. Hold for 3+ seconds.

**Social Ad — TikTok/Reels (15s, 9:16 vertical):**
1. (0–2s) SCROLL-STOPPER: Bold kinetic text fills the screen. Must stop the thumb in 1.5 seconds.
2. (2–6s) HOOK: Expand on the opening — what is this, why should I care?
3. (6–11s) VALUE: One killer feature or benefit, shown with animation. Keep it simple.
4. (11–15s) CTA: "Link in bio" / "Follow for more" / swipe-up prompt. Logo present.

**Pitch Deck Video (60s):**
1. (0–5s) HOOK: Bold problem statement or market stat.
2. (5–15s) PROBLEM: Quantify the pain with animated stats and charts.
3. (15–30s) SOLUTION: Product demo — real screenshots, real UI, smooth transitions.
4. (30–45s) TRACTION: Metrics that matter — users, revenue, growth rate. Animated counters.
5. (45–55s) TEAM/VISION: Brief — logo + one-line vision statement.
6. (55–60s) CTA: "Let's talk" + contact info + logo.

**Website Hero (10–15s, 16:9, seamless loop):**
1. (0–5s) Brand name + tagline animate in.
2. (5–10s) Key visual — product mockup, abstract animation, or feature highlight.
3. (10–15s) Subtle transition back to start frame for seamless loop. No hard cuts.

---

## Section 3: Animation Library & Techniques

### Core Pattern: Spring Entrance with Stagger

This is the foundation for 90% of motion graphics scenes. Master this pattern:

```tsx
import { spring, useCurrentFrame, useVideoConfig, interpolate } from "remotion";

const frame = useCurrentFrame();
const { fps } = useVideoConfig();

// Spring entrance — the core building block
const slideUp = spring({ frame, fps, config: { damping: 15, stiffness: 120 } });
const translateY = interpolate(slideUp, [0, 1], [40, 0]);
const opacity = slideUp;

// Staggered list — delay each item by N frames
const items = ["Feature 1", "Feature 2", "Feature 3"];
{items.map((item, i) => {
  const delay = i * 8; // 8 frames = ~0.27s at 30fps
  const progress = spring({ frame: frame - delay, fps, config: { damping: 15, stiffness: 100 } });
  return (
    <div key={i} style={{ opacity: progress, transform: `translateX(${interpolate(progress, [0, 1], [-30, 0])}px)` }}>
      {item}
    </div>
  );
})}
```

### Animation Toolkit Reference

| Effect | Technique | Key Code |
|--------|-----------|----------|
| Fade in | `interpolate(frame, [0, 15], [0, 1], { extrapolateRight: "clamp" })` |
| Slide up/left | `spring()` → `interpolate(spring, [0,1], [offset, 0])` |
| Scale pop | `spring({ config: { damping: 10, stiffness: 150, mass: 0.5 } })` |
| Blur to sharp | `interpolate(frame, [0, 20], [12, 0])` → `filter: blur(${v}px)` |
| Typewriter | `text.slice(0, Math.floor(interpolate(frame, ...)))` + cursor blink |
| Word-by-word | `.split(" ").map()` with per-word delay spring |
| Counter animation | `Math.floor(target * spring())` + `fontVariantNumeric: "tabular-nums"` |
| Kinetic text | Combine `scale(spring)` + `rotate(interpolate)` |
| Gradient text | `background: linear-gradient(...)` + `WebkitBackgroundClip: "text"` |
| Glow pulse | `Math.sin(frame * 0.1)` driving `textShadow` radius |
| Cross-fade | Two `interpolate` on same range: `[1,0]` and `[0,1]` |
| Wipe | `clipPath: inset(0 ${100-progress}% 0 0)` |
| Mask reveal | `overflow: hidden` + `translateY(${(1-spring)*100}%)` |
| Particle BG | Array of objects with pseudo-random positions + frame-driven y offset |
| Gradient shift | `hsl(${base + interpolate(frame,...)}, ...)` |

### Motion Principles

**NEVER use linear motion.** Always use `spring()` or eased `interpolate`.

| Feel | damping | stiffness | Use Case |
|------|---------|-----------|----------|
| Snappy | 15–20 | 100–150 | UI elements, text, buttons |
| Bouncy | 8–12 | 150–200 | Logos, icons, emphasis |
| Premium | 20–30 | 40–80 | Background, slow reveals |
| Punchy | 10–12 | 200–300 | Social media, TikTok |

- Stagger children by 0.1–0.15s. NEVER bring everything in at once.
- Hold scenes 2–4s after animations complete — let viewers read.
- Transitions: 0.3–0.5s. Faster = more professional.
- Animate ONE thing at a time. Sequential > simultaneous.
- Exit animations should be faster than entrances (0.2–0.4s vs 0.4–0.8s).

---

## Advanced Animation Libraries

Remotion's `spring()` + `interpolate()` handle basics. For premium output, pick the right library:

### Framer Motion — Declarative Animations (PRIMARY)

`npm i framer-motion@11` — Best for entrances, layout transitions, staggered reveals.

**Complete Framer Motion variants pattern (use this for multi-element scenes):**
```tsx
import { motion, AnimatePresence } from "framer-motion";

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.15, delayChildren: 0.3 }
  }
};

const itemVariants = {
  hidden: { opacity: 0, y: 30 },
  visible: {
    opacity: 1, y: 0,
    transition: { type: "spring", stiffness: 120, damping: 14 }
  }
};

// Staggered entrance — items animate in one by one
<motion.div variants={containerVariants} initial="hidden" animate="visible">
  {items.map((item, i) => (
    <motion.div key={i} variants={itemVariants}>{item}</motion.div>
  ))}
</motion.div>

// Scene transitions with AnimatePresence
<AnimatePresence mode="wait">
  {currentScene === 1 && (
    <motion.div key="scene1"
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 1.05 }}
      transition={{ type: "spring", stiffness: 120, damping: 14 }}
    >
      <Scene1 />
    </motion.div>
  )}
</AnimatePresence>
```

**Spring presets:** Snappy `{stiffness:400, damping:30}` | Bouncy `{stiffness:200, damping:10}` | Premium `{stiffness:120, damping:14}` | Punchy `{stiffness:600, damping:35}`

### Library Selection Guide

| Effect | Library | Install |
|--------|---------|---------|
| Entrances, staggered reveals | Framer Motion | `npm i framer-motion@11` |
| Complex timelines, char-by-char text | GSAP | `npm i gsap@3.12` |
| Physics-based bouncy motion | React Spring | `npm i @react-spring/web` |
| Continuous loops, shimmer, pulse | CSS @keyframes | Built-in (GPU-accelerated) |
| Particles, binary rain, star fields | Canvas API | Built-in (`useCurrentFrame()` drives `ctx`) |
| SVG path morphing | GSAP MorphSVG | GSAP plugin |
| 3D scenes | React Three Fiber | `npm i @react-three/fiber` |

**CSS GPU rule:** Only animate `transform` and `opacity`. NEVER animate width/height/top/left/margin/padding.

**Remotion integration:** All libraries work inside Remotion components. Use `useCurrentFrame()` to control trigger timing: `const shouldAnimate = frame >= sceneStartFrame;`

---

## Section 4: Prompt Template

Use as a starting point. Fill in bracketed values and hand to the storyboard step. Adapt this structure for explainers (add problem→solution arc), social ads (vertical 9:16, scroll-stopper first 1.5s), pitch decks (add traction metrics), or hero loops (seamless: last frame = first frame).

### Product Launch (30s, 16:9)

```
Create a 30-second product launch video for [PRODUCT NAME].

5 scenes:
1. (0-3s) Bold product name + spring physics on dark bg. Tagline fades in 0.5s after.
2. (3-10s) 3 key features as icon + text pairs, 0.4s stagger. Features: [F1], [F2], [F3]
3. (10-18s) Product screenshot slides in from right with parallax. Real screenshot, not mockup.
4. (18-25s) Social proof — animated counter "[NUMBER]+ [METRIC]" + customer quote below.
5. (25-30s) CTA "[CTA TEXT]" with glow pulse. URL + logo bottom-right.

Brand: Primary [HEX], Background [HEX], Text [HEX]
Font: Headings "[FONT]", Body "[FONT]"
Tone: [professional/playful/premium/energetic]
```

---

## Section 5: Iteration & Surgical Editing

The entire point of code-based video is that you can change anything without starting over. Use this.

### How to Iterate Efficiently

**NEVER regenerate the entire video for a small change.** Reference specific scenes and properties:

| User Says | What to Change |
|-----------|---------------|
| "Scene 3 background is wrong" | Change one hex value in Scene 3's background style |
| "Make the text bigger in the hook" | Increase fontSize in Scene 1 |
| "The features come in too fast" | Increase stagger delay from 8 to 12 frames |
| "Move the CTA earlier" | Adjust Scene 5's start frame |
| "I don't like the bounce on the logo" | Change spring config: increase damping, decrease stiffness |
| "Make it feel more premium" | Slow down transitions, increase damping, add subtle background motion, use more whitespace |
| "Make it feel more energetic" | Speed up transitions, decrease damping, add overshoot, tighten timing between scenes |
| "The pacing feels off" | Adjust scene durations — usually means middle scenes are too long or CTA is too short |

### Timing Adjustments

```tsx
// Scene timing is controlled by frame ranges
// At 30fps: 30 frames = 1 second

// To move Scene 2 entrance 0.5s earlier:
// Change: frame - 90  →  frame - 75  (15 frames = 0.5s at 30fps)

// To make Scene 3 last longer:
// Change scene3End from frame 540 to frame 600 (extend by 2 seconds)
// Also shift all subsequent scene start frames by 60
```

### When the user says "make it better"

Escalate quality in this order:
1. **Improve easing** — replace any remaining linear interpolations with spring physics
2. **Add depth** — subtle background motion (floating particles, gradient shift, noise texture)
3. **Improve typography** — add letter-spacing to headlines, use font-weight contrast, add text shadows
4. **Add micro-interactions** — hover-like states on buttons, subtle pulse on CTA, icon rotations
5. **Refine transitions** — use clip-path reveals instead of simple fades, add motion blur
6. **Add polish** — loading-bar-style progress indicators, subtle sound design cues in the storyboard

---

## Section 6: Template & Project Setup

### Starter Template

A complete working template is at `assets/template-basic/`:

```
assets/template-basic/
├── package.json          # Dependencies (remotion, @remotion/cli, etc.)
├── src/index.ts          # Entry point
├── src/Root.tsx           # Composition registration
├── src/MyVideo.tsx        # Multi-scene template with spring animations
├── remotion.config.ts     # Rendering configuration
└── tsconfig.json          # TypeScript config
```

### Setup Workflow

```bash
# 1. Copy template to workspace (includes pre-installed node_modules)
cp -r ~/.openclaw/skills/motion-graphics/assets/template-basic ~/.openclaw/workspace/video-project
cd ~/.openclaw/workspace/video-project

# 2. Edit src/MyVideo.tsx with brand assets, scenes, and copy

# 4. Preview (opens browser)
npx remotion preview src/index.ts

# 5. Draft render (fast, lower quality for review)
npx remotion render src/index.ts MyVideo out/draft.mp4 --crf 28

# 6. Production render (high quality)
npx remotion render src/index.ts MyVideo out/final.mp4 --crf 18 --codec h264
```

### Composition Registration

`src/Root.tsx` registers three compositions. **DO NOT rename the Root export** — `src/index.ts` imports it by name. `src/index.ts` — **never modify.**

**Composition IDs for render commands:** `MyVideo` (16:9, 1920x1080), `Vertical` (9:16, 1080x1920), `Square` (1:1, 1080x1080). All 15s @ 30fps. Edit `defaultProps` in Root.tsx to set brand colors, fonts, copy.

---

## Section 7: Export Settings

### Default Export

| Setting | Value | Notes |
|---------|-------|-------|
| Resolution | 1080p | 1920x1080 (16:9) or 1080x1920 (9:16) |
| Frame rate | 30fps | Use 60fps only for complex motion or gaming content |
| Codec | H.264 | Maximum compatibility |
| CRF | 18–23 | 18 = high quality/larger file, 23 = good quality/smaller file |

### Platform-Specific Settings

| Platform | Aspect Ratio | Resolution | Max Duration | Notes |
|----------|-------------|-----------|-------------|-------|
| TikTok / Reels | 9:16 | 1080x1920 | 60s (15-30s ideal) | First frame must be scroll-stopping. Bold text. |
| YouTube | 16:9 | 1920x1080 | No limit | Thumbnail-quality first frame. |
| Instagram Feed | 1:1 | 1080x1080 | 60s | Center-weighted composition — don't put key info at edges. |
| Instagram Stories | 9:16 | 1080x1920 | 15s | Avoid top 15% (username overlay) and bottom 20% (swipe-up). |
| Website Hero | 16:9 | 1920x1080 | 10-20s loop | Must loop seamlessly. No audio needed. Compress aggressively. |
| Twitter/X | 16:9 or 1:1 | 1920x1080 | 2m20s | Auto-plays muted. Text must carry the message without audio. |
| LinkedIn | 16:9 or 1:1 | 1920x1080 | 10min | Professional tone. Subtitles recommended. |

### Render Commands

```bash
# Draft (fast review cycle — 20-30s render time)
npx remotion render src/index.ts MyVideo out/draft.mp4 --crf 28

# Production (final quality — 1-3 min render time)
npx remotion render src/index.ts MyVideo out/final.mp4 --crf 18 --codec h264

# Vertical variant
npx remotion render src/index.ts Vertical out/vertical.mp4 --crf 18 --codec h264

# Square variant
npx remotion render src/index.ts Square out/square.mp4 --crf 18 --codec h264

# GIF (for previews, short loops)
npx remotion render src/index.ts MyVideo out/preview.gif --every-nth-frame 2
```

### FFmpeg Re-Encoding

Always re-encode Remotion output for delivery. Key flags: `-movflags +faststart` (web playback), `-pix_fmt yuv420p` (compatibility), `-profile:v high -level 4.1`.

```bash
# Premium delivery: ffmpeg -i out/final.mp4 -c:v libx264 -preset veryslow -crf 18 -movflags +faststart -pix_fmt yuv420p -profile:v high -level 4.1 out/delivery.mp4
# Web-optimized: add -maxrate 5M -bufsize 10M, use -crf 22 -preset slow
# Mix audio: ffmpeg -i video.mp4 -i voiceover.mp3 -c:v copy -c:a aac -b:a 192k -shortest out/with-audio.mp4
```

CRF guide: 18 = premium, 23 = good, 28 = draft.

---

## Deterministic Rendering

On VMs without GPU, Chrome's compositor can skip/duplicate frames under CPU load. Fix: launch with `--deterministic-mode` which forces synchronous frame-by-frame rendering.

**Key rules:**
- Always render 10 warmup frames before capture (fills pipeline, loads fonts/images)
- Use `HeadlessExperimental.beginFrame` API for manual frame control
- Capture PNGs → pipe to ffmpeg: `ffmpeg -framerate 30 -i frames/frame_%04d.png -c:v libx264 -preset veryslow -crf 18 -pix_fmt yuv420p -movflags +faststart out/deterministic.mp4`
- **Always** use for final/delivery renders and complex animations
- **Skip** for draft renders (CRF 28 previews)

---

## Audio & Voiceover Sync

### Workflow
1. Generate voiceover FIRST (ElevenLabs skill) → get word-level timestamps
2. Map timestamps to frames: `frameNumber = Math.round(timestampSeconds * fps)`
3. Align visuals to audio: text appears as narrator says it, scene transitions on sentence boundaries, emphasis animations on key words, pauses = hold time

### Key pattern
For each word timestamp, compute `startFrame = Math.round(w.start * fps)`, use `spring({ frame: frame - startFrame, ... })` for per-word entrance. Scene transitions: `sentenceEndFrame + 5` (5-frame buffer after sentence end).

### Mixing audio with video
```bash
# Basic: ffmpeg -i video.mp4 -i voiceover.mp3 -c:v copy -c:a aac -b:a 192k -shortest out/final-with-audio.mp4
# With ducked bg music: add -i bg-music.mp3, filter_complex "[2:a]volume=0.15[bg];[1:a][bg]amix=inputs=2:duration=first[aout]"
```

---

## Premium Design Patterns

### The "Expensive Video" Formula

Apply ALL of these to any video and it will look premium:

1. **Dark bg:** `#0A0A0A` (not #000) with subtle gradient (`linear-gradient(135deg, #0A0A0A, #1a1a2e, #0A0A0A)`)
2. **Typography:** Inter/Poppins/Space Grotesk, weight 800 headline + 400 body, `letterSpacing: "-0.03em"` headlines
3. **Text hierarchy:** `#FFF` headline, `rgba(255,255,255,0.7)` body, `rgba(255,255,255,0.5)` labels
4. **Glass cards:** `backdrop-filter: blur(12px)`, `border: 1px solid rgba(255,255,255,0.1)`, `boxShadow: 0 8px 32px rgba(0,0,0,0.3)`
5. **Spring preset:** `stiffness: 120, damping: 14` (Premium feel)
6. **Stagger:** 0.15s between sibling elements — NEVER everything at once
7. **Hold time:** 1–2s after animations complete before scene transition
8. **Background motion:** Gradient hue shift or particles at 3–5% opacity
9. **Noise overlay:** PNG at 4% opacity, `mixBlendMode: "overlay"`
10. **Vignette:** `radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.4) 100%)`

### Motion Rhythm Rules
- Entrance: 0.4–0.8s | Exit: 0.2–0.4s (always faster than entrance)
- Scene transitions: 0.3–0.5s | Same easing across all elements in a scene
- Never use Arial, Helvetica, Times New Roman, or Calibri
- 2 fonts max. Weight contrast > font contrast

---

## Section 8: Common Mistakes

- **Linear easing** → Always use `spring()`. No exceptions.
- **Everything animates at once** → Stagger entrances, guide attention sequentially
- **No hold time** → Key messages need 3–4s minimum on screen
- **Too much text** → Max 5–7 words/scene (social), 10–15 (explainer)
- **Min font sizes** → 48px body, 72px headlines at 1080p (mobile viewers = 60%+ of views)
- **Wrong logo contrast** → Dark on dark = invisible. Always verify.
- **Skipping storyboard** → Always get scene approval before coding
- **Regenerating for small changes** → This is code. Change the one line.
- **No draft render** → CRF 28 draft first (20s), then CRF 18 final (3min)

---

## Section 9: Quality Checklist

**Run through this checklist before delivering ANY video to the user.**

### Content & Copy
- [ ] All text is spelled correctly
- [ ] Key messages match what the user provided (no creative liberties with their copy)
- [ ] CTA is clear, actionable, and visible for at least 3 seconds
- [ ] No orphaned text (single words on their own line)

### Brand Fidelity
- [ ] Colors match brand exactly — hex codes verified, not approximated
- [ ] Fonts are correct — not falling back to system fonts
- [ ] Logo is the right variant for the background (white on dark, dark on light)
- [ ] Logo is correctly sized — not stretched, not pixelated
- [ ] Overall feel matches the brand's design language

### Animation Quality
- [ ] Zero linear easing — everything uses spring physics or curved interpolation
- [ ] Animations are smooth with no frame drops or jank
- [ ] Stagger timing is consistent within each scene
- [ ] Transitions between scenes are smooth — no jarring cuts
- [ ] Nothing animates during hold time (let viewers read)

### Technical
- [ ] Export matches target platform specs (resolution, aspect ratio, duration)
- [ ] File renders without errors
- [ ] File size is reasonable (1–4MB for 15–30s at 1080p)
- [ ] First frame is visually strong (matters for thumbnails and autoplay)
- [ ] Last frame is clean (no half-animated elements frozen mid-transition)

### Platform-Specific
- [ ] **Vertical (9:16):** No important content in top 15% or bottom 20% (UI overlays)
- [ ] **Social:** First 2 seconds are scroll-stopping
- [ ] **Website hero:** Loop is seamless — no visible jump at the loop point
- [ ] **All platforms:** Readable without audio — the video makes sense on mute

### Pacing
- [ ] Hook grabs attention in the first 2 seconds
- [ ] Middle section doesn't drag — every scene earns its time
- [ ] CTA has enough screen time (3+ seconds)
- [ ] Overall duration matches the brief — not padded with dead time
- [ ] Tone matches the requested feel (professional, playful, premium, etc.)

---

## Section 10: Delivery — Sending Videos to Users

After rendering, **you MUST send the video to the user.** A rendered file sitting on your VM is useless. The user is on Telegram — send it there.

### Telegram Video Delivery (Primary Method)

Your Telegram bot token is in `~/.openclaw/openclaw.json`. Use it to send the rendered .mp4 directly as a Telegram video message.

**Step 1: Extract bot token and find chat ID**
```bash
# Extract bot token from config
BOT_TOKEN=$(python3 -c "import json; print(json.load(open('$HOME/.openclaw/openclaw.json'))['channels']['telegram']['botToken'])")

# Get chat_id from most recent incoming message
CHAT_ID=$(curl -s "https://api.telegram.org/bot$BOT_TOKEN/getUpdates?limit=1&offset=-1" | python3 -c "import sys,json; r=json.load(sys.stdin)['result']; print(r[-1]['message']['chat']['id'] if r else 'NONE')")

echo "Bot: $BOT_TOKEN"
echo "Chat: $CHAT_ID"
```

**Step 2: Send the video**
```bash
# Send video with caption (max 50MB, recommended <20MB)
curl -F "chat_id=$CHAT_ID" \
     -F "video=@out/final.mp4" \
     -F "caption=Here's your video! 🎬" \
     -F "supports_streaming=true" \
     "https://api.telegram.org/bot$BOT_TOKEN/sendVideo"
```

**Step 3: Confirm delivery and STOP**

Capture the curl response. Check for `"ok":true` — that means the video was delivered successfully.

```bash
# Save the response to verify delivery
RESPONSE=$(curl -s -F "chat_id=$CHAT_ID" \
     -F "video=@out/final.mp4" \
     -F "caption=Here's your video!" \
     -F "supports_streaming=true" \
     "https://api.telegram.org/bot$BOT_TOKEN/sendVideo")
echo "$RESPONSE" | python3 -c "import sys,json; r=json.load(sys.stdin); print('DELIVERED' if r.get('ok') else 'FAILED:', json.dumps(r, indent=2)[:200])"
```

**CRITICAL: After a successful sendVideo (HTTP 200, `"ok":true`), you are DONE.**
- Do NOT attempt to re-send via the message tool, file transfer, or any other method
- Do NOT use `sendDocument` as a "backup" — one successful `sendVideo` is sufficient
- Do NOT try to attach or embed the video in a text reply
- Simply tell the user "Video sent!" and ask for feedback
- If `"ok":false`, THEN troubleshoot (check file size, bot token, chat ID)

### File Size Limits

| Method | Max Size | Notes |
|--------|----------|-------|
| Telegram sendVideo | 50MB hard limit | 20MB recommended for reliable delivery |
| Telegram sendDocument | 50MB hard limit | Fallback — sends as file attachment, no inline player |

### If the video is too large (>20MB)

1. **Re-encode with higher CRF** (smaller file):
```bash
ffmpeg -i out/final.mp4 -crf 26 -preset medium -movflags +faststart out/final-compressed.mp4
```

2. **Send as document** (if still >50MB after compression):
```bash
curl -F "chat_id=$CHAT_ID" \
     -F "document=@out/final.mp4" \
     -F "caption=Video file (large)" \
     "https://api.telegram.org/bot$BOT_TOKEN/sendDocument"
```

### Delivery Checklist
- [ ] Video renders without errors
- [ ] File size is under 20MB (re-encode if larger)
- [ ] Send via `sendVideo` (not `sendDocument` — users want inline playback)
- [ ] Include a caption describing what the video is
- [ ] Capture the curl response and verify `"ok":true`
- [ ] If `"ok":true` → STOP. Tell the user "Video sent!" and ask for feedback
- [ ] Do NOT re-send via message tool, sendDocument, or any other method after success

---

## Scripts & References

- `~/.openclaw/skills/motion-graphics/assets/template-basic/` — Starter template (renders out of the box)
- `~/.openclaw/skills/motion-graphics/references/advanced-patterns.md` — Complex animations, audio sync, data-driven videos
- `~/.openclaw/skills/motion-graphics/references/brand-assets-checklist.md` — Asset collection checklist
