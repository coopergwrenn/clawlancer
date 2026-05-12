# X-reply drafts — @garrytan OpenClaw zombie bug (2026-05-12)

Reply to Garry Tan's X post about an OpenClaw bug. Lead is libuv #1911 →
`prctl-subreaper`. Launch-mode voice (no emojis, no em-dashes,
lowercase). Helpful and technically credible, not self-promotional.

Drafted manually because this is a high-stakes single reply that
needed factual disambiguation before generating. The user clarified
Garry's bug maps to the zombie/libuv-1911 angle, NOT the
newline-strip/md5-hash story (separate bug, separate fix; bundling
them would misattribute libuv #1911 publicly).

Style guide: `docs/x-post-style-guide.md` (launch mode).
Source incident: CLAUDE.md "v87 — prctl-subreaper integration" section.

---

## Variant A — tight single reply (≤280 chars)

hey garry. that's libuv #1911. uv_close runs before waitpid finishes and the child's exit signal gets dropped. tini cant catch it because the parent already missed the SIGCHLD.

we shipped the fix on npm. node becomes the subreaper.

github.com/coopergwrenn/prctl-subreaper

---

## Variant B — 2-tweet reply (hook + technical depth)

1/

hey garry. you're hitting libuv #1911. open since 2018.

node calls uv_close before waitpid completes and the child's exit signal gets dropped. tini as PID 1 can't catch it because the parent already missed the SIGCHLD. systemd Restart=on-failure doesn't help either.

2/

fix is making node itself the subreaper. PR_SET_CHILD_SUBREAPER plus a polling /proc walker on a background thread. small N-API addon, MIT, bun-compatible. running on our fleet.

github.com/coopergwrenn/prctl-subreaper

---

## Variant C — single reply, longer, premium-safe

hey garry. that's libuv #1911. open since 2018.

node calls uv_close before waitpid finishes. the child's exit signal gets dropped, the SIGCHLD handler gets unregistered, the process stays defunct. tini as PID 1 can't catch it because the parent already missed the SIGCHLD.

we shipped a fix. make node itself the subreaper via PR_SET_CHILD_SUBREAPER plus a polling /proc walker. small N-API addon, MIT, bun-compatible. running on our production fleet right now.

github.com/coopergwrenn/prctl-subreaper

---

## Notes

**What was intentionally excluded:**

- **The md5 hash compare fix (`b4b1e97b`).** That's a different bug — `node-ssh` strips trailing newlines from stdout, so the systemd unit verify was failing for unrelated reasons. Including it in the same reply would conflate two distinct issues and misattribute libuv #1911 publicly. Save that story for a separate post.
- **Specific fleet numbers (149 VMs, etc).** Variants B and C use "our fleet" / "our production fleet" instead — keeps the reply about the technical fix, not about us.
- **The 2026.4.26 release notes / OpenClaw version pin context.** This is a libuv-level issue, not OpenClaw-specific; framing it as "OpenClaw broke" would be wrong and Peter would correctly push back.
- **CTA to InstaClaw.** Reply is a contribution to the ecosystem. Linking instaclaw.io would tip into self-promotion. Keep it focused on the npm package.

**Facts verified:**

- libuv #1911 is real, open since July 5 2018, exact title: "child process stuck in defunct state if uv_close is called before child exited" ([github.com/libuv/libuv/issues/1911](https://github.com/libuv/libuv/issues/1911)). Mechanism described in the variants matches the issue body.
- `prctl-subreaper` is on npm as 0.1.1 per CLAUDE.md ("0.1.1 dropped the `|| exit 0` install mask from v0.1.0 that was hiding native-build failures").
- The package is MIT, N-API, bun-compatible per CLAUDE.md.
- CLAUDE.md and changelog-thread-v62-v88 both note Garry is already aware of the package ("@garrytan is testing it" in tweet 11). The reply doesn't reference that prior contact — it lets Garry connect it himself rather than naming the prior interaction publicly.

**Facts to verify before posting:**

- **Confirm Garry's actual post wording.** I couldn't find a specific OpenClaw-bug tweet from him via search — only his praise/gstack tweets indexed. If his post used different terminology (e.g., "process leak" or "hangs" rather than "zombies"), tune the opening line to mirror his phrasing. The hook should echo what he said.
- **Has Peter Steinberger posted yet?** If yes, this reply should reference his fix as the long-term path and `prctl-subreaper` as the in-userland workaround. If no, ship as-is. If both fix paths land in parallel, that's a feature, not a conflict.
- **Confirm libuv #1911 framing for the Linux/macOS case only.** The issue is platform-specific (depends on libuv's SIGCHLD handling); on Windows the mechanism is different. If Garry's stack is Linux/macOS, you're correct. If Windows, lead with the OpenClaw issue #74378 ("node.exe processes after execution on Windows") which is a related but distinct shape.

**Style audit (manual):**

- All lowercase except `SIGCHLD`, `PID`, `MIT`, `PR_SET_CHILD_SUBREAPER`, `N-API` (acronyms — per style guide).
- No emojis.
- No em-dashes (consensus/launch-mode rule).
- No marketing verbs ("excited to announce", "introducing", "unlock", "empower").
- No hashtags.
- Single URL at the end, no shortener.
- One-sentence-per-line cadence in B/C (matches consensus thread style).
- Variant A is ≤280 chars (counts: 277 with the URL).
- Variants B/C may exceed 280 per tweet — fine on Premium, split at blank lines otherwise.

**Recommended ship order:**

1. Post Variant A as the reply if you want maximum cut-through.
2. Use Variant B if Garry's post invited engagement (longer thread reply is welcome).
3. Variant C only if you have Premium or are converting to a quote-tweet/long post.

If Peter has already posted a fix, prefix any variant with: "ack @steipete. the in-userland workaround for anyone who can't wait for the upstream patch is libuv #1911 territory: [rest of variant]". Don't pretend his fix doesn't exist.
