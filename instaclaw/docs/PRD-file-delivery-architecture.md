# PRD: File Delivery Architecture

**Author:** Cooper Wrenn
**Date:** 2026-03-19
**Status:** Draft
**Priority:** P1 — Core product gap blocking retention and expansion

---

## Problem Statement

InstaClaw agents run on dedicated Linux VMs and frequently create files that users need: CSVs from data analysis, HTML dashboards, PDFs, images, videos from Sjinn/Remotion, and more. Today, there is no production-grade file delivery pipeline. The current setup is a patchwork:

1. **Caddy tmp-media hack** — Agents are instructed (via SOUL.md) to copy files to `~/.openclaw/workspace/tmp-media/` and share a raw URL like `https://vm-058.vm.instaclaw.io/tmp-media/report.csv`. This is fragile: URLs are publicly guessable, files have no expiration, there is no access control, filenames collide, and the URL leaks the VM hostname.

2. **Dashboard file browser** — An auth-gated file browser at `/dashboard/files` (backed by `/api/vm/files`) lets users browse `~/.openclaw/workspace/` via SSH. It supports inline preview for images/video and download for any file type. But it requires the user to leave Telegram, log into the dashboard, and navigate manually. Most users never visit it.

3. **Telegram text-only** — The OpenClaw gateway currently delivers text messages to Telegram. The motion-graphics and sjinn-video skills use raw `curl` calls to Telegram's `sendVideo` API as a workaround, but this pattern is not generalized. Agents cannot send arbitrary documents, images, or files through the normal message flow.

4. **No signed URLs, no sharing** — There is no way for a user to share an agent-generated file with a third party without giving them the raw VM URL (which has no expiration or auth).

**Impact:** Users ask their agent to "make me a CSV of my portfolio" and get back a raw VM URL they have to copy-paste into a browser. Or worse, the agent says "I saved the file" with no delivery at all. This is the single largest UX gap in the product.

---

## Industry Research

### Claude Artifacts

**How it works:** When Claude generates substantial standalone content (code, HTML, React components, SVGs, documents), it renders it in a dedicated side panel next to the conversation. The architecture uses a sandboxed iframe hosted on a separate origin (`claudeusercontent.com`) running a Next.js app. Artifacts are rendered with strict Content Security Policy (CSP) rules — only `cdnjs.cloudflare.com` is whitelisted for external resources.

**Rendering pipeline:** The LLM outputs structured artifact blocks (with type metadata like `text/html`, `application/vnd.ant.react`, `image/svg+xml`). The client parses these and renders them in the iframe. React components get full interactivity including hooks and state management. HTML artifacts combine HTML/CSS/JS into single-file applications.

**Download/sharing:** Users can copy artifact code, download the rendered content, or share artifacts via a public URL. Artifacts are stateless between sessions with no persistent storage. The single-file constraint ensures portability — copy the code, save as `.html`, and it runs anywhere.

**Key insight for InstaClaw:** The artifact model works because the LLM output IS the file. In our case, agents create files on disk via tool use, which is a fundamentally different flow. We cannot render artifacts inline in Telegram. But we can adopt the "structured output block" pattern for the dashboard.

*Sources: [Reid Barber — Reverse Engineering Claude Artifacts](https://www.reidbarber.com/blog/reverse-engineering-claude-artifacts), [Albato — Claude Artifacts Guide](https://albato.com/blog/publications/how-to-use-claude-artifacts-guide), [Anthropic Help Center](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them)*

### Devin (Cognition)

**Sandbox architecture:** Devin operates in a sandboxed compute environment with shell, code editor, and browser — essentially a full developer workstation in the cloud. By mid-2025, Cognition expanded to enterprise-ready agentic environments with secure workspaces deployable via SaaS or customer VPC.

**File delivery:** Devin uses a **presigned URL pattern**. The API endpoint `GET /attachments/{session_id}/{filename}` returns a 307 redirect to a presigned URL with 60-second validity. This is the gold standard for secure, temporary file access. Structured output from sessions can be viewed and downloaded from a "Structured output" menu option in the web UI.

**Key insight for InstaClaw:** Devin's presigned URL model (307 redirect to time-limited S3 URL) is the exact pattern we should adopt. It solves security (no permanent public URLs), sharing (links work for anyone within the window), and cleanup (URLs self-expire).

*Sources: [Devin Docs — Download Attachment Files](https://docs.devin.ai/api-reference/attachments/download-attachment-files), [Devin Docs — Structured Output](https://docs.devin.ai/api-reference/v1/structured-output), [Cognition Blog — Devin 2.0](https://cognition.ai/blog/devin-2)*

### Replit Agent

**Architecture:** Replit Agent creates apps from natural language with real-time preview. Deployments are powered by Google Cloud Platform, with apps accessible via `<app-name>.replit.app` URLs. Static deployments serve HTML/CSS/JS from a specified base directory with automatic caching and CDN scaling.

**File access model:** Replit's approach is "the file IS the deployment." When an agent builds an app, the entire filesystem is the deliverable, and it gets a live URL. For static content, files are served directly from the container. For dynamic apps, the server handles requests. Critical limitation: local filesystem writes do not persist across re-deploys.

**Key insight for InstaClaw:** Replit's model of "every project gets a URL" is relevant to our tmp-media approach, but Replit has the advantage of dedicated infrastructure (GCE VMs per user) with proper CDN fronting. Our Caddy `tmp-media/` is a poor man's version of this. The upgrade path is to add expiration, namespacing, and CDN fronting.

*Sources: [Replit Docs — Static Deployments](https://docs.replit.com/cloud-services/deployments/static-deployments), [Replit Blog — Deployments Launch](https://blog.replit.com/deployments-launch), [Replit Deployments Architecture](https://rpltbldrs.com/p/how-do-replit-deployments-work)*

### Base44

**Subdomain infrastructure:** Every Base44 app gets a `yourapp.base44.app` subdomain by default. Custom domains use a CNAME pointing to `base44.onrender.com`, confirming that **Render** powers the hosting layer. Backend functions are serverless TypeScript/JavaScript running on Deno runtime.

**Key insight for InstaClaw:** Base44's approach of unique subdomains per app (backed by Render/Deno) is overkill for file delivery but interesting for the "published outputs" use case — if an agent builds an HTML dashboard, we could potentially serve it at `{agent-name}.instaclaw.io/outputs/{slug}`. This is V3 territory.

*Sources: [Certified Code — Base44 Hosting Infrastructure](https://www.certifiedcode.us/resources/article/where-do-apps-run-in-base44s-hosting-infrastructure), [Base44 Docs — Custom Domain](https://docs.base44.com/Setting-up-your-app/Setting-up-your-custom-domain), [Base44 — Standalone Subdomains](https://base44.com/changelog/feature/standalone-subdomains)*

### Manus AI

**Sandbox architecture:** Manus (acquired by Meta for $2B+) launched Sandbox in January 2026. Each task gets a fully isolated cloud Linux VM with networking, file systems, and browser capabilities. Zero Trust architecture — users and AI have unrestricted root-level permissions within each VM, but operations are containerized with no cross-sandbox leakage.

**File delivery:** Manus outputs are downloadable as Word docs, Excel files, PDFs, PowerPoints, websites, and more — all fully editable. Free users get 7-day file retention; Manus Pro gets 21 days with automatic artifact restoration (upon sandbox recycle, key files are restored to a fresh sandbox). **Shared tasks display only conversation messages and output artifacts — sandbox contents remain invisible to recipients.** Collaborative sessions grant full sandbox access.

**Key insight for InstaClaw:** Manus's distinction between "output artifacts" (shareable) and "sandbox contents" (private) is exactly what we need. Our `~/.openclaw/workspace/` is the sandbox. We need a concept of "delivered artifacts" that are explicitly promoted from workspace to a shareable layer. The retention policy (7 days free / 21 days paid) is also worth adopting.

*Sources: [Manus AI — DataCamp](https://www.datacamp.com/blog/manus-ai), [Manus Sandbox Architecture](https://www.adwaitx.com/meta-manus-sandbox-cloud-ai-execution/), [Manus AI Review — Cybernews](https://cybernews.com/ai-tools/manus-ai-review/)*

### Cursor

**Architecture:** Cursor is a full fork of VS Code with deep AI integration. The Composer mode allows multi-file generation from natural language — the AI plans architecture, generates new files, and edits existing ones simultaneously. Background Agents can test, refactor, and document code autonomously.

**File creation model:** Cursor operates entirely on the local filesystem. Files are created directly in the user's project directory. There is no "delivery" problem because the user's IDE IS the file browser. The AI writes to disk, and the user sees it instantly in the editor tree.

**Key insight for InstaClaw:** Cursor's model is not directly applicable (local IDE vs. remote VM), but the principle of "zero-friction file visibility" is. When our agent creates a file, the user should see it appear instantly — either in Telegram or in the dashboard — without navigating anywhere.

*Sources: [Cursor.com](https://cursor.com/), [Cursor AI Review — Hackceleration](https://hackceleration.com/cursor-review/), [DigitalOcean — Copilot vs Cursor](https://www.digitalocean.com/resources/articles/github-copilot-vs-cursor)*

### Telegram Bot API Deep Dive

The Telegram Bot API provides several methods for file delivery, all of which are available to InstaClaw agents:

**Sending methods:**

| Method | Max Size | Inline Preview | Notes |
|--------|----------|---------------|-------|
| `sendDocument` | 50 MB | No (file attachment) | Any file type. URL upload limited to .PDF and .ZIP only. |
| `sendPhoto` | 10 MB | Yes (inline image) | Compressed by Telegram. Use `sendDocument` for original quality. |
| `sendVideo` | 50 MB | Yes (inline player) | MP4 preferred. `supports_streaming=true` recommended. |
| `sendAudio` | 50 MB | Yes (inline player) | MP3/M4A with metadata display. |
| `sendVoice` | 50 MB (1 MB for inline) | Yes (inline waveform) | OGG format only. >1 MB sent as file. |
| `sendAnimation` | 50 MB | Yes (inline GIF) | GIF/MP4 without audio. |
| `sendMediaGroup` | 50 MB each | Yes | 2-10 photos/videos in album layout. |

**Three ways to provide files:**

1. **file_id** — If already on Telegram servers, pass the ID. No size limits. Instant delivery. Cannot transfer between bots.
2. **URL** — Telegram downloads from URL. For `sendDocument`, only works for .PDF and .ZIP. For `sendPhoto`/`sendVideo`, works with direct image/video URLs.
3. **Multipart upload** — POST the file as multipart/form-data. 10 MB for photos, 50 MB for everything else.

**Critical for InstaClaw:** Our agents run on the same VM as the file. The fastest path is multipart upload via curl (which the motion-graphics skill already does). For the generalized solution, the agent needs:
- The bot token (already in env as `BOT_TOKEN`)
- The chat ID (available from the incoming message context)
- The file path on disk

The missing piece is a **generalized file-send tool** that the agent can invoke instead of raw curl commands.

*Sources: [Telegram Bot API](https://core.telegram.org/bots/api), [grammY File Handling](https://grammy.dev/guide/files), [Telegram Bot SDK — sendDocument](https://telegram-bot-sdk.readme.io/reference/senddocument)*

### OpenClaw Native Capabilities

**Current state (v2026.3.x):**

- **Inbound media:** OpenClaw downloads media from Telegram to `~/.openclaw/media/inbound/` and provides file paths to the agent. Works for compressed photos; documents/files sent as attachments have a known bug where the agent sees `<media:image>` placeholder without the file path (Issue #18577).
- **Outbound media:** OpenClaw supports sending media through the `send` action with channel set to `telegram`. However, this appears to be limited and unreliable — there are documented issues with `sendDocument`/`sendPhoto` failing after version upgrades (Issue #28835).
- **A2A file sharing:** The A2A plugin supports `FilePart` (URI + base64) for agent-to-agent file transfer, with an `a2a_send_file` tool. Not relevant for agent-to-user delivery.
- **File metadata:** v2026.3.2 added preservation of original `file_name` metadata for inbound document/audio/video downloads.

**Gap analysis:** OpenClaw does NOT have a reliable, generalized "send file to user" tool. The `send` action is text-oriented. Agents resort to raw curl calls to the Telegram API, which is fragile and requires the agent to know the bot token and chat ID.

*Sources: [OpenClaw Telegram Docs](https://docs.openclaw.ai/channels/telegram), [OpenClaw GitHub Releases](https://github.com/openclaw/openclaw/releases), [Issue #18577](https://github.com/openclaw/openclaw/issues/18577), [Issue #28835](https://github.com/openclaw/openclaw/issues/28835)*

---

## Gold Standard UX

The ideal file delivery experience for an AI agent platform looks like this:

1. **Agent creates a file** (CSV, HTML page, PDF, image, video) as part of fulfilling a user request.
2. **Agent sends the file inline in the chat** — images render as previews, videos play inline, documents show as downloadable attachments with filename and size. No URL copying. No manual navigation.
3. **User taps to download or share** — one tap to save locally, one tap to forward. The file is the message.
4. **Dashboard shows all delivered files** — a chronological "Artifacts" or "Deliveries" tab shows every file the agent has created, with timestamps, preview thumbnails, and one-click download.
5. **Shareable links** — for files the user wants to share externally (e.g., sending a report to a colleague), a signed URL with configurable expiration (1 hour to 7 days) is generated.
6. **Retention policy** — files persist for a defined period (e.g., 7 days for free tier, 30 days for paid), then are automatically cleaned up.
7. **Zero agent-side complexity** — the agent calls a single tool (e.g., `deliver_file`) with the local path and an optional caption. The platform handles Telegram API calls, MIME detection, thumbnail generation, signed URL creation, and dashboard indexing.

---

## Architecture Options for InstaClaw

### Option 1: Telegram Direct Send + Signed URL API (Recommended V1)

**Description:** Build a generalized file delivery pipeline that (a) sends files directly to users via Telegram Bot API from the VM, and (b) creates time-limited signed URLs for dashboard access and external sharing. No cloud storage required — files stay on the VM.

**How it works end-to-end:**

1. Agent creates a file at any path on the VM (e.g., `~/.openclaw/workspace/report.csv`).
2. Agent calls a new tool: `deliver_file(path="/home/openclaw/.openclaw/workspace/report.csv", caption="Your portfolio report")`.
3. The `deliver_file` tool (a bash script on the VM):
   a. Detects MIME type via `file --mime-type`.
   b. Chooses the right Telegram method (`sendDocument`, `sendPhoto`, `sendVideo`) based on MIME + file size.
   c. Sends via multipart curl to `https://api.telegram.org/bot$BOT_TOKEN/{method}`.
   d. Copies the file to `~/.openclaw/workspace/delivered/{uuid}/{original-filename}` for persistence.
   e. Logs the delivery to `~/memory/delivered-files.json` (uuid, path, filename, mime, size, timestamp, telegram_file_id).
   f. Returns success/failure + Telegram file_id to the agent.
4. Dashboard `/api/vm/files/delivered` endpoint reads `delivered-files.json` and returns the delivery log.
5. Dashboard `/api/vm/files/share` endpoint generates a signed URL: `https://instaclaw.io/f/{token}` that proxies through to the VM file via SSH, with configurable expiration (default 24 hours).
6. A cron job on each VM cleans up `delivered/` files older than the retention period.

**Files to change:**

| File | Change |
|------|--------|
| `instaclaw/lib/ssh.ts` | Add `deliverFile()` function (or new module `instaclaw/lib/file-delivery.ts`) |
| `instaclaw/app/api/vm/files/route.ts` | Add `delivered` action to list delivery history |
| NEW: `instaclaw/app/api/vm/files/share/route.ts` | Signed URL generation endpoint |
| NEW: `instaclaw/app/api/f/[token]/route.ts` | Public signed URL resolver — validates token, proxies file from VM |
| `instaclaw/app/(dashboard)/files/page.tsx` | Add "Delivered" tab showing delivery history with re-download and share buttons |
| `instaclaw/lib/ssh.ts` → `configureOpenClaw()` | Deploy `deliver_file.sh` script to VMs |
| NEW: VM-side script `~/scripts/deliver_file.sh` | The actual delivery script that runs on the VM |
| SOUL.md template in `lib/ssh.ts` | Update file sharing instructions to use `deliver_file` tool |

**Effort estimate:** 3-5 days for a senior engineer.

**Tradeoffs:**
- (+) No new infrastructure (no S3, no CDN, no new servers)
- (+) Files never leave the VM until downloaded — good for security
- (+) Telegram delivery is instant and native
- (+) Signed URLs work for external sharing
- (-) SSH proxy for signed URL downloads adds latency for large files
- (-) VM disk is the storage layer — if VM is destroyed, files are lost
- (-) No CDN caching — each download is a live SSH fetch

### Option 2: Object Storage + CDN (V2)

**Description:** Upload delivered files to Supabase Storage (S3-compatible) with signed URL generation. Decouple file access from VM availability.

**How it works end-to-end:**

1. Agent creates a file and calls `deliver_file` (same as V1).
2. The delivery script on the VM sends to Telegram (same as V1) AND uploads to Supabase Storage via a POST to `https://instaclaw.io/api/vm/files/upload`.
3. The upload endpoint SSHs into the VM, reads the file (base64), and stores it in a Supabase Storage bucket (`delivered-files/{user_id}/{uuid}/{filename}`).
4. A `delivered_files` table in Supabase tracks metadata (id, user_id, vm_id, filename, mime_type, size_bytes, storage_path, telegram_file_id, created_at, expires_at).
5. Signed URLs are generated via Supabase Storage's native signed URL API — no SSH needed for downloads.
6. Dashboard shows delivery history from the database with instant downloads from storage.
7. Retention is handled by a scheduled function that deletes expired files from storage.

**Files to change:**

| File | Change |
|------|--------|
| Everything from Option 1 | Same VM-side delivery + Telegram sending |
| NEW: `instaclaw/app/api/vm/files/upload/route.ts` | Upload endpoint (SSH read + Supabase Storage put) |
| NEW: `instaclaw/supabase/migrations/XXXXXXXX_delivered_files.sql` | New table |
| `instaclaw/app/api/vm/files/share/route.ts` | Generate Supabase Storage signed URLs instead of SSH-proxy tokens |
| `instaclaw/app/(dashboard)/files/page.tsx` | Query delivered_files table for history |

**Effort estimate:** 5-8 days.

**Tradeoffs:**
- (+) Files survive VM destruction
- (+) Fast downloads via Supabase CDN (no SSH latency)
- (+) Native signed URL support with configurable expiration
- (+) Proper database-backed delivery history
- (-) Supabase Storage costs (free tier: 1 GB, then $0.021/GB/month)
- (-) Upload latency (SSH read from VM + write to storage)
- (-) More moving parts to maintain

### Option 3: Full Artifacts System (V3 / Full Vision)

**Description:** Build a first-class "Artifacts" experience: every file the agent creates is automatically indexed, tagged, and made available in a beautiful gallery UI. Includes HTML artifact rendering (Claude-style), shareable public pages, and a Telegram inline keyboard for file management.

**How it works end-to-end:**

1. Everything from V2 (Telegram send + object storage).
2. Agent classifies outputs using structured metadata: `deliver_file(path, caption, type="report|visualization|data|media|code")`.
3. Dashboard gets a dedicated "Artifacts" page with:
   - Card-based gallery with thumbnails
   - Inline HTML rendering (sandboxed iframe, like Claude artifacts)
   - CSV/data preview with table rendering
   - Filter by type, date, size
   - Bulk download as ZIP
   - One-click share with expiration picker
4. Telegram inline keyboard on each delivered file:
   - [Download] [Share Link] [View in Dashboard]
5. Public artifact pages at `https://instaclaw.io/a/{slug}` for sharing — renders HTML artifacts live, provides download for other types.
6. Agent-side file watcher (inotify on `~/.openclaw/workspace/`) auto-detects new files and prompts the agent to deliver them.
7. Per-user subdomain for published artifacts: `{username}.instaclaw.io/artifacts/`.

**Effort estimate:** 3-4 weeks.

**Tradeoffs:**
- (+) Best-in-class UX — competitive with Claude/Manus
- (+) Shareable public artifact pages drive organic growth
- (+) Inline HTML rendering is a differentiator for AI agent platforms
- (-) Significant engineering investment
- (-) HTML rendering requires sandboxing/security hardening
- (-) Subdomain routing adds infrastructure complexity

---

## Phased Rollout

### V1 — Week 1-2: Telegram Direct Send + Signed URLs

**Goal:** Every file the agent creates can be delivered directly in Telegram chat with one tool call.

- [ ] Build `deliver_file.sh` VM-side script
- [ ] Deploy to all VMs via `configureOpenClaw()`
- [ ] Update SOUL.md to teach agents about `deliver_file`
- [ ] Build `/api/vm/files/share` signed URL endpoint
- [ ] Build `/api/f/[token]` public resolver
- [ ] Add "Delivered Files" section to dashboard files page
- [ ] Add cleanup cron to VMs (7-day retention)
- [ ] Test on 1 VM, then fleet rollout

### V2 — Week 3-4: Object Storage + Delivery History

**Goal:** Files persist beyond VM lifecycle, downloads are fast, delivery history is queryable.

- [ ] Create `delivered_files` Supabase table
- [ ] Build upload pipeline (VM -> Supabase Storage)
- [ ] Switch signed URLs to Supabase Storage native
- [ ] Build delivery history API and dashboard UI
- [ ] Add retention policy enforcement (scheduled function)
- [ ] Migrate existing tmp-media files to new system

### V3 — Month 2-3: Full Artifacts Experience

**Goal:** Best-in-class artifact gallery with inline rendering and public sharing.

- [ ] Artifact gallery UI with thumbnails and type filtering
- [ ] Sandboxed HTML rendering (iframe on separate origin)
- [ ] CSV/data table preview
- [ ] Telegram inline keyboard on delivered files
- [ ] Public artifact pages (`/a/{slug}`)
- [ ] Bulk download
- [ ] Per-user artifact subdomain (stretch)

---

## Technical Specification (V1 — Recommended)

### VM-Side: `deliver_file.sh`

```bash
#!/bin/bash
# Usage: deliver_file.sh <file_path> [caption]
# Env required: BOT_TOKEN, CHAT_ID (from last inbound message)
# Outputs: JSON with status, telegram_file_id, delivered_path

set -euo pipefail

FILE_PATH="$1"
CAPTION="${2:-}"
FILENAME=$(basename "$FILE_PATH")
MIME=$(file --mime-type -b "$FILE_PATH")
SIZE=$(stat -c%s "$FILE_PATH" 2>/dev/null || stat -f%z "$FILE_PATH")
UUID=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen)

# Determine Telegram method based on MIME type
case "$MIME" in
  image/*)
    if [ "$SIZE" -le 10485760 ]; then
      METHOD="sendPhoto"
      FILE_FIELD="photo"
    else
      METHOD="sendDocument"
      FILE_FIELD="document"
    fi
    ;;
  video/*)
    METHOD="sendVideo"
    FILE_FIELD="video"
    ;;
  audio/*)
    METHOD="sendAudio"
    FILE_FIELD="audio"
    ;;
  *)
    METHOD="sendDocument"
    FILE_FIELD="document"
    ;;
esac

# Size check
if [ "$SIZE" -gt 52428800 ]; then
  echo '{"ok":false,"error":"File exceeds 50MB Telegram limit","size":'$SIZE'}'
  exit 1
fi

# Send to Telegram
RESPONSE=$(curl -s -X POST \
  -F "chat_id=$CHAT_ID" \
  -F "${FILE_FIELD}=@${FILE_PATH}" \
  -F "caption=${CAPTION}" \
  ${METHOD:+$([ "$METHOD" = "sendVideo" ] && echo '-F "supports_streaming=true"')} \
  "https://api.telegram.org/bot${BOT_TOKEN}/${METHOD}")

TG_OK=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok','false'))" 2>/dev/null || echo "false")

# Archive to delivered/
DELIVERED_DIR="$HOME/.openclaw/workspace/delivered/${UUID}"
mkdir -p "$DELIVERED_DIR"
cp "$FILE_PATH" "$DELIVERED_DIR/$FILENAME"

# Log delivery
DELIVERY_RECORD="{\"uuid\":\"$UUID\",\"filename\":\"$FILENAME\",\"mime\":\"$MIME\",\"size\":$SIZE,\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"telegram_ok\":$TG_OK,\"path\":\"$DELIVERED_DIR/$FILENAME\"}"

LOGFILE="$HOME/memory/delivered-files.json"
if [ -f "$LOGFILE" ]; then
  python3 -c "
import json, sys
log = json.load(open('$LOGFILE'))
log.append($DELIVERY_RECORD)
json.dump(log, open('$LOGFILE','w'), indent=2)
"
else
  echo "[$DELIVERY_RECORD]" > "$LOGFILE"
fi

echo "{\"ok\":true,\"uuid\":\"$UUID\",\"telegram_ok\":$TG_OK,\"method\":\"$METHOD\",\"filename\":\"$FILENAME\",\"size\":$SIZE}"
```

### API: Signed URL Generation

**Endpoint:** `POST /api/vm/files/share`

```typescript
// Request
{
  file: string;          // Path on VM (within workspace)
  expires_in?: number;   // Seconds until expiration (default: 86400 = 24h, max: 604800 = 7d)
}

// Response
{
  url: string;           // https://instaclaw.io/f/{token}
  expires_at: string;    // ISO 8601 timestamp
  token: string;         // Opaque token
}
```

**Token format:** HMAC-SHA256 of `{user_id}:{file_path}:{expires_at}`, base64url-encoded. No database storage needed — the token is self-validating.

**Token validation (at `/api/f/[token]`):**
1. Decode token to extract user_id, file_path, expires_at.
2. Verify HMAC signature against server secret.
3. Check expiration.
4. Look up user's VM from Supabase.
5. SSH into VM, read file, stream to client with appropriate Content-Type and Content-Disposition headers.

### API: Delivery History

**Endpoint:** `GET /api/vm/files/delivered`

```typescript
// Response
{
  deliveries: Array<{
    uuid: string;
    filename: string;
    mime: string;
    size: number;
    timestamp: string;
    telegram_ok: boolean;
    path: string;
  }>;
}
```

Implementation: SSH into user's VM, read `~/memory/delivered-files.json`, return parsed JSON.

### Database Schema (V1 — no new tables)

V1 intentionally avoids new Supabase tables. Delivery metadata lives on the VM in `~/memory/delivered-files.json`. This keeps the implementation simple and avoids schema migrations.

V2 introduces the `delivered_files` table:

```sql
CREATE TABLE delivered_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  vm_id TEXT NOT NULL,
  uuid TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  storage_path TEXT,           -- Supabase Storage path (V2)
  telegram_file_id TEXT,       -- For re-sending without re-upload
  caption TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days'),
  deleted_at TIMESTAMPTZ       -- Soft delete for cleanup
);

CREATE INDEX idx_delivered_files_user ON delivered_files(user_id, created_at DESC);
CREATE INDEX idx_delivered_files_expires ON delivered_files(expires_at) WHERE deleted_at IS NULL;

-- RLS
ALTER TABLE delivered_files ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own deliveries" ON delivered_files
  FOR SELECT USING (auth.uid() = user_id);
```

### Security Model

1. **No public file URLs** — the `tmp-media/` Caddy endpoint should be deprecated in favor of signed URLs.
2. **HMAC-signed tokens** — self-validating, no database lookup needed, expire automatically.
3. **Path traversal prevention** — `deliver_file.sh` validates that the file path is within allowed directories.
4. **Rate limiting** — signed URL generation rate-limited to 20/hour per user.
5. **Size limits** — signed URL downloads capped at 100 MB. Files larger than 50 MB cannot be sent via Telegram.
6. **Audit trail** — all deliveries logged to `~/memory/delivered-files.json` and (V2) to database.

---

## Telegram-Specific UX

### File Delivery Flow (V1)

**User says:** "Make me a CSV of my top 10 holdings"

**Agent flow:**
1. Agent runs analysis, generates `~/workspace/portfolio-top10.csv`
2. Agent calls: `bash ~/scripts/deliver_file.sh ~/workspace/portfolio-top10.csv "Your top 10 holdings by value"`
3. Script sends via `sendDocument` to Telegram
4. User sees a document attachment in chat with filename `portfolio-top10.csv` and caption
5. User taps to download or open
6. Agent confirms: "Sent your portfolio report. You can also find it in your dashboard under Files."

### Telegram Method Selection Matrix

| Scenario | Method | Rationale |
|----------|--------|-----------|
| CSV, JSON, TXT, any document | `sendDocument` | Shows as downloadable file attachment |
| PNG/JPG/WEBP < 10 MB | `sendPhoto` | Renders inline as image in chat |
| PNG/JPG/WEBP >= 10 MB | `sendDocument` | Too large for photo, send as file |
| SVG | `sendDocument` | Telegram doesn't render SVG inline |
| MP4 < 50 MB | `sendVideo` | Inline video player with streaming |
| MP4 >= 50 MB | Compress or split | Hard limit, cannot send |
| PDF | `sendDocument` | Shows with PDF icon, one-tap open |
| HTML page | `sendDocument` + signed URL | Send HTML file + "View live: {url}" |
| Multiple images | `sendMediaGroup` | Album layout, 2-10 photos |

### Telegram Inline Keyboard (V3)

In V3, each delivered file includes an inline keyboard:

```
[Download Again] [Share Link (24h)] [View in Dashboard]
```

This requires the bot to use `reply_markup` with `InlineKeyboardMarkup`. The callback handling would be:
- `download:{uuid}` — re-send the file using stored `telegram_file_id` (instant, no re-upload)
- `share:{uuid}` — generate signed URL, send as text message
- `dashboard:{uuid}` — send deep link to `https://instaclaw.io/dashboard/files?id={uuid}`

### CHAT_ID Discovery

The agent needs the current Telegram chat ID to send files. This is available from:
1. **Incoming message context** — OpenClaw provides `CHAT_ID` in the environment during message handling.
2. **Stored in config** — `~/.openclaw/agents/main/channel-config.json` contains the Telegram chat ID.
3. **Fallback** — `~/memory/telegram-context.json` can store the last-seen chat ID.

The `deliver_file.sh` script should try these sources in order.

---

## Open Questions

1. **OpenClaw native send action** — Should we invest in contributing a `send_file` action to OpenClaw upstream, or continue with the curl-based approach? The curl approach is more reliable today given OpenClaw's documented issues with media sending.

2. **HTML artifact rendering** — For V3, should HTML artifacts be rendered in a sandboxed iframe on `artifacts.instaclaw.io` (separate origin, like Claude) or inline in the dashboard (simpler but riskier)?

3. **tmp-media deprecation timeline** — When can we remove the public Caddy `tmp-media/` endpoint? It needs to stay until V1 is fully deployed to all VMs and agents are retrained.

4. **File size economics** — What is the average file size agents produce? If most files are < 1 MB (CSVs, JSON), the SSH-proxy approach in V1 is fine. If agents routinely produce 10-50 MB videos, we need object storage (V2) sooner.

5. **Telegram file_id reuse** — Telegram assigns a `file_id` to every uploaded file. Storing this allows instant re-delivery without re-upload. Should V1 capture and store `file_id` from the API response?

6. **Multi-channel delivery** — If we add Discord or WhatsApp channels, the delivery script needs to be channel-aware. Should V1 abstract the delivery target, or hardcode Telegram?

7. **Retention policy enforcement** — Is 7 days enough for free tier? Manus uses 7 days free / 21 days Pro. Should delivered files have a different retention than workspace files?

8. **Agent tool registration** — Should `deliver_file` be registered as a formal OpenClaw tool (in the tools config), or remain a bash script the agent invokes via shell? A formal tool would give better error handling and structured output.

9. **Dashboard notification** — When an agent delivers a file, should the dashboard show a real-time notification (via WebSocket or polling)? This would improve the experience for users who have the dashboard open alongside Telegram.

10. **Compression/transcoding** — Should the delivery pipeline automatically compress images > 10 MB or transcode videos to optimize for Telegram? This adds complexity but improves delivery reliability.
