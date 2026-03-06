#!/usr/bin/env python3
"""Higgsfield AI Video — Character persistence & consistency.

Usage:
  python3 higgsfield-character.py create --name "..." --description "..." [--ref-image <url>] [--json]
  python3 higgsfield-character.py list [--json]
  python3 higgsfield-character.py use --name "..." [--json]
  python3 higgsfield-character.py delete --name "..." [--json]

Exit codes: 0=OK, 1=FAIL
"""

import argparse
import json
import sys
import time
from pathlib import Path

# ── Constants ──────────────────────────────────────────────────────────────────
WORKSPACE_DIR = Path.home() / ".openclaw" / "workspace" / "higgsfield"
CHARACTERS_FILE = WORKSPACE_DIR / "characters.json"

# ── Helpers ────────────────────────────────────────────────────────────────────

def load_characters() -> list[dict]:
    if not CHARACTERS_FILE.exists():
        return []
    try:
        return json.loads(CHARACTERS_FILE.read_text())
    except Exception:
        return []


def save_characters(characters: list[dict]) -> None:
    WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)
    CHARACTERS_FILE.write_text(json.dumps(characters, indent=2))


def find_character(name: str) -> dict | None:
    chars = load_characters()
    name_lower = name.lower()
    for c in chars:
        if c.get("name", "").lower() == name_lower:
            return c
    return None


def output(data: dict, as_json: bool = False) -> None:
    if as_json:
        print(json.dumps(data, indent=2))
    else:
        for k, v in data.items():
            print(f"  {k}: {v}")


# ── Commands ───────────────────────────────────────────────────────────────────

def cmd_create(args: argparse.Namespace) -> int:
    """Create a new character profile."""
    name = args.name.strip()
    if not name:
        print("ERROR: Name cannot be empty", file=sys.stderr)
        return 1

    existing = find_character(name)
    if existing:
        print(f"ERROR: Character '{name}' already exists. Delete it first.", file=sys.stderr)
        return 1

    character = {
        "name": name,
        "description": args.description or "",
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "ref_images": [],
        "elements_refs": [],
        "lora_refs": [],
        "style_notes": args.style or "",
        "generation_history": [],
    }

    if args.ref_image:
        character["ref_images"].append({
            "url": args.ref_image,
            "added_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "purpose": "primary_reference",
        })

    if args.elements_ref:
        character["elements_refs"].append(args.elements_ref)

    if args.lora_ref:
        character["lora_refs"].append(args.lora_ref)

    chars = load_characters()
    chars.append(character)
    save_characters(chars)

    result = {
        "status": "created",
        "name": name,
        "ref_images": len(character["ref_images"]),
        "elements_refs": len(character["elements_refs"]),
        "lora_refs": len(character["lora_refs"]),
    }
    output(result, args.json)
    return 0


def cmd_list(args: argparse.Namespace) -> int:
    """List all characters."""
    chars = load_characters()
    if not chars:
        result = {"status": "empty", "message": "No characters defined yet."}
        output(result, args.json)
        return 0

    if args.json:
        print(json.dumps(chars, indent=2))
    else:
        print(f"Characters ({len(chars)}):\n")
        for c in chars:
            print(f"  {c['name']}")
            if c.get("description"):
                print(f"    Description: {c['description'][:80]}")
            print(f"    Ref images: {len(c.get('ref_images', []))}")
            print(f"    Elements refs: {len(c.get('elements_refs', []))}")
            print(f"    LoRA refs: {len(c.get('lora_refs', []))}")
            print(f"    Created: {c.get('created_at', 'unknown')}")
            gen_count = len(c.get("generation_history", []))
            if gen_count:
                print(f"    Generations: {gen_count}")
            print()
    return 0


def cmd_use(args: argparse.Namespace) -> int:
    """Get character details for use in generation."""
    char = find_character(args.name)
    if not char:
        print(f"ERROR: Character '{args.name}' not found.", file=sys.stderr)
        return 1

    # Build generation hints
    hints = {
        "name": char["name"],
        "description": char.get("description", ""),
        "prompt_prefix": "",
        "elements_refs": char.get("elements_refs", []),
        "lora_refs": char.get("lora_refs", []),
        "ref_images": [img["url"] for img in char.get("ref_images", [])],
        "style_notes": char.get("style_notes", ""),
    }

    # Build a prompt prefix for character consistency
    parts = []
    if char.get("description"):
        parts.append(char["description"])
    if char.get("style_notes"):
        parts.append(f"Style: {char['style_notes']}")
    hints["prompt_prefix"] = ". ".join(parts)

    output(hints, args.json)
    return 0


def cmd_delete(args: argparse.Namespace) -> int:
    """Delete a character."""
    chars = load_characters()
    name_lower = args.name.lower()
    new_chars = [c for c in chars if c.get("name", "").lower() != name_lower]

    if len(new_chars) == len(chars):
        print(f"ERROR: Character '{args.name}' not found.", file=sys.stderr)
        return 1

    save_characters(new_chars)
    result = {"status": "deleted", "name": args.name}
    output(result, args.json)
    return 0


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Higgsfield AI Video — Character Management")
    sub = parser.add_subparsers(dest="command", required=True)

    p_create = sub.add_parser("create", help="Create a character")
    p_create.add_argument("--name", required=True, help="Character name")
    p_create.add_argument("--description", help="Character description")
    p_create.add_argument("--ref-image", help="Reference image URL")
    p_create.add_argument("--elements-ref", help="Kling Elements reference ID")
    p_create.add_argument("--lora-ref", help="LoRA reference ID")
    p_create.add_argument("--style", help="Style notes")
    p_create.add_argument("--json", action="store_true", help="JSON output")

    p_list = sub.add_parser("list", help="List characters")
    p_list.add_argument("--json", action="store_true", help="JSON output")

    p_use = sub.add_parser("use", help="Get character for generation")
    p_use.add_argument("--name", required=True, help="Character name")
    p_use.add_argument("--json", action="store_true", help="JSON output")

    p_del = sub.add_parser("delete", help="Delete a character")
    p_del.add_argument("--name", required=True, help="Character name")
    p_del.add_argument("--json", action="store_true", help="JSON output")

    args = parser.parse_args()
    cmd_map = {
        "create": cmd_create,
        "list": cmd_list,
        "use": cmd_use,
        "delete": cmd_delete,
    }
    sys.exit(cmd_map[args.command](args))


if __name__ == "__main__":
    main()
