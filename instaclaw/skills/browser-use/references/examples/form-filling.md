# Example — Form Filling (Public Forms Only)

Submit a public web form — newsletter signup, contact request, demo request, lead-gen — where the user has authorized this specific submission.

## When to use

- "Sign me up for the newsletter on company.com." (single, authorized)
- "Submit this contact form with my info." (single, authorized)
- "Request a demo of Product X." (single, authorized)

## When NOT to use

- Logged-in accounts (Tier 4 relay).
- Bulk submission (refused — abuse pattern).
- Anything involving payment fields (refused — out of scope).
- Account creation (refused — abuse pattern).

## Invocation

```bash
python3 ~/scripts/browser-use-task.py \
  --task "On the contact page, fill the form with: name='Jane Doe', email='jane@example.com', company='Example Inc', message='Interested in your enterprise plan, please send pricing.'. Submit. Confirm submission succeeded by reading the confirmation message. Return JSON with fields: submitted (bool), confirmation_text (string)." \
  --start-url "https://company.com/contact" \
  --max-steps 12 \
  --timeout-sec 120 \
  --budget-usd 0.30 \
  --headless \
  --output-format json
```

Notes on the flags:
- `--max-steps 12` — form fill + submit + confirm read = ~6-10 steps typical, with retry headroom.
- `--timeout-sec 120` — submission redirects can be slow.
- Task is fully specified up-front. Don't make the agent prompt for missing fields mid-task.

## Expected output (success)

```json
{
  "ok": true,
  "result": {
    "submitted": true,
    "confirmation_text": "Thank you! We'll be in touch within 1 business day."
  },
  "wall_time_ms": 38200,
  "cost_usd": 0.18
}
```

## Failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| `submitted: false`, no error | Form validation rejected one field | Re-read field requirements, retry with corrected data |
| Hits CAPTCHA | Site has bot protection on this form | Tier 4 (relay) only — user must solve CAPTCHA |
| Times out on confirmation | Site uses async submission | Raise `--timeout-sec` to 180 |
| Email field rejected | Site requires email verification before accepting | Out of scope; tell user to use the relay |

## Authorization check (agent-side, before invoking)

Before calling the wrapper, the agent should confirm with the user:

> "I'm about to submit a contact form on company.com with your info: name=…, email=…, message=…. Confirm to proceed?"

Don't submit without explicit confirmation. The form goes to a real human at the receiving company; treat it like sending an email.

## Don't

- Don't submit the same form more than once per session.
- Don't run this on payment pages, sign-up flows, or any page that creates an account.
- Don't auto-fill fields the user didn't provide. If a required field is missing, fail back and ask the user.
- Don't store the submitted info anywhere other than the task description in the wrapper invocation. The wrapper output is logged briefly; don't pile on persistent records of user form submissions.
