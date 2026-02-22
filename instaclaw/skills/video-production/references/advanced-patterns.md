# Advanced Remotion Patterns

## Complex Animations

### Typewriter Effect

```tsx
import { interpolate, useCurrentFrame } from "remotion";

const TypewriterText: React.FC<{ text: string; startFrame: number }> = ({ text, startFrame }) => {
  const frame = useCurrentFrame();
  const charsToShow = Math.floor(
    interpolate(frame - startFrame, [0, text.length * 2], [0, text.length], {
      extrapolateRight: "clamp",
    })
  );
  return <span>{text.substring(0, charsToShow)}<span style={{ opacity: frame % 20 < 10 ? 1 : 0 }}>|</span></span>;
};
```

### Parallax Scrolling

```tsx
const parallaxY = interpolate(frame, [0, durationInFrames], [0, -200], {
  extrapolateRight: "clamp",
});
const bgParallaxY = interpolate(frame, [0, durationInFrames], [0, -50], {
  extrapolateRight: "clamp",
});
// Background moves slower than foreground
```

### Counter Animation

```tsx
const CountUp: React.FC<{ from: number; to: number; duration: number }> = ({ from, to, duration }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const progress = spring({ frame, fps, config: { damping: 30 }, durationInFrames: duration });
  const value = Math.round(interpolate(progress, [0, 1], [from, to]));
  return <span>{value.toLocaleString()}</span>;
};
```

## Scene Transitions

### Fade Transition

```tsx
// End of scene: fade out last 15 frames
const fadeOut = interpolate(frame, [durationInFrames - 15, durationInFrames], [1, 0], {
  extrapolateLeft: "clamp",
  extrapolateRight: "clamp",
});
```

### Slide Transition

```tsx
// Slide in from right
const slideX = interpolate(
  spring({ frame, fps, config: { damping: 15 } }),
  [0, 1],
  [1920, 0]
);
```

### Zoom Transition

```tsx
const zoom = spring({
  frame,
  fps,
  config: { damping: 8, stiffness: 60 },
});
// Scale from 1.5x down to 1x for a zoom-in effect
const scale = interpolate(zoom, [0, 1], [1.5, 1]);
```

## Audio Integration

### Background Music

```tsx
import { Audio, staticFile } from "remotion";

// Add to composition:
<Audio src={staticFile("music/background.mp3")} volume={0.3} />
```

### Sound Effects

```tsx
// Play sound at specific frame
<Sequence from={90}>
  <Audio src={staticFile("sfx/whoosh.mp3")} volume={0.5} />
</Sequence>
```

### Volume Ducking

```tsx
const musicVolume = interpolate(
  frame,
  [0, 30, 60, 90],
  [0.3, 0.3, 0.1, 0.3], // Duck during voiceover
  { extrapolateRight: "clamp" }
);
```

## Data-Driven Videos

### Dynamic Content from JSON

```tsx
const VideoFromData: React.FC<{ data: { title: string; stats: number[] } }> = ({ data }) => {
  return (
    <AbsoluteFill>
      <h1>{data.title}</h1>
      {data.stats.map((stat, i) => (
        <CountUp key={i} from={0} to={stat} duration={30} />
      ))}
    </AbsoluteFill>
  );
};
```

### Batch Rendering Multiple Variants

```bash
# Render 3 variants with different props
for variant in brand1 brand2 brand3; do
  npx remotion render src/index.ts MyVideo "out/${variant}.mp4" \
    --props="configs/${variant}.json"
done
```

## Multi-Resolution Exports

### Horizontal (16:9) — Default

```tsx
<Composition width={1920} height={1080} fps={30} ... />
```

### Vertical (9:16) — TikTok / Reels

```tsx
<Composition width={1080} height={1920} fps={30} ... />
```

### Square (1:1) — Instagram

```tsx
<Composition width={1080} height={1080} fps={30} ... />
```

### Render all formats:

```bash
npx remotion render src/index.ts MyVideo-16x9 out/horizontal.mp4
npx remotion render src/index.ts MyVideo-9x16 out/vertical.mp4
npx remotion render src/index.ts MyVideo-1x1 out/square.mp4
```

## A/B Testing Patterns

### Color Variant Testing

```tsx
// Create multiple compositions with different color schemes
const variants = [
  { id: "variant-a", primary: "#e67e4d", bg: "#0f1419" },
  { id: "variant-b", primary: "#3b82f6", bg: "#1a1a2e" },
  { id: "variant-c", primary: "#10b981", bg: "#064e3b" },
];

// Register each as a separate composition
variants.forEach(v => (
  <Composition
    id={v.id}
    component={MyVideo}
    defaultProps={{ primaryColor: v.primary, bgDark: v.bg, ... }}
  />
));
```

### CTA Variant Testing

```tsx
const ctaVariants = [
  { text: "Get Started Free", urgency: "low" },
  { text: "Start Now — Limited Time", urgency: "high" },
  { text: "Try It Today", urgency: "medium" },
];
```

## Performance Tips

- Use `React.memo()` for scene components that don't change every frame
- Preload images with `staticFile()` — don't fetch from URLs during render
- Keep `spring()` config consistent across a scene for visual coherence
- Use `interpolate()` with `extrapolateRight: "clamp"` to prevent overshoot
- Draft renders (`--crf 28`) are 3-5x faster than production renders
