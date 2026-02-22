# Voice Selection Guide

## OpenAI TTS Voices

| Voice ID | Character | Best For |
|---|---|---|
| alloy | Balanced, neutral | Product demos, general narration |
| echo | Clear, measured | Document summaries, tutorials |
| fable | Warm, natural | Accessibility reading, storytelling |
| onyx | Deep, authoritative | Podcast intros, presentations |
| nova | Bright, approachable | Explainer videos, friendly content |
| shimmer | Casual, conversational | Voice messages, informal updates |

**Models:**
- `tts-1` — Fast, lower quality. Good for drafts, voice messages.
- `tts-1-hd` — Higher quality, slightly slower. Use for all public-facing content.

**Cost:** ~$0.015 per 1,000 characters ($0.030 for tts-1-hd)

## ElevenLabs Voices

### Built-in Voices (No Cloning Required)
| Voice ID | Name | Character |
|---|---|---|
| 21m00Tcm4TlvDq8ikWAM | Rachel | Neutral female, clear |
| ErXwobaYiN019PkySvjV | Antoni | Warm male, conversational |
| EXAVITQu4vr4xnSDxMaL | Bella | Soft female, gentle |
| MF3mGyEYCl7XYWbV9V6O | Elli | Young female, energetic |
| TxGEqnHWrfWFTfGW9XjX | Josh | Deep male, confident |
| VR6AewLTigWG4xSOukaG | Arnold | Mature male, narration |
| pNInz6obpgDQGcFmaJgB | Adam | Professional male |

### List All Available Voices
```bash
curl -s -H "xi-api-key: $ELEVENLABS_API_KEY" \
  https://api.elevenlabs.io/v1/voices | \
  python3 -c "import json,sys; [print(f\"{v['voice_id']} — {v['name']}: {v.get('labels',{}).get('description','')}\") for v in json.load(sys.stdin)['voices']]"
```

### Voice Settings
```json
{
  "stability": 0.5,          // 0.0=variable/expressive → 1.0=stable/monotone
  "similarity_boost": 0.75   // 0.0=diverse → 1.0=close to original voice
}
```

**For voiceovers:** stability=0.5, similarity=0.75 (balanced)
**For conversational:** stability=0.3, similarity=0.5 (more expressive)
**For narration:** stability=0.7, similarity=0.8 (consistent, professional)

## Use Case → Voice Mapping

| Use Case | Recommended Voice | Provider | Why |
|---|---|---|---|
| Marketing video | alloy or Rachel | ElevenLabs preferred | Professional, trustworthy |
| Explainer video | nova or Antoni | ElevenLabs preferred | Warm, approachable |
| Podcast intro | onyx or Josh | ElevenLabs preferred | Gravitas, authority |
| Voice message | shimmer or nova | OpenAI (cost) | Quick, natural |
| Document summary | echo | OpenAI (cost) | Clear, measured |
| Accessibility | fable | OpenAI (cost) | Natural pace, warm |
| Draft/preview | alloy | OpenAI (cost) | Fast, good enough |

## Provider Decision Tree

```
Is this public-facing content? (video, podcast, demo)
├─ YES → Is ElevenLabs available and within budget?
│        ├─ YES → Use ElevenLabs
│        └─ NO  → Use OpenAI TTS-1-HD
└─ NO  → Is this a voice message or internal?
         ├─ YES → Use OpenAI TTS-1 (fast, cheap)
         └─ NO  → Use OpenAI TTS-1-HD
```

## Audio Format Guide

| Delivery Channel | Format | How to Convert |
|---|---|---|
| Remotion video | MP3 | Default TTS output |
| Telegram voice | OGG Opus | `audio-toolkit.sh convert in.mp3 out.ogg opus` |
| Apple devices | AAC/M4A | `audio-toolkit.sh convert in.mp3 out.m4a aac` |
| Web playback | MP3 | Default TTS output |
| Podcast hosting | MP3 128kbps | Already default |
| High quality archive | WAV/FLAC | `audio-toolkit.sh convert in.mp3 out.wav` |
