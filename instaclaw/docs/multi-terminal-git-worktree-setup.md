# Multi-Terminal Git Worktree Setup

**Status:** Recommended workflow (proposed 2026-05-16-PM)
**Motivated by:** 2026-05-16 incident where multiple Claude Code terminals operating in the same working tree caused commit cross-contamination — IR's Phase 2 freeze-v2 files (route.ts + middleware.ts) were swept into the gbrain terminal's `fix(install-gbrain.sh)` commit because both terminals shared the same `.git/index` and the staging state interleaved unpredictably.

## 1. The problem in one paragraph

`/Users/cooperwrenn/wild-west-bots/` is a single git working tree. Git's index — the staging area `git add` writes to — is global to a working tree. When two Claude Code terminals both `cd` into that directory and run `git add`/`git commit` concurrently, they share the index. Terminal A stages files; before A commits, B's commit fires and captures A's staged changes as if they were B's work. Commit messages and contents diverge. The `git reflog` of the resulting weeks-of-work-in-flight session is unrecognizable (see the 2026-05-16 reflog for HEAD@{4-7}: my correctly-prepared Phase 2 commit `99e91f77` contained ZERO of my files — they were already in the other terminal's pending stage).

Git worktrees fix this. `git worktree add <path>` creates a second working tree linked to the same `.git/` directory but with its own index, its own HEAD pointer, and its own files on disk. Each terminal works in its own worktree. The branches converge through normal merges.

## 2. What's already in place

`git worktree list` on Cooper's machine as of 2026-05-16 shows:

```
/Users/cooperwrenn/wild-west-bots                main         (current main)
/Users/cooperwrenn/wild-west-bots-changelog      feat/automated-changelog
/Users/cooperwrenn/wild-west-bots-xmtp           feat/posthog-and-backfill
/private/tmp/merge-dryrun                        detached HEAD
/private/tmp/wwb-privacy-audit                   feat/edge-privacy-mode-v0 (prunable; dir deleted)
```

So the pattern is already established for feature branches (sibling dirs named `wild-west-bots-<purpose>`). The problem is that the **Claude Code terminals haven't been using it.** All recent agent sessions have run inside `/Users/cooperwrenn/wild-west-bots/` against `main` directly, sharing the index.

## 3. The setup, per terminal

When starting a new Claude Code terminal for any non-trivial task that will touch the repo:

```bash
# 1. From the main repo, create a new worktree on a feature branch.
cd /Users/cooperwrenn/wild-west-bots
git fetch origin main
git worktree add ../wild-west-bots-<terminal-name> -b feat/<terminal-task-name> origin/main

# 2. Move into the new worktree's instaclaw subdir.
cd ../wild-west-bots-<terminal-name>/instaclaw

# 3. Copy the env files (they're gitignored — must be present in each worktree).
cp /Users/cooperwrenn/wild-west-bots/instaclaw/.env.local .
cp /Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key .
chmod 600 .env.ssh-key

# 4. Install dependencies (one-time per worktree, ~30s, ~1GB disk).
npm install --no-audit --no-fund

# 5. (Optional) link Vercel project if you need vercel CLI from this worktree.
#    Each worktree's .vercel/project.json is independent; without this the
#    `npx vercel` commands won't know which project they're against.
npx vercel link --yes --project instaclaw
```

`<terminal-name>` examples (chosen for clarity in `git worktree list` output):
- `IR` — incident response
- `gbrain` — gbrain HTTP sidecar work
- `village` — edgeclaw village
- `freeze-v2` — freeze/thaw v2 substrate
- `cloud-init` — cloud-init bootstrap work

`<terminal-task-name>` is the branch identifier. Use `feat/<topic>-<date>` for date-scoped sessions or `feat/<topic>` for ongoing tracks. Examples: `feat/freeze-v2-2026-05-16`, `feat/gbrain-http-sidecar`.

## 4. How a terminal discovers its own path

Each Claude Code terminal needs to know which worktree it's running in so it can `cd` to the right place at session start. Three approaches, ordered by simplicity:

**A. The launcher's `cwd` already reflects it.** The terminal launches Claude Code from within the worktree, so the working directory is correct from message 1. This is the recommended pattern. The agent does NOT need to discover the path — it inherits it.

**B. Filename convention `.claude-terminal-name`.** Drop a `.claude-terminal-name` file at the worktree root containing the terminal identifier (`IR`, `gbrain`, etc.). The agent reads it on startup. Excluded via `.gitignore` so it never gets committed.

**C. Env var `CLAUDE_TERMINAL_NAME`.** Set in the shell profile that launches the terminal. Visible to the agent via `process.env.CLAUDE_TERMINAL_NAME`. Slightly more friction to set up than B.

A is the cleanest default. B/C exist if a session needs to introspect its identity (e.g., to label log entries).

## 5. Workflow: starting work, ending work

**Start of session:**

```bash
cd /Users/cooperwrenn/wild-west-bots-<terminal-name>/instaclaw
git fetch origin
git pull --rebase origin main         # OR: git rebase origin/main if branch diverged
# work happens here — git add/commit affect ONLY this worktree's index
```

**Ready to integrate:**

```bash
# Option A (preferred for non-trivial changes): PR flow
git push origin feat/<terminal-task-name>
gh pr create --base main --title "..." --body "..."
# Cooper reviews + merges via GitHub

# Option B (small changes, no review needed): direct merge to main
git fetch origin main
git rebase origin/main                # resolve any conflicts here, in this worktree
git push origin feat/<terminal-task-name>
# Then merge via gh pr merge or git push origin HEAD:main (if linear-history allowed)
```

**End of worktree (work done, branch merged):**

```bash
cd /Users/cooperwrenn/wild-west-bots
git worktree remove ../wild-west-bots-<terminal-name>     # deletes the dir + git ref
git branch -d feat/<terminal-task-name>                    # delete the local branch
```

`git worktree remove` refuses to delete a worktree with uncommitted changes. To force: `git worktree remove --force`. Don't force unless you're certain.

## 6. What's shared vs per-worktree

| Resource | Scope | Notes |
|---|---|---|
| `.git/` (refs, objects, config) | Shared | All worktrees see the same git history, branches, tags |
| Git index / staging area | **Per-worktree** | This is the fix — concurrent `git add` no longer collides |
| Git HEAD pointer | **Per-worktree** | Each worktree can be on a different branch |
| Working-tree files | **Per-worktree** | Each has its own copy on disk |
| **`.env.local`, `.env.ssh-key`** | **Per-worktree** (manual copy needed) | Gitignored. Step 3 in setup above copies from main. |
| **`node_modules/`** | **Per-worktree** (`npm install` per worktree) | ~1 GB. Could be symlinked / pnpm-storied to reduce duplication, but per-worktree is simpler. |
| `.next/` build cache | **Per-worktree** | Build output. Each worktree's `next build` is independent. |
| `.vercel/project.json` | **Per-worktree** (run `vercel link` per worktree) | Otherwise `npx vercel` can't find the project. |
| Git stashes | Shared (`.git/refs/stash`) | **GOTCHA** — see §7. |
| Husky pre-commit hooks (`../.husky/`) | Shared | Hooks fire in whichever worktree is committing. No collision. |
| `/tmp/ic_ssh_key` (decoded SSH key) | Shared (user-scoped, not worktree-scoped) | Same key works from any worktree. |

## 7. Risks and gotchas

### 7.1 Stashes are global

`git stash push` writes to `.git/refs/stash`, which is shared across all worktrees of the same repo. If terminal A stashes a change and terminal B runs `git stash pop`, B gets A's stashed work. This caused real confusion during the 2026-05-16 incident.

**Mitigation:** prefer commits over stashes. If you must stash, name it descriptively:

```bash
git stash push -u -m "IR-terminal: pre-rebase WIP 2026-05-16T18:00"
```

And always `git stash apply stash@{N}` rather than `git stash pop` so other terminals can still see the stash and figure out it isn't theirs. List stashes via `git stash list` before popping anything.

### 7.2 Same branch in two worktrees is refused

`git worktree add ../wt-A main` fails if `main` is already checked out in `/Users/cooperwrenn/wild-west-bots`. By design — you can't have the same branch in two worktrees simultaneously. Always create a feature branch with `-b`:

```bash
git worktree add ../wild-west-bots-IR -b feat/IR-session-2026-05-16 origin/main
```

There's a `--force` to allow same-branch worktrees, but **don't use it** — it reintroduces the index-collision problem.

### 7.3 Pre-existing files on disk in the target dir

`git worktree add ../wild-west-bots-IR` refuses if `../wild-west-bots-IR` already exists with files. Either remove the dir first (`rm -rf ../wild-west-bots-IR`) or pick a different name.

### 7.4 First-time `npm install` per worktree

Each worktree needs its own `node_modules/`. The first `npm install` in a new worktree takes ~30 seconds and consumes ~1 GB of disk. Across N worktrees that's N × 1 GB. Acceptable for now (Cooper's MacBook has plenty of disk), but if it becomes a problem, options:

- **pnpm with content-addressable store**: switch the project to pnpm. `pnpm install` hardlinks to a global store; per-worktree disk usage drops to ~150 MB.
- **Symlink `node_modules/` from main**: brittle (different worktrees on different branches may have different package.json → mismatched modules). Don't do this.

### 7.5 `npx vercel` confusion across worktrees

Earlier today (2026-05-16) the Vercel CLI ran from `/Users/cooperwrenn/wild-west-bots/instaclaw` failed with `path "~/wild-west-bots/instaclaw/instaclaw" does not exist` — the linked project's `rootDirectory` was misconfigured for that specific working tree. Each worktree's `.vercel/project.json` is independent; if one is misconfigured the others aren't affected.

**Mitigation:** run `npx vercel link --yes` once per worktree. If linking fails, the fallback `git commit --allow-empty + git push origin main` always works.

### 7.6 `.env.local` divergence

If terminal A modifies `.env.local` in its worktree and terminal B doesn't pick up the change, they have different views of secrets. This is rare in practice (env updates happen via Vercel dashboard, then `vercel env pull` updates `.env.local`), but worth being explicit about: **`.env.local` is gitignored per worktree, and may drift.**

If a terminal needs an updated secret, run `npx vercel env pull --environment=production --yes` from that worktree.

### 7.7 Git hooks fire from the active worktree

Husky's pre-commit hook lives in `../.husky/pre-commit` and is shared. The hook fires in whichever worktree is committing, with `cwd` set to that worktree. The hook's `git diff --cached --name-only` only sees the staging from that worktree's index. So no cross-contamination here — the hook just works.

### 7.8 Two worktrees pulling main at the same time

If terminal A and terminal B both `git pull --rebase origin main` at the same instant against different branches, they don't conflict (each operates on its own ref). The shared `.git/objects` is append-only and concurrent-safe by git's design.

But if both are on the same branch (which we explicitly disallow per §7.2), the second pull would race-fail.

### 7.9 `git worktree prune` cleans up stale references

If a worktree directory is deleted directly (`rm -rf`) instead of via `git worktree remove`, git keeps a stale reference. List shows `prunable` next to it. `git worktree prune` cleans these. Run periodically — no harm if there's nothing to prune.

## 8. Recommended CLAUDE.md rule addition

Add to the rules section after the most recent rule (currently Rule 55, per the village terminal's just-shipped addition):

> ### Rule 56 (or next available number) — Each parallel Claude Code terminal MUST work in its own git worktree
>
> When more than one Claude Code session is operating on the same repo at the same time — even loosely "in parallel" with hours of gap between them — each MUST run from a separate git worktree (sibling directory of the main repo). Shared working trees cause `.git/index` collisions: one terminal's staged files get captured in another terminal's commit, producing commits whose contents don't match their messages.
>
> **The 2026-05-16 incident:** IR's Phase 2 freeze-v2 work (route.ts + middleware.ts) was swept into gbrain's `fix(install-gbrain.sh)` commit because both terminals were `cd`-ing to `/Users/cooperwrenn/wild-west-bots/instaclaw`. IR's commits 99e91f77 and 483ac8cd contained ZERO of IR's intended files. `git reset HEAD~1` then dropped the bogus commit. Root cause: shared index.
>
> **Setup**: see `instaclaw/docs/multi-terminal-git-worktree-setup.md`. One worktree per terminal session, named `wild-west-bots-<terminal-name>`, on a `feat/<terminal-task>` branch off main. End-of-session: `git worktree remove`.
>
> **Banned pattern**: any Claude Code agent session running from `/Users/cooperwrenn/wild-west-bots/` directly while another session is active in the same dir. The first session that lands there should warn the user before doing any git operation; subsequent sessions should refuse to write anything until they're moved.
>
> **Stash hygiene**: stashes are GLOBAL across worktrees (`.git/refs/stash`). Always name stashes with the terminal identifier (`git stash push -m "<terminal>: <reason>"`) and prefer `git stash apply` over `git stash pop` so other terminals can still see them. Better yet: commit instead of stash.

## 9. Migration from current state

The 4+ Claude Code terminals currently running ALL share `/Users/cooperwrenn/wild-west-bots/`. They can't all be moved to worktrees simultaneously — that would be disruptive. Recommended migration:

1. **Today (immediate)**: Cooper picks the "lead" terminal that stays in `/Users/cooperwrenn/wild-west-bots/`. All others should:
   - Finish their current commit + push (one at a time, coordinated via Cooper)
   - Exit
   - Restart in a new worktree per §3
2. **Going forward**: every new Claude Code session for non-trivial work starts in a fresh worktree. Cooper sets the pattern by always saying "start in `wild-west-bots-<name>/instaclaw`" at session-spawn time.
3. **CLAUDE.md rule lands** so future agent sessions know to honor this without being told each time.

If a session breaks the rule and the agent realizes mid-work, the agent should report the violation and offer to migrate (move uncommitted changes to a fresh worktree). Don't try to "just be careful" within the shared dir — the index-collision is structural, not procedural.

## 10. Open questions for Cooper

1. **Should we use pnpm to reduce per-worktree disk?** Adds setup overhead but saves ~800 MB per worktree. Probably wait until 6+ active worktrees are normal.
2. **Should `vercel link` be automated via a setup script?** A `bin/setup-worktree.sh` could do steps 3-5 of §3 in one shot. Small but real ergonomic win.
3. **Should we standardize the worktree path scheme?** Currently mixed: `wild-west-bots-changelog` (sibling), `/private/tmp/merge-dryrun` (tmp). Sticking to siblings of `wild-west-bots/` keeps things discoverable via `git worktree list`.
4. **For "/loop" or autonomous Claude Code sessions running on cron — should they get their own dedicated worktrees too?** If they only run a few minutes and never concurrently with humans, sharing main might be acceptable. If they overlap with active human-driven terminals, they need isolation.

These are answerable when the basic worktree pattern is in steady use for a week.
