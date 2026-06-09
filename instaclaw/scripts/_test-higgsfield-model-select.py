#!/usr/bin/env python3
"""Discriminating guard for higgsfield-cloud resolve_model (G8, Rule 31).

The natural-request → Cloud-slug mapping is contract-shaped: a wrong slug means
the user gets the wrong model (or a gate 400). These assertions are DISCRIMINATING
— they pin the exact slug AND assert the wrong ones are NOT returned, so a sloppy
mapping (e.g. premium falling through to lite, or an unsupported model leaking a
slug) fails loudly.

Run: python3 scripts/_test-higgsfield-model-select.py
Exit 0 = all pass, 1 = a failure.
"""
import importlib.util
import os
import sys

# The skill script is hyphenated (skill convention) → load via importlib.
_path = os.path.join(os.path.dirname(__file__), "..", "skills", "higgsfield-cloud", "scripts", "higgsfield-cloud.py")
_spec = importlib.util.spec_from_file_location("higgsfield_cloud", _path)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
resolve_model = _mod.resolve_model
SLUG_IMAGE = _mod.SLUG_IMAGE
SLUG_DOP_LITE = _mod.SLUG_DOP_LITE
SLUG_DOP_TURBO = _mod.SLUG_DOP_TURBO
SLUG_DOP_STANDARD = _mod.SLUG_DOP_STANDARD
SLUG_KLING = _mod.SLUG_KLING
ALLOWLISTED = _mod.ALLOWLISTED

_p = 0
_f = 0


def ok(name, cond):
    global _p, _f
    if cond:
        _p += 1
        print(f"  PASS  {name}")
    else:
        _f += 1
        print(f"  FAIL  {name}")


def slug(kind=None, quality=None, explicit=None):
    s, _ = resolve_model(kind, quality, explicit)
    return s


def blocked(kind=None, quality=None, explicit=None):
    s, reason = resolve_model(kind, quality, explicit)
    return s is None and bool(reason)


print("== higgsfield-cloud resolve_model (G8) ==")

# images
ok("image kind → soul", slug(kind="image") == SLUG_IMAGE)
ok("'photo' → soul", slug(kind="photo") == SLUG_IMAGE)
ok("explicit 'soul' → soul", slug(explicit="soul") == SLUG_IMAGE)
ok("image is NOT a video slug", slug(kind="image") not in (SLUG_DOP_LITE, SLUG_KLING))

# video quality ladder — DISCRIMINATING (exact + not-the-others)
ok("video default → dop/lite", slug(kind="video") == SLUG_DOP_LITE)
ok("video default is NOT kling/standard", slug(kind="video") not in (SLUG_KLING, SLUG_DOP_STANDARD))
ok("video hq → dop/standard", slug(kind="video", quality="hq") == SLUG_DOP_STANDARD)
ok("video hq is NOT lite", slug(kind="video", quality="hq") != SLUG_DOP_LITE)
ok("video premium → kling", slug(kind="video", quality="premium") == SLUG_KLING)
ok("video premium is NOT lite (the sloppy-fallthrough trap)", slug(kind="video", quality="premium") != SLUG_DOP_LITE)
ok("video 'long'/'10s' → kling", slug(kind="video", quality="long") == SLUG_KLING and slug(kind="video", quality="10s") == SLUG_KLING)
ok("video 'cinematic' → dop/standard", slug(kind="video", quality="cinematic") == SLUG_DOP_STANDARD)

# explicit aliases
ok("explicit 'kling' → kling", slug(explicit="kling") == SLUG_KLING)
ok("explicit 'lite' → dop/lite", slug(explicit="lite") == SLUG_DOP_LITE)
ok("explicit 'turbo' → dop/turbo (allowed, not surfaced)", slug(explicit="turbo") == SLUG_DOP_TURBO)
ok("explicit 'hq' → dop/standard", slug(explicit="hq") == SLUG_DOP_STANDARD)
ok("explicit canonical slug passes through", slug(explicit=SLUG_KLING) == SLUG_KLING)

# case-insensitivity
ok("'PREMIUM' (caps) → kling", slug(kind="video", quality="PREMIUM") == SLUG_KLING)
ok("'Image' (caps) → soul", slug(kind="Image") == SLUG_IMAGE)

# UNSUPPORTED — must fail CLOSED, never leak a slug
ok("seedance → blocked (no slug)", blocked(explicit="seedance"))
ok("veo → blocked", blocked(explicit="veo"))
ok("sora → blocked", blocked(explicit="sora"))
ok("wan → blocked", blocked(explicit="wan"))
ok("runway → blocked", blocked(explicit="runway"))
ok("first-last-frame → blocked", blocked(explicit="first-last-frame"))
ok("speak/lipsync → blocked", blocked(explicit="speak") and blocked(explicit="lipsync"))
ok("unsupported NEVER returns an allowlisted slug", slug(explicit="seedance") not in ALLOWLISTED and slug(explicit="veo") not in ALLOWLISTED)

# ambiguity / robustness
ok("no kind, no model → blocked (ask image-or-video)", blocked())
ok("unknown explicit + video kind → falls to default (not a hard fail)", slug(kind="video", explicit="zzgarbage") == SLUG_DOP_LITE)
ok("unknown explicit + image kind → soul", slug(kind="image", explicit="zzgarbage") == SLUG_IMAGE)

# every resolved slug is actually allowlisted (no typos vs the gate SoT)
for case in [("image", None, None), ("video", None, None), ("video", "hq", None), ("video", "premium", None), (None, None, "turbo")]:
    s = slug(*case)
    ok(f"resolved slug is allowlisted: {case} → {s}", s in ALLOWLISTED)

print(f"\n== {_p} passed, {_f} failed ==")
sys.exit(1 if _f else 0)
