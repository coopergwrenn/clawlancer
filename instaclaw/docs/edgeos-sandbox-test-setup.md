# EdgeOS sandbox test setup — operator runbook

**Goal:** end-to-end exercise of the OTP → bearer → api-key → events query chain against `api.dev.edgeos.world` so we can prove the modules work before wiring into `configureOpenClaw`.

**Why this needs an operator step:** EdgeOS requires a real email address that has a real EdgeOS user account in the sandbox tenant. There is no service-to-service / admin / fixture endpoint to create one programmatically. Per Tule's 2026-05-14 message: *"all the calendar stuff is working pretty well. if you need test users go into demo.dev.edgeos.world and submit an application that i can approve it."*

## Topology (what's where)

| host | role | backend |
|---|---|---|
| `demo.dev.edgeos.world` | sandbox portal frontend (where you sign up) | api.dev.edgeos.world |
| `api.dev.edgeos.world` | sandbox API (what our modules hit) | — |
| `edgecity.edgeos.world` | prod portal frontend | api.edgeos.world |
| `api.edgeos.world` | prod API (real Edge Esmeralda) | — |

Sandbox tenant: `Demo` (UUID `ea1aaa1d-d06f-4c43-b690-79c22c441093`, slug `demo`).
Sandbox has 3 popups for testing: `amanita-festival`, `tech-summit-2025`, `community-meetup` (UUIDs in `instaclaw/skills/edgeos-events/SKILL.md` frontmatter).

## What Cooper needs to do (the operator step)

1. Open `https://demo.dev.edgeos.world` in a browser. The home page is the OTP login form ("Sign Up or Log In — Welcome! Enter your email to receive a verification code").
2. Enter a test-dedicated email address. Recommend a fresh address you control (e.g. `coopergrantwrenn+edgeos-sbx@gmail.com`) rather than your daily inbox — easier to track which emails are from this test.
3. Check inbox for the 6-digit code, paste into the form, click verify.
4. Once logged in, browse to a popup. The frontend will surface an "Apply" CTA for each popup. Pick `community-meetup` (it's the shortest-lived one — least clutter).
5. Submit the application form (fill in whatever fields it requires; this is sandbox, no consequence). Note the application ID if shown.
6. Ping Tule on whichever channel you have him on: *"approved Cooper's sandbox application for community-meetup, please thumbs-up so I can test the agent's OTP→API-key chain end-to-end."* Wait for approval.
7. Once approved, the email is a fully provisioned EdgeOS user with at least one popup membership in sandbox. The remaining steps run from a terminal.

## What the terminal then does

```bash
cd instaclaw
EDGEOS_API_BASE=https://api.dev.edgeos.world \
  npx tsx scripts/_test-edgeos-auth-chain.ts --email coopergrantwrenn+edgeos-sbx@gmail.com
```

Flow the script runs:

1. POST `/api/v1/auth/user/login` with the email — triggers another OTP to that inbox.
2. Pauses; prompts for the 6-digit code at the terminal.
3. POST `/api/v1/auth/user/authenticate` with email+code → bearer.
4. POST `/api/v1/api-keys` with bearer, name=`instaclaw-edge-test-<ts>`, scopes=`["events:read"]` → `eos_live_*`.
5. GET `/api/v1/api-keys` → confirms the new key appears.
6. GET `/api/v1/events/portal/events?popup_id=fd7114a3-ae46-42fa-9286-165ade5a2a23&limit=1` with the `eos_live_*` → first event in `community-meetup`.
7. Cleanup: DELETE the test key (or `--keep` to leave it for further poking).

## Open questions the test resolves

- **Does `/api/v1/api-keys` need `X-Tenant-Id`?** Frontend interceptor sends it on every call, but the spec doesn't list it as a parameter for this endpoint. We currently DON'T send it in `lib/edgeos-api-keys.ts`. If we get 422 missing-header, we'll add an opt-in `tenantId` arg.
- **Can a user mint `events:write` and `rsvp:write` scopes, or does the api-keys endpoint enforce a per-scope role?** Default is `events:read` for v0 safety; expanding the scope is a follow-up if needed.
- **Does the events list endpoint return data without an approved popup application?** Probably yes (the events are public-within-tenant once you have an `eos_live_*`). If the list comes back empty after Tule approves the application, we know membership IS gated and we need to adjust the integration story.
- **How long does the bearer last?** Spec says nothing. Empirical test should keep the bearer alive for at least the time it takes to mint the api-key in the same session. We don't persist the bearer, only the `eos_live_*`.

## If something fails

| failure | likely cause | fix |
|---|---|---|
| `requestOTP returned no_account` | the email isn't in EdgeOS yet, OR demo.dev signup not completed | go back to step 1 of operator runbook |
| `authenticateOTP returned invalid_code` | code expired (10 min default per spec), or typo | rerun the script — it'll request a fresh OTP |
| `createApiKey returned validation_error` | very likely missing `X-Tenant-Id` header — first probe | add `xTenantId` arg to `createApiKey` and re-run |
| `createApiKey returned unauthorized` | bearer expired between authenticate and create; OR the user hasn't been approved by Tule yet | ping Tule re: approval; rerun OTP if approved |
| events list returns `[]` | popup application not approved, or wrong popup_id | check Tule approved, verify popup_id matches `community-meetup` |

## Why we test against sandbox first, not prod

Prod (EdgeCity tenant, Edge Esmeralda 2026 popup `43746fd0-bce2-472b-93e4-a438177b2dff`) has real attendees and real applications. A botched POST `/api-keys` against a real user account could surface keys we don't track. Sandbox is the right blast radius for a chain we haven't run end-to-end yet.

Once the chain is green in sandbox, point at prod by flipping `EDGEOS_API_BASE` and using the EdgeCity tenant UUID. No code changes; just env.

## Status

- 2026-05-14: modules built (`lib/edgeos-auth.ts`, `lib/edgeos-api-keys.ts`), smoke-tested for error categorization, NOT yet run end-to-end. This doc is the unblock.
