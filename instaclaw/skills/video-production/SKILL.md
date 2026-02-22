# Skill: Remotion Video Production

## Metadata

```yaml
name: remotion-video-production
version: 1.0.0
updated: 2026-02-22
author: InstaClaw
triggers:
  keywords: [video, animation, motion graphics, demo video, promo video, marketing video, render video, product demo, social media video, branded content, explainer video, remotion]
  phrases: ["create a video", "make a demo video", "render a promo", "build a marketing video", "product demo video", "social media video", "branded video"]
  NOT: [watch video, play video, stream, download video, screen recording]
```

## Overview

Professional video production using Remotion (React-based motion graphics framework). Creates marketing videos, product demos, social content, and branded video from scratch — including brand asset extraction, scene composition, animation, and rendering.

**Key principle:** Gather brand assets FIRST. Without real fonts, colors, and logos, videos look amateur.

## Dependencies

- Node.js + npm (pre-installed on VM snapshot)
- Remotion packages: `remotion`, `@remotion/cli`, `@remotion/bundler`
- FFmpeg (pre-installed on VM snapshot)

## Core Workflow

1. **Gather brand assets FIRST** (logos, fonts, colors, screenshots, copy)
   - Use brand-asset-extraction skill or browser tool
   - Extract exact fonts via `getComputedStyle`
   - Extract exact hex colors from website
   - Find logo variants (white on dark, dark on light)
   - Capture real UI screenshots (real product > mockups)
2. **Structure video** using proven patterns (Hook → Problem → Solution → CTA)
3. **Build scenes** with Remotion's React-based framework
4. **Apply animations** (spring physics, stagger reveals, smooth transitions)
5. **Render draft** → get feedback → iterate → render final

## Video Structures (Proven Patterns)

| Format | Duration | Frames (30fps) | Structure | Use Case |
|--------|----------|----------------|-----------|----------|
| Marketing Demo | 15s | 450 | Hook (0-3s) → Problem (3-6s) → Solution (6-12s) → CTA (12-15s) | Product launches, ads |
| Feature Showcase | 20s | 600 | Title (0-3s) → Feature 1 (3-8s) → Feature 2 (8-13s) → Feature 3 (13-18s) → CTA (18-20s) | Feature announcements |
| Social Teaser | 10s | 300 | Hook (0-2s) → Key Visual (2-7s) → CTA (7-10s) | Twitter, Instagram, TikTok |

## Brand Asset Extraction (Critical)

This is what makes videos look professional vs amateur.

### The #1 Mistake: Logo Contrast

| Background | Logo Variant | Result |
|-----------|-------------|--------|
| Dark (#0f1419) | White logo | ✅ Visible |
| Dark (#0f1419) | Dark/black logo | ❌ INVISIBLE |
| Light (#f5f3ee) | Dark logo | ✅ Visible |
| Light (#f5f3ee) | White logo | ❌ INVISIBLE |

v1-v2 of InstaClaw video used dark logo on dark background = invisible. v3 switched to white logo = immediately professional.

### Font Extraction

```javascript
browser.act({
  request: {
    kind: "evaluate",
    fn: `() => {
      const selectors = ['body', 'h1', 'h2', 'h3', 'p', 'button'];
      const fonts = {};
      selectors.forEach(sel => {
        const el = document.querySelector(sel);
        if (el) fonts[sel] = window.getComputedStyle(el).fontFamily;
      });
      return fonts;
    }`
  }
});
```

Quote font names properly: `'"Instrument Serif", serif'` — multi-word names need quotes in CSS.

### Color Extraction

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
      const colorFrequency = {};
      document.querySelectorAll('*').forEach(el => {
        const bg = getComputedStyle(el).backgroundColor;
        if (bg && bg !== 'rgba(0, 0, 0, 0)') {
          const hex = rgbToHex(bg);
          if (hex) colorFrequency[hex] = (colorFrequency[hex] || 0) + 1;
        }
      });
      return Object.entries(colorFrequency)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([color, count]) => ({ color, count }));
    }`
  }
});
```

### Logo Discovery

```javascript
browser.act({
  request: {
    kind: "evaluate",
    fn: `() => {
      const logos = [];
      const selectors = [
        'img[alt*="logo" i]', '[class*="logo"] img',
        'header img', 'nav img', '.navbar-brand img'
      ];
      selectors.forEach(sel => {
        document.querySelectorAll(sel).forEach(img => {
          logos.push({ src: img.src, alt: img.alt, width: img.width, height: img.height });
        });
      });
      document.querySelectorAll('svg[class*="logo"], header svg, nav svg').forEach(svg => {
        logos.push({ type: 'svg', html: svg.outerHTML.substring(0, 200) });
      });
      return logos;
    }`
  }
});
```

## Animation Patterns

### Spring Physics (Natural Motion)

```tsx
import { spring, useCurrentFrame, useVideoConfig } from "remotion";

const frame = useCurrentFrame();
const { fps } = useVideoConfig();

const scale = spring({ frame, fps, config: { damping: 12, stiffness: 100 } });
const translateY = spring({ frame: frame - 5, fps, config: { damping: 15 } });
```

Elements don't just appear — they bounce in with spring physics for natural motion.

### Staggered Reveals

```tsx
const items = ["Feature 1", "Feature 2", "Feature 3"];
{items.map((item, i) => {
  const delay = i * 8; // 8 frames between each
  const opacity = spring({ frame: frame - delay, fps, config: { damping: 20 } });
  return <div style={{ opacity }}>{item}</div>;
})}
```

Items appear one by one, not all at once.

### Opacity + Transform Combinations

```tsx
const progress = spring({ frame, fps });
const style = {
  opacity: progress,
  transform: `translateY(${(1 - progress) * 30}px)`,
};
```

Fade in while sliding up — the most common professional animation.

## Rendering Pipeline

### Draft Render (Quick Review)

```bash
npx remotion render src/index.ts MyVideo out/draft.mp4 --crf 28
```

- Higher CRF = lower quality, faster render (~20-30 seconds)
- Use for quick review cycles

### Production Render (Final Output)

```bash
npx remotion render src/index.ts MyVideo out/final.mp4 --crf 18 --codec h264
```

- Lower CRF = higher quality
- h264 codec for maximum compatibility
- File sizes: 1.3-2.4MB for 15s @ 1920x1080

### Iteration Time

- Each edit + render + review cycle: 2-3 minutes
- Expect 3-5 iterations per video
- Total production time for a polished 15s video: 15-30 minutes

## Production Lessons Learned

From real InstaClaw video production:

- **v1 was trash** ("like a 5 year old made them") — basic text overlays, no brand assets
- **v2 added real UI screenshots** — immediately looked 10x better
- **v3 fixed logo contrast** (black logo on dark background was invisible → switched to white)
- **v4 fixed mobile layout** (side-by-side was cramped → single centered screen)
- Each iteration took 2-3 minutes (edit + render + review cycle)

## Template

A complete starter template is included at `assets/template-basic/`:

```
assets/template-basic/
├── package.json          # Dependencies (remotion, @remotion/cli, etc.)
├── src/index.ts          # Entry point
├── src/Root.tsx           # Composition registration
├── src/MyVideo.tsx        # 4-scene template with spring animations
├── remotion.config.ts     # Rendering configuration
└── tsconfig.json          # TypeScript config
```

The template is NOT a skeleton — it's a working video that renders out of the box. Customize it with the user's brand assets and copy.

### Using the Template

1. Copy template to workspace: `cp -r ~/.openclaw/skills/video-production/assets/template-basic ~/workspace/video-project`
2. Install deps: `cd ~/workspace/video-project && npm install`
3. Preview: `npx remotion preview src/index.ts`
4. Edit `src/MyVideo.tsx` with brand assets and copy
5. Render: `npx remotion render src/index.ts MyVideo out/video.mp4`

## Brand Config Template

After extracting brand assets, save as `brand-config.json`:

```json
{
  "brand": "Company Name",
  "extracted_from": "https://example.com",
  "extracted_at": "2026-02-22T00:00:00Z",
  "typography": {
    "heading": { "family": "\"Instrument Serif\", serif", "weights": [400, 700] },
    "body": { "family": "Inter, sans-serif", "weights": [400, 500, 600] }
  },
  "colors": {
    "primary": "#e67e4d",
    "secondary": "#d4634a",
    "background": { "dark": "#0f1419", "light": "#f5f3ee" },
    "text": { "dark": "#1a1a1a", "light": "#ffffff" }
  },
  "logos": {
    "white": "https://example.com/logo-white.png",
    "dark": "https://example.com/logo-dark.png"
  }
}
```

## Quality Checklist

Run before delivering any video:

- [ ] Logo is visible against background (correct contrast variant used)
- [ ] Brand fonts loaded correctly (not falling back to system fonts)
- [ ] Colors match brand exactly (hex codes from website, not approximations)
- [ ] UI screenshots are real product screenshots, not mockups
- [ ] Single centered screen, not side-by-side duplicates
- [ ] Animations are smooth (spring physics, not linear)
- [ ] CTA is clear and readable
- [ ] Video length matches requested format
- [ ] File renders without errors
- [ ] File size is reasonable (1-3MB for 15s)

## Future Improvements

1. Additional templates: 9:16 vertical (TikTok/Reels), 1:1 square (Instagram)
2. Script automation: auto-extract brand assets from any URL
3. Batch rendering: generate multiple variants from one brief
4. Audio integration: background music, sound effects
5. Animation library: reusable motion presets

## Scripts & References

- `~/.openclaw/skills/video-production/assets/template-basic/` — Starter template
- `~/.openclaw/skills/video-production/references/advanced-patterns.md` — Complex animations, audio, data-driven videos
- `~/.openclaw/skills/video-production/references/brand-assets-checklist.md` — Asset collection checklist
