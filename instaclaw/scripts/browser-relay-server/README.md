# Browser Relay Server

VM-side WebSocket server that bridges the InstaClaw Browser Relay Chrome extension to the agent's browser plugin, replacing the OpenClaw extension relay subsystem that was removed upstream (CHANGELOG: *"Browser/Chrome MCP: remove the legacy Chrome extension relay path…"*).

## Why this exists

- Our `instaclaw-chrome-extension/background.js` is forked from OpenClaw chrome-extension at version 2026.2.24 and still expects the original protocol (`openclaw-extension-relay-v1`, port 18792, `connect.challenge`/`connect`/`forwardCDPCommand`/`forwardCDPEvent`).
- Fleet runs OpenClaw 2026.4.5; the relay is gone from `node_modules/openclaw`.
- The Caddyfile baked into the snapshot still proxies `/relay/*` to `localhost:18792`. Without something listening there, every install gets `502 Bad Gateway` and the user sees the misleading "Cannot reach relay — check Gateway URL" message.

This server fills that gap. Same deployment shape as `dispatch-server.js` (the user-side computer-control relay) — own systemd user unit, restart=always, audit log under `~/.openclaw/workspace/`.

## What it does

1. Listens on `127.0.0.1:18792` (HTTP + WS via the same `http.createServer`).
2. Accepts the extension's WebSocket at `/extension/connect`, validates the HMAC token query param against `HMAC-SHA256(GATEWAY_TOKEN, "openclaw-extension-relay-v1:18792")`, and runs the `connect.challenge`/`connect` handshake (echoing the server-issued nonce, also re-validating the inner `auth.token` plain value).
3. Tracks targets attached by the extension via `Target.attachedToTarget` events, removing them on `Target.detachedFromTarget`.
4. Emulates Chromium's CDP discovery surface (`/json/version`, `/json/list`, `/devtools/page/<targetId>`) so the agent's browser plugin can connect to attached extension tabs as if they were real Chromium pages.
5. Bridges CDP commands and events between the gateway-side per-target WS and the extension's `forwardCDPCommand`/`forwardCDPEvent` channel.
6. Exposes `/extension/status` for the dashboard's "Extension Connected · Live" indicator (already polled from `instaclaw/app/api/vm/extension-status/route.ts`).

## What's still on Cooper

The server is built and wired through Caddy (the existing `handle /relay/* { reverse_proxy localhost:18792 }` rule already points here). What still needs configuration is the gateway-side: telling OpenClaw's browser plugin to use **this** server as its CDP endpoint instead of the local Chromium on port 18800.

In `~/.openclaw/openclaw.json`, the agent's browser profile currently points at:

```json
"browser": {
  "executablePath": "/usr/local/bin/chromium-browser",
  "headless": true,
  "profiles": {
    "openclaw": { "cdpPort": 18800 }
  }
}
```

To switch to extension-driven browsing, OpenClaw's `existing-session` driver needs to be configured with a CDP host pointing at `127.0.0.1:18792`. The exact key is upstream-dependent; running `openclaw doctor --fix` (per the CHANGELOG migration note) is the suggested starting point.

**This means the server is shipped but not yet wired into the agent's browse path.** Standalone effect of deploying this:

- ✅ Extension WS handshake succeeds; users see "Extension Connected · Live" in the dashboard
- ✅ Dashboard maintenance banner can be removed once a soak window confirms the handshake is stable
- ⚠️ Agent can't yet drive the extension's browser — gateway browser plugin still talks to local Chromium on 18800
- ⚠️ When agent browse traffic should switch over: configure OpenClaw browser to use existing-session at `127.0.0.1:18792`, document in v64 manifest

That last step is its own focused change — the server here is the foundation, not the whole feature.

## Files

- `browser-relay-server.js` — the server. ~400 lines, deployed to `/home/openclaw/scripts/browser-relay-server.js`.
- `browser-relay-server.service` — systemd user unit, deployed to `~/.config/systemd/user/browser-relay-server.service`.
- `deploy.sh` — idempotent fleet deploy helper. SSHes to a VM, copies the two files, enables + starts the unit, verifies the WS is accepting connections.

## Deploy to one VM (smoke test)

```bash
cd instaclaw
npx tsx scripts/_deploy-browser-relay-to-vm.ts --vm vm-860
```

Verify (from your laptop):

```bash
# Health check via Caddy
curl -sI https://<vm-id>.vm.instaclaw.io/relay/extension/status
# Expect: HTTP/2 200, body: {"connected":false,"connectedAt":null,"targets":0}
```

Then install the extension in Chrome, paste the gateway URL, click Save. The server log should show `extension connected` and `extension handshake complete`. The dashboard should flip to "Extension Connected · Live" within ~15s.

## Verify locally (no extension)

```bash
node browser-relay-server.js &
curl -s http://127.0.0.1:18792/                 # → ok
curl -s http://127.0.0.1:18792/extension/status # → {"connected":false,...}
curl -s http://127.0.0.1:18792/json/version     # → CDP banner
curl -s http://127.0.0.1:18792/json/list        # → []
```

## Fleet rollout

After single-VM smoke-test passes:

1. Add the server install to `configureOpenClaw()` in `lib/ssh.ts` (mirroring how `dispatch-server.js` is currently installed). Bump `VM_MANIFEST.version` to v64.
2. Reconciler picks up the new manifest, deploys to existing fleet over the next few hours.
3. Bake a fresh snapshot once 100% of healthy VMs report manifest v64 (CLAUDE.md Rule 7).
4. Once observable in production for ~24h: remove the maintenance banner from the dashboard + `/browser-relay` docs page.

## Tearing it down (rollback)

```bash
systemctl --user disable --now browser-relay-server.service
rm ~/.config/systemd/user/browser-relay-server.service
rm /home/openclaw/scripts/browser-relay-server.js
systemctl --user daemon-reload
```

Caddy keeps proxying `/relay/*` to `localhost:18792` — that returns to 502 immediately, dashboard maintenance banner shows again, no other side-effects.
