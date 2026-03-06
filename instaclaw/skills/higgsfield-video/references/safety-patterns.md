# Safety Patterns — Error Handling & Reliability

## Error Classification

### TRANSIENT (Retry)
- HTTP 429 (Rate limited)
- HTTP 500, 502, 503 (Server errors)
- Network timeouts
- DNS resolution failures

**Action**: Retry with exponential backoff: 5s → 15s → 45s (max 3 retries)

### PERMANENT (Stop)
- HTTP 400 (Bad request — invalid params)
- HTTP 401 (Invalid API key)
- HTTP 403 (Forbidden — insufficient plan/credits)
- HTTP 404 (Endpoint not found)
- Invalid model name
- Content policy violation

**Action**: Report error clearly to user. Do NOT retry.

### DANGEROUS (Escalate)
- Unexpected billing/charge indicators
- API key exposure in logs
- Account suspension notices
- Unusual response patterns suggesting compromise

**Action**: Stop all operations immediately. Alert user. Do NOT retry.

## Retry Logic

All scripts implement this retry pattern:
```
attempt 1: immediate
attempt 2: wait 5s
attempt 3: wait 15s
(failure): report error, stop
```

For polling (checking status):
- Video: 120 polls × 2s interval = 4 min max
- Image: 60 polls × 2s interval = 2 min max
- Audio: 120 polls × 2s interval = 4 min max

## Context Budget

### Problem
AI video generation can produce large response payloads. Dumping these into the conversation context wastes tokens and may hit limits.

### Rules
1. Always use `--json` flag for machine-readable output
2. Extract only relevant fields (status, output_url, error)
3. Keep generation output under 50KB per operation
4. For job history, limit to 10-20 entries
5. Never dump raw API responses into conversation

### Pattern
```
result = run_script("higgsfield-generate.py text-to-video --json")
# Extract: status, output_url, request_id
# Discard: raw response, intermediate polling data
```

## Fallback Chains

When a model fails or is unavailable:

### Video Fallback
1. Kling 3.0 (primary)
2. Veo 3.1
3. Seedance 2.0
4. Hailuo (fastest, most available)

### Anime/Stylized Fallback
1. Wan 2.2 (primary)
2. Kling 3.0
3. PixVerse v4

### Image Fallback
1. Flux Pro (primary)
2. Flux Dev
3. Flux Schnell (always available)

### I2V Fallback
1. Kling 3.0 (primary)
2. Seedance 2.0
3. Runway Gen4

## Content Safety

### Prohibited Content
- Explicit sexual content (NSFW)
- Graphic violence or gore
- Content targeting minors
- Deepfakes of real people without consent
- Harassment or hate content
- Misinformation/disinformation

### Face Swap Safety
- Only allow with clear consent context
- Warn user about ethical implications
- Never generate face swaps of public figures

### Pre-Flight Checklist
Before submitting any generation:
- [ ] API key is valid
- [ ] Prompt does not violate content policy
- [ ] Model is appropriate for the content type
- [ ] User has confirmed expensive operations
- [ ] No prohibited content indicators

## Job Tracking

### Local Storage
All jobs are tracked in `~/.openclaw/workspace/higgsfield/jobs.json`:
- Last 200 jobs retained
- Includes request_id, type, model, prompt, status, timestamps
- Updated on submit and on status check

### Stale Job Cleanup
Jobs older than 7 days with status "processing" are likely stale:
- Check status one more time
- If still "processing", mark as "unknown"
- Do not auto-delete — user may need the request ID

## API Key Security

- Store in `~/.openclaw/.env` only
- Never log or display the full key
- Show only preview: `sk-xxxx...yyyy`
- Never include in error messages or prompts
- If key appears in logs, alert user to rotate immediately
