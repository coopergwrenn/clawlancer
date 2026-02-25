#!/bin/bash
#
# setup-language-learning.sh — Initialize language learning memory file
#
# Creates ~/memory/language-learning.md with a minimal Global section.
# The agent adds per-language sections (## English, ## Spanish, etc.) dynamically.
# Safe to re-run — will NOT overwrite existing file.
#
# Usage:
#   bash ~/scripts/setup-language-learning.sh           — Create template
#   bash ~/scripts/setup-language-learning.sh status     — Check if file exists
#

set -euo pipefail

MEMORY_DIR="$HOME/memory"
LEARN_FILE="$MEMORY_DIR/language-learning.md"

case "${1:-}" in
  status)
    if [ -f "$LEARN_FILE" ]; then
      echo "Language learning file exists: $LEARN_FILE"
      wc -l < "$LEARN_FILE" | xargs -I{} echo "Lines: {}"
    else
      echo "No language learning file found. Run without arguments to create."
    fi
    exit 0
    ;;
  "")
    # Create template (default)
    ;;
  *)
    echo "Usage: $0 [status]"
    exit 1
    ;;
esac

# Don't overwrite existing file
if [ -f "$LEARN_FILE" ]; then
  echo "Language learning file already exists at $LEARN_FILE"
  echo "To reset, delete it first: rm $LEARN_FILE"
  exit 0
fi

mkdir -p "$MEMORY_DIR"

cat > "$LEARN_FILE" << 'TEMPLATE'
# Language Learning Progress

## Global
- Native language: (not set)
- Interests: (not set)
- Daily time: (not set)
- Reminders: off
TEMPLATE

chmod 644 "$LEARN_FILE"
echo "Created language learning template at $LEARN_FILE"
echo "The agent will add language sections (## English, ## Spanish, etc.) during setup."
