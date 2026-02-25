#!/bin/bash
#
# setup-language-learning.sh — Initialize language learning memory file
#
# Creates ~/memory/language-learning.md with multi-language template.
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

## English
### Configuration
- Level: (not set)
- Goal: (not set)
- Placement score: (not set)
- Setup date: (not set)

### Progress
- Total XP: 0
- Level: 1 (Seedling 🌱)
- Current streak: 0 days
- Longest streak: 0 days
- Streak last activity: (none)
- Words learned: 0
- Words mastered: 0
- Total conversation time: 0 min
- Quizzes completed: 0
- Lessons completed: 0
- Stories completed: 0
- Speed round personal best: 0/10

### Session History (last 5)
(none)

### Interrupted Lesson
(none)

### Vocabulary Bank
| Word | Translation | EF | Interval | Reps | Next Review | Score History | Examples | Tags |
|------|-------------|-----|----------|------|-------------|---------------|----------|------|

### Struggle Areas
(none yet)

### Achievement Log
| Achievement | Date Unlocked |
|-------------|---------------|
TEMPLATE

chmod 644 "$LEARN_FILE"
echo "Created language learning template at $LEARN_FILE"
echo "The agent will add new language sections (## Spanish, ## French, etc.) as needed."
