# SM-2 Spaced Repetition Algorithm Reference

> For use by the AI language teacher agent. This document governs how vocabulary
> is scheduled, scored, and reviewed across all lesson modes.

---

## 1. Algorithm Overview

Spaced repetition exploits the **spacing effect**: memories are retained longer when
review sessions are spread out over increasing intervals rather than crammed together.
The SM-2 algorithm, originally developed by Piotr Wozniak in 1987, is the foundation
of modern flashcard systems (Anki, SuperMemo, etc.).

**Core idea:** After each review of an item, the algorithm decides *when* to show it
again based on how easily the learner recalled it. Easy items get pushed far into the
future; difficult items come back quickly. Over time, well-known words require almost
no maintenance while weak words get intensive reinforcement.

**Why it matters for language learning:**
- Prevents the "learned it, forgot it" cycle
- Maximizes retention per minute of study time
- Automatically identifies weak spots without the learner having to self-diagnose
- Scales to thousands of vocabulary items without overwhelming the learner

---

## 2. Algorithm Implementation

### 2.1 Score System (Quality of Response)

| Score | Meaning                                | Keyword        |
|-------|----------------------------------------|----------------|
| 0     | Complete blank -- no recognition at all | `blank`        |
| 1     | Wrong, but recognized the word after seeing the answer | `recognized`   |
| 2     | Wrong, but the answer was close / on the tip of the tongue | `close`        |
| 3     | Correct, but required significant effort or long pause | `hard_correct` |
| 4     | Correct with some hesitation            | `good`         |
| 5     | Instant, effortless recall              | `perfect`      |

### 2.2 Easiness Factor (EF)

The Easiness Factor reflects how naturally a word comes to the learner. It starts at
**2.5** for every new word and is updated after each review.

**Update formula:**

```
EF' = EF + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))
```

Where `q` is the score (0-5) and `EF` is the current easiness factor.

**Constraint:** EF must never drop below **1.3**.

**EF adjustment by score:**

| Score (q) | EF Delta  | EF after 1 review (starting at 2.5) |
|-----------|-----------|--------------------------------------|
| 5         | +0.10     | 2.60                                 |
| 4         | +0.00     | 2.50                                 |
| 3         | -0.14     | 2.36                                 |
| 2         | -0.32     | 2.18                                 |
| 1         | -0.54     | 1.96                                 |
| 0         | -0.80     | 1.70                                 |

### 2.3 Interval Calculation

```
if reps == 0:  interval = 1        # first review: 1 day
if reps == 1:  interval = 6        # second review: 6 days
if reps >= 2:  interval = round(previous_interval * EF)
```

### 2.4 Handling Failures (Score < 3)

If the score is **less than 3**, the item is considered a failure:
- Reset `reps` to **0**
- Reset `interval` to **1 day**
- **Keep the current EF** (it still gets updated by the formula above)

The word re-enters the "new word" schedule but carries its adjusted EF, so a
chronically difficult word will have short intervals even after recovering.

### 2.5 Worked Example: The Word "tuttavia" (Italian for "however")

**Day 1 -- Introduced in a lesson (initial state):**

| Field    | Value      |
|----------|------------|
| EF       | 2.50       |
| Interval | --         |
| Reps     | 0          |

**Day 2 -- First review, score = 4 (correct with hesitation):**

```
EF' = 2.50 + (0.1 - (5-4) * (0.08 + (5-4) * 0.02))
    = 2.50 + (0.1 - 1 * (0.08 + 0.02))
    = 2.50 + (0.1 - 0.10)
    = 2.50
Interval = 1 (first successful review)
Reps = 1
Next review = Day 2 + 1 = Day 3
```

**Day 3 -- Second review, score = 5 (instant recall):**

```
EF' = 2.50 + (0.1 - (5-5) * (0.08 + (5-5) * 0.02))
    = 2.50 + 0.10
    = 2.60
Interval = 6 (second successful review)
Reps = 2
Next review = Day 3 + 6 = Day 9
```

**Day 9 -- Third review, score = 3 (correct but hard):**

```
EF' = 2.60 + (0.1 - (5-3) * (0.08 + (5-3) * 0.02))
    = 2.60 + (0.1 - 2 * (0.08 + 0.04))
    = 2.60 + (0.1 - 0.24)
    = 2.46
Interval = round(6 * 2.46) = round(14.76) = 15
Reps = 3
Next review = Day 9 + 15 = Day 24
```

**Day 24 -- Fourth review, score = 1 (failed -- recognized after seeing answer):**

```
EF' = 2.46 + (0.1 - (5-1) * (0.08 + (5-1) * 0.02))
    = 2.46 + (0.1 - 4 * (0.08 + 0.08))
    = 2.46 + (0.1 - 0.64)
    = 1.92
Score < 3 -> reset: Reps = 0, Interval = 1
Next review = Day 24 + 1 = Day 25
```

**Day 25 -- Fifth review (re-learning), score = 5:**

```
EF' = 1.92 + 0.10 = 2.02
Interval = 1 (reps was 0)
Reps = 1
Next review = Day 25 + 1 = Day 26
```

**Day 26 -- Sixth review, score = 4:**

```
EF' = 2.02 + 0.00 = 2.02
Interval = 6 (reps was 1)
Reps = 2
Next review = Day 26 + 6 = Day 32
```

The word is now back on track with a slightly lower EF (2.02 vs. original 2.50),
meaning future intervals will grow more slowly -- the algorithm "remembers" that this
word is harder for the learner.

---

## 3. Vocabulary Bank Format

The file `~/memory/language-learning.md` contains the vocabulary bank as a markdown
table under the `## Vocabulary Bank` heading.

### Schema

```markdown
## Vocabulary Bank
| Word | Translation | EF | Interval | Reps | Next Review | Score History | Examples | Tags |
|------|-------------|----|----------|------|-------------|---------------|----------|------|
| tuttavia | however | 2.02 | 6 | 2 | 2026-03-04 | 4,5,3,1,5,4 | Tuttavia, non sono d'accordo. | conjunctions, daily-lesson-3 |
```

### Field Definitions

| Field         | Type    | Description                                                  |
|---------------|---------|--------------------------------------------------------------|
| Word          | string  | Target language word or short phrase                          |
| Translation   | string  | Native language meaning(s)                                   |
| EF            | decimal | Current easiness factor (min 1.3, starts at 2.5)             |
| Interval      | integer | Days until next review                                       |
| Reps          | integer | Count of consecutive successful reviews (score >= 3)         |
| Next Review   | date    | ISO date (YYYY-MM-DD) when the word is next due              |
| Score History | string  | Last 5 scores, comma-separated, most recent last             |
| Examples      | string  | An example sentence using the word in context                |
| Tags          | string  | Comma-separated category tags (topic, lesson source, etc.)   |

### Rules

- When a new word is added, set `EF=2.5`, `Interval=0`, `Reps=0`, `Next Review=today`.
- Score History retains only the **last 5** scores to keep the table readable.
- Tags should include the lesson or context where the word was introduced
  (e.g. `daily-lesson-12`, `user-requested`, `story-mode`).
- The Examples field should be updated periodically with fresh sentences when the
  agent generates new contexts for the word.

---

## 4. Heartbeat Integration

During each heartbeat or scheduled cron check, the agent performs the following:

```
1. Read ~/memory/language-learning.md
2. Parse the Vocabulary Bank table
3. Filter: words where Next Review <= today's date
4. Count due words
```

### Decision Logic

```
if due_words.count == 0:
    -> No action needed. Continue normal operations.

if due_words.count > 0 AND near_preferred_lesson_time:
    -> Proactively message the user to start a session.
    -> Example: "Hey! I was thinking we could practice some Italian today.
       Want to do a quick conversation or a mini-lesson?"

if due_words.count > 0 AND user_initiates_any_session:
    -> Weave due words into whatever session type the user chose.
    -> Do NOT delay the session to do a separate review block.
```

### Priority Ordering

When multiple words are due, prioritize:
1. **Overdue words** (Next Review is furthest in the past)
2. **Struggle words** (EF < 1.5 -- see section 8)
3. **Low-rep words** (fewer successful reviews = more fragile memory)
4. **Everything else** by Next Review date ascending

### Session Capacity

Aim to review **5-10 due words per session**. If more are due, carry the remainder
to the next session. Never overwhelm the learner with a 30-word review marathon.

---

## 5. Natural Weaving

**The cardinal rule: the learner should never feel like they are doing flashcard drills.**

Spaced repetition reviews must be invisible, embedded in the flow of natural
language practice. The agent uses the following strategies by session type:

### Conversation Mode

- Steer the topic toward contexts where due words naturally appear.
- If the due word is "mercato" (market), ask about weekend plans, shopping, cooking.
- If the user produces the word unprompted, score it and move on silently.
- If they struggle, provide a gentle scaffold: "How would you say you went to
  the... place where you buy vegetables?"

### Daily Lessons

- Build the lesson theme around a cluster of 2-3 due words plus new material.
- Use due words in example sentences, reading passages, and exercises.
- The lesson should feel thematic and coherent, not like a grab-bag of unrelated words.

### Quizzes

- Mix due words with new content at roughly a 40/60 ratio.
- Due words appear as fill-in-the-blank, multiple choice, or translation items.
- New words appear as introduction + recognition items.

### Story Mode

- Write short dialogues or narratives that organically use due review words.
- After the story, ask comprehension questions that require using the due words.

### What NOT to Do

- NEVER say "time for your flashcard review"
- NEVER say "let's review these 5 words"
- NEVER present a bare word-translation pair and ask "what does this mean?"
- NEVER list all due words at the start of a session
- NEVER break the immersive flow to announce that a word is being reviewed

---

## 6. Score Update Logic

The agent assigns scores based on how the learner demonstrates knowledge. Scoring
rules differ between structured (quiz) and unstructured (conversation) contexts.

### Quiz / Exercise Scoring

| Situation                                           | Score |
|-----------------------------------------------------|-------|
| Correct on first attempt, no hesitation              | 5     |
| Correct on first attempt, but paused / was unsure    | 4     |
| Correct after receiving a hint or clue               | 3     |
| Wrong initially, then self-corrected                 | 2     |
| Wrong, recognized the answer after seeing it         | 1     |
| Wrong, gave up or complete blank                     | 0     |

### Conversation Scoring

| Situation                                           | Score |
|-----------------------------------------------------|-------|
| Used the word correctly and unprompted               | 5     |
| Used the word correctly after a gentle topic steer   | 4     |
| Used the word after an explicit prompt / scaffold    | 3     |
| Attempted the word but used it incorrectly           | 2     |
| Could not recall; agent provided the word            | 1     |
| Word was presented but learner showed no recognition | 0     |

### Scoring Rules

- Each due word gets **at most one score per session**. Use the best demonstration.
- If a word appears multiple times in conversation, use the **highest** score observed.
- Non-due words that the user happens to use do NOT get scored (they are not up
  for review yet). Exception: if a non-due word is used incorrectly, note it for
  the next session but do not alter its schedule.
- After scoring, immediately recalculate EF, interval, reps, and next review date,
  then update the vocabulary bank.

---

## 7. Mastery Definition

A word is considered **mastered** when ALL of the following are true:

```
EF >= 2.5
AND Interval >= 30 days
AND last 3 scores are ALL >= 4
```

### What Mastery Means

- The word is well-retained and comes easily to the learner.
- It still gets reviewed, but at very long intervals (the interval keeps growing
  via the standard formula: `interval * EF`).
- Mastered words are deprioritized in session planning -- they only appear when
  their next review date arrives, and they are the lowest priority among due words.

### Mastery Lifecycle Example

A word that scores 5 repeatedly with EF 2.6:

| Review # | Score | EF   | Interval | Status     |
|----------|-------|------|----------|------------|
| 1        | 5     | 2.60 | 1        | Learning   |
| 2        | 5     | 2.70 | 6        | Learning   |
| 3        | 4     | 2.70 | 16       | Learning   |
| 4        | 5     | 2.80 | 45       | Learning   |
| 5        | 5     | 2.90 | 131      | **Mastered** |
| 6        | 5     | 3.00 | 393      | Mastered   |

After review 5, the word meets all three criteria: EF (2.90) >= 2.5, interval
(131) >= 30, and last 3 scores (4, 5, 5) are all >= 4. It will not come up for
review again for over four months.

---

## 8. Struggle Words

A word is flagged as a **struggle word** when EITHER condition is met:

```
EF < 1.5
OR (Reps >= 5 AND max(last 5 scores) < 4)
```

### How the Agent Handles Struggle Words

1. **Increased Frequency:** Struggle words are woven into sessions more often,
   even outside their scheduled review date. Aim for at least one exposure every
   2-3 sessions.

2. **Richer Context:** Provide multiple example sentences, not just one. Show the
   word in different grammatical forms, registers, and situations.

3. **Mnemonics:** Offer a mnemonic device. For example:
   - "**Tuttavia** (however) -- think of 'tutta via' = 'all the way'... but then
     you change direction. It's the word that changes direction in a sentence."

4. **Paired Practice:** Pair the struggle word with a mastered word in the same
   semantic field. The strong association with a known word can serve as an anchor.

5. **Multi-Modal Exposure:** Use the word in different session types:
   - Reading: include it in a passage
   - Writing: ask the learner to write a sentence with it
   - Listening: use it in spoken dialogue
   - Speaking: prompt the learner to use it in conversation

6. **Progress Tracking:** When a struggle word achieves score 4+ for three
   consecutive reviews, remove the struggle flag. Update the Examples field with
   the contexts that finally helped it stick.

### Struggle Word Example

```
| Word | Translation | EF | Interval | Reps | Next Review | Score History | Examples | Tags |
| comunque | anyway/however | 1.40 | 1 | 0 | 2026-02-26 | 2,1,2,0,2 | Comunque, andiamo. | conjunctions, struggle |
```

This word has EF 1.40 (below 1.5) and has never scored above 2 in the last 5
reviews. The agent should:
- Use it in the next 3 sessions regardless of schedule
- Provide a mnemonic: "**Comunque** -- 'come un que' = 'come what may' = anyway"
- Create mini-dialogues where "comunque" is the pivot word
- Pair it with the mastered word "tuttavia" to contrast similar conjunctions

---

## Quick Reference Card

```
NEW WORD:       EF=2.5  Interval=0  Reps=0  Next=today
SCORE >= 3:     Update EF, advance reps, calculate new interval
SCORE < 3:      Update EF, reset reps=0, interval=1
EF FORMULA:     EF' = EF + (0.1 - (5-q) * (0.08 + (5-q) * 0.02))
EF FLOOR:       1.3
INTERVAL:       rep1=1d, rep2=6d, rep3+=round(interval*EF)
MASTERED:       EF>=2.5 AND interval>=30d AND last 3 scores all >=4
STRUGGLE:       EF<1.5 OR (reps>=5 AND max(last 5 scores)<4)
SESSION CAP:    5-10 due words per session
GOLDEN RULE:    Never break immersion to announce a review
```
