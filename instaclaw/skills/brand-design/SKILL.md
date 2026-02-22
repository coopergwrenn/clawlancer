# Skill: Brand Asset Extraction

## Metadata

```yaml
name: brand-asset-extraction
version: 1.0.0
updated: 2026-02-22
author: InstaClaw
triggers:
  keywords: [brand, extract brand, brand assets, fonts from website, colors from website, logo, brand identity, brand consistency, match brand, brand config, brand guidelines]
  phrases: ["extract brand assets", "get the fonts from", "match the brand", "what fonts does this site use", "brand colors", "find the logo", "create brand config"]
  NOT: [design logo, create brand, rebrand]
```

## Overview

Automated extraction and documentation of brand assets (fonts, colors, logos) from any website using browser automation. This is the foundational skill that feeds into Remotion video production, Kling AI prompting, and any branded content creation. Without accurate brand assets, nothing looks professional.

**This skill is documentation + code patterns, no separate scripts.** The agent uses its browser tool directly with the patterns documented here.

## Dependencies

- Browser automation (Playwright/Chromium, pre-installed on VM snapshot)
- No external API keys required

## What This Skill Extracts

1. **Typography** — Font families, weights, hierarchy (heading vs body vs button)
2. **Colors** — Primary, secondary, background, text colors (as hex codes)
3. **Logo variants** — White, dark, color, transparent (URLs + download)
4. **Spacing/sizing patterns** — Common sizes, margins (for layout consistency)

## Complete Extraction Workflow

### Step 1: Open Target Website

```javascript
const tab = await browser.open({
  profile: "openclaw",
  targetUrl: "https://target-brand.com"
});
```

### Step 2: Extract Fonts

```javascript
browser.act({
  request: {
    kind: "evaluate",
    fn: `() => {
      const selectors = ['body', 'h1', 'h2', 'h3', 'h4', 'p', 'button', 'a'];
      const fonts = {};
      selectors.forEach(sel => {
        const el = document.querySelector(sel);
        if (el) {
          const style = window.getComputedStyle(el);
          fonts[sel] = {
            family: style.fontFamily,
            weight: style.fontWeight,
            size: style.fontSize,
            lineHeight: style.lineHeight
          };
        }
      });
      return fonts;
    }`
  }
});
// Result: { body: { family: "Inter, sans-serif", weight: "400", ... }, h1: { family: '"Instrument Serif", serif', ... } }
```

**Font troubleshooting:**
- If font shows as generic ("sans-serif"): font may be loaded via CSS `@font-face`. Check network tab for font file requests.
- Quote multi-word font names: `'"Instrument Serif", serif'` — quotes needed in CSS.

### Step 3: Extract Colors (with RGB → Hex Conversion)

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
        const styles = getComputedStyle(el);
        // Background colors
        const bg = styles.backgroundColor;
        if (bg && bg !== 'rgba(0, 0, 0, 0)') {
          const hex = rgbToHex(bg);
          if (hex) colorFrequency[hex] = (colorFrequency[hex] || 0) + 1;
        }
        // Text colors
        const color = styles.color;
        if (color) {
          const hex = rgbToHex(color);
          if (hex) colorFrequency['text:' + hex] = (colorFrequency['text:' + hex] || 0) + 1;
        }
      });

      return Object.entries(colorFrequency)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([color, count]) => ({ color, count }));
    }`
  }
});
```

**Color troubleshooting:**
- Element might have gradient: check `background-image` and `background` in addition to `backgroundColor`.
- Transparency: check `opacity` property. Some "colors" are transparent overlays.

### Step 4: Find Logo URLs

```javascript
browser.act({
  request: {
    kind: "evaluate",
    fn: `() => {
      const logos = [];
      // Image-based logos
      const selectors = [
        'img[alt*="logo" i]', '[class*="logo"] img',
        'header img', 'nav img', '.navbar-brand img',
        '[id*="logo"] img', 'a[href="/"] img'
      ];
      selectors.forEach(sel => {
        document.querySelectorAll(sel).forEach(img => {
          logos.push({
            type: 'img',
            src: img.src,
            alt: img.alt,
            width: img.naturalWidth || img.width,
            height: img.naturalHeight || img.height
          });
        });
      });
      // SVG logos
      document.querySelectorAll('svg[class*="logo"], header svg, nav svg, [id*="logo"] svg').forEach(svg => {
        logos.push({
          type: 'svg',
          viewBox: svg.getAttribute('viewBox'),
          html: svg.outerHTML.substring(0, 500)
        });
      });
      // CSS background logos
      document.querySelectorAll('[class*="logo"]').forEach(el => {
        const bg = getComputedStyle(el).backgroundImage;
        if (bg && bg !== 'none') {
          logos.push({ type: 'css-background', value: bg });
        }
      });
      return logos;
    }`
  }
});
```

**Logo troubleshooting:**
- Logo might not be an `<img>` tag — check for inline SVGs, CSS background images, or icon fonts.
- Always find both light and dark variants. Check footer (often has different variant than header).

### Step 5: Take Reference Screenshot

```javascript
browser.screenshot({
  profile: "openclaw",
  targetId: tab.targetId,
  fullPage: true
});
// Save for visual comparison
```

### Step 6: Generate Brand Config File

Save extracted data as `brand-config.json`:

```json
{
  "brand": "Company Name",
  "extracted_from": "https://example.com",
  "extracted_at": "2026-02-22T00:00:00Z",
  "typography": {
    "heading": {
      "family": "\"Instrument Serif\", serif",
      "weights": [400, 700],
      "use": "Headlines, hero text"
    },
    "body": {
      "family": "Inter, sans-serif",
      "weights": [400, 500, 600],
      "use": "Body copy, UI elements"
    },
    "button": {
      "family": "Inter, sans-serif",
      "weights": [600],
      "use": "Buttons, CTAs"
    }
  },
  "colors": {
    "primary": "#e67e4d",
    "secondary": "#d4634a",
    "background": { "dark": "#0f1419", "light": "#f5f3ee" },
    "text": { "dark": "#1a1a1a", "light": "#ffffff" },
    "accent": "#3b82f6"
  },
  "logos": {
    "white": "https://example.com/logo-white.png",
    "dark": "https://example.com/logo-dark.png",
    "color": "https://example.com/logo-color.png"
  }
}
```

## Logo Variant Rules (Most Common Mistake)

| Background | Logo Variant | Result |
|-----------|-------------|--------|
| Dark (#0f1419) | White logo | ✅ Visible |
| Dark (#0f1419) | Dark/black logo | ❌ INVISIBLE |
| Light (#f5f3ee) | Dark logo | ✅ Visible |
| Light (#f5f3ee) | White logo | ❌ INVISIBLE |
| Gradient | Test both | Depends on dominant color |

**This is the #1 mistake agents make.** The InstaClaw video production proved it — v1-v2 had invisible logos due to wrong contrast variant.

## Real Example: InstaClaw Brand Extraction

```
Extracted from: https://instaclaw.io

Typography:
  heading: "Instrument Serif", serif  (display font, warm/editorial)
  body: Inter, sans-serif  (clean, modern UI font)

Colors:
  primary: #e67e4d  (orange — the claw color)
  dark: #0f1419  (almost black — backgrounds)
  light: #f5f3ee  (off-white — content areas)

Logos:
  white variant: used on dark backgrounds (CRITICAL)
  color variant: used on light backgrounds

Key learning: The white logo variant was the make-or-break discovery.
```

## Integration with Other Skills

| Skill | How Brand Assets Are Used |
|---|---|
| **Remotion Video (Skill 1)** | Fonts → fontFamily styles, colors → backgrounds/text, logos → staticFile() |
| **Social Media (Skill 9)** | Colors inform visual content style, brand voice informs copy |
| **Email (Skill 8)** | Brand colors/logo for email templates |
| **Any branded content** | brand-config.json is the single source of truth |

## Quality Checklist

- [ ] Fonts extracted and verified (test rendering, not just names)
- [ ] Colors converted to hex (not left as RGB strings)
- [ ] Logo variants identified (white AND dark at minimum)
- [ ] Logo contrast tested against intended backgrounds
- [ ] Brand config JSON is valid and complete
- [ ] All logo URLs are accessible and downloadable
- [ ] Font weights documented (not just families)
- [ ] Results compared visually to the actual website (side-by-side check)

## Files

- `~/.openclaw/skills/brand-design/SKILL.md` — This file (the complete skill)
- `~/.openclaw/skills/brand-design/references/brand-extraction-guide.md` — Quick reference card
