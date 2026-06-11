#!/usr/bin/env python3
"""Higgsfield Cloud — AI video & image generation (Cloud-rail).

The Cloud-rail successor to the Muapi `higgsfield-video` skill. Talks to OUR
gateway (`/api/gateway/higgsfield`), which meters + gates spend in our own
video-credits.

Delivery model (M5 fix — async video, sync image):
  - VIDEO is SUBMIT-ONLY. The script submits and returns immediately ("rendering
    ~2-5 min"); it does NOT block-poll (that loop was M5 — a multi-minute bash
    call the tool backgrounds, poisoning the session). The gate's webhook delivers
    the finished clip to the chat_id signed at submit, server-side — surviving the
    turn ending and even a VM restart mid-render. Pass --chat-id for video.
  - IMAGE is SYNCHRONOUS: a short, bounded poll returns the URL so the agent can
    deliver it or chain it into a video. No long block; re-checkable if slow.

Usage:
  higgsfield-cloud.py generate --kind video|image --prompt "..." \
       [--quality fast|hq|premium] [--image-url <url>] [--model <slug>] \
       [--duration N] [--chat-id <id>] [--max-wait 60] [--json]
  higgsfield-cloud.py status --request-id <id> [--json]

Exit codes: 0=submitted/completed, 1=failed/nsfw, 2=image still rendering (re-check),
            3=blocked/unsupported/insufficient/busy/no_chat_id, 4=error.

Auth + endpoint:
  GATEWAY_TOKEN from ~/.openclaw/.env (same per-VM token the other proxies use).
  Gate base = ${INSTACLAW_GATEWAY_BASE:-https://instaclaw.io}/api/gateway/higgsfield.
"""

import argparse
import json
import os
import sys
import time
import urllib.request
import urllib.error
import urllib.parse

# ── Cloud model allowlist (MUST match the gate's lib/higgsfield-models.ts keys;
#    the gate is the source of truth + validates — a drift surfaces as a 400). ──
SLUG_IMAGE = "higgsfield-ai/soul/standard"
SLUG_DOP_LITE = "higgsfield-ai/dop/lite"
SLUG_DOP_TURBO = "higgsfield-ai/dop/turbo"
SLUG_DOP_STANDARD = "higgsfield-ai/dop/standard"
SLUG_KLING_21_I2V = "kling-video/v2.1/pro/image-to-video"
SLUG_KLING_26_I2V = "kling-video/v2.6/pro/image-to-video"
SLUG_KLING_30_I2V = "kling-video/v3.0/pro/image-to-video"
SLUG_KLING_30_T2V = "kling-video/v3.0/pro/text-to-video"

ALLOWLISTED = {
    SLUG_IMAGE, SLUG_DOP_LITE, SLUG_DOP_TURBO, SLUG_DOP_STANDARD,
    SLUG_KLING_21_I2V, SLUG_KLING_26_I2V, SLUG_KLING_30_I2V, SLUG_KLING_30_T2V,
}

# Slugs that take a PROMPT ONLY (no source image). The gate forwards aspect_ratio
# for these (default 16:9 — the legacy crab's cinematic format). Everything else
# in the video ladder is image→video and needs a source frame.
TEXT2VIDEO = {SLUG_KLING_30_T2V}

# Friendly names / aliases the agent (or a user) might pass → canonical slug.
# MODEL NAMES ONLY — quality words ("premium"/"hq"/"fast") are NOT aliases; they
# are the --quality ladder, resolved BY INPUT in resolve_model below. (Mixing the
# two is how "premium" used to hard-pin one slug regardless of text-vs-image
# input — the bug this rewrite closes.)
ALIASES = {
    "soul": SLUG_IMAGE, "image": SLUG_IMAGE, "img": SLUG_IMAGE,
    "lite": SLUG_DOP_LITE, "dop-lite": SLUG_DOP_LITE, "dop_lite": SLUG_DOP_LITE,
    "turbo": SLUG_DOP_TURBO, "dop-turbo": SLUG_DOP_TURBO,
    "dop-standard": SLUG_DOP_STANDARD, "dop_standard": SLUG_DOP_STANDARD,
    "kling": SLUG_KLING_30_I2V, "kling-2.1": SLUG_KLING_21_I2V,
    "kling-2.6": SLUG_KLING_26_I2V, "kling-3.0": SLUG_KLING_30_I2V,
    "kling-3.0-t2v": SLUG_KLING_30_T2V, "text-to-video": SLUG_KLING_30_T2V,
}

# Models that EXIST upstream but are NOT allowlisted (unmeasured cost — the gate
# would reject them; we reject locally first with clear copy). Tell the user
# they're not available YET, don't pretend they work.
UNSUPPORTED = {
    "seedance", "veo", "veo3", "veo-3", "sora", "wan", "hailuo", "minimax",
    "runway", "gen3", "pika", "luma", "first-last-frame", "speak", "lipsync",
}


def resolve_model(kind, quality=None, explicit=None, has_image=False):
    """Natural-request → Cloud slug. Pure + deterministic (Rule-31 contract).

    Returns (slug, None) on success, or (None, reason) where reason is a short,
    user-safe explanation.

    Routing is BY INPUT (the 2026-06-11 wiring): the video quality ladder splits
    on whether the caller supplied a source image.
      • text-only (no image)  → text→video. kling-3.0 t2v is the cinematic bar
        (the legacy muapi crab's exact mode — full-scene generation, native 16:9,
        full motion). It's our only t2v slug, so every text-only request resolves
        to it: premium IS the default for text-only. This is the fleet's first
        video experience, on purpose.
      • user/agent image (i2v) → image→video ladder: premium → kling-3.0 i2v,
        standard → kling-2.6 i2v, fast → dop-lite. KNOWN LIMIT: a soul source frame
        caps at ~4:3 landscape (1536x1152 @1080p), so an i2v clip is not true 16:9
        — for cinematic widescreen, prefer text-only (t2v). Documented in SKILL.md.

    explicit model/alias still wins (literal slug); the UNSUPPORTED set fails
    CLOSED with clear copy.
    """
    # 1. Explicit model/alias wins — literal slug, validated. (Power-user escape
    #    hatch: an explicit i2v alias with no image will fall to needs_image in
    #    cmd_generate — that's intended; explicit means explicit.)
    if explicit:
        e = explicit.strip().lower()
        if e in UNSUPPORTED:
            return (None, f"'{explicit}' isn't available yet. Try a standard clip or image instead.")
        if e in ALIASES:
            return (ALIASES[e], None)
        if explicit in ALLOWLISTED:  # someone passed a full canonical slug
            return (explicit, None)
        # Unknown explicit name → fall through to kind/quality defaults (don't hard-fail).

    # 2. Image vs video.
    k = (kind or "").strip().lower()
    if k in ("image", "img", "photo", "picture"):
        return (SLUG_IMAGE, None)
    if k not in ("video", "clip", "animation", "vid"):
        return (None, "Tell me whether you want an image or a video.")

    # 3. Video quality ladder — routed by INPUT.
    q = (quality or "").strip().lower()
    if has_image:
        # image→video: animate the supplied source frame.
        if q in ("standard", "hq", "high", "cinematic"):
            return (SLUG_KLING_26_I2V, None)
        if q in ("fast", "lite", "quick", "cheap"):
            return (SLUG_DOP_LITE, None)
        # premium / best / unspecified → the kling-3.0 bar
        return (SLUG_KLING_30_I2V, None)
    # text-only → text→video. Only one t2v slug exists (the cinematic bar), so
    # every quality lands there. premium IS the default for text-only.
    return (SLUG_KLING_30_T2V, None)


# ── Gate plumbing ───────────────────────────────────────────────────────────

def _load_env_var(name):
    path = os.path.expanduser("~/.openclaw/.env")
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if line.startswith(f"{name}="):
                    return line[len(name) + 1:].strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return os.environ.get(name)


def _gate_base():
    # _load_env_var reads ~/.openclaw/.env first, then falls back to os.environ —
    # so the canary's branch-alias base (set in .env) is honored even if the skill
    # subprocess doesn't inherit it from the gateway's process env. Prod default
    # stays instaclaw.io when neither is set.
    base = (_load_env_var("INSTACLAW_GATEWAY_BASE") or "https://instaclaw.io").rstrip("/")
    return base + "/api/gateway/higgsfield"


def _gate_call(action, token, params=None, body=None, timeout=120):
    url = f"{_gate_base()}?action={action}"
    if params:
        for k, v in params.items():
            url += f"&{k}={urllib.parse.quote(str(v))}"
    data = json.dumps(body).encode() if body is not None else b"{}"
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("x-gateway-token", token)
    # Canary-only: Vercel Deployment-Protection bypass so vm-050 can reach the
    # dark branch-alias preview gate while it stays SSO-walled from the public.
    # Read from ~/.openclaw/.env (HIGGSFIELD_GATE_BYPASS); absent in prod (the
    # prod gate isn't protection-gated), so this is a no-op there. Never hardcode.
    bypass = _load_env_var("HIGGSFIELD_GATE_BYPASS")
    if bypass:
        req.add_header("x-vercel-protection-bypass", bypass)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or "{}")
        except Exception:
            return e.code, {}
    except Exception as e:
        return 0, {"error": "network", "detail": str(e)}


def _out(data, as_json):
    if as_json:
        print(json.dumps(data, indent=2))
    else:
        for k, v in data.items():
            print(f"  {k}: {v}")


# ── Commands ──────────────────────────────────────────────────────────────

def cmd_generate(args):
    token = _load_env_var("GATEWAY_TOKEN")
    if not token:
        print("ERROR: no GATEWAY_TOKEN configured", file=sys.stderr)
        return 4

    slug, reason = resolve_model(args.kind, args.quality, args.model, has_image=bool(args.image_url))
    if not slug:
        _out({"status": "blocked", "message": reason}, args.json)
        return 3

    is_image = slug == SLUG_IMAGE
    is_text2video = slug in TEXT2VIDEO
    # i2v models animate a source frame → they NEED an image. t2v + soul-image are
    # self-sufficient (prompt only). Text-only video routes to t2v (resolve_model),
    # so this needs_image branch only fires for an explicit i2v alias with no image.
    needs_source = (not is_image) and (not is_text2video)
    if needs_source and not args.image_url:
        _out({
            "status": "needs_image",
            "message": "That model animates a source image. Either pass --image-url, "
                       "or just describe the video with no image and I'll generate the "
                       "whole scene (text-to-video).",
        }, args.json)
        return 3

    body = {"endpoint": slug, "prompt": args.prompt}
    if needs_source:
        body["image_url"] = args.image_url
    if is_text2video:
        # The legacy crab's format. The gate validates aspect_ratio against
        # /^\d+:\d+$/ and forwards it; t2v generates the full scene natively 16:9.
        body["aspect_ratio"] = "16:9"
    if args.duration is not None:
        body["duration"] = args.duration
    # VIDEO is async (submit → webhook delivers). Sign the chat_id so the gate's
    # webhook can push the finished clip server-side — this survives the turn
    # ending and even a VM restart mid-render. The chat_id comes from the agent
    # (the conversation metadata it sees, "telegram:<id>"); we strip the prefix.
    # IMAGE stays synchronous (the agent needs the URL to deliver or chain into a
    # video), carries no chat_id, and the webhook settles-only for it.
    if not is_image and args.chat_id:
        body["chat_id"] = str(args.chat_id).replace("telegram:", "").strip()

    status, resp = _gate_call("create", token, body=body)
    if status in (402, 400):
        # 402 = free_exhausted / insufficient_balance; 400 = bad params / unsupported.
        # Surface the gate's own user-safe message.
        _out({"status": "blocked", "reason": resp.get("error"), "message": resp.get("message")}, args.json)
        return 3
    if status in (429, 503):
        # M2: busy / rate-limited / at-capacity — distinct from a hard error.
        _out({"status": "busy", "message": "The video service is busy right now. Please try again in a few minutes."}, args.json)
        return 3
    if status != 200 or not resp.get("request_id"):
        _out({"status": "error", "message": resp.get("message") or "Couldn't start generation."}, args.json)
        return 4

    request_id = resp["request_id"]

    # ── VIDEO: SUBMIT-ONLY. No block-poll (that loop was M5 — a multi-minute bash
    #    call the tool backgrounds, leaving a stuck "still running" + a poisoned
    #    session). The gate's webhook delivers the finished clip to the signed
    #    chat_id server-side; the agent just tells the user it's rendering. ──
    if not is_image:
        # The gate may resolve a delivery target server-side (A2: vm.telegram_chat_id)
        # even when the agent didn't pass one; trust resp.delivery if present.
        has_target = bool(body.get("chat_id")) or resp.get("delivery") == "webhook"
        if not has_target:
            _out({"status": "no_chat_id", "request_id": request_id, "model": slug,
                  "message": "Submitted, but I have no delivery target — pass --chat-id "
                             "(the chat id from the conversation metadata) so I can send the video."}, args.json)
            return 0
        _out({"status": "submitted", "request_id": request_id, "model": slug,
              "message": "Rendering now — usually 2 to 5 minutes. I'll send the video here the "
                         "moment it's ready (you don't need to do anything)."}, args.json)
        return 0

    # ── IMAGE: short, bounded SYNC poll (images finish in seconds). Returns the
    #    URL so the agent can deliver it or chain it into a video. Capped well
    #    under any tool-background threshold — never a long block; if it's slow,
    #    hand back a re-checkable handle instead of waiting. ──
    deadline = time.time() + min(args.max_wait or 60, 90)
    err_streak = 0  # M2: distinguish a busy/rate-limited service from a slow job
    while time.time() < deadline:
        time.sleep(5)
        s, st = _gate_call("status", token, params={"request_id": request_id})
        upstream_err = s != 200 or bool(st.get("http"))
        if s == 200 and not st.get("http") and st.get("done"):
            if st.get("ok") and st.get("video_url"):
                _out({"status": "completed", "request_id": request_id, "url": st["video_url"], "model": slug}, args.json)
                return 0
            _out({"status": st.get("status", "failed"), "request_id": request_id,
                  "message": "That image didn't render. Want to tweak it and try again?"}, args.json)
            return 1
        if upstream_err:
            err_streak += 1
            if err_streak >= 4:
                _out({"status": "busy", "request_id": request_id,
                      "message": "The image service is busy right now. Please try again in a few moments."}, args.json)
                return 3
        else:
            err_streak = 0
    _out({"status": "rendering", "request_id": request_id,
          "message": "Still creating the image — re-check in a few seconds with: "
                     "status --request-id " + request_id}, args.json)
    return 2


def cmd_status(args):
    token = _load_env_var("GATEWAY_TOKEN")
    if not token:
        print("ERROR: no GATEWAY_TOKEN configured", file=sys.stderr)
        return 4
    s, st = _gate_call("status", token, params={"request_id": args.request_id})
    if s in (429, 503):
        _out({"status": "busy", "message": "The video service is busy right now. Please try again in a few minutes."}, args.json)
        return 3
    if s != 200:
        _out({"status": "error", "http": s}, args.json)
        return 4
    _out(st, args.json)
    if st.get("done"):
        return 0 if st.get("ok") else 1
    return 2


def main():
    p = argparse.ArgumentParser(description="Higgsfield Cloud — video & image (agent-poll)")
    sub = p.add_subparsers(dest="command", required=True)

    g = sub.add_parser("generate", help="Generate + poll to completion")
    g.add_argument("--kind", help="video | image")
    g.add_argument("--prompt", required=True)
    g.add_argument("--quality", help="fast | hq | premium")
    g.add_argument("--image-url", help="source image for video (image→video)")
    g.add_argument("--model", help="explicit model/alias (overrides kind/quality)")
    g.add_argument("--duration", type=int, help="seconds (Kling only honors 10)")
    g.add_argument("--chat-id", dest="chat_id",
                   help="VIDEO delivery target — the chat id from the conversation "
                        "metadata (e.g. 5918081163 or telegram:5918081163). REQUIRED for "
                        "video so the gate's webhook can send the finished clip here.")
    g.add_argument("--max-wait", type=int, default=60, help="IMAGE sync-poll cap seconds (video is submit-only)")
    g.add_argument("--submit-only", action="store_true", help="(video is always submit-only now)")
    g.add_argument("--json", action="store_true")

    s = sub.add_parser("status", help="Check a request's status")
    s.add_argument("--request-id", required=True)
    s.add_argument("--json", action="store_true")

    args = p.parse_args()
    sys.exit({"generate": cmd_generate, "status": cmd_status}[args.command](args))


if __name__ == "__main__":
    main()
