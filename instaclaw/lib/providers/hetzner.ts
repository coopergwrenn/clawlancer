import { logger } from "../logger";
import type { CloudProvider, ServerConfig, ServerResult } from "./types";

const HETZNER_BASE = "https://api.hetzner.cloud/v1";

function getToken(): string {
  const token = process.env.HETZNER_API_TOKEN;
  if (!token) throw new Error("HETZNER_API_TOKEN not set");
  return token;
}

async function hetznerFetch(path: string, options?: RequestInit) {
  const res = await fetch(`${HETZNER_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${getToken()}`,
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Hetzner API ${res.status}: ${body}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export async function getSSHKeyId(name: string): Promise<number> {
  const data = await hetznerFetch("/ssh_keys");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const key = data.ssh_keys.find((k: any) => k.name === name);
  if (!key) throw new Error(`SSH key "${name}" not found in Hetzner`);
  return key.id;
}

export async function getFirewallId(name: string): Promise<number> {
  const data = await hetznerFetch("/firewalls");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fw = data.firewalls.find((f: any) => f.name === name);
  if (!fw) throw new Error(`Firewall "${name}" not found in Hetzner`);
  return fw.id;
}

// ---------------------------------------------------------------------------
// Server management
// ---------------------------------------------------------------------------

export interface HetznerServer {
  id: number;
  name: string;
  status: string;
  public_net: {
    ipv4: { ip: string };
  };
}

interface CreateServerOptions {
  name: string;
  serverType?: string;
  image?: string;
  location?: string;
  sshKeyId: number;
  firewallId: number;
  userData?: string;
}

export async function createServer(
  opts: CreateServerOptions
): Promise<HetznerServer> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body: Record<string, any> = {
    name: opts.name,
    server_type: opts.serverType ?? "cpx21",
    image: opts.image ?? "ubuntu-24.04",
    location: opts.location ?? "ash",
    ssh_keys: [opts.sshKeyId],
    firewalls: [{ firewall: opts.firewallId }],
  };
  if (opts.userData) {
    body.user_data = opts.userData;
  }
  const data = await hetznerFetch("/servers", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return data.server;
}

export async function waitForServer(
  serverId: number,
  timeoutMs = 120_000
): Promise<HetznerServer> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const data = await hetznerFetch(`/servers/${serverId}`);
    if (data.server.status === "running") return data.server;
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(
    `Server ${serverId} did not become ready within ${timeoutMs / 1000}s`
  );
}

export async function deleteServer(serverId: number): Promise<void> {
  await hetznerFetch(`/servers/${serverId}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const HETZNER_DEFAULTS = {
  sshKeyName: "instaclaw-deploy",
  firewallName: "instaclaw-firewall",
  serverType: "cpx21",
  image: "ubuntu-24.04",
  location: "ash",
  region: "us-east",
} as const;

/**
 * Returns the snapshot image ID if set, otherwise falls back to ubuntu-24.04.
 */
export function getImage(): string {
  return process.env.HETZNER_SNAPSHOT_ID || HETZNER_DEFAULTS.image;
}

/**
 * Generate cloud-init user_data for personalizing a snapshot-based VM.
 * Returns base64-encoded cloud-init script, or undefined for fresh installs.
 */
export function getSnapshotUserData(): string | undefined {
  if (!process.env.HETZNER_SNAPSHOT_ID) return undefined;

  const script = `#!/bin/bash
set -euo pipefail
OPENCLAW_USER="openclaw"
CONFIG_DIR="/home/\${OPENCLAW_USER}/.openclaw"

rm -f /etc/ssh/ssh_host_* 2>/dev/null || true
dpkg-reconfigure openssh-server 2>/dev/null || ssh-keygen -A
systemd-machine-id-setup

# Embed deploy key directly (snapshot may not have correct key baked in)
OPENCLAW_SSH="/home/\${OPENCLAW_USER}/.ssh"
mkdir -p "\${OPENCLAW_SSH}"
cat > "\${OPENCLAW_SSH}/authorized_keys" <<'SSHEOF'
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB9cr49D/z0kHvimN65SWqKOHqJrrJAI6W/VVLlIZ+k4 instaclaw-deploy
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICn5FKGDhYrRQm85VX5VtR+mXLt2U+8wfXYZZN+zuHFz instaclaw-deploy@vercel
SSHEOF
chown "\${OPENCLAW_USER}:\${OPENCLAW_USER}" "\${OPENCLAW_SSH}" "\${OPENCLAW_SSH}/authorized_keys"
chmod 700 "\${OPENCLAW_SSH}"
chmod 600 "\${OPENCLAW_SSH}/authorized_keys"

mkdir -p "\${CONFIG_DIR}"
chown "\${OPENCLAW_USER}:\${OPENCLAW_USER}" "\${CONFIG_DIR}"

cat > "\${CONFIG_DIR}/openclaw.json" <<'EOF'
{"_placeholder":true,"gateway":{"mode":"local","port":18789,"bind":"lan"}}
EOF
chown "\${OPENCLAW_USER}:\${OPENCLAW_USER}" "\${CONFIG_DIR}/openclaw.json"
chmod 600 "\${CONFIG_DIR}/openclaw.json"

rm -f /var/lib/fail2ban/fail2ban.sqlite3 2>/dev/null || true
systemctl restart fail2ban 2>/dev/null || true
if systemctl is-active ssh.service &>/dev/null; then systemctl restart ssh; fi

# Enable loginctl linger so systemd user services survive SSH disconnect
loginctl enable-linger "\${OPENCLAW_USER}" 2>/dev/null || true

touch /tmp/.instaclaw-personalized
`;

  return Buffer.from(script).toString("base64");
}

/**
 * Resolve SSH key ID and firewall ID from Hetzner by name.
 * Caches nothing — call once per request batch.
 */
export async function resolveHetznerIds() {
  const [sshKeyId, firewallId] = await Promise.all([
    getSSHKeyId(HETZNER_DEFAULTS.sshKeyName),
    getFirewallId(HETZNER_DEFAULTS.firewallName),
  ]);
  return { sshKeyId, firewallId };
}

/**
 * Get the next VM name based on existing names in Supabase.
 * Returns the numeric suffix to start from.
 */
export function getNextVmNumber(
  existingNames: (string | null)[],
  offset = 0
): number {
  let maxNum = 0;
  for (const name of existingNames) {
    const match = name?.match(/instaclaw-vm-(\d+)/);
    if (match) maxNum = Math.max(maxNum, parseInt(match[1]));
  }
  return maxNum + 1 + offset;
}

export function formatVmName(num: number): string {
  return `instaclaw-vm-${String(num).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// CloudProvider interface implementation
// ---------------------------------------------------------------------------

let cachedIds: { sshKeyId: number; firewallId: number } | null = null;

async function getCachedIds() {
  if (!cachedIds) {
    cachedIds = await resolveHetznerIds();
  }
  return cachedIds;
}

export const hetznerProvider: CloudProvider = {
  name: "hetzner",

  isConfigured(): boolean {
    return !!process.env.HETZNER_API_TOKEN;
  },

  async createServer(config: ServerConfig): Promise<ServerResult> {
    const { sshKeyId, firewallId } = await getCachedIds();
    const image = getImage();
    const userData = getSnapshotUserData();

    const server = await createServer({
      name: config.name,
      image,
      sshKeyId,
      firewallId,
      userData: config.userData ?? userData,
    });

    return {
      providerId: String(server.id),
      provider: "hetzner",
      ip: server.public_net?.ipv4?.ip ?? "",
      name: server.name,
      region: HETZNER_DEFAULTS.region,
      serverType: HETZNER_DEFAULTS.serverType,
      status: server.status,
    };
  },

  async waitForServer(providerId: string): Promise<ServerResult> {
    const server = await waitForServer(Number(providerId));
    return {
      providerId: String(server.id),
      provider: "hetzner",
      ip: server.public_net.ipv4.ip,
      name: server.name,
      region: HETZNER_DEFAULTS.region,
      serverType: HETZNER_DEFAULTS.serverType,
      status: server.status,
    };
  },

  async deleteServer(providerId: string): Promise<void> {
    await deleteServer(Number(providerId));
  },
};
