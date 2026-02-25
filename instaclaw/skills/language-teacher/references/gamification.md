# Gamification & Engagement System

This file defines all XP values, levels, achievements, streak logic, reminders, reports, and celebration phrases. The agent reads this file directly — all values and templates are canonical.

---

## 1. XP Values Per Activity

| Activity | XP | Bonus Conditions |
|----------|----|--------------------|
| Correct quiz answer | +5 | +2 bonus if first try |
| Complete daily lesson | +20 | — |
| 10-min conversation | +30 | +10 for 20+ min |
| New word mastered | +10 | — |
| Cultural lesson | +15 | — |
| Story mode session | +25 | — |
| Speed round completion | +20 | +10 for personal best |
| Streak bonus (daily) | +5 x streak_day | Caps at +50/day at day 10+ |
| Achievement unlocked | +50 | — |
| First try correct | +2 | Stacks with quiz answer (+5 + +2 = +7) |
| Used a struggle word correctly | +5 | Struggle words are from ~/memory/language-learning.md |
| Self-correction in conversation | +3 | User catches and fixes own mistake without prompting |

**Rules:**
- XP is awarded immediately and announced inline (e.g., "+5 XP!").
- Bonuses stack. A first-try correct quiz answer = +5 + +2 = +7 XP.
- Streak bonus is applied once per day on the first activity of the day.
- Level-up announcements interrupt the current activity briefly, then resume.

---

## 2. Levels

| Level | Name | XP Required | Emoji | Unlock Message |
|-------|------|-------------|-------|----------------|
| 1 | Seedling | 0 | 🌱 | "Your journey begins! 🌱" |
| 2 | Sprout | 100 | 🌿 | "Growing fast! 🌿 Level 2!" |
| 3 | Sapling | 300 | 🌳 | "Taking root! 🌳 Level 3!" |
| 4 | Tree | 600 | 🏔️ | "Standing tall! 🏔️ Level 4!" |
| 5 | Forest | 1,000 | 🌲 | "A whole forest of knowledge! 🌲 Level 5!" |
| 6 | Explorer | 1,500 | 🗺️ | "Exploring new frontiers! 🗺️ Level 6!" |
| 7 | Navigator | 2,500 | 🧭 | "Navigating like a pro! 🧭 Level 7!" |
| 8 | Ambassador | 4,000 | 🏛️ | "Cultural ambassador! 🏛️ Level 8!" |
| 9 | Scholar | 6,000 | 🎓 | "Scholarly! 🎓 Level 9!" |
| 10 | Polyglot | 10,000 | 👑 | "👑 POLYGLOT! You've reached the top! This is legendary!" |

**Level-up behavior:**
- When a user crosses an XP threshold, send the unlock message immediately.
- Include a brief recap: "You earned 340 XP this week to get here!"
- After Level 10, XP still accumulates but no further level-ups occur. Acknowledge milestones at 15,000, 20,000, etc. with a custom message.

---

## 3. Achievements

16 achievements. Each awards +50 XP on unlock. Achievements can only be earned once.

### 3.1 🌱 First Steps
- **Trigger:** Complete the very first lesson after setup (any language).
- **Announcement:** "🌱 ACHIEVEMENT UNLOCKED: First Steps! Your language learning journey begins NOW! This is where it all starts! +50 XP!"

### 3.2 🗣️ First Conversation
- **Trigger:** Complete first 5+ minute conversation practice session.
- **Announcement:** "🗣️ ACHIEVEMENT UNLOCKED: First Conversation! You just had your first real conversation practice — this is where the magic happens! +50 XP!"

### 3.3 📚 Word Collector (10)
- **Trigger:** Add 10 words to vocabulary tracker.
- **Announcement:** "📚 ACHIEVEMENT UNLOCKED: Word Collector! 10 words in your collection — your vocabulary is growing! +50 XP!"

### 3.4 📚 Word Collector (50)
- **Trigger:** Add 50 words to vocabulary tracker.
- **Announcement:** "📚📚 ACHIEVEMENT UNLOCKED: Word Collector II! 50 words! You're building a serious vocabulary arsenal! +50 XP!"

### 3.5 📚 Word Collector (100)
- **Trigger:** Add 100 words to vocabulary tracker.
- **Announcement:** "📚📚📚 ACHIEVEMENT UNLOCKED: Word Collector III! 100 WORDS! That's a whole dictionary in your head! +50 XP!"

### 3.6 🧠 Memory Master
- **Trigger:** Get 10 previously-struggled words correct without hints.
- **Announcement:** "🧠 ACHIEVEMENT UNLOCKED: Memory Master! You nailed 10 words that used to trip you up — your brain is leveling up! +50 XP!"

### 3.7 🔥 On Fire (7-day streak)
- **Trigger:** Maintain a 7-day practice streak.
- **Announcement:** "🔥 ACHIEVEMENT UNLOCKED: On Fire! 7 days in a row! You're building a real habit — this is how fluency happens! +50 XP!"

### 3.8 🔥🔥 Unstoppable (30-day streak)
- **Trigger:** Maintain a 30-day practice streak.
- **Announcement:** "🔥🔥 ACHIEVEMENT UNLOCKED: Unstoppable! 30 DAYS STRAIGHT! You are absolutely relentless — most people never get here! +50 XP!"

### 3.9 ⚡ Speed Demon
- **Trigger:** Score 10/10 on a speed round.
- **Announcement:** "⚡ ACHIEVEMENT UNLOCKED: Speed Demon! Perfect score on a speed round! Your reflexes in this language are getting scary fast! +50 XP!"

### 3.10 🌍 Culture Club
- **Trigger:** Complete 5 cultural lessons.
- **Announcement:** "🌍 ACHIEVEMENT UNLOCKED: Culture Club! 5 cultural deep-dives — you're not just learning words, you're understanding a whole world! +50 XP!"

### 3.11 💬 Chatterbox
- **Trigger:** Accumulate 30+ minutes of total conversation practice.
- **Announcement:** "💬 ACHIEVEMENT UNLOCKED: Chatterbox! Over 30 minutes of conversation practice! Talking is the fastest path to fluency and you're crushing it! +50 XP!"

### 3.12 🎯 Perfect Quiz
- **Trigger:** Score 100% on a quiz with 5 or more questions.
- **Announcement:** "🎯 ACHIEVEMENT UNLOCKED: Perfect Quiz! 100% with 5+ questions — not a single mistake! Your accuracy is incredible! +50 XP!"

### 3.13 📖 Storyteller
- **Trigger:** Complete 3 story mode sessions.
- **Announcement:** "📖 ACHIEVEMENT UNLOCKED: Storyteller! 3 stories completed — you're learning through narrative like a natural! +50 XP!"

### 3.14 🦸 Phrasal Verb Hero
- **Trigger:** Use 10 different phrasal verbs correctly in conversation or quizzes.
- **Announcement:** "🦸 ACHIEVEMENT UNLOCKED: Phrasal Verb Hero! 10 phrasal verbs used correctly — these trip up even advanced learners and you're owning them! +50 XP!"

### 3.15 🎓 Grammar Guru
- **Trigger:** Receive 20 grammar corrections and subsequently use the correct form in later sessions.
- **Announcement:** "🎓 ACHIEVEMENT UNLOCKED: Grammar Guru! 20 grammar corrections all learned and applied — you don't just hear feedback, you absorb it! +50 XP!"

### 3.16 🌅 Early Bird
- **Trigger:** Practice before 7:00 AM local time on 5 separate days.
- **Announcement:** "🌅 ACHIEVEMENT UNLOCKED: Early Bird! 5 sunrise study sessions — the dedication is real! Morning practice = supercharged retention! +50 XP!"

---

## 4. Streak Logic

**What counts as a streak activity:**
Any of these actions count toward maintaining the daily streak:
- Completing a quiz (any score)
- Completing a daily lesson
- Having a conversation session (any length)
- Completing a story mode session
- Completing a speed round
- Completing a cultural lesson
- Looking up a word (minimum: asking about one word's meaning or usage)

**Streak rules:**
- The streak counter increments by 1 for each consecutive calendar day with at least one qualifying activity.
- The calendar day is determined by the user's local timezone (stored in user profile).
- Streak resets to 0 at midnight local time if no activity was recorded for the previous day.
- There is NO grace period. This keeps streaks meaningful and earned.
- Streak counter is stored in `~/memory/language-learning.md` under the `streak` section.
- The longest-ever streak (streak record) is also tracked in the same file and updated whenever the current streak exceeds it.

**Streak XP calculation:**
- Daily streak bonus = 5 x current_streak_day (awarded on first activity of the day).
- Cap: maximum +50 XP per day from streak bonus (reached at day 10+).
- Example: Day 3 = +15 XP bonus. Day 10 = +50 XP bonus. Day 15 = +50 XP bonus (capped).

---

## 5. Streak Reminder Escalation

Reminders are sent ONLY on days when the user has not yet practiced. Times are user-local. Tone is personality-driven — never robotic or generic.

### 4:00 PM — Casual, Light Touch
Variations (rotate, never repeat the same one back-to-back):
1. "Hey! Quick 5-minute practice today? Even one word keeps your {streak_count}-day streak alive 🔥"
2. "Just popping in — your streak is at {streak_count} days. A quick quiz would keep it going!"
3. "Friendly nudge! Haven't seen you today. Even a single vocab lookup counts toward your streak 🌱"
4. "Your {streak_count}-day streak is waiting for you! Got 2 minutes for a quick round?"
5. "Afternoon check-in! One small practice and your streak stays golden ✨"

### 6:00 PM — Urgency But Fun
Variations:
1. "⏰ Your {streak_count}-day streak needs you! A quick quiz before dinner? Takes 2 minutes!"
2. "Clock's ticking on that beautiful {streak_count}-day streak! How about a speed round? ⚡"
3. "Evening reminder — don't let {streak_count} days of hard work slip away! One quick activity saves it 🔥"
4. "Your streak is looking nervously at the clock... give it some love with a quick practice? 😄"
5. "6 PM and your streak is still on the line! Jump in for even 60 seconds — it all counts!"

### 8:00 PM — Last Chance, Dramatic But Encouraging
Variations:
1. "🚨 Last call! Your {streak_count}-day streak expires at midnight. One word lookup — that's all it takes!"
2. "This is it — the final stretch! {streak_count} days of dedication on the line. 2 minutes. You've got this! 💪"
3. "Midnight is coming for your {streak_count}-day streak! Quick — even asking me one vocabulary question saves it!"
4. "Your streak is holding on by its fingernails! 🔥 {streak_count} days — don't let it go! One quick practice!"
5. "Final reminder tonight — {streak_count} days is incredible. Protect it with one quick activity before bed!"

### Streak Broken — Encouragement Messages
When a streak breaks, send one of these (rotate):
1. "Your {old_streak}-day streak ended — but wow, {old_streak} days is something to be proud of! Ready to start a new one? 🌱"
2. "Fresh start today! Your previous streak was {old_streak} days — that's real dedication. Let's build an even longer one 💪"
3. "Hey, {old_streak} days of consistent practice means you learned a LOT. The knowledge stays even if the counter resets. New streak starts now! 🔥"
4. "Streaks break — it happens to everyone. But {old_streak} days? That's {old_streak} days of growth that nobody can take away. Let's go again!"
5. "New day, new streak! Your record is still {streak_record} days — let's chase that! 🎯"

### NEVER say these things:
- "You let your streak die" — too guilt-heavy.
- "You failed to practice" — failure framing is forbidden.
- "You should have..." — no hindsight blame.
- "I'm disappointed" — the agent is never disappointed in the user.
- "You broke your promise" — never reference past commitments as failures.
- Any message that could make the user feel bad about missing a day. Always frame forward.

---

## 6. Weekly Progress Report

Sent every Sunday at 10:00 AM user-local time. Use this exact template structure, filling in real values:

```
📊 Weekly Language Report — {week_start} to {week_end}

🔥 Streak: {current_streak} days {streak_commentary}
⭐ XP this week: {xp_this_week} {xp_comparison}
📚 New words: {new_words} | Mastered: {mastered_words}
🗣️ Conversation time: {conv_minutes} minutes
📈 Level: {level_number} {level_emoji} ({percent_to_next}% to Level {next_level})

TOP ACHIEVEMENTS:
{achievements_list_or_none}

AREAS TO FOCUS:
{focus_areas}

WORDS YOU CRUSHED:
{crushed_words}

{closing_encouragement}
```

**Field rules:**
- `{streak_commentary}`: If current streak is their best ever, add "(your best ever!)". If within 3 days of record, add "(almost your record of {record}!)". Otherwise, just the number.
- `{xp_comparison}`: Compare to previous week. Show as percentage change, e.g., "(+15% vs last week)" or "(-8% vs last week — still solid!)". Always soften negative comparisons.
- `{achievements_list_or_none}`: List any achievements unlocked that week, prefixed with "🏆 Unlocked". If none, write "No new achievements this week — one might be close though! 👀"
- `{focus_areas}`: Pull from struggle words and grammar issues tracked in memory. List 2-3 max. Be specific (e.g., "Phrasal verbs (3/10 correct this week)") not vague.
- `{crushed_words}`: Highlight 2-3 words the user used correctly multiple times or mastered this week. Include usage count if available.
- `{closing_encouragement}`: One sentence, forward-looking, specific to their progress. Reference a concrete goal if possible (e.g., "You're on track for Level 5 by next week! 🚀").

**Example filled report:**
```
📊 Weekly Language Report — Feb 17–23, 2026

🔥 Streak: 12 days (your best ever!)
⭐ XP this week: 340 (+15% vs last week)
📚 New words: 18 | Mastered: 5
🗣️ Conversation time: 42 minutes
📈 Level: 4 🏔️ (60% to Level 5)

TOP ACHIEVEMENTS:
- 🏆 Unlocked "Chatterbox" — 30+ min conversation!

AREAS TO FOCUS:
- Phrasal verbs (3/10 correct this week)
- Past perfect tense (keep practicing!)

WORDS YOU CRUSHED:
- "Nevertheless" — used it 4 times correctly! 🎯
- "Straightforward" — mastered! 🧠

Keep going! You're on track for Level 5 by next week! 🚀
```

---

## 7. Celebration Phrase Bank

The agent MUST rotate through these and never repeat the same phrase back-to-back. Track the last used phrase index in session state.

### Mild (for small wins: correct answer, word lookup, etc.)
1. "Nice! ✓"
2. "Got it! 👍"
3. "Correct! ✓"
4. "That's right!"
5. "Yep! Nailed it."
6. "Right on target."
7. "Clean answer! ✓"
8. "Smooth. 👌"
9. "Solid."

### Medium (for notable wins: streak maintained, lesson completed, bonus XP, etc.)
10. "Great work! You're on a roll! 🔥"
11. "Look at you go! 💪"
12. "That's the way! Keep it up!"
13. "Awesome — you're really getting this! ⭐"
14. "Boom! Another one down! 💥"
15. "You're making this look easy! 🎯"
16. "Impressive progress! Keep that momentum!"
17. "This is what consistency looks like! 🔥"
18. "You should be proud of that one! 👏"

### High-Energy (for major wins: level-up, achievement, personal best, streak milestone, etc.)
19. "🎉 YES! That is absolutely incredible!"
20. "🚀 You are on FIRE right now!"
21. "🏆 LEGENDARY move! Seriously impressive!"
22. "⚡ UNSTOPPABLE! Nothing is slowing you down!"
23. "🎊 This deserves a standing ovation! Wow!"
24. "🌟 You're rewriting what's possible! Amazing!"
25. "💎 BRILLIANT! This is elite-level progress!"
26. "🔥🔥🔥 THREE FIRE EMOJIS. That's how good this is!"
27. "🎯 BULLSEYE! Absolute perfection!"
28. "👑 Take a bow — you earned this one!"

**Rotation rules:**
- Track the index of the last phrase used in each intensity tier.
- Never use the same phrase twice in a row within the same tier.
- Within a session, try to cycle through all phrases in a tier before repeating any.
- It is fine to use phrases from different tiers back-to-back (e.g., a mild followed by a high-energy is perfectly normal when the context shifts).
