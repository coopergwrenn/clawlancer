# Brand Asset Collection Checklist

## Before Starting Any Video

Complete this checklist before writing any video code. Missing assets = amateur result.

### Typography

- [ ] **Heading font** — Extract from `<h1>` via `getComputedStyle().fontFamily`
- [ ] **Body font** — Extract from `<p>` or `<body>`
- [ ] **Button/CTA font** — Extract from `<button>` or `<a>` elements
- [ ] **Font weights** — Document which weights are used (400, 500, 600, 700)
- [ ] **Verify fonts render** — Test in a simple component before full video
- [ ] **Quote multi-word names** — `'"Instrument Serif", serif'` not `Instrument Serif, serif`

### Colors

- [ ] **Primary brand color** — The dominant accent color (buttons, links, highlights)
- [ ] **Secondary color** — Supporting accent
- [ ] **Dark background** — For dark sections/scenes
- [ ] **Light background** — For light sections/scenes
- [ ] **Text on dark** — Usually white or near-white
- [ ] **Text on light** — Usually dark gray or black
- [ ] **All colors as hex** — Convert RGB to hex, never use RGB strings in code

### Logos

- [ ] **White/light variant** — For use on dark backgrounds
- [ ] **Dark variant** — For use on light backgrounds
- [ ] **Color variant** — Full-color logo if available
- [ ] **Contrast tested** — Each variant tested against its intended background
- [ ] **Downloaded locally** — Don't rely on external URLs during render
- [ ] **Correct size** — Logo should be prominent but not overwhelming (typically 100-200px wide)

### Screenshots

- [ ] **Real product screenshots** — Not mockups, not wireframes
- [ ] **Single centered screen** — Not side-by-side (looks cramped at 1920x1080)
- [ ] **Clean state** — No debug info, no personal data, no error states
- [ ] **High resolution** — At least 1x the display size (ideally 2x for retina)
- [ ] **Cropped appropriately** — Show the relevant UI, not the entire desktop

### Copy

- [ ] **Headline/hook** — Bold statement that grabs attention (max 8 words)
- [ ] **Problem statement** — What the user struggles with (2-3 bullet points)
- [ ] **Solution points** — How the product helps (3 features max)
- [ ] **CTA text** — Clear action ("Get Started", "Try Free", "Learn More")
- [ ] **CTA URL** — Where the CTA points

## Brand Config Template

Save as `brand-config.json` in project root:

```json
{
  "brand": "Company Name",
  "extracted_from": "https://example.com",
  "extracted_at": "2026-02-22T00:00:00Z",
  "typography": {
    "heading": { "family": "\"Font Name\", serif", "weights": [400, 700] },
    "body": { "family": "Inter, sans-serif", "weights": [400, 500, 600] }
  },
  "colors": {
    "primary": "#e67e4d",
    "secondary": "#d4634a",
    "background": { "dark": "#0f1419", "light": "#f5f3ee" },
    "text": { "dark": "#1a1a1a", "light": "#ffffff" }
  },
  "logos": {
    "white": "/path/to/logo-white.png",
    "dark": "/path/to/logo-dark.png"
  },
  "copy": {
    "headline": "",
    "problem": ["", "", ""],
    "solution": ["", "", ""],
    "cta": { "text": "", "url": "" }
  }
}
```

## Validation Checklist (After First Render)

- [ ] Logo visible and correctly contrasted
- [ ] Fonts rendering correctly (not falling back to system fonts)
- [ ] Colors match the actual website (open side by side)
- [ ] Animations smooth (no jitter, no linear motion)
- [ ] Text readable at expected viewing size
- [ ] CTA clear and actionable
- [ ] No placeholder text remaining
- [ ] Video length matches requested format

## Stakeholder Review Checklist

Before delivering to user:

- [ ] Does it match the brand? (fonts, colors, logo)
- [ ] Is the messaging clear? (can you understand the pitch in 5 seconds?)
- [ ] Are animations professional? (spring physics, not jarring)
- [ ] Is the CTA compelling? (would you click?)
- [ ] File size reasonable? (1-3MB for 15s @ 1080p)
- [ ] No quality issues? (no artifacts, no black frames, no rendering errors)
