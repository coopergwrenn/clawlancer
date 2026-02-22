# Voice & Audio Production
```yaml
name: voice-audio-production
version: 1.0.0
updated: 2026-02-21
author: InstaClaw
triggers:
  keywords: [voiceover, voice, audio, narration, TTS, text to speech, podcast, speech, sound, voice message, narrator]
  phrases: ["add voiceover", "make a voiceover", "generate audio", "text to speech", "podcast intro", "voice message", "narrate this", "read this aloud", "audio version", "add narration to video"]
  NOT: [play music, music production, voice call, phone call, transcribe audio, speech to text]
```

## Overview

Generate professional voiceovers, audio content, and voice messages using text-to-speech APIs. The killer use case: Remotion videos with synchronized voiceovers — transforming silent motion graphics into broadcast-quality content.

**Prerequisites (already on your VM):**
- FFmpeg (format conversion, mixing, normalization)
- Remotion (video+audio integration)
- OpenAI API key (TTS endpoint — same key as LLM, always available)
- ElevenLabs API key (premium voices — check `.env` for `ELEVENLABS_API_KEY`)

## Provider Selection

**Use ElevenLabs when:**
- Public-facing content (marketing videos, podcasts, demos)
- Voice quality is critical
- User is on Pro or Power tier

**Use OpenAI TTS when:**
- Internal/draft content
- Voice messages via Telegram
- Document summaries
- User is on Free/Starter tier
- ElevenLabs is unavailable or over monthly limit

**Always check before generating:**
1. Run `python3 ~/scripts/audio-usage-tracker.py check <char_count>` to verify budget
2. If ElevenLabs is over limit, fall back to OpenAI TTS automatically
3. Log usage after every generation: `python3 ~/scripts/audio-usage-tracker.py track <chars> <provider>`

## Workflow 1: Remotion Video with Voiceover (THE KILLER FEATURE)

This is the end-to-end pipeline from "make me a video" to final MP4 with synchronized voiceover. **Generate audio FIRST, then set video duration to match.** Never the other way around.

### Step 1: Write the Voiceover Script

```javascript
// Write the script based on the video's purpose
const script = `Welcome to InstaClaw. The AI agent platform that works 24/7.
Traditional chatbots just answer questions. InstaClaw agents take action.
Deploy your own AI agent in 60 seconds. Try it today.`;

// Estimate duration (~150 words per minute for natural speech)
const wordCount = script.split(/\s+/).length;
const estimatedSeconds = (wordCount / 150) * 60;
console.log(`Script: ${wordCount} words, ~${estimatedSeconds.toFixed(1)}s`);
```

### Step 2: Generate Audio

**Option A: ElevenLabs (premium)**
```bash
# Using the helper script
~/scripts/tts-elevenlabs.sh "$SCRIPT" public/voiceover.mp3

# Or directly via API
curl -s -X POST "https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM" \
  -H "xi-api-key: $ELEVENLABS_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"text\": \"$SCRIPT\", \"model_id\": \"eleven_monolingual_v1\", \"voice_settings\": {\"stability\": 0.5, \"similarity_boost\": 0.75}}" \
  --output public/voiceover.mp3
```

**Option B: OpenAI TTS (standard/fallback)**
```bash
# Using the helper script
~/scripts/tts-openai.sh "$SCRIPT" public/voiceover.mp3 alloy tts-1-hd

# Or directly via API
curl -s -X POST "https://api.openai.com/v1/audio/speech" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"model\": \"tts-1-hd\", \"voice\": \"alloy\", \"input\": \"$SCRIPT\"}" \
  --output public/voiceover.mp3
```

### Step 3: Get Exact Audio Duration

```bash
# CRITICAL: Use ffprobe to get exact duration — don't estimate
DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=0 public/voiceover.mp3)
echo "Audio duration: ${DURATION}s"
```

### Step 4: Remove Leading/Trailing Silence

```bash
# TTS engines often add 0.5-1s of silence. Remove it for tight sync.
~/scripts/audio-toolkit.sh silence-remove public/voiceover.mp3 public/voiceover-clean.mp3
mv public/voiceover-clean.mp3 public/voiceover.mp3

# Re-measure duration after silence removal
DURATION=$(~/scripts/audio-toolkit.sh duration public/voiceover.mp3)
```

### Step 5: Normalize Volume

```bash
~/scripts/audio-toolkit.sh normalize public/voiceover.mp3 public/voiceover.mp3
```

### Step 6: Set Remotion Composition Duration to Match Audio

```javascript
// In Root.tsx
import { Composition } from 'remotion';

const fps = 30;
const audioDuration = 18.5; // From ffprobe — use EXACT value

<Composition
  id="ProductDemo"
  component={ProductDemo}
  durationInFrames={Math.ceil(audioDuration * fps)}
  fps={fps}
  width={1920}
  height={1080}
/>
```

### Step 7: Add Audio Track + Sync Scene Transitions

```javascript
// In ProductDemo.tsx
import { Audio, staticFile, AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';

// Time visual transitions to match voiceover content
const scriptBeats = {
  intro:    { start: 0, end: 3 },      // "Welcome to InstaClaw..."
  problem:  { start: 3, end: 8 },      // "Traditional chatbots..."
  solution: { start: 8, end: 15 },     // "InstaClaw agents take action..."
  cta:      { start: 15, end: 18.5 }   // "Try it today..."
};

export const ProductDemo = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const currentTime = frame / fps;

  return (
    <AbsoluteFill>
      {currentTime < scriptBeats.intro.end && <IntroScene />}
      {currentTime >= scriptBeats.problem.start && currentTime < scriptBeats.problem.end && <ProblemScene />}
      {currentTime >= scriptBeats.solution.start && currentTime < scriptBeats.solution.end && <SolutionScene />}
      {currentTime >= scriptBeats.cta.start && <CTAScene />}

      {/* Voiceover track */}
      <Audio src={staticFile('voiceover.mp3')} volume={1.0} />

      {/* Optional: Background music at low volume */}
      <Audio src={staticFile('background-music.mp3')} volume={0.15} />
    </AbsoluteFill>
  );
};
```

### Step 8: Render

```bash
npx remotion render ProductDemo output.mp4
```

**Result:** Professional MP4 with synchronized voiceover + optional background music.

## Workflow 2: Podcast Intro/Outro Generation

```bash
# 1. Write intro script
SCRIPT="Welcome to The AI Agent Show, the podcast where we explore how artificial intelligence is reshaping work, creativity, and the future. I'm your host. Let's dive in."

# 2. Generate with professional voice (ElevenLabs for quality)
~/scripts/tts-elevenlabs.sh "$SCRIPT" /tmp/intro-voice.mp3 onyx

# 3. Mix with music bed (music at 20% volume)
~/scripts/audio-toolkit.sh mix /tmp/intro-voice.mp3 public/intro-music.mp3 output/podcast-intro.mp3 0.2

# 4. Normalize final mix
~/scripts/audio-toolkit.sh normalize output/podcast-intro.mp3 output/podcast-intro.mp3
```

## Workflow 3: Audio Summary of Document

When user says: "Summarize this report as audio" or "Read me the highlights"

```bash
# 1. Agent summarizes document to ~750 words (~5 min at 150 wpm)
# (Agent writes summary to /tmp/summary.txt)

# 2. Generate audio (OpenAI — cheaper for summaries)
~/scripts/tts-openai.sh "$(cat /tmp/summary.txt)" /tmp/summary-raw.mp3 echo tts-1-hd

# 3. Normalize and compress for mobile
~/scripts/audio-toolkit.sh normalize /tmp/summary-raw.mp3 /tmp/summary-norm.mp3
~/scripts/audio-toolkit.sh compress /tmp/summary-norm.mp3 output/summary.mp3

# 4. Deliver via Telegram (or send as file)
# Agent sends output/summary.mp3 via messaging
```

## Workflow 4: Voice Messages via Telegram

Agent sends voice replies instead of text:

```bash
# 1. Agent composes response text
RESPONSE="Here's what I found about your competitor pricing..."

# 2. Generate voice (OpenAI — faster, cheaper for quick messages)
~/scripts/tts-openai.sh "$RESPONSE" /tmp/voice-raw.mp3 nova tts-1

# 3. Convert to Telegram voice format (OGG Opus)
~/scripts/audio-toolkit.sh convert /tmp/voice-raw.mp3 output/voice-reply.ogg opus

# 4. Send as Telegram voice message
# Agent uses messaging tool to send output/voice-reply.ogg
```

## Audio Processing Toolkit

All commands available via `~/scripts/audio-toolkit.sh`:

| Command | Usage | What It Does |
|---|---|---|
| `duration` | `audio-toolkit.sh duration file.mp3` | Get exact duration in seconds |
| `normalize` | `audio-toolkit.sh normalize in.mp3 out.mp3` | Normalize volume (loudnorm) |
| `mix` | `audio-toolkit.sh mix voice.mp3 music.mp3 out.mp3 0.2` | Mix voice + music at given volume |
| `compress` | `audio-toolkit.sh compress in.mp3 out.mp3` | Compress for messaging (96k mono) |
| `convert` | `audio-toolkit.sh convert in.mp3 out.ogg opus` | Convert format (mp3/ogg/aac/wav) |
| `trim` | `audio-toolkit.sh trim in.mp3 out.mp3 2 10` | Trim: start at 2s, duration 10s |
| `silence-remove` | `audio-toolkit.sh silence-remove in.mp3 out.mp3` | Remove leading/trailing silence |
| `concat` | `audio-toolkit.sh concat out.mp3 part1.mp3 part2.mp3` | Join multiple files |

## Voice Selection Guide

| Use Case | ElevenLabs Voice | OpenAI Voice | Why |
|---|---|---|---|
| Product demo video | Professional Male/Female | alloy | Authority, trust |
| Explainer video | Warm Narrator | nova | Approachable, clear |
| Podcast intro | Deep Professional | onyx | Gravitas |
| Voice message reply | Casual Conversational | shimmer | Friendly, natural |
| Document summary | Clear, Measured | echo | Easy to follow |
| Accessibility reading | Natural, Unhurried | fable | Comfortable pace |

**OpenAI voice IDs:** alloy, echo, fable, onyx, nova, shimmer
**ElevenLabs:** Use voice IDs from `curl -s -H "xi-api-key: $ELEVENLABS_API_KEY" https://api.elevenlabs.io/v1/voices | python3 -m json.tool`

## Long Text Handling

TTS APIs have per-request character limits. For long content:

1. **Check length first:** If text > 5000 chars, split into segments
2. **Split at sentence boundaries:** Never split mid-sentence
3. **Generate each segment separately**
4. **Concatenate with FFmpeg:**

```bash
# Split text into segments (agent does this in code)
# Generate each: tts-openai.sh "$SEGMENT1" /tmp/part1.mp3
#                tts-openai.sh "$SEGMENT2" /tmp/part2.mp3

# Join them
~/scripts/audio-toolkit.sh concat output/full.mp3 /tmp/part1.mp3 /tmp/part2.mp3 /tmp/part3.mp3
```

## Usage Tracking

**ALWAYS track usage.** TTS costs add up. Before generating:

```bash
# Check if we have budget for this text
python3 ~/scripts/audio-usage-tracker.py check $(echo -n "$TEXT" | wc -c)
# Output: OK — 150000/1800000 chars used (8.3%), 1650000 remaining
# Or:     WARN — 1750000/1800000 chars used (97.2%), consider OpenAI fallback
# Or:     OVER — monthly limit exceeded, switching to OpenAI fallback

# After generating, log it
python3 ~/scripts/audio-usage-tracker.py track $(echo -n "$TEXT" | wc -c) elevenlabs

# Check current status
python3 ~/scripts/audio-usage-tracker.py status
```

## Common Mistakes

1. **Not matching video duration to audio.** Generate audio FIRST, get exact duration from ffprobe, THEN set Remotion composition duration. Never estimate.

2. **Using ElevenLabs for everything.** ElevenLabs is premium. Use OpenAI TTS for internal/draft content, voice messages, and document summaries. Reserve ElevenLabs for public-facing content.

3. **Ignoring audio normalization.** Different TTS providers output at different volumes. Always run `audio-toolkit.sh normalize` before mixing or delivering.

4. **Wrong format for platform.** Telegram voice = OGG Opus. Apple = AAC. Web = MP3. Always convert to the right format.

5. **Script too long for single API call.** ElevenLabs limit is ~5000 chars per call on lower tiers. Split long scripts into segments and concatenate.

6. **Not removing TTS silence.** Most TTS engines add 0.5-1s silence at start/end. Use `silence-remove` before syncing to video.

7. **Forgetting to track usage.** Always run `audio-usage-tracker.py track` after every generation. A single agent generating hours of audio blows through the budget.

## Quality Checklist

Before delivering any audio:
- [ ] Audio plays correctly (not corrupted, correct format)
- [ ] Volume normalized (`loudnorm` applied)
- [ ] Leading/trailing silence removed
- [ ] Correct voice selected for use case
- [ ] If Remotion: video duration matches audio duration exactly
- [ ] If Remotion: scene transitions align with script beats
- [ ] If mixing: background music at 15-25% volume (not overpowering)
- [ ] File size appropriate for delivery channel (compressed for Telegram)
- [ ] Usage logged via `audio-usage-tracker.py track`
- [ ] Within monthly budget (checked via `audio-usage-tracker.py check`)
- [ ] Output format matches delivery channel (OGG for Telegram, MP3 general, AAC Apple)
