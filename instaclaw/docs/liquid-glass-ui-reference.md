# Liquid Glass UI Reference

The InstaClaw landing page uses a custom liquid-glass design language ported
verbatim from wabi.ai's button component on 2026-05-24. This document is the
canonical reference for replicating that material anywhere in the codebase or
in future projects. **Read it end-to-end before adding a new glass element.**

> **Status:** the CSS values in `app/globals.css` are **LOCKED**. New surfaces
> must reuse the existing classes (`.liquid-glass-btn`, `.liquid-glass-pill`,
> `.liquid-glass-nav-btn`, `.liquid-glass-orb`) or create a new class that
> uses the same recipe with only dimensions / border-radius changed.
> Individual `box-shadow` alpha values, `linear-gradient` stops, and rim
> `conic-gradient` percentages must NOT be tweaked — they are interdependent
> and any single change breaks the material illusion.

---

## 1. The architecture — 3 elements, not 1

Every glass surface in the codebase uses three DOM elements:

```html
<span class="liquid-glass-X-root">                <!-- 1. root wrapper -->
  <button class="liquid-glass-X">…content…</button> <!-- 2. surface -->
  <div aria-hidden="true" class="liquid-glass-X-shadow"></div> <!-- 3. shadow proxy -->
</span>
```

### Why each element exists

| Element | Job | What breaks if removed |
|---|---|---|
| **`-root` wrapper** | (a) positioning context for the absolute-positioned shadow proxy; (b) `isolation: isolate` creates a new stacking context so `z-index` on inner pieces is local; (c) hosts the `::before` refraction substrate. | Shadow proxy floats relative to whatever ancestor is positioned (usually `<body>`), so it's mispositioned or invisible. Stacking context leaks — `z-index` collisions with other page elements. |
| **Surface** (the actual `<button>` / `<span>` the user clicks) | Carries the sheen `background-image`, the 4-layer `box-shadow`, the `backdrop-filter`, and hosts the `::after` conic rim. This is the glass material itself. | The element is no longer glass. Removing this is removing the feature. |
| **`-shadow` sibling div** | Renders the directional drop shadow as a *masked ring* outside the surface's stacking context. The mask hides the part of the ring that would be behind the transparent surface (which would otherwise bleed through and dirty the glass). | The directional shadow disappears or starts showing through the surface, making it look like a flat sticker with a halo. The "floating above the page" cue dies. |

The shadow MUST be a **sibling DOM node**, not a pseudo-element on the
surface. Pseudo-elements (`::before`, `::after`) inherit the surface's
stacking context and `overflow`, so a `blur(2px)` filter on a pseudo either
gets clipped or shows through the transparent surface. The sibling div sits
in the root's stacking context, NOT the surface's.

The root MUST set `isolation: isolate` so `z-index: -1` on the
`::before` refraction substrate doesn't sink behind page-level content.

The shadow div MUST have `overflow: visible` (its `inset: -Npx` makes it
extend past the surface; the wrapper's overflow must not clip it).

---

## 2. The 5-ingredient recipe

These five ingredients are present on every glass element. Removing any one
breaks the illusion — verified empirically on 2026-05-24 when the first
orb attempt used a different recipe (radial-gradient + sphere illusion) and
read as a "flat gray disc from a different website" until all 5 were
restored.

### Ingredient 1 — `linear-gradient(-75deg)` sheen

Diagonal directional sheen across the surface. The angle (-75deg, off-axis
from a corner) reads as "light source from upper-right hitting curved glass"
rather than a vertical fill.

```css
background-image: linear-gradient(-75deg,
  rgba(255, 255, 255, 0.05),
  rgba(255, 255, 255, 0.20),
  rgba(255, 255, 255, 0.05));
```

Used identically on `.liquid-glass-btn`, `.liquid-glass-pill`,
`.liquid-glass-nav-btn`, and `.liquid-glass-orb`. **Do not change the angle
or alpha stops.** The 0.05 → 0.20 → 0.05 sweep is calibrated so the bright
midstop reads as a single light reflection, not a flat tint.

### Ingredient 2 — 4-layer `box-shadow`

Four shadows stacked on the surface, each doing a specific job. Order is
load-bearing — CSS renders shadows top-to-bottom in the declaration list.

```css
box-shadow:
  rgba(0, 0, 0, 0.05) 0px 2px 2px 0px inset,        /* 1. top inner shadow */
  rgba(255, 255, 255, 0.5) 0px -2px 2px 0px inset,  /* 2. bottom inner highlight */
  rgba(0, 0, 0, 0.2) 0px 4px 2px -2px,              /* 3. outer drop shadow */
  rgba(255, 255, 255, 0.2) 0px 0px 1.6px 4px inset; /* 4. inset rim glow */
```

| Layer | Purpose |
|---|---|
| 1. `inset 0 2px 2px black 0.05` | Top inner shadow — gives the upper rim a soft "behind glass" depth, the way the inside of a clear container looks slightly darker at the top from above. |
| 2. `inset 0 -2px 2px white 0.5` | Bottom inner highlight — the bright bottom edge where light passing through the glass catches on the lower lip. Wabi's signature move; this is what makes glass read as glass and not as a beveled button. |
| 3. `0 4px 2px -2px black 0.2` (NOT inset) | Outer drop shadow — small, tight contact shadow that anchors the element to the surface beneath. The `-2px` spread makes it narrower than the element so it doesn't read as a heavy floating shadow. The `.liquid-glass-nav-btn` uses `0.18` here for a slightly subtler grounding. |
| 4. `inset 0 0 1.6px 4px white 0.2` | Inset rim glow — distributed spread that softly lifts the entire interior. Keeps the surface from going gray when other shadows pull it down. |

The two opposing inset shadows (layer 1 dark on top, layer 2 light on
bottom) are the load-bearing pair. They invert the conventional "light from
above" lighting cue — which is exactly why glass looks the way it does.
Don't be tempted to "fix" this.

### Ingredient 3 — `::after` conic-gradient rim

A 1-pixel ring around the surface where the `conic-gradient` rotates dark
stops to specific positions (-75deg start, dark at 0%, transparent 5-40%,
dark at 50%, transparent 60-95%, dark at 100%). This simulates how light
catches the curved edges of real glass — bright at the cardinal points
where the surface curves toward the viewer, dark where it curves away.

```css
.liquid-glass-X::after {
  content: '';
  position: absolute;
  inset: -0.5px 0 0 -0.5px;
  width: calc(100% + 1px);
  height: calc(100% + 1px);
  padding: 1px;
  background-image:
    conic-gradient(from -75deg at 50% 50%,
      rgba(0, 0, 0, 0.5),
      rgba(0, 0, 0, 0) 5%,
      rgba(0, 0, 0, 0) 40%,
      rgba(0, 0, 0, 0.5) 50%,
      rgba(0, 0, 0, 0) 60%,
      rgba(0, 0, 0, 0) 95%,
      rgba(0, 0, 0, 0.5)),
    linear-gradient(rgba(255, 255, 255, 0.5), rgba(255, 255, 255, 0.5));
  -webkit-mask:
    linear-gradient(#000, #000) content-box,
    linear-gradient(#000, #000);
  -webkit-mask-composite: xor;
          mask-composite: exclude;
  box-shadow: rgba(255, 255, 255, 0.5) 0px 0px 0px 0.5px inset;
  border-radius: inherit;  /* IMPORTANT — inherits the surface shape */
  z-index: 1;
  pointer-events: none;
}
```

#### The mask-composite trick

`padding: 1px` + double `-webkit-mask` + `mask-composite: exclude` makes the
`::after` paint ONLY the 1px ring around the perimeter — not the interior
fill. This is the key technique: a normal `border` can't do conic
gradients, but a masked padding-box ring can.

```
linear-gradient(#000, #000) content-box,  → mask 1: paint everything inside content-box
linear-gradient(#000, #000);              → mask 2: paint the full padding-box
mask-composite: exclude;                   → result: paint padding-box MINUS content-box = the ring
```

#### Two-layer background

The conic-gradient is *layered on top of* a flat 50% white. Without the
white underlay the dark conic stops would show the page bg through the
gradient's transparent sections. With it, the ring is a uniform white that
the conic darkens at specific angles.

#### `border-radius: inherit` is load-bearing

The rim must match the surface shape. Stadium-pill (`9999px`), rounded-
square (`0.5rem`), and circle (`50%`) all derive from `inherit`. Hard-
coding the value here would force per-shape rim CSS.

### Ingredient 4 — `::before` refraction substrate

A dark radial gradient *behind* the surface (`z-index: -1`) sized slightly
larger than it (`inset: -Npx`, where N is 2-5 depending on the surface).
Sits underneath the glass on the cream bg.

```css
.liquid-glass-X-root::before {
  content: '';
  position: absolute;
  inset: -Npx;       /* btn -5px, pill -3px, nav-btn -2px, orb -3px */
  border-radius: 9999px;  /* match the wrapper's shape */
  background: radial-gradient(
    ellipse at 50% 60%,
    rgba(0, 0, 0, 0.10) 0%,    /* btn 0.12, nav-btn 0.09, others 0.10 */
    rgba(0, 0, 0, 0.03) 50%,   /* btn 0.04, nav-btn 0.025 */
    transparent 80%
  );
  z-index: -1;
  pointer-events: none;
}
```

#### Why this exists

`backdrop-filter: blur(2px)` blurs whatever is rasterized BEHIND the
element. On a flat cream background, there's nothing to blur — backdrop-
filter renders as a no-op and the surface reads as a flat sticker.

The refraction substrate paints a soft dark radial under the element on
the cream bg, giving `backdrop-filter` actual pixels to blur. This is the
single most important ingredient on flat-color pages. **Without it on a
cream page, the glass dies.** Pages with photo backgrounds or busy
content typically don't need this — but ours is cream-on-cream.

Discovered during the 2026-05-24 hero work when the button looked great
during the framer-motion entrance (because opacity-induced stacking context
provided rasterized content for backdrop-filter to blur) but went flat
when opacity reached 1.

### Ingredient 5 — Sibling shadow div with masked ring

A direct sibling of the surface (NOT a pseudo on the surface) that paints
a directional drop shadow biased toward the bottom-right. The shadow is
shaped as a **masked ring** — only the bottom and right edges show; the
top-left edge is hidden because the surface itself sits over it.

```css
.liquid-glass-X-shadow {
  position: absolute;
  inset: -Npx;          /* btn -16px, pill -10px, nav-btn -8px, orb -10px */
  filter: blur(Npx);    /* btn/pill/orb 2px, nav-btn 2px */
  pointer-events: none;
  overflow: visible;
}

.liquid-glass-X-shadow::after {
  content: '';
  position: absolute;
  top: Tpx;             /* btn 24px, pill 14px, nav-btn 12px, orb 14px */
  left: Lpx;            /* btn 18px, pill 10px, nav-btn 8px, orb 10px */
  right: 0;
  bottom: 0;
  width: calc(100% - 2*Lpx);
  height: calc(100% - 2*Lpx);
  padding: 2px;
  background-image: linear-gradient(rgba(0, 0, 0, 0.2), rgba(0, 0, 0, 0.1));
  -webkit-mask:
    linear-gradient(#000, #000) content-box,
    linear-gradient(#000, #000);
  -webkit-mask-composite: xor;
          mask-composite: exclude;
  border-radius: 9999px;  /* match the surface shape (50% for orb) */
  pointer-events: none;
}
```

#### Why sibling, not pseudo

A pseudo on the surface inherits the surface's `overflow`/clipping context.
Sibling-of-surface inside the root means the shadow lives in the *root's*
stacking context, can extend past the surface's bounds, and won't bleed
through the transparent surface from inside.

#### Why masked ring, not solid shape

A solid shadow shape behind a transparent surface would show through the
glass (you'd see the dark blob through the clear material). The masked
ring paints only the bottom-right perimeter — the part the surface
doesn't cover.

#### The asymmetric `top:Tpx, left:Lpx` offsets

The `top`/`left` offsets bias the visible ring toward the bottom-right.
Combined with `inset: -Npx` overhang and `filter: blur(2px)`, this reads
as "light from upper-left, shadow falls to lower-right" — the universal
visual language for "this object is in front of the page."

---

## 3. The class system

Four glass shapes ship in use today, plus one defined-but-unused class
reserved for future content containers. Each is independent CSS — none
inherit from the others. **Tweaking one does not affect the others, by
design.**

### `.liquid-glass-btn` — Hero CTA ("Claim My Agent")

- **Dimensions:** `height: 68px`, `padding: 0 40px`, `font-size: 17px`
- **Shape:** Stadium (`border-radius: 9999px`)
- **Substrate inset:** `-5px` with `rgba(0,0,0,0.12)` core alpha
- **Shadow inset:** `-16px`, shadow `::after` offset `top: 24px / left: 18px`
- **Hover:** background `rgba(240,240,240,0.4)`, brighter rim, shadow retracts (`top: 18px`), `filter: blur(1px)` (sharpens shadow toward user)
- **Active:** `translateY(1px) scale(0.99)`, shadow springs back (`top: 24px, opacity: 0.75`)
- **Wrapping:** Required — root + surface + shadow. The hero CTA's `Link` is the surface.
- **Locked in:** `globals.css` lines 264-474.

### `.liquid-glass-pill` — Spots counter + use-cases marquee pills

- **Dimensions:** `height: 40px`, `padding: 0 20px`, `gap: 10px`, `font-size: 12px`
- **Shape:** Stadium (`border-radius: 9999px`)
- **Substrate inset:** `-3px` with `rgba(0,0,0,0.10)` core alpha
- **Shadow inset:** `-10px`, shadow `::after` offset `top: 14px / left: 10px`
- **No hover state.** Pills are decorative.
- **Wrapping:** Required — root + surface + shadow.
- **Used by:** `components/landing/spots-counter.tsx` (the "10 Spots Open" pill above the headline), `components/landing/use-cases.tsx` (the "Email Manager" / "Scheduling Bot" / etc. marquee — both rows, 80 pill instances total after the 4× duplication).
- **Locked in:** `globals.css` lines 476-598.

### `.liquid-glass-nav-btn` — Top-right Get Started + Dashboard

- **Dimensions:** `height: 36px`, `padding: 0 16px`, `font-size: 14px`
- **Shape:** Rounded square (`border-radius: 0.5rem`)
- **Substrate inset:** `-2px` with `rgba(0,0,0,0.09)` core alpha (tighter than pill so it doesn't bleed into adjacent nav items)
- **Shadow inset:** `-8px`, shadow `::after` offset `top: 12px / left: 8px`
- **Hover:** background `rgba(240,240,240,0.30)`, brighter rim (white alpha 0.5→0.6), shadow retracts (`top: 10px, left: 6px`), `filter: blur(3px)`
- **Active:** `translateY(0.5px)`, shadow springs back to `top: 14px, left: 10px` with softer gradient (`linear-gradient(rgba(0,0,0,0.10), rgba(0,0,0,0.04))`)
- **Outer drop shadow alpha:** `0.18` (vs `0.20` on pill — slightly subtler so it doesn't compete with the hero CTA below)
- **Wrapping:** Required — root + surface + shadow. The nav Links are the surfaces.
- **Locked in:** `globals.css` lines 741-925.

### `.liquid-glass-card` — DEFINED BUT NOT CURRENTLY USED

- **Status:** Class definition lives in `globals.css` (root + surface + shadow with two scale-tuned values vs pill: substrate `-4px / 0.08`, shadow proxy `-20px / blur(3px)` with `::after top:26 / left:18`). It is **not consumed by any component** as of 2026-05-24.
- **History:** Shipped briefly on the testimonial cards in "What People Are Saying" (commit `9c8c1af3`, reverted in the next commit). Cooper preferred the lighter inline-styled cards over the full wabi recipe at card scale — the full recipe (heavy halo + masked-ring shadow + rim) read as too dense on the 320×240 rectangles. The equal-height fix also disrupted the section's vertical rhythm.
- **Preserved why:** Kept in `globals.css` because the class itself is well-tuned and may be appropriate for a future content container where the full glass recipe is desired (e.g., a modal, a feature card with darker imagery behind it, a dashboard panel).
- **Before reusing:** Test on the actual page background — large flat-cream rectangles tend to amplify the substrate's halo into something that reads as "muddy," which is what bit the testimonial revert. If the page has photo/dark/textured content behind the card, the substrate has something to refract and the recipe holds.
- **Dimensions for reference:** Width set externally via tailwind. Height pinned via `min-height: 240px` + `flex: 1` on the surface for equal-height rows.
- **Shape:** Rounded square (`border-radius: 12px`)
- **Locked in:** `globals.css` (look for the `─── Liquid Glass CARD ───` comment block).

### `.liquid-glass-orb` — Numbered step circles in "How It Works"

- **Dimensions:** Set externally via `w-N h-N` tailwind on the root (currently `w-12 h-12 sm:w-14 sm:h-14` → 48px / 56px)
- **Shape:** Circle (`border-radius: 50%`)
- **Substrate inset:** `-3px` with `rgba(0,0,0,0.10)` core alpha (same as pill)
- **Shadow inset:** `-10px`, shadow `::after` offset `top: 14px / left: 10px` (same as pill)
- **Surface positioning:** `position: absolute; inset: 0` so it fills the root (because the root is sized externally, not the surface)
- **No hover state.** Orbs are decorative.
- **Critical history:** First attempt used a sphere-illusion recipe (radial-gradient diffuse + inset top/bottom lighting + specular `::before` pseudo) and looked flat. The real fix was porting `.liquid-glass-pill` verbatim with `border-radius: 50%`. See section 4 below.
- **Wrapping:** Required — root + surface + shadow.
- **Locked in:** `globals.css` lines 600-739.

### What's shared

All four classes share, identically:

- `linear-gradient(-75deg)` sheen — same 0.05/0.20/0.05 stops
- 4-layer `box-shadow` recipe — same alphas (except `.liquid-glass-nav-btn` uses 0.18 instead of 0.20 on layer 3)
- `::after` conic-gradient rim — same stops, same mask-composite trick
- `::before` refraction substrate shape (radial-gradient at 50%/60%) — alphas vary slightly (0.09–0.12 core)
- Sibling shadow div with masked ring — same `linear-gradient(0,0,0,0.2) → (0,0,0,0.1)`, same mask-composite trick
- `backdrop-filter: blur(2px)`
- Root `isolation: isolate`
- Surface `> * { position: relative; z-index: 2 }` to keep content above the rim

### What differs

| Class | Shape | Height | Font | H-pad | Substrate inset | Shadow inset | Shadow `top/left` |
|---|---|---|---|---|---|---|---|
| `.liquid-glass-btn` | stadium 9999px | 68px | 17px/500 | 40px | -5px | -16px | 24px / 18px |
| `.liquid-glass-pill` | stadium 9999px | 40px | 12px/500 | 20px | -3px | -10px | 14px / 10px |
| `.liquid-glass-nav-btn` | rounded 0.5rem | 36px | 14px/500 | 16px | -2px | -8px | 12px / 8px |
| `.liquid-glass-orb` | circle 50% | parent-sized | parent-sized | n/a | -3px | -10px | 14px / 10px |
| `.liquid-glass-card` *(defined, unused)* | rounded 12px | min 240px | 14px (content) | 20px | -4px | -20px | 26px / 18px |

Surface dimensions scale roughly linearly with substrate / shadow offsets.
A future variant should follow this scaling pattern (e.g., a 100px hero
orb would want substrate `-7px`, shadow `-22px`, shadow `::after` offset
roughly `28px / 22px`).

---

## 4. Critical lessons learned (the hard way)

These are the painful discoveries from the 2026-05-24 build session.
Internalize them or you'll repeat them.

### Stacking-context snap on `backdrop-filter` + animating ancestor

**The bug.** `backdrop-filter` samples pixels through ancestor stacking
contexts. When an ancestor animates `opacity` from `<1` to `1` (or
`transform` from non-identity to identity), the stacking context's
rasterization changes at the settle moment. You see a visible darker → lighter
"snap" where the glass looks one way during the animation and abruptly
changes when the animation ends.

**Root cause.** Both `opacity: <1` and `transform: <non-none>` create
stacking contexts. Both are common in framer-motion entrance animations
(`initial={{ opacity: 0, y: 20 }}`). When the animation settles, the
ancestor's stacking context goes away and `backdrop-filter` re-samples,
producing a different result.

**The fix.** Convert the offending `<motion.div>` to a plain `<div>`. Move
the entrance animation to a sibling that is NOT an ancestor of the glass,
OR animate something other than opacity/transform.

**Where it bit us:** the hero CTA (outer hero motion.div, inner button-row
motion.div, SpotsCounter wrapper motion.div, top-right nav motion.div all
had to be flattened), the how-it-works steps (per-step motion.div had to
be flattened).

**Detection.** Before shipping, run this in DevTools console at the page
where the glass lives:

```js
const surface = document.querySelector('.liquid-glass-X-root');
let n = surface.parentElement;
const issues = [];
while (n && n.tagName !== 'BODY') {
  const cs = getComputedStyle(n);
  if (cs.opacity !== '1' || cs.transform !== 'none' || cs.filter !== 'none') {
    issues.push({ tag: n.tagName, cls: n.className, opacity: cs.opacity, transform: cs.transform.slice(0,40), filter: cs.filter });
  }
  n = n.parentElement;
}
console.log(issues);
```

The output MUST be `[]`. Any entry is a snap risk.

### Continuous `transform` is NOT the same as animating `transform`

The use-cases marquee row has `animation: marquee-left 30s linear infinite`
which animates `transform: translateX(0)` → `translateX(-50%)` continuously.
This creates a stacking context, BUT there's no "settle moment" — the
transform is always non-identity, so `backdrop-filter` re-samples every
frame and the result is stable.

**Rule:** Entrance animations that go from "stacking context" → "no
stacking context" snap. Continuous animations that never leave their
non-identity state do not.

### CC cannot self-assess visual quality

Multiple times during the 2026-05-24 session, I claimed a glass element
was "good enough" or "matched wabi" when it visibly did not. Cooper had
to push back twice with screenshots.

**The lesson.** When matching a reference design, port the reference's
*actual computed CSS* verbatim. Don't theorize. Don't tweak. Verify the
match by side-by-side screenshot before claiming success.

If a screenshot side-by-side shows a difference, the difference is real
and matters. The instinct to say "close enough" is always wrong here.

### Sphere illusion is the wrong path for "glass orbs"

The first orb attempt used a sphere-illusion recipe:
- `radial-gradient(circle at 30% 25%)` background simulating a light source
- `inset 0 3px 5px white` + `inset 0 -3px 6px black` for Lambertian shading
- `::before` ellipse near top-left as a specular highlight
- Larger outer drop shadow for "floating"

It produced a subtle 3D-sphere effect but **broke material consistency
with the rest of the page**. The orbs read as "from a different website"
because they used a different glass recipe than the pill, button, and
nav-btn.

**The fix.** Port `.liquid-glass-pill` verbatim with `border-radius: 50%`.
The orbs now share the exact 5-ingredient recipe with everything else.
They read as the same material, shaped differently.

**The lesson.** Material consistency beats per-element illusion. If your
glass system is built on a unified recipe, all shapes use that recipe.
Don't reach for "this shape needs a special technique" — the recipe is
shape-agnostic.

### Refraction substrate is essential on flat backgrounds

Without `::before { background: radial-gradient(...); z-index: -1; }`, the
button looks like a flat sticker on the cream bg. `backdrop-filter` blurs
a flat color and produces the same flat color — no-op.

**Detection.** Temporarily delete the `::before` rule, reload, and compare.
If the glass goes flat, you found the load-bearing piece. Restore it.

**Generalization.** On pages with rich photographic or busy backgrounds
(e.g., a hero image), the refraction substrate may be unnecessary —
`backdrop-filter` has plenty of content to blur. But verify empirically;
don't assume.

### Idempotency / cache traps

The Next.js dev server cached stale CSS chunks multiple times during the
session. If a CSS change isn't reflecting after Fast Refresh, kill the
dev server PID and restart `npm run dev`. Hard reload is not sufficient.

When debugging "the CSS doesn't apply," before assuming a CSS bug:
1. Confirm Fast Refresh ran (`[Fast Refresh] done in Nms` in console).
2. If stale, restart dev server.
3. Only then question your CSS.

---

## 5. How to add glass to a new element

Follow this checklist exactly. Skipping a step = guaranteed regression.

### Step 1 — Determine shape

What shape do you need?
- **Stadium pill** (rounded ends, wider than tall) → use `.liquid-glass-pill`
- **Stadium button** (larger, padded, primary CTA) → use `.liquid-glass-btn`
- **Rounded square** (nav-style chip) → use `.liquid-glass-nav-btn`
- **Circle** (orb, avatar, badge) → use `.liquid-glass-orb`
- **Something else** (e.g., a card with `border-radius: 12px`) → see Step 2

### Step 2 — Pick existing class or create a new one

If the shape matches an existing class, use it. Set dimensions via tailwind
classes or inline styles on the root.

If the shape is genuinely new (e.g., a 12px-radius card), create a new
class set:

1. Copy the closest existing class block from `globals.css` (probably
   `.liquid-glass-nav-btn` since it has the rounded-square shape).
2. Rename `nav-btn` → `your-shape` everywhere (root, surface, shadow,
   substrate, conic rim, hover/active states if applicable).
3. Change the `border-radius` values on ALL of:
   - `.liquid-glass-X-root` → your radius
   - `.liquid-glass-X-root::before` → your radius
   - `.liquid-glass-X` → your radius
   - `.liquid-glass-X-shadow::after` → your radius
   - (The `::after` conic rim uses `border-radius: inherit` — don't touch it.)
4. Adjust `inset:` values on the substrate and shadow div if your shape
   is bigger or smaller than nav-btn. The scaling pattern: substrate inset
   roughly `1/15 × element height`, shadow inset roughly `1/4 × element
   height`.
5. Adjust shadow `::after` `top`/`left` offsets — same proportions as the
   nearest existing class.
6. **Do not change** any other CSS values. The sheen gradient, conic
   rim stops, box-shadow alphas, and mask-composite tricks are locked.

### Step 3 — Wrap in 3-element architecture

```jsx
<span className="liquid-glass-X-root /* + your dimension classes */">
  <YourSurface className="liquid-glass-X">
    {content}
  </YourSurface>
  <div aria-hidden="true" className="liquid-glass-X-shadow"></div>
</span>
```

`YourSurface` can be `<button>`, `<a>`, `<Link>`, `<span>` — anything.
`aria-hidden="true"` on the shadow div keeps screen readers from
announcing it.

### Step 4 — Check ALL ancestors for opacity/transform animations

Walk up the DOM tree from your new glass element to `<body>`. For each
ancestor:

- If it's a `<motion.div>` with `initial={{ opacity: 0 }}` or `initial={{ y: 20 }}` → CONVERT TO PLAIN `<div>`.
- If it has CSS `animation` that animates opacity or transform AND has a
  settle state (i.e., the animation ends, not infinite loop) → REMOVE OR
  RESTRUCTURE.
- Continuous animations (e.g., the marquee) are fine.

Use the DevTools console snippet from section 4 to verify.

### Step 5 — Verify on the actual background

Glass-on-cream and glass-on-white look different. Glass-on-photo looks
different again. Test on the actual page background you'll ship on.

If the glass looks flat:
1. Check the `::before` refraction substrate is rendering (DevTools →
   Computed → look for the pseudo-element).
2. Tune the substrate's core alpha (0.08–0.12 range) if needed.
3. Make sure `isolation: isolate` is on the root (otherwise `z-index: -1`
   sinks below page bg).

### Step 6 — Test entrance animations

Reload the page 5 times. Watch the glass element during the first 1
second. If you see ANY brightness/blur change during settle, you have an
ancestor stacking-context issue. Go back to Step 4.

### Step 7 — Screenshot before AND after

Capture at desktop (1440px) AND mobile (390px) BEFORE your change and
AFTER. Compare side-by-side. The new glass MUST be visually consistent
with existing glass on the same page.

If they don't match, the issue is almost certainly:
- You modified one of the locked CSS values (don't).
- You skipped an ingredient (verify all 5 are present).
- An ancestor has opacity/transform (see Step 4).
- The dev server is serving stale CSS (restart it).

---

## 6. The wabi.ai source

The recipe in `globals.css` is a verbatim port of wabi.ai's button
component (`glassmorphic-button-module`), extracted via puppeteer's
`getComputedStyle` on 2026-05-24. The original CSS lived in a Tailwind
+ Emotion stack at the wabi.ai homepage and used three DOM elements
identical in structure to ours.

### Why wabi works

Wabi's button looks like real glass because of the **interaction** of
the 5 ingredients, not any single one. Removing any single ingredient
makes the button look like a flat sticker. Verified empirically during
the v1–v8 hero iterations:

- No `::before` substrate → flat on cream
- No conic `::after` rim → no edge depth, looks like flat tinted shape
- No sibling shadow div → no "floating" cue, looks pasted-on
- No `-75deg` sheen → no light direction, looks like a colored disc
- No 4-layer `box-shadow` → no rim depth, looks like a soft circle

Each ingredient is doing 20% of the work. The illusion requires all
five operating together.

### The 6 changes we made vs wabi

Wabi's button is 68px tall with weight 400 and rgb(25,25,25) text. We
ship with:

1. Same height (68px) on the hero CTA, scaled down for pill/nav-btn/orb.
2. Weight 500 (vs 400) — better hierarchy with our Instrument Serif headline.
3. `letter-spacing: -0.15px` (vs normal) — subtle tightening.
4. `color: #1c1c1c` (basically wabi's value, simplified to hex).
5. Focus ring uses our `--accent` (orange-red) instead of wabi's blue.
6. Custom hover/active states that mirror wabi's pattern (`top` offset
   shifting on shadow `::after`, slight `filter: blur` change).

Beyond these, **everything else is bit-identical to wabi**.

---

## 7. DO NOT MODIFY — values are locked

The following values in `app/globals.css` are LOCKED. Touching them in
isolation will break the material match across the page.

### Locked: `linear-gradient(-75deg)` sheen
- Angle: `-75deg` — do not change
- Stops: `0.05 → 0.20 → 0.05` — do not change

### Locked: 4-layer `box-shadow` recipe
- Inset top: `rgba(0,0,0,0.05) 0 2px 2px 0 inset`
- Inset bottom: `rgba(255,255,255,0.5) 0 -2px 2px 0 inset`
- Outer drop: `rgba(0,0,0,0.20) 0 4px 2px -2px` (or `0.18` for nav-btn)
- Inset glow: `rgba(255,255,255,0.20) 0 0 1.6px 4px inset`

### Locked: `::after` conic-gradient rim
- Start angle: `from -75deg at 50% 50%`
- All seven color stops and positions (5%, 40%, 50%, 60%, 95%)
- Two-layer background with white underlay at `rgba(255,255,255,0.5)`
- Inset rim shadow `rgba(255,255,255,0.5) 0 0 0 0.5px inset`
- `mask-composite: exclude` technique

### Locked: `::before` refraction substrate
- `radial-gradient(ellipse at 50% 60%, ...)` shape and position
- Stop positions (0%, 50%, 80%)
- Core alpha range: 0.09–0.12 (tune within this range for new shapes only)
- `z-index: -1`
- `isolation: isolate` on the wrapper

### Locked: Sibling shadow div
- `filter: blur(2px)`
- `linear-gradient(rgba(0,0,0,0.20), rgba(0,0,0,0.10))` (or `0.18 / 0.08` for nav-btn)
- `mask-composite: exclude` masked-ring technique
- The asymmetric `top/left` offset pattern (top > left, both biasing
  toward bottom-right)

### What you MAY change

- `border-radius` on a new class (the whole point of new classes).
- Surface dimensions (height, padding, font-size) on a new class.
- `inset` distances on the substrate and shadow div, scaled
  proportionally to your new element's height (see scaling pattern in
  section 3).
- Hover/active states (offsets, blur intensity, background-color) —
  use existing classes as templates.
- Text color, weight, letter-spacing on the root.

### What you MUST NOT change

- The five ingredient recipes (sheen stops, shadow alphas, conic stops,
  substrate alpha range, masked-ring linear-gradient stops).
- The 3-element DOM structure.
- The `mask-composite` techniques.
- The `isolation: isolate` on the root.
- The `border-radius: inherit` on the conic `::after`.

### If you think you've found a way to improve a locked value

You haven't. The values are interdependent — calibrated against each
other so the resulting material reads correctly. Anything you tweak in
isolation will look worse in some interaction you haven't tested.

If a new shape genuinely needs different values, create a new class
that's a verbatim copy of the closest existing class, then change ONLY
dimensions and `inset:` distances. Do not tweak ingredient stops.

---

## Appendix — File pointers

- **CSS source of truth:** `instaclaw/app/globals.css` lines 264–925
- **Hero CTA usage:** `instaclaw/components/landing/hero.tsx` (search `.liquid-glass-btn`)
- **Spots pill usage:** `instaclaw/components/landing/spots-counter.tsx`
- **Marquee pill usage:** `instaclaw/components/landing/use-cases.tsx`
- **Nav button usage:** `instaclaw/components/landing/hero.tsx` (search `.liquid-glass-nav-btn`)
- **Orb usage:** `instaclaw/components/landing/how-it-works.tsx`
- **Reference site:** https://wabi.ai (extracted via puppeteer 2026-05-24)
- **Build session commits:** `47eba427` (initial v9 CTA), `2de5002e` (snap fix), `9b546ec7` (nav-btn full glass), `882575aa` (marquee pills), `cf9f3c0a` (orbs via pill recipe), `a07d6877` (shimmer serif font)
