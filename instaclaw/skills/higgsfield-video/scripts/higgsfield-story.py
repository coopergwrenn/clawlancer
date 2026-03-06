#!/usr/bin/env python3
"""Higgsfield AI Video — Multi-scene story pipeline.

Usage:
  python3 higgsfield-story.py plan --outline "..." [--scenes N] [--json]
  python3 higgsfield-story.py generate --plan-file <path> [--model kling-3.0] [--json]
  python3 higgsfield-story.py assemble --plan-file <path> [--output <path>] [--json]
  python3 higgsfield-story.py status --plan-file <path> [--json]

Exit codes: 0=OK, 1=FAIL, 2=BLOCK
"""

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

# ── Constants ──────────────────────────────────────────────────────────────────
WORKSPACE_DIR = Path.home() / ".openclaw" / "workspace" / "higgsfield"
STORIES_DIR = WORKSPACE_DIR / "stories"
SCRIPTS_DIR = Path(__file__).parent

# ── Helpers ────────────────────────────────────────────────────────────────────

def output(data: dict, as_json: bool = False) -> None:
    if as_json:
        print(json.dumps(data, indent=2))
    else:
        for k, v in data.items():
            if isinstance(v, list):
                print(f"  {k}:")
                for item in v:
                    print(f"    - {item}")
            else:
                print(f"  {k}: {v}")


def run_generate(args_list: list[str]) -> dict:
    """Run higgsfield-generate.py with given args, return parsed JSON."""
    cmd = [sys.executable, str(SCRIPTS_DIR / "higgsfield-generate.py")] + args_list + ["--json"]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if result.returncode != 0:
        return {"error": result.stderr.strip() or f"Exit code {result.returncode}"}
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return {"error": f"Invalid JSON output: {result.stdout[:200]}"}


# ── Commands ───────────────────────────────────────────────────────────────────

def cmd_plan(args: argparse.Namespace) -> int:
    """Create a scene plan from an outline."""
    num_scenes = args.scenes or 3

    # Create a story plan structure
    story_id = f"story_{int(time.time())}"
    plan = {
        "story_id": story_id,
        "outline": args.outline,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "num_scenes": num_scenes,
        "model": args.model or "kling-3.0",
        "aspect_ratio": args.aspect_ratio or "16:9",
        "scenes": [],
        "status": "planned",
    }

    # Generate scene placeholders
    # The agent should fill in detailed prompts based on the outline
    for i in range(num_scenes):
        scene = {
            "scene_number": i + 1,
            "prompt": f"Scene {i + 1} of {num_scenes}: {args.outline}",
            "duration": args.duration or "5",
            "status": "pending",
            "request_id": None,
            "output_url": None,
        }
        plan["scenes"].append(scene)

    # Save plan
    STORIES_DIR.mkdir(parents=True, exist_ok=True)
    plan_file = STORIES_DIR / f"{story_id}.json"
    plan_file.write_text(json.dumps(plan, indent=2))

    result = {
        "status": "planned",
        "story_id": story_id,
        "plan_file": str(plan_file),
        "num_scenes": num_scenes,
        "note": "Edit the plan file to customize scene prompts before running 'generate'.",
    }
    output(result, args.json)
    return 0


def cmd_generate(args: argparse.Namespace) -> int:
    """Generate all scenes in a story plan."""
    plan_file = Path(args.plan_file)
    if not plan_file.exists():
        print(f"ERROR: Plan file not found: {plan_file}", file=sys.stderr)
        return 1

    plan = json.loads(plan_file.read_text())
    model = args.model or plan.get("model", "kling-3.0")
    aspect_ratio = plan.get("aspect_ratio", "16:9")
    scenes = plan.get("scenes", [])

    if not scenes:
        print("ERROR: No scenes in plan", file=sys.stderr)
        return 1

    plan["status"] = "generating"
    completed = 0
    failed = 0

    for scene in scenes:
        if scene.get("status") == "completed" and scene.get("output_url"):
            completed += 1
            continue

        scene_num = scene.get("scene_number", "?")
        prompt = scene.get("prompt", "")
        duration = scene.get("duration", "5")

        if not args.json:
            print(f"\nGenerating scene {scene_num}/{len(scenes)}...")

        gen_args = [
            "text-to-video",
            "--prompt", prompt,
            "--model", model,
            "--aspect-ratio", aspect_ratio,
            "--duration", str(duration),
        ]

        # Add character elements if specified
        if scene.get("elements_ref"):
            for ref in scene["elements_ref"]:
                gen_args.extend(["--elements-ref", ref])

        result = run_generate(gen_args)

        if result.get("status") == "completed":
            scene["status"] = "completed"
            scene["output_url"] = result.get("output_url")
            scene["request_id"] = result.get("request_id")
            completed += 1
        else:
            scene["status"] = "failed"
            scene["error"] = result.get("error", "Unknown error")
            scene["request_id"] = result.get("request_id")
            failed += 1

        # Save progress after each scene
        plan_file.write_text(json.dumps(plan, indent=2))

    plan["status"] = "completed" if failed == 0 else "partial"
    plan_file.write_text(json.dumps(plan, indent=2))

    summary = {
        "status": plan["status"],
        "story_id": plan.get("story_id"),
        "total_scenes": len(scenes),
        "completed": completed,
        "failed": failed,
        "plan_file": str(plan_file),
    }
    output(summary, args.json)
    return 0 if failed == 0 else 1


def cmd_assemble(args: argparse.Namespace) -> int:
    """Assemble completed scenes into a single video using FFmpeg."""
    plan_file = Path(args.plan_file)
    if not plan_file.exists():
        print(f"ERROR: Plan file not found: {plan_file}", file=sys.stderr)
        return 1

    plan = json.loads(plan_file.read_text())
    scenes = plan.get("scenes", [])
    completed_scenes = [s for s in scenes if s.get("status") == "completed" and s.get("output_url")]

    if not completed_scenes:
        print("ERROR: No completed scenes to assemble", file=sys.stderr)
        return 1

    # Check FFmpeg availability
    try:
        subprocess.run(["ffmpeg", "-version"], capture_output=True, timeout=5)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        print("ERROR: FFmpeg not found. Install it to assemble videos.", file=sys.stderr)
        return 1

    story_id = plan.get("story_id", "story")
    output_dir = STORIES_DIR / story_id
    output_dir.mkdir(parents=True, exist_ok=True)

    # Download each scene
    scene_files = []
    for i, scene in enumerate(completed_scenes):
        url = scene["output_url"]
        scene_file = output_dir / f"scene_{i+1}.mp4"

        if not scene_file.exists():
            if not args.json:
                print(f"Downloading scene {i+1}...")
            try:
                from urllib.request import urlretrieve
                urlretrieve(url, str(scene_file))
            except Exception as e:
                print(f"ERROR: Failed to download scene {i+1}: {e}", file=sys.stderr)
                continue

        scene_files.append(scene_file)

    if not scene_files:
        print("ERROR: No scenes downloaded successfully", file=sys.stderr)
        return 1

    # Create FFmpeg concat file
    concat_file = output_dir / "concat.txt"
    with open(concat_file, "w") as f:
        for sf in scene_files:
            f.write(f"file '{sf}'\n")

    # Assemble
    output_path = Path(args.output) if args.output else output_dir / f"{story_id}_final.mp4"
    ffmpeg_cmd = [
        "ffmpeg", "-y", "-f", "concat", "-safe", "0",
        "-i", str(concat_file), "-c", "copy", str(output_path),
    ]

    if not args.json:
        print("Assembling video...")

    result = subprocess.run(ffmpeg_cmd, capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        output_data = {"error": f"FFmpeg failed: {result.stderr[:300]}"}
        output(output_data, args.json)
        return 1

    summary = {
        "status": "assembled",
        "output_file": str(output_path),
        "scenes_assembled": len(scene_files),
        "story_id": story_id,
    }
    output(summary, args.json)
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    """Check story generation status."""
    plan_file = Path(args.plan_file)
    if not plan_file.exists():
        print(f"ERROR: Plan file not found: {plan_file}", file=sys.stderr)
        return 1

    plan = json.loads(plan_file.read_text())
    scenes = plan.get("scenes", [])

    status_counts = {}
    for s in scenes:
        st = s.get("status", "unknown")
        status_counts[st] = status_counts.get(st, 0) + 1

    summary = {
        "story_id": plan.get("story_id"),
        "status": plan.get("status"),
        "outline": plan.get("outline", "")[:100],
        "total_scenes": len(scenes),
        **{f"scenes_{k}": v for k, v in status_counts.items()},
    }
    output(summary, args.json)
    return 0


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Higgsfield AI Video — Story Pipeline")
    sub = parser.add_subparsers(dest="command", required=True)

    p_plan = sub.add_parser("plan", help="Create a scene plan")
    p_plan.add_argument("--outline", required=True, help="Story outline")
    p_plan.add_argument("--scenes", type=int, help="Number of scenes (default 3)")
    p_plan.add_argument("--model", help="Video model")
    p_plan.add_argument("--aspect-ratio", help="Aspect ratio")
    p_plan.add_argument("--duration", help="Duration per scene")
    p_plan.add_argument("--json", action="store_true", help="JSON output")

    p_gen = sub.add_parser("generate", help="Generate scenes from plan")
    p_gen.add_argument("--plan-file", required=True, help="Path to plan JSON")
    p_gen.add_argument("--model", help="Override model")
    p_gen.add_argument("--json", action="store_true", help="JSON output")

    p_asm = sub.add_parser("assemble", help="Assemble scenes into video")
    p_asm.add_argument("--plan-file", required=True, help="Path to plan JSON")
    p_asm.add_argument("--output", help="Output file path")
    p_asm.add_argument("--json", action="store_true", help="JSON output")

    p_st = sub.add_parser("status", help="Check story status")
    p_st.add_argument("--plan-file", required=True, help="Path to plan JSON")
    p_st.add_argument("--json", action="store_true", help="JSON output")

    args = parser.parse_args()
    cmd_map = {
        "plan": cmd_plan,
        "generate": cmd_generate,
        "assemble": cmd_assemble,
        "status": cmd_status,
    }
    sys.exit(cmd_map[args.command](args))


if __name__ == "__main__":
    main()
