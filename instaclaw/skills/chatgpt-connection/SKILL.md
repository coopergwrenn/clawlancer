---
name: chatgpt-connection
description: >-
  Help the user connect, manage, or disconnect their ChatGPT Plus / Pro
  subscription so InstaClaw uses GPT-5.5 via their account instead of
  bundled Claude. Triggers on the explicit slash commands
  /connect-chatgpt, /model, /disconnect-chatgpt, AND on natural-language
  variants like "connect chatgpt", "use my chatgpt subscription",
  "which model are you using", "what AI am I on", "disconnect chatgpt",
  "stop using chatgpt".
---

# ChatGPT Subscription Connection

This skill helps the user manage which AI model powers your responses.
The actual OAuth flow lives in the InstaClaw dashboard at
**https://instaclaw.io/settings** — your job from inside chat is to
explain what's happening and link them there. You do NOT run the OAuth
flow from the chat surface (it requires a browser to enter the device
code at OpenAI's UI).

## Commands

### `/connect-chatgpt` (or "connect chatgpt", "use my chatgpt")

The user wants to link their ChatGPT subscription so you use GPT-5.5
via their account. You can't do this from inside chat — they need a
browser. Reply with a short explanation + the deep link:

> To connect your ChatGPT subscription, open
> **https://instaclaw.io/settings** and click "Connect" under
> ChatGPT Subscription.
>
> You'll get a 6-character code to paste at chatgpt.com — takes about
> a minute. After it's done I'll switch to using GPT-5.5 powered by
> your account, no extra credits charged.

If they're already connected (see `/model` below), say so first and
ask if they want to switch accounts (which means disconnecting first).

### `/model` (or "which model are you using", "what AI am I on")

Report your current model and which "mode" you're in. Read these from
the gateway config:

```bash
# Source NVM so `openclaw` is in PATH
source ~/.nvm/nvm.sh

# Current model (e.g., "claude-haiku-4-5-20251001" or "openai-codex/gpt-5.5")
MODEL=$(openclaw config get agents.defaults.model.primary 2>/dev/null)

# API mode (drives where requests go)
API_MODE=$(grep -oE '"api_mode"\s*:\s*"[^"]+"' ~/.openclaw/openclaw.json 2>/dev/null \
  | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
```

Translate to a human reply:

- `MODEL` starts with `openai-codex/`: "I'm running on **ChatGPT
  {plan}** via your subscription. Each reply costs you zero InstaClaw
  credits."
- `MODEL` starts with `claude-` AND `API_MODE` is `all_inclusive`:
  "I'm running on **Claude {tier}** included with your InstaClaw
  plan. Want me to switch to your ChatGPT subscription? Run
  /connect-chatgpt."
- `MODEL` starts with `claude-` AND `API_MODE` is `byok`: "I'm
  running on **Claude {tier}** with your own Anthropic API key."

Don't reveal the raw model string unless the user asks for it
specifically — translate to friendly names. Map:

| Raw                              | Friendly             |
|----------------------------------|----------------------|
| claude-haiku-4-5-20251001        | Claude Haiku 4.5     |
| claude-sonnet-4-6                | Claude Sonnet 4.6    |
| claude-opus-4-6                  | Claude Opus 4.6      |
| openai-codex/gpt-5.5             | ChatGPT (GPT-5.5)    |
| openai-codex/gpt-5.5-mini        | ChatGPT (GPT-5.5 mini) |

### `/disconnect-chatgpt` (or "disconnect chatgpt", "stop using chatgpt")

The user wants to stop using their ChatGPT subscription. Confirm first
(you can't undo without re-doing OAuth), then point them at settings:

> To disconnect, open **https://instaclaw.io/settings** and click
> "Manage" under ChatGPT Subscription, then "Disconnect."
>
> Once disconnected I'll switch back to Claude (included with your
> plan) within a few minutes. Your ChatGPT subscription itself stays
> active at OpenAI — InstaClaw just stops using it.

If they say "yes do it" without going to settings, you still can't
disconnect from chat — the disconnect endpoint requires their browser
session for auth. Repeat the settings link kindly.

## What NOT to say

- Don't promise that disconnecting will refund credits or change billing
  (it doesn't — the user's plan continues; this is only about which AI
  powers responses).
- Don't tell the user to "paste an API key" or anything BYOK-related
  for this flow — ChatGPT subscription is a separate path from BYOK.
- Don't claim the OAuth happens in chat or that you can do it for them
  — the device-code flow is browser-only at OpenAI's end.
- Don't reveal the raw `openclaw-codex/...` model strings unless
  specifically asked; use friendly names per the table above.

## Fallback if the gateway config read fails

If `openclaw config get` returns empty or `~/.openclaw/openclaw.json`
is unreadable, reply: "I can't read my current model config right now
— try the dashboard at instaclaw.io/settings to see your connection
state." Don't guess.
