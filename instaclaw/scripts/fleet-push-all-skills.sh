#!/bin/bash
#
# fleet-push-all-skills.sh — Master fleet push: deploy ALL 14 skills to fleet
#
# Runs each skill push script in sequence. Supports:
#   --dry-run   Preview all deployments (ALWAYS run first)
#   --canary    Deploy all skills to 1 VM, pause for approval
#   --all       Deploy all skills to all active VMs
#
# Order: Voice → Web → Code → Kling → Email → Marketplace → Finance → Intel → Social → E-Commerce → Video → Brand → Polymarket → Language Teacher
#
# MANDATORY: Always run --dry-run first, per CLAUDE.md rules.
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

MODE="${1:---help}"
TARGET_IP="${2:-}"

SKILLS=(
  "fleet-push-voice-skill.sh"
  "fleet-push-web-skill.sh"
  "fleet-push-code-skill.sh"
  "fleet-push-kling-skill.sh"
  "fleet-push-email-skill.sh"
  "fleet-push-marketplace-skill.sh"
  "fleet-push-finance-skill.sh"
  "fleet-push-intel-skill.sh"
  "fleet-push-social-skill.sh"
  "fleet-push-ecommerce-skill.sh"
  "fleet-push-video-skill.sh"
  "fleet-push-brand-skill.sh"
  "fleet-push-polymarket-skill.sh"
  "fleet-push-language-teacher-skill.sh"
)

LABELS=(
  "Voice & Audio Production"
  "Web Search & Browser Automation"
  "Code Execution & Backend Development"
  "Kling AI Cinematic Video Prompting"
  "Email & Outreach"
  "Marketplace Earning & Digital Products"
  "Financial Analysis"
  "Competitive Intelligence"
  "Social Media Content"
  "E-Commerce & Marketplace"
  "Video Production (Remotion)"
  "Brand Asset Extraction"
  "Prediction Markets (Polymarket)"
  "Language Teacher"
)

TOTAL_SKILLS=${#SKILLS[@]}

case "$MODE" in
  --dry-run)
    echo "================================================================"
    echo "  MASTER FLEET PUSH — DRY RUN (all $TOTAL_SKILLS skills)"
    echo "================================================================"
    echo ""

    PASSED=0
    FAILED=0

    for i in "${!SKILLS[@]}"; do
      SCRIPT="${SCRIPT_DIR}/${SKILLS[$i]}"
      LABEL="${LABELS[$i]}"

      echo "────────────────────────────────────────"
      echo "  [$((i+1))/$TOTAL_SKILLS] $LABEL"
      echo "────────────────────────────────────────"

      if [ ! -f "$SCRIPT" ]; then
        echo "  ❌ MISSING: $SCRIPT"
        FAILED=$((FAILED + 1))
        echo ""
        continue
      fi

      if bash "$SCRIPT" --dry-run; then
        PASSED=$((PASSED + 1))
      else
        echo "  ❌ FAILED: $SCRIPT"
        FAILED=$((FAILED + 1))
      fi
      echo ""
    done

    echo "================================================================"
    echo "  DRY RUN COMPLETE"
    echo "  Passed: $PASSED/$TOTAL_SKILLS  |  Failed: $FAILED/$TOTAL_SKILLS"
    echo "================================================================"
    echo ""
    if [ "$FAILED" -gt 0 ]; then
      echo "⚠️  Fix failures above before running --canary or --all"
      exit 1
    else
      echo "✅ All $TOTAL_SKILLS skills validated. Run with --canary to deploy to 1 VM first."
    fi
    ;;

  --canary)
    if [ -z "$TARGET_IP" ]; then
      echo "Usage: $0 --canary <VM_IP>"
      echo "  Pick a VM IP from the --dry-run output."
      exit 1
    fi

    export CANARY_IP="$TARGET_IP"

    echo "================================================================"
    echo "  MASTER FLEET PUSH — CANARY (all $TOTAL_SKILLS skills to $TARGET_IP)"
    echo "================================================================"
    echo ""

    PASSED=0
    FAILED=0

    for i in "${!SKILLS[@]}"; do
      SCRIPT="${SCRIPT_DIR}/${SKILLS[$i]}"
      LABEL="${LABELS[$i]}"
      SKILL_NAME="${SKILLS[$i]}"

      echo "────────────────────────────────────────"
      echo "  [$((i+1))/$TOTAL_SKILLS] $LABEL"
      echo "────────────────────────────────────────"

      if [ ! -f "$SCRIPT" ]; then
        echo "  ❌ MISSING: $SCRIPT"
        FAILED=$((FAILED + 1))
        echo ""
        continue
      fi

      # Voice & Email scripts accept --canary <IP> as arg
      # Scripts 3-8 read CANARY_IP env var (exported above)
      if [[ "$SKILL_NAME" == "fleet-push-voice-skill.sh" ]] || [[ "$SKILL_NAME" == "fleet-push-email-skill.sh" ]]; then
        if bash "$SCRIPT" --canary "$TARGET_IP"; then
          PASSED=$((PASSED + 1))
        else
          echo "  ❌ FAILED: ${SKILLS[$i]}"
          FAILED=$((FAILED + 1))
        fi
      else
        if bash "$SCRIPT" --canary; then
          PASSED=$((PASSED + 1))
        else
          echo "  ❌ FAILED: ${SKILLS[$i]}"
          FAILED=$((FAILED + 1))
        fi
      fi
      echo ""
    done

    echo "================================================================"
    echo "  CANARY COMPLETE — $TARGET_IP"
    echo "  Passed: $PASSED/$TOTAL_SKILLS  |  Failed: $FAILED/$TOTAL_SKILLS"
    echo "================================================================"
    echo ""
    if [ "$FAILED" -gt 0 ]; then
      echo "⚠️  Some skills failed canary. Check output above."
      echo "Fix issues before running --all"
      exit 1
    else
      echo "✅ All $TOTAL_SKILLS skills deployed to canary VM ($TARGET_IP)."
      echo "Verify the VM is healthy, then run: $0 --all"
    fi
    ;;

  --all)
    echo "================================================================"
    echo "  MASTER FLEET PUSH — ALL VMs (all $TOTAL_SKILLS skills)"
    echo "================================================================"
    echo ""
    echo "⚠️  This will deploy all $TOTAL_SKILLS skills to ALL active VMs."
    echo "    Make sure you ran --dry-run and --canary first."
    echo ""

    PASSED=0
    FAILED=0

    for i in "${!SKILLS[@]}"; do
      SCRIPT="${SCRIPT_DIR}/${SKILLS[$i]}"
      LABEL="${LABELS[$i]}"

      echo "────────────────────────────────────────"
      echo "  [$((i+1))/$TOTAL_SKILLS] $LABEL"
      echo "────────────────────────────────────────"

      if [ ! -f "$SCRIPT" ]; then
        echo "  ❌ MISSING: $SCRIPT"
        FAILED=$((FAILED + 1))
        echo ""
        continue
      fi

      # Voice & Email scripts use no-arg for fleet mode; scripts 3-8 use --all
      SKILL_NAME="${SKILLS[$i]}"
      if [[ "$SKILL_NAME" == "fleet-push-voice-skill.sh" ]] || [[ "$SKILL_NAME" == "fleet-push-email-skill.sh" ]]; then
        if bash "$SCRIPT"; then
          PASSED=$((PASSED + 1))
        else
          echo "  ❌ FAILED: ${SKILLS[$i]}"
          FAILED=$((FAILED + 1))
        fi
      else
        if bash "$SCRIPT" --all; then
          PASSED=$((PASSED + 1))
        else
          echo "  ❌ FAILED: ${SKILLS[$i]}"
          FAILED=$((FAILED + 1))
        fi
      fi
      echo ""
    done

    echo "================================================================"
    echo "  FLEET DEPLOY COMPLETE"
    echo "  Passed: $PASSED/$TOTAL_SKILLS  |  Failed: $FAILED/$TOTAL_SKILLS"
    echo "================================================================"
    echo ""
    if [ "$FAILED" -gt 0 ]; then
      echo "⚠️  Some skills failed. Check output above."
    else
      echo "✅ All $TOTAL_SKILLS skills deployed to entire fleet."
    fi
    ;;

  --help|*)
    echo "fleet-push-all-skills.sh — Deploy ALL 14 agent skills to fleet"
    echo ""
    echo "Usage:"
    echo "  $0 --dry-run   — Preview all deployments (ALWAYS run first)"
    echo "  $0 --canary <IP> — Deploy all 14 skills to 1 VM, verify"
    echo "  $0 --all       — Deploy all 14 skills to all active VMs"
    echo ""
    echo "Skills deployed (in order):"
    for i in "${!LABELS[@]}"; do
      echo "  $((i+1)). ${LABELS[$i]}"
    done
    echo ""
    echo "API keys deployed (4 platform-level):"
    echo "  - ELEVENLABS_API_KEY (Voice)"
    echo "  - RESEND_API_KEY (Email)"
    echo "  - ALPHAVANTAGE_API_KEY (Finance)"
    echo "  - BRAVE_SEARCH_API_KEY (Intel)"
    echo ""
    echo "BYOK (user provides own credentials):"
    echo "  - E-Commerce (Shopify/Amazon/eBay/ShipStation)"
    echo ""
    echo "No API keys needed (doc-only or built-in tools):"
    echo "  - Web Search, Code Execution, Kling AI, Marketplace, Social Media, Video Production, Brand Extraction, Polymarket, Language Teacher"
    ;;
esac
