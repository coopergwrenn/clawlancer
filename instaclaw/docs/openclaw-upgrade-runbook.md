# OpenClaw Upgrade Runbook — patch survival edition

> **Purpose.** The next time anyone (human or Claude Code terminal) bumps
> `OPENCLAW_PINNED_VERSION`, this runbook makes it **impossible to silently
> lose a custom dist patch**. Read it end-to-end before bumping. It is the
> operational companion to **CLAUDE.md Rule 71** and the
> **OpenClaw Upgrade Playbook** (CLAUDE.md → "OpenClaw Upgrade Playbook"),
> which covers the broader timeout/watchdog/canary discipline. This doc is
> specifically about the *custom patches*.

---

## 0. The one-paragraph model

OpenClaw ships as a globally-installed npm package whose bundled `dist/` files
we modify. Every `npm install -g openclaw@<v>` wipes those files. We keep a
**registry of every patch** in `lib/openclaw-patches.ts` (data + a pure
transform each), a **shared apply engine** that reproduces the gold-standard
discipline, and tools to **apply** and **verify** patches over SSH. Patches are
located by **content anchor**, never by hashed filename, so a version bump that
only renames a bundle chunk does not break them. Drift (anchors gone) and
native-fixes (upstream now does it) are surfaced **loudly** by the verify tool —
never swallowed.

---

## 1. The patch inventory (current)

Run `npx tsx scripts/_verify-openclaw-patches.ts --vm=instaclaw-vm-1019` for the
live picture. As of this writing:

| id | kind | rollout | applied by | survives npm -g? |
|---|---|---|---|---|
| `pi-ai-reasoning-router` | feature | fleet | `stepPiAiReasoningPatch` (reconciler, runs right after `stepNpmPinDrift`) | ✅ — re-applied every reconcile, adjacent to the wipe |
| `typing-keepalive` | bugfix | **parked** | nobody (suspended per Rule 63/64; likely native-fixed in 2026.5.x) | n/a |
| `queue-collect-batch` | bugfix | **canary** | **nobody — body not in repo; lives only on vm-1028/vm-1043 via manual SSH** | ❌ until captured |
| config: `messages.queue.mode=collect`, `messages.queue.debounceMs=3000`, `messages.queue.byChannel.telegram=collect` | config override | unmanaged | nobody — not in manifest | config survives npm -g (lives in `~/.openclaw`) but is **not reproducible / not enforced** |

### ⚠ Two standing hazards to clear (do these independently of any upgrade)

1. **The queue patch + its config overrides exist only on vm-1028/vm-1043.**
   They are uncommitted. They will be **silently wiped** the moment either VM
   reconciles to 2026.5.22 (`stepNpmPinDrift` reinstalls openclaw → dist wiped),
   and the config will then describe "collect mode" with no patch to make it
   batch correctly. **Capture them** — see §6.
2. **The reasoning-router patch's anchors were written for an older pi-ai.**
   The 4.26→5.22 bump may have changed pi-ai's source. If the anchors no longer
   match, `stepPiAiReasoningPatch` pushes a *warning* (not an error) and the
   router is **silently off fleet-wide**. **Run the verify tool now** (§3) — an
   `anchor-drift` or `missing` on `pi-ai-reasoning-router` is a live incident.

---

## 2. The six wipe sites (where dist gets reinstalled)

Every one of these runs `npm install -g openclaw` and therefore destroys patches.
Each must end by re-applying patches:

| Wipe site | File | Re-applies patches today? | Correct behavior |
|---|---|---|---|
| `stepNpmPinDrift` (reconciler) | `lib/vm-reconcile.ts` | `stepPiAiReasoningPatch` runs immediately after → reasoning-router ✅ | engine, all `fleet` patches |
| `configureOpenClaw` (provision) | `lib/ssh.ts` | reasoning-router via first reconcile after provision; typing patch was removed | call apply engine / rely on first reconcile |
| `upgradeOpenClaw` (manual endpoint) | `lib/ssh.ts` | ❌ | run apply engine after install |
| `fleet-upgrade-openclaw.sh` | `instaclaw/scripts/` | ❌ | run apply engine after install |
| Snapshot bake | CLAUDE.md "Snapshot Creation Process" | ❌ (not in 15-point checklist) | §5 below |
| cloud-init (fresh VM) | `lib/cloud-init-setup-sh.ts` | inherits snapshot | covered if snapshot is baked with patches |

The **gold-standard invariant**: the wipe and the re-apply are adjacent in the
same code path so they can never desync. `stepNpmPinDrift` → `stepPiAiReasoningPatch`
is the model. Every other wipe site should either (a) be immediately followed by
the apply engine, or (b) rely on the next reconcile (acceptable only when a
short patch-less window is tolerable — NOT for a snapshot that may sit unbaked).

---

## 3. Verify (read-only) — the load-bearing tool

```bash
# after ANY OPENCLAW_PINNED_VERSION bump, and any time you suspect drift:
npx tsx scripts/_verify-openclaw-patches.ts --all          # whole healthy+assigned fleet
npx tsx scripts/_verify-openclaw-patches.ts                # quick deterministic sample of 8
npx tsx scripts/_verify-openclaw-patches.ts --vm=instaclaw-vm-1019
npx tsx scripts/_verify-openclaw-patches.ts --id=pi-ai-reasoning-router --all
```

Statuses and what to do:

| status | meaning | action |
|---|---|---|
| `applied` | sentinel present — patch is LIVE | nothing |
| `missing` | pristine, anchors present | re-apply (§4) or wait for reconcile; for a **fleet** patch this is a problem |
| `anchor-drift` | anchors gone — upstream changed the file | **RE-ANCHOR** (§4.1) — the patch is silently off |
| `native-fixed` | upstream now does this itself | delete the patch (§7) |
| `target-missing` | file not found (version/layout change) | investigate; re-anchor discovery |
| `no-transform` | registry stub (queue) — body not captured | §6 |
| `ssh-fail` | VM unreachable | retry / exclude |

Exit code is non-zero if any **fleet-rollout** patch is missing/drifted on any
reachable VM — wire it into CI / patrol if you like.

---

## 4. Apply / re-apply

```bash
# fleet patches to one VM (idempotent, backs up, node --check, rollback on fail):
npx tsx scripts/_apply-openclaw-patches.ts --vm=instaclaw-vm-1019
npx tsx scripts/_apply-openclaw-patches.ts --vm=instaclaw-vm-1019 --dry-run
# include canary patches (e.g. queue, once its body is captured):
npx tsx scripts/_apply-openclaw-patches.ts --vm=instaclaw-vm-1019 --include-canary
# a bake VM that isn't in the DB:
npx tsx scripts/_apply-openclaw-patches.ts --ip=<bake-vm-ip>
```

Fleet-wide apply, and promoting a `canary`/`parked` patch to `fleet`, is a
**Rule 64 decision**: test on vm-1019, confirm with Cooper, then either bump the
manifest (reconciler picks it up) or run a tested fleet-push.

### 4.1 Re-anchoring after drift

When verify reports `anchor-drift`, upstream changed the file. To re-anchor:

1. SSH a VM on the new version. Locate the file by content:
   `ROOT=$(npm root -g)/openclaw; grep -rlF '<discriminator>' "$ROOT/<searchDir>"`
2. Open it; find the new byte-exact text around where the old anchor was.
3. Update the patch's `anchors` (and `transform` injects if the surrounding
   code shape changed) in `lib/openclaw-patches.ts`.
4. Add/adjust the fixture in `scripts/_test-openclaw-patches.ts` and run it
   (no VM needed): `npx tsx scripts/_test-openclaw-patches.ts`.
5. Dry-run apply on vm-1019, then real apply, then verify.

---

## 5. Snapshot bake — patch step (ADD to the 15-point checklist)

After `npm install -g openclaw@<v>` on the bake nanode, before powering off:

```bash
# from your laptop, against the bake VM's IP:
npx tsx scripts/_apply-openclaw-patches.ts --ip=<bake-ip>            # fleet patches
# if collect-mode is promoted to fleet by then, add --include-canary
# verify it took:
npx tsx scripts/_verify-openclaw-patches.ts --vm=<bake-name-or-ip>
```

Add this as a numbered item in CLAUDE.md "Snapshot Creation Process" §7
verification, e.g. **item 17**: "`_verify-openclaw-patches.ts` shows every
fleet patch `applied` on the bake VM." Baking patches in means fresh VMs are
correct from first boot (not just after the first reconcile).

---

## 6. Capturing the queue-collect-batch patch (DO THIS SOON)

The body is not in source control. To rescue it before vm-1028/1043 reconcile
and wipe it:

```bash
ssh -i /tmp/ic_ssh_key openclaw@<vm-1028-ip>
ROOT=$(npm root -g)/openclaw
grep -rlF 'hasRuntimeOnlyFollowupMetadata' "$ROOT/dist"     # find the chunk
# look for a sibling backup the manual edit left (.bak / .pre-*):
ls -la "$(grep -rlF 'hasRuntimeOnlyFollowupMetadata' "$ROOT/dist" | head -1)"*
```

Then either diff against the left-behind backup, or install pristine
`openclaw@2026.5.22` into a scratch dir and `diff -u pristine patched`. That diff
IS the transform. Hand it to Claude (or write it):

1. Fill in `transform` on the `queue-collect-batch` descriptor in
   `lib/openclaw-patches.ts`, embedding `INSTACLAW_PATCH_QCB_V1`.
2. Tighten `anchors` to the byte-exact pre-patch text.
3. Add a fixture to `scripts/_test-openclaw-patches.ts`; run it.
4. Capture the **config overrides** into the manifest (see §8) — the patch and
   the config are a pair; one without the other is broken.
5. Test on vm-1019 per Rule 64; get Cooper's approval to promote `rollout` to
   `fleet`; then bump the manifest so the reconciler applies it.

Until then the descriptor is a `no-transform` stub: the engine refuses to apply
it and prints these instructions, and verify shows `no-transform` so it's never
mistaken for "fine".

---

## 7. Native-fix detection — deleting patches upstream has fixed

For `bugfix` patches, `detectNativeFix` reports whether the running version
already implements the fix. The typing patch is the live example:

```bash
npx tsx scripts/_verify-openclaw-patches.ts --id=typing-keepalive --vm=instaclaw-vm-1019
# native-fixed → upstream's createTypingKeepaliveLoop is present; the patch is
# redundant on this version. Keep it parked, or delete the descriptor outright.
```

To delete a patch: remove its descriptor from `PATCHES`, remove its fixture
from the test, and note the deletion + the version that obsoleted it in the
descriptor's git history / CLAUDE.md. Never delete a `feature` patch on
native-fix grounds (upstream won't ship our features) — only by product choice.

---

## 8. Config overrides (separate from patches)

`messages.queue.mode=collect`, `messages.queue.debounceMs=3000`,
`messages.queue.byChannel.telegram=collect` are **config**, not dist patches.
They live in `~/.openclaw/openclaw.json`, which `npm install -g` does NOT touch —
so they survive upgrades. Their problem is different: they are currently set
**manually on vm-1028/1043 only**, so they're neither reproducible nor enforced.

The correct home is `VM_MANIFEST.configSettings` (`lib/vm-manifest.ts`), which
`stepConfigSettings` enforces fleet-wide and re-applies on drift.
`messages.*` is already in `RESTART_REQUIRED_CONFIG_PREFIXES`, so the reconciler
will restart the gateway when these change (Rule 32). When you promote
collect-mode from canary to fleet (Rule 64), add the three keys to
`configSettings` in the same change as the queue patch.

When an upgrade changes an upstream **default** (e.g. queue.mode default
steer→collect), our explicit setting protects us — but per Rule 2, diff the
config *schema* between versions: a renamed/removed key makes our setting a
silent no-op.

---

## 9. Upgrade procedure (the whole thing, in order)

1. **Read the changelog** for the version range (per the OpenClaw Upgrade
   Playbook). Look for timeout/watchdog/config-schema changes.
2. **Re-anchor pre-check:** on a VM already on the NEW version (or a scratch
   install), run `_verify-openclaw-patches.ts --vm=<that vm>`. Any
   `anchor-drift`/`target-missing` → re-anchor (§4.1) BEFORE the fleet bump.
3. **Native-fix check:** if a bugfix patch shows `native-fixed`, plan to delete
   it (§7) rather than carry it.
4. **Canary** on vm-1019 (per Rule 64 + the Playbook's canary discipline): bump
   nothing fleet-wide yet; install the new version on vm-1019, apply patches,
   run the real chat-completion probe, watch the journal for 5+ min.
5. **Verify** vm-1019: `_verify-openclaw-patches.ts --vm=instaclaw-vm-1019` → all
   fleet patches `applied`.
6. **Get Cooper's explicit ship approval** (Rule 64).
7. **Bump** `OPENCLAW_PINNED_VERSION` + (if needed) re-anchored patches + (if
   promoting) `rollout` flags + manifest config. Commit.
8. **Fleet rollout** via reconcile (concurrency ≤ 3 per the Playbook). Wave-audit.
9. **Post-rollout verify:** `_verify-openclaw-patches.ts --all`. Exit 0 = every
   fleet patch is live on every reachable VM.
10. **Snapshot bake** with the patch step (§5). Keep the previous snapshot ≥ 1
    week for rollback.

---

## 10. Future: unify the apply path (optional cleanup, Rule-64 gated)

Today `pi-ai-reasoning-router` is applied by the dedicated `stepPiAiReasoningPatch`
and ALSO described in the registry (for verify + native-fix + documentation).
That's a small duplication. The clean end state is to replace the body of
`stepPiAiReasoningPatch` with a call to `applyOpenClawPatches(ssh, { rollouts:
["fleet"] })` so the registry is the *only* place anchors/transforms live. This
is behavior-preserving (the registry's reasoning-router transform is byte-for-byte
the same injects) but it touches the live reconciler path, so:

- Do it as its own PR, NOT during an active version rollout.
- Diff the registry transform output against the current step's output on a
  captured copy of the pi-ai file first.
- Test on vm-1019; get Cooper's approval; then deploy.

Until then, when you re-anchor `pi-ai-reasoning-router`, update **both** the
registry entry AND `stepPiAiReasoningPatch` (the runbook's re-anchor step and
the registry comment both say this).

---

## 11. Rollback

- Keep the previous `OPENCLAW_PINNED_VERSION` documented and pinnable.
- Per-VM openclaw rollback: see the Playbook's `_rollback-fleet-to-vN.ts` pattern
  and vm-1019's `openclaw-canary-backup-*.tar.gz` precedent (CLAUDE.md Rule 65).
- Per-patch rollback: every apply leaves `<file>.pre-<id>.bak`. Restore it and
  restart the gateway. But note a reconcile will re-apply a `fleet` patch — to
  truly disable one, set its `rollout` to `parked` (or remove it) and deploy.
