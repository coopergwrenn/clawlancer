#!/usr/bin/env python3
"""Higgsfield Cloud — AI video & image generation (Cloud-rail, agent-poll).

The Cloud-rail successor to the Muapi `higgsfield-video` skill. Talks to OUR
gateway (`/api/gateway/higgsfield`), which meters + gates spend in our own
video-credits. The agent submits, the script polls to completion (Option B —
agent-poll delivery: the agent is in the conversation, so it delivers the result
by replying; no chat_id plumbing needed), then the agent sends the clip/image.

Usage:
  higgsfield-cloud.py generate --kind video|image --prompt "..." \
       [--quality fast|hq|premium] [--image-url <url>] [--model <slug>] \
       [--duration N] [--max-wait 480] [--json]
  higgsfield-cloud.py status --request-id <id> [--json]

Exit codes: 0=completed (deliver it), 1=failed/nsfw, 2=timeout (still rendering),
            3=blocked/unsupported/insufficient (tell the user), 4=error.

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
SLUG_KLING = "kling-video/v2.1/pro/image-to-video"

ALLOWLISTED = {SLUG_IMAGE, SLUG_DOP_LITE, SLUG_DOP_TURBO, SLUG_DOP_STANDARD, SLUG_KLING}

# Friendly names / aliases the agent (or a user) might pass → canonical slug.
ALIASES = {
    "soul": SLUG_IMAGE, "image": SLUG_IMAGE, "img": SLUG_IMAGE,
    "lite": SLUG_DOP_LITE, "dop-lite": SLUG_DOP_LITE, "dop_lite": SLUG_DOP_LITE,
    "turbo": SLUG_DOP_TURBO, "dop-turbo": SLUG_DOP_TURBO,
    "standard": SLUG_DOP_STANDARD, "dop-standard": SLUG_DOP_STANDARD, "hq": SLUG_DOP_STANDARD,
    "kling": SLUG_KLING, "premium": SLUG_KLING,
}

# Models that EXIST upstream but are NOT allowlisted (unmeasured cost — the gate
# would reject them; we reject locally first with clear copy). Tell the user
# they're not available YET, don't pretend they work.
UNSUPPORTED = {
    "seedance", "veo", "veo3", "veo-3", "sora", "wan", "hailuo", "minimax",
    "runway", "gen3", "pika", "luma", "first-last-frame", "speak", "lipsync",
}


def resolve_model(kind, quality=None, explicit=None):
    """Natural-request → Cloud slug. Pure + deterministic (Rule-31 contract).

    Returns (slug, None) on success, or (None, reason) where reason is a short,
    user-safe explanation. Discriminating: image vs video, the quality ladder,
    explicit aliases, and an UNSUPPORTED set that fails CLOSED with clear copy.
    """
    # 1. Explicit model/alias wins — but validate it.
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

    # 3. Video quality ladder. Default = lite (cheapest + fastest + free-allowance).
    q = (quality or "").strip().lower()
    if q in ("premium", "best", "long", "longer", "10s", "kling"):
        return (SLUG_KLING, None)
    if q in ("hq", "high", "standard", "cinematic"):
        return (SLUG_DOP_STANDARD, None)
    # fast / unspecified / anything else → the default
    return (SLUG_DOP_LITE, None)


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
    base = (os.environ.get("INSTACLAW_GATEWAY_BASE") or "https://instaclaw.io").rstrip("/")
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

    slug, reason = resolve_model(args.kind, args.quality, args.model)
    if not slug:
        _out({"status": "blocked", "message": reason}, args.json)
        return 3

    is_image = slug == SLUG_IMAGE
    if not is_image and not args.image_url:
        # All video models are image→video — they need a source image. Tell the
        # agent to generate a base image first (image kind) then animate it.
        _out({
            "status": "needs_image",
            "message": "Video needs a source image. Generate an image first "
                       "(--kind image), then animate it by passing its URL as --image-url.",
        }, args.json)
        return 3

    body = {"endpoint": slug, "prompt": args.prompt}
    if not is_image:
        body["image_url"] = args.image_url
    if args.duration is not None:
        body["duration"] = args.duration

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
    if args.submit_only:
        _out({"status": "submitted", "request_id": request_id, "model": slug}, args.json)
        return 0

    # Block-poll to completion (Option B). The agent's single call returns the
    # final result; it then delivers in-conversation.
    deadline = time.time() + (args.max_wait or 480)
    err_streak = 0  # M2: distinguish a busy/rate-limited service from a slow job
    while time.time() < deadline:
        time.sleep(15)
        s, st = _gate_call("status", token, params={"request_id": request_id})
        # An upstream error = our gate call wasn't 200, OR the gate proxied a
        # non-ok Higgsfield response (it returns {http:<code>} then).
        upstream_err = s != 200 or bool(st.get("http"))
        if s == 200 and not st.get("http") and st.get("done"):
            if st.get("ok") and st.get("video_url"):
                _out({"status": "completed", "request_id": request_id, "url": st["video_url"], "model": slug}, args.json)
                return 0
            _out({"status": st.get("status", "failed"), "request_id": request_id,
                  "message": "That one didn't render. Want to tweak it and try again?"}, args.json)
            return 1
        if upstream_err:
            err_streak += 1
            if err_streak >= 4:  # ~1 min of consecutive 429/5xx → not a slow job, the service is busy
                _out({"status": "busy", "request_id": request_id,
                      "message": "The video service is busy right now. Please try again in a few minutes."}, args.json)
                return 3
        else:
            err_streak = 0  # a clean in-progress poll resets the streak
    _out({"status": "timeout", "request_id": request_id,
          "message": "Still rendering. Check again in a moment with `status`."}, args.json)
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
    g.add_argument("--max-wait", type=int, default=480, help="poll budget seconds")
    g.add_argument("--submit-only", action="store_true", help="submit, don't block-poll")
    g.add_argument("--json", action="store_true")

    s = sub.add_parser("status", help="Check a request's status")
    s.add_argument("--request-id", required=True)
    s.add_argument("--json", action="store_true")

    args = p.parse_args()
    sys.exit({"generate": cmd_generate, "status": cmd_status}[args.command](args))


if __name__ == "__main__":
    main()
