# Brand Extraction Quick Reference

## Extraction Commands

### Fonts

```javascript
browser.act({
  request: {
    kind: "evaluate",
    fn: `() => {
      const selectors = ['body', 'h1', 'h2', 'h3', 'p', 'button', 'a'];
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

### Colors (Top 10 by Frequency)

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
      const freq = {};
      document.querySelectorAll('*').forEach(el => {
        const bg = getComputedStyle(el).backgroundColor;
        if (bg && bg !== 'rgba(0, 0, 0, 0)') {
          const hex = rgbToHex(bg);
          if (hex) freq[hex] = (freq[hex] || 0) + 1;
        }
      });
      return Object.entries(freq).sort((a,b) => b[1]-a[1]).slice(0,10);
    }`
  }
});
```

### Logos

```javascript
browser.act({
  request: {
    kind: "evaluate",
    fn: `() => {
      const logos = [];
      ['img[alt*="logo" i]', '[class*="logo"] img', 'header img', 'nav img'].forEach(sel => {
        document.querySelectorAll(sel).forEach(img => {
          logos.push({ src: img.src, alt: img.alt, width: img.width, height: img.height });
        });
      });
      document.querySelectorAll('svg[class*="logo"], header svg').forEach(svg => {
        logos.push({ type: 'svg', viewBox: svg.getAttribute('viewBox') });
      });
      return logos;
    }`
  }
});
```

## Logo Contrast Rules

| Background | Use Logo | Why |
|-----------|----------|-----|
| Dark | White/light variant | Dark logo on dark = invisible |
| Light | Dark/color variant | White logo on light = invisible |
| Gradient | Test both | Depends on dominant color |

**This is the #1 mistake.** Always test logo against its actual background.

## Brand Config Output Format

```json
{
  "brand": "Name",
  "extracted_from": "https://...",
  "typography": {
    "heading": { "family": "\"Font\", serif", "weights": [400, 700] },
    "body": { "family": "Inter, sans-serif", "weights": [400, 500] }
  },
  "colors": {
    "primary": "#hex",
    "background": { "dark": "#hex", "light": "#hex" },
    "text": { "dark": "#hex", "light": "#hex" }
  },
  "logos": { "white": "url", "dark": "url" }
}
```

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| Font shows "sans-serif" | Loaded via @font-face | Check CSS source for @font-face declarations |
| Color doesn't match visual | Gradient or transparency | Check background-image and opacity properties |
| Can't find logo | Not an img tag | Check for inline SVGs, CSS backgrounds, icon fonts |
| Logo URL is relative | Missing domain | Prepend the site's domain to the path |

## Integration

- **Video Production (Skill 1):** brand-config.json → Remotion template props
- **Social Media (Skill 9):** Brand voice and colors for content styling
- **Email (Skill 8):** Logo + colors for email templates
