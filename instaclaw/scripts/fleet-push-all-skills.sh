#!/bin/bash
#
# fleet-push-all-skills.sh — Master fleet push: deploy ALL 8 skills to fleet
#
# Runs each skill push script in sequence. Supports:
#   --dry-run   Preview all deployments (ALWAYS run first)
#   --canary    Deploy all skills to 1 VM, pause for approval
#   --all       Deploy all skills to all active VMs
#
# Order: Voice → Email → Finance → Intel → Social → E-Commerce → Video → Brand
#
# MANDATORY: Always run --dry-run first, per CLAUDE.md rules.
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

MODE="${1:---help}"

SKILLS=(
  "fleet-push-voice-skill.sh"
  "fleet-push-email-skill.sh"
  "fleet-push-finance-skill.sh"
  "fleet-push-intel-skill.sh"
  "fleet-push-social-skill.sh"
  "fleet-push-ecommerce-skill.sh"
  "fleet-push-video-skill.sh"
  "fleet-push-brand-skill.sh"
)

LABELS=(
  "Voice & Audio Production"
  "Email & Outreach"
  "Financial Analysis"
  "Competitive Intelligence"
  "Social Media Content"
  "E-Commerce & Marketplace"
  "Video Production (Remotion)"
  "Brand Asset Extraction"
)

case "$MODE" in
  --dry-run)
    echo "================================================================"
    echo "  MASTER FLEET PUSH — DRY RUN (all 8 skills)"
    echo "================================================================"
    echo ""

    PASSED=0
    FAILED=0

    for i in "${!SKILLS[@]}"; do
      SCRIPT="${SCRIPT_DIR}/${SKILLS[$i]}"
      LABEL="${LABELS[$i]}"

      echo "────────────────────────────────────────"
      echo "  [$((i+1))/8] $LABEL"
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
    echo "  Passed: $PASSED/8  |  Failed: $FAILED/8"
    echo "================================================================"
    echo ""
    if [ "$FAILED" -gt 0 ]; then
      echo "⚠️  Fix failures above before running --canary or --all"
      exit 1
    else
      echo "✅ All 8 skills validated. Run with --canary to deploy to 1 VM first."
    fi
    ;;

  --canary)
    echo "================================================================"
    echo "  MASTER FLEET PUSH — CANARY (all 8 skills to 1 VM)"
    echo "================================================================"
    echo ""

    PASSED=0
    FAILED=0

    for i in "${!SKILLS[@]}"; do
      SCRIPT="${SCRIPT_DIR}/${SKILLS[$i]}"
      LABEL="${LABELS[$i]}"

      echo "────────────────────────────────────────"
      echo "  [$((i+1))/8] $LABEL"
      echo "────────────────────────────────────────"

      if [ ! -f "$SCRIPT" ]; then
        echo "  ❌ MISSING: $SCRIPT"
        FAILED=$((FAILED + 1))
        echo ""
        continue
      fi

      if bash "$SCRIPT" --canary; then
        PASSED=$((PASSED + 1))
      else
        echo "  ❌ FAILED: ${SKILLS[$i]}"
        FAILED=$((FAILED + 1))
      fi
      echo ""
    done

    echo "================================================================"
    echo "  CANARY COMPLETE"
    echo "  Passed: $PASSED/8  |  Failed: $FAILED/8"
    echo "================================================================"
    echo ""
    if [ "$FAILED" -gt 0 ]; then
      echo "⚠️  Some skills failed canary. Check output above."
      echo "Fix issues before running --all"
      exit 1
    else
      echo "✅ All 8 skills deployed to canary VM."
      echo "Verify the VM is healthy, then run: $0 --all"
    fi
    ;;

  --all)
    echo "================================================================"
    echo "  MASTER FLEET PUSH — ALL VMs (all 8 skills)"
    echo "================================================================"
    echo ""
    echo "⚠️  This will deploy all 8 skills to ALL active VMs."
    echo "    Make sure you ran --dry-run and --canary first."
    echo ""

    PASSED=0
    FAILED=0

    for i in "${!SKILLS[@]}"; do
      SCRIPT="${SCRIPT_DIR}/${SKILLS[$i]}"
      LABEL="${LABELS[$i]}"

      echo "────────────────────────────────────────"
      echo "  [$((i+1))/8] $LABEL"
      echo "────────────────────────────────────────"

      if [ ! -f "$SCRIPT" ]; then
        echo "  ❌ MISSING: $SCRIPT"
        FAILED=$((FAILED + 1))
        echo ""
        continue
      fi

      if bash "$SCRIPT" --all; then
        PASSED=$((PASSED + 1))
      else
        echo "  ❌ FAILED: ${SKILLS[$i]}"
        FAILED=$((FAILED + 1))
      fi
      echo ""
    done

    echo "================================================================"
    echo "  FLEET DEPLOY COMPLETE"
    echo "  Passed: $PASSED/8  |  Failed: $FAILED/8"
    echo "================================================================"
    echo ""
    if [ "$FAILED" -gt 0 ]; then
      echo "⚠️  Some skills failed. Check output above."
    else
      echo "✅ All 8 skills deployed to entire fleet."
    fi
    ;;

  --help|*)
    echo "fleet-push-all-skills.sh — Deploy ALL 8 agent skills to fleet"
    echo ""
    echo "Usage:"
    echo "  $0 --dry-run   — Preview all deployments (ALWAYS run first)"
    echo "  $0 --canary    — Deploy all 8 skills to 1 VM, verify"
    echo "  $0 --all       — Deploy all 8 skills to all active VMs"
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
    echo "No API keys needed:"
    echo "  - Social Media, Video Production, Brand Extraction"
    ;;
esac
