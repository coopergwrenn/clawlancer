# Skill: Video Production Studio

## Metadata

```yaml
name: video-production-studio
version: 2.0.0
updated: 2026-02-27
author: InstaClaw
triggers:
  keywords: [video, animation, motion graphics, demo video, promo video, marketing video, render video, product demo, social media video, branded content, explainer video, remotion, tiktok video, reel, product launch video, pitch deck video]
  phrases: ["create a video", "make a demo video", "render a promo", "build a marketing video", "product demo video", "social media video", "branded video", "make me a reel", "product launch video", "explainer video", "pitch deck video"]
  NOT: [watch video, play video, stream, download video, screen recording]
```

## What This Is (and Isn't)

This is **programmatic motion graphics** — NOT AI-generated video like Sora, Runway, or Kling. Videos are built as **code** using React + Remotion + animation libraries. Every frame is a React component. Every animation is a function.

Why this matters:

- **100% brand fidelity** — exact hex colors, exact fonts, exact logos. Not "close enough" — exact.
- **Surgical editing** — change one word, one color, one timing value without re-rendering the entire video. Scene 3's background is wrong? Change one hex code. Done.
- **Deterministic output** — same code = same video every time. No "roll the dice and hope the AI gets it right this time."
- **Full creative control** — you control every frame, every easing curve, every millisecond of timing. Nothing is left to chance.
- **Infinite iterations at near-zero cost** — each edit + render cycle takes 30-90 seconds. You can iterate 20 times in the time it takes an AI video tool to generate one clip.

The tradeoff: this produces motion graphics, kinetic typography, animated UI, and data visualization — not photorealistic footage of people walking through a field. For that, use generative video tools. For everything else — product launches, explainers, social ads, pitch decks, branded content — programmatic video is superior.

## Dependencies

- Node.js + npm (pre-installed on VM snapshot)
- Remotion packages: `remotion`, `@remotion/cli`, `@remotion/bundler`
- FFmpeg (pre-installed on VM snapshot)
- Template: `assets/template-basic/` (working Remotion project, renders out of the box)

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

Extract brand assets automatically before proceeding:

**Font extraction:**
```javascript
browser.act({
  request: {
    kind: "evaluate",
    fn: `() => {
      const selectors = ['body', 'h1', 'h2', 'h3', 'p', 'button', '.hero', '[class*="title"]'];
      const fonts = {};
      selectors.forEach(sel => {
        const el = document.querySelector(sel);
        if (el) {
          const style = window.getComputedStyle(el);
          fonts[sel] = {
            family: style.fontFamily,
            weight: style.fontWeight,
            size: style.fontSize,
            letterSpacing: style.letterSpacing
          };
        }
      });
      return fonts;
    }`
  }
});
```

**Color extraction:**
```javascript
browser.act({
  request: {
    kind: "evaluate",
    fn: `() => {
      const rgbToHex = (rgb) => {
        const match = rgb.match(/\\d+/g);
        if (!match) return null;
        const [r, g, b] = match.map(Number);
        return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
      };
      const colors = { backgrounds: {}, text: {}, accents: {} };
      document.querySelectorAll('*').forEach(el => {
        const s = getComputedStyle(el);
        const bg = rgbToHex(s.backgroundColor);
        const fg = rgbToHex(s.color);
        if (bg && bg !== '#000000') colors.backgrounds[bg] = (colors.backgrounds[bg] || 0) + 1;
        if (fg) colors.text[fg] = (colors.text[fg] || 0) + 1;
      });
      // Sort by frequency
      const sortObj = (obj) => Object.entries(obj).sort((a,b) => b[1]-a[1]).slice(0,8);
      return { backgrounds: sortObj(colors.backgrounds), text: sortObj(colors.text) };
    }`
  }
});
```

**Logo discovery:**
```javascript
browser.act({
  request: {
    kind: "evaluate",
    fn: `() => {
      const logos = [];
      ['img[alt*="logo" i]', '[class*="logo"] img', 'header img', 'nav img',
       '.navbar-brand img', '[class*="brand"] img', 'a[href="/"] img'].forEach(sel => {
        document.querySelectorAll(sel).forEach(img => {
          logos.push({ src: img.src, alt: img.alt, w: img.naturalWidth, h: img.naturalHeight });
        });
      });
      document.querySelectorAll('svg[class*="logo"], header svg, nav svg').forEach(svg => {
        logos.push({ type: 'inline-svg', classes: svg.className?.baseVal, viewBox: svg.getAttribute('viewBox') });
      });
      return logos;
    }`
  }
});
```

### Save brand assets as a theme file

After extraction, save everything to `brand-config.json` so it's reusable across scenes:

```json
{
  "brand": "Company Name",
  "extracted_from": "https://example.com",
  "extracted_at": "2026-02-27T00:00:00Z",
  "typography": {
    "heading": { "family": "\"Instrument Serif\", serif", "weights": [400, 700], "letterSpacing": "-0.02em" },
    "body": { "family": "Inter, sans-serif", "weights": [400, 500, 600], "letterSpacing": "0" },
    "mono": { "family": "\"JetBrains Mono\", monospace", "weights": [400, 500] }
  },
  "colors": {
    "primary": "#e67e4d",
    "secondary": "#d4634a",
    "accent": "#4ecdc4",
    "background": { "dark": "#0f1419", "light": "#f5f3ee", "gradient": "linear-gradient(135deg, #0f1419, #1a1a2e)" },
    "text": { "primary": "#ffffff", "secondary": "rgba(255,255,255,0.7)", "dark": "#1a1a1a" }
  },
  "logos": {
    "white": "path/to/logo-white.png",
    "dark": "path/to/logo-dark.png",
    "icon": "path/to/icon.svg"
  }
}
```

### Logo Contrast Rule (Critical)

| Background | Logo Variant | Result |
|-----------|-------------|--------|
| Dark (#0f1419) | White logo | Visible |
| Dark (#0f1419) | Dark/black logo | INVISIBLE — never do this |
| Light (#f5f3ee) | Dark logo | Visible |
| Light (#f5f3ee) | White logo | INVISIBLE — never do this |

This was learned the hard way. Always verify logo contrast before rendering.

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

### Entrance Animations

```tsx
import { spring, useCurrentFrame, useVideoConfig, interpolate } from "remotion";

const frame = useCurrentFrame();
const { fps } = useVideoConfig();

// Fade in
const fadeIn = interpolate(frame, [0, 15], [0, 1], { extrapolateRight: "clamp" });

// Slide in from bottom
const slideUp = spring({ frame, fps, config: { damping: 15, stiffness: 120 } });
const translateY = interpolate(slideUp, [0, 1], [40, 0]);

// Slide in from left
const slideRight = spring({ frame, fps, config: { damping: 15 } });
const translateX = interpolate(slideRight, [0, 1], [-60, 0]);

// Scale up (pop in)
const scaleUp = spring({ frame, fps, config: { damping: 10, stiffness: 150, mass: 0.5 } });

// Blur to sharp
const blur = interpolate(frame, [0, 20], [12, 0], { extrapolateRight: "clamp" });
// Apply as: filter: `blur(${blur}px)`
```

**Typewriter text:**
```tsx
const text = "Your message here";
const charsShown = Math.floor(interpolate(frame, [0, text.length * 2], [0, text.length], {
  extrapolateRight: "clamp"
}));
const displayText = text.slice(0, charsShown);
const showCursor = frame % 16 < 8; // Blinking cursor
```

**Word-by-word reveal:**
```tsx
const words = "Ship faster with confidence".split(" ");
{words.map((word, i) => {
  const delay = i * 6; // 6 frames between words
  const opacity = spring({ frame: frame - delay, fps, config: { damping: 20 } });
  const y = interpolate(opacity, [0, 1], [15, 0]);
  return (
    <span key={i} style={{ opacity, transform: `translateY(${y}px)`, display: "inline-block", marginRight: 8 }}>
      {word}
    </span>
  );
})}
```

**Staggered list reveal:**
```tsx
const items = ["Feature 1", "Feature 2", "Feature 3", "Feature 4"];
{items.map((item, i) => {
  const delay = i * 8; // 8 frames = ~0.27s at 30fps
  const progress = spring({ frame: frame - delay, fps, config: { damping: 15, stiffness: 100 } });
  const opacity = progress;
  const x = interpolate(progress, [0, 1], [-30, 0]);
  return (
    <div key={i} style={{ opacity, transform: `translateX(${x}px)` }}>
      {item}
    </div>
  );
})}
```

### Transitions Between Scenes

**Cross-fade:**
```tsx
// Scene A fades out as Scene B fades in
const sceneAOpacity = interpolate(frame, [transitionStart, transitionEnd], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
const sceneBOpacity = interpolate(frame, [transitionStart, transitionEnd], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
```

**Wipe transition:**
```tsx
const wipeProgress = interpolate(frame, [transitionStart, transitionEnd], [0, 100], { extrapolateRight: "clamp" });
// Scene B clips in from left:
<div style={{ clipPath: `inset(0 ${100 - wipeProgress}% 0 0)` }}>{sceneB}</div>
```

**Zoom transition:**
```tsx
const zoomOut = interpolate(frame, [transitionStart, transitionEnd], [1, 0.8], { extrapolateRight: "clamp" });
const zoomIn = interpolate(frame, [transitionStart, transitionEnd], [1.2, 1], { extrapolateRight: "clamp" });
// Scene A shrinks, Scene B grows into frame
```

**Color wash:**
```tsx
// Background color fills the screen as transition
const washProgress = spring({ frame: frame - transitionStart, fps, config: { damping: 20 } });
const bgColor = interpolateColors(washProgress, [0, 1], ["#0f1419", "#1a1a2e"]);
```

### Text Effects

**Kinetic typography:**
```tsx
const scale = spring({ frame, fps, config: { damping: 8, stiffness: 200 } });
const rotate = interpolate(frame, [0, 10], [-5, 0], { extrapolateRight: "clamp" });
<span style={{
  display: "inline-block",
  transform: `scale(${scale}) rotate(${rotate}deg)`,
  fontWeight: 900,
  fontSize: 72
}}>
  BOLD TEXT
</span>
```

**Gradient text:**
```tsx
<span style={{
  background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
  WebkitBackgroundClip: "text",
  WebkitTextFillColor: "transparent",
  fontSize: 64,
  fontWeight: 800
}}>
  Gradient Headline
</span>
```

**Animated counter:**
```tsx
const targetNumber = 50000;
const progress = spring({ frame, fps, config: { damping: 30, stiffness: 40 } });
const currentNumber = Math.floor(targetNumber * progress);
const formatted = currentNumber.toLocaleString();
<span style={{ fontVariantNumeric: "tabular-nums" }}>{formatted}+</span>
```

**Glow effect:**
```tsx
const glowPulse = Math.sin(frame * 0.1) * 0.3 + 0.7;
<span style={{
  textShadow: `0 0 ${20 * glowPulse}px rgba(78, 205, 196, ${glowPulse}),
               0 0 ${40 * glowPulse}px rgba(78, 205, 196, ${glowPulse * 0.5})`,
  color: "#4ecdc4"
}}>
  Glowing CTA
</span>
```

### Motion Principles

**Easing — NEVER use linear.** Linear motion looks robotic and cheap. Always use:
- `spring()` for organic, natural motion (primary choice)
- Ease-out (`extrapolateRight: "clamp"`) for entrances — fast start, gentle landing
- Ease-in for exits — gentle start, fast departure
- Ease-in-out for transitions between states

**Spring physics parameters:**
| Feel | damping | stiffness | mass | Use Case |
|------|---------|-----------|------|----------|
| Snappy & professional | 15–20 | 100–150 | 0.5–1 | UI elements, text, buttons |
| Bouncy & playful | 8–12 | 150–200 | 0.5 | Logos, icons, emphasis |
| Smooth & premium | 20–30 | 40–80 | 1–1.5 | Background elements, slow reveals |
| Punchy & energetic | 10–12 | 200–300 | 0.3 | Social media, TikTok, fast-paced |

**Timing rhythm:**
- If items enter at 0.25s intervals, maintain that interval throughout the scene.
- Stagger delays: 0.1–0.15s for rapid lists, 0.3–0.5s for deliberate reveals.
- Scene transitions: 0.3–0.6s. Faster feels energetic, slower feels premium.
- Hold time: Let key messages sit for 2–4 seconds. Viewers need time to read.

**Guide the eye:**
- Animate ONE thing at a time. Sequential reveals > simultaneous chaos.
- Use motion direction to create flow: left-to-right reads as "progress."
- Larger elements attract attention first — animate them first, then supporting elements.

### Advanced Techniques

**Particle background:**
```tsx
const particles = Array.from({ length: 30 }, (_, i) => ({
  x: (i * 73) % 100, // Pseudo-random distribution
  y: (i * 47) % 100,
  size: 2 + (i % 4),
  speed: 0.2 + (i % 5) * 0.1
}));

{particles.map((p, i) => {
  const y = (p.y + frame * p.speed) % 120 - 10;
  const opacity = interpolate(y, [0, 50, 100], [0, 0.4, 0]);
  return (
    <div key={i} style={{
      position: "absolute",
      left: `${p.x}%`,
      top: `${y}%`,
      width: p.size,
      height: p.size,
      borderRadius: "50%",
      backgroundColor: "rgba(255,255,255,0.3)",
      opacity
    }} />
  );
})}
```

**Mask reveal (text clips into view):**
```tsx
const revealProgress = spring({ frame, fps, config: { damping: 20 } });
<div style={{ overflow: "hidden" }}>
  <div style={{ transform: `translateY(${(1 - revealProgress) * 100}%)` }}>
    <h1>Headline Text</h1>
  </div>
</div>
```

**3D perspective tilt:**
```tsx
const tiltX = interpolate(frame, [0, 30], [15, 0], { extrapolateRight: "clamp" });
<div style={{
  perspective: 1000,
  perspectiveOrigin: "center"
}}>
  <div style={{
    transform: `rotateX(${tiltX}deg)`,
    transformOrigin: "bottom center"
  }}>
    {/* Content tilts into view */}
  </div>
</div>
```

**Gradient background animation:**
```tsx
const hueShift = interpolate(frame, [0, 150], [0, 30]);
<div style={{
  background: `linear-gradient(${135 + hueShift}deg,
    hsl(${220 + hueShift}, 60%, 15%),
    hsl(${260 + hueShift}, 50%, 20%))`,
  width: "100%",
  height: "100%"
}} />
```

---

## Section 4: Prompt Templates (Copy-Paste Starting Points)

Use these as starting points. Fill in the bracketed values and hand to the storyboard step.

### Product Launch (30s, 16:9)

```
Create a 30-second product launch video for [PRODUCT NAME].

5 scenes:
1. (0-3s) Bold product name animates in with spring physics on dark background.
   Tagline fades in 0.5s after. Text: "[TAGLINE]"
2. (3-10s) 3 key features animate in as icon + text pairs with 0.4s stagger delay.
   Features: [FEATURE 1], [FEATURE 2], [FEATURE 3]
3. (10-18s) Product screenshot slides in from right with subtle parallax effect.
   Use real screenshot, not a mockup.
4. (18-25s) Social proof — animated counter "[NUMBER]+ [METRIC]" counts up with
   spring physics. Customer quote fades in below.
5. (25-30s) CTA "[CTA TEXT]" pulses with glow effect. URL "[URL]" fades in below.
   Logo anchored bottom-right.

Brand: Primary [HEX], Background [HEX], Text [HEX]
Font: Headings "[FONT]", Body "[FONT]"
Tone: [professional/playful/premium/energetic]
```

### Explainer (45s, 16:9)

```
Create a 45-second explainer video for [CONCEPT/PRODUCT].

Structure: Hook question → Problem visualization → Solution intro → How it works (3 steps) → CTA

1. (0-3s) HOOK: Text "[HOOK QUESTION]?" animates in large, centered.
2. (3-10s) PROBLEM: Visualize [PAIN POINT]. Red accent color, X marks or
   frustrated iconography. Text: "[PROBLEM STATEMENT]"
3. (10-18s) SOLUTION: Clean transition to brand colors. Product name + logo
   animate in. Text: "[SOLUTION STATEMENT]"
4. (18-35s) HOW IT WORKS: 3 numbered steps with icons. Each step gets 5s.
   Step 1: [STEP], Step 2: [STEP], Step 3: [STEP]
   Stagger entrance, each slides in from left with number badge.
5. (35-45s) CTA: "[CTA TEXT]" + "[URL]" + logo. Hold 5+ seconds.

Style: Clean, minimal, generous whitespace. Slide-in and fade transitions only.
```

### Social Ad — TikTok/Reels (15s, 9:16 vertical)

```
Create a 15-second VERTICAL (9:16, 1080x1920) social ad for [PRODUCT].

CRITICAL: First 1.5 seconds must stop the scroll. Bold, full-screen kinetic text.

1. (0-2s) SCROLL-STOPPER: "[HOOK TEXT]" fills the screen in bold, oversized type.
   Animates with punch: fast scale-up with slight overshoot.
2. (2-6s) EXPAND: "[SECONDARY TEXT]" — explain the hook. Slide in from bottom.
3. (6-11s) VALUE: Show the key benefit. Use [PRODUCT SCREENSHOT or ICON + TEXT].
   Keep it to ONE thing. Don't overcrowd.
4. (11-15s) CTA: "[CTA TEXT]" + subtle arrow animation pointing down.
   Logo centered below.

Style: Fast-paced, bold typography, high contrast. Text IS the visual.
Colors: [BRAND COLORS]. Font: [BOLD FONT NAME] for headlines.
```

### Pitch Deck Video (60s, 16:9)

```
Create a 60-second pitch deck video for [COMPANY].

1. (0-5s) HOOK: "[MARKET STAT or BOLD CLAIM]" — large text, dramatic entrance.
2. (5-15s) PROBLEM: Animated stats showing the pain. Counter animations.
   Stats: [STAT 1], [STAT 2]. Red/orange accent for urgency.
3. (15-30s) SOLUTION: Product demo sequence. Real screenshots sliding in with
   parallax. 2-3 screens showing key flows.
4. (30-45s) TRACTION: Metrics dashboard animation. Counters animate up:
   "[NUMBER] users", "[NUMBER] revenue", "[PERCENT]% growth"
5. (45-55s) VISION: "[ONE-LINE VISION STATEMENT]". Minimal, aspirational.
6. (55-60s) CTA: "[CTA TEXT]" + "[EMAIL/URL]" + logo. Hold 5s.

Tone: Confident, data-driven, premium. Dark background, clean type.
```

### Website Hero Loop (12s, 16:9, seamless)

```
Create a 12-second SEAMLESS LOOPING hero video for [BRAND] website.

1. (0-4s) Brand name + tagline fade in with spring physics.
2. (4-9s) [KEY VISUAL — abstract shapes, product mockup, or feature highlight].
   Subtle continuous motion — floating particles, gentle parallax, color shift.
3. (9-12s) Elements gracefully fade/transition back to starting state.
   Frame 360 must match frame 0 exactly for seamless loop.

Style: Premium, subtle, not distracting. This plays behind other content.
Keep motion minimal — it's atmosphere, not the main event.
Must render as a loop: last frame transitions cleanly to first frame.
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
# 1. Copy template to workspace
cp -r ~/.openclaw/skills/video-production/assets/template-basic ~/workspace/video-project

# 2. Install dependencies
cd ~/workspace/video-project && npm install

# 3. Edit src/MyVideo.tsx with brand assets, scenes, and copy

# 4. Preview (opens browser)
npx remotion preview src/index.ts

# 5. Draft render (fast, lower quality for review)
npx remotion render src/index.ts MyVideo out/draft.mp4 --crf 28

# 6. Production render (high quality)
npx remotion render src/index.ts MyVideo out/final.mp4 --crf 18 --codec h264
```

### Composition Registration

In `src/Root.tsx`, register compositions for different aspect ratios:

```tsx
import { Composition } from "remotion";
import { MyVideo } from "./MyVideo";

export const RemotionRoot = () => (
  <>
    {/* 16:9 landscape */}
    <Composition id="Landscape" component={MyVideo} durationInFrames={900} fps={30} width={1920} height={1080} />

    {/* 9:16 vertical (TikTok/Reels) */}
    <Composition id="Vertical" component={MyVideo} durationInFrames={450} fps={30} width={1080} height={1920} />

    {/* 1:1 square (Instagram) */}
    <Composition id="Square" component={MyVideo} durationInFrames={900} fps={30} width={1080} height={1080} />
  </>
);
```

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

---

## Section 8: Common Mistakes to Avoid

### Animation Mistakes

- **Linear easing.** Everything looks robotic and cheap. Use `spring()` for every animation. No exceptions.
- **Animating everything at once.** The eye can't track 5 things moving simultaneously. Stagger entrances. Guide the viewer's attention sequentially.
- **Transitions too fast or too slow.** 0.3–0.6s is the sweet spot. Under 0.2s feels jumpy. Over 0.8s feels sluggish.
- **No hold time on key messages.** If text appears for less than 2 seconds, nobody will read it. Important messages need 3–4 seconds minimum.
- **Inconsistent rhythm.** If items enter at 0.3s intervals in Scene 2, don't switch to 0.1s intervals in Scene 3 for no reason. Maintain a consistent tempo.

### Design Mistakes

- **Too much text per scene.** Maximum 5–7 words on screen at once for social content. 10–15 for explainers. If you're writing paragraphs, you're making a presentation, not a video.
- **Default fonts.** Typography is 50% of perceived quality. Arial, Helvetica, Times New Roman scream "low effort." Use the brand's actual fonts, or choose a modern pair (e.g., Inter + Instrument Serif).
- **Ignoring mobile viewers.** 60%+ of video views are on phones. Text must be readable at mobile size. Minimum 48px for body text in 1080p. Minimum 72px for headlines.
- **Wrong logo contrast.** Dark logo on dark background = invisible. Always check.
- **Busy backgrounds competing with content.** Background animation should be subtle (opacity 0.1–0.3). If the background distracts from the text, tone it down.

### Process Mistakes

- **Skipping the storyboard.** "Just make me a video" → 5 rounds of "that's not what I wanted." Always present scenes for approval first.
- **Regenerating the entire video for small changes.** This is code. Change the one line that needs changing.
- **Not doing a draft render first.** Always render at CRF 28 for quick review before the final CRF 18 render. A 20-second draft render saves a 3-minute production render.
- **Forgetting platform constraints.** A horizontal video cropped to vertical looks terrible. Design for the target platform from scene 1.

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

## Production Lessons Learned

From real InstaClaw video production:

- **v1 was trash** ("like a 5 year old made them") — basic text overlays, no brand assets, amateur hour
- **v2 added real UI screenshots** — immediately looked 10x better. Real product > mockups, always.
- **v3 fixed logo contrast** (dark logo on dark background was invisible → switched to white logo). This single change made it look professional.
- **v4 fixed mobile layout** (side-by-side screens were cramped → single centered screen). Less is more.
- Each iteration took 2–3 minutes. Total time from brief to polished video: 15–30 minutes across 3–5 iterations.

## Scripts & References

- `~/.openclaw/skills/video-production/assets/template-basic/` — Starter template (renders out of the box)
- `~/.openclaw/skills/video-production/references/advanced-patterns.md` — Complex animations, audio sync, data-driven videos
- `~/.openclaw/skills/video-production/references/brand-assets-checklist.md` — Asset collection checklist
