import { randomBytes } from "crypto";
import { logger } from "../logger";
import {
  getInstallOpenClawUserData,
  getConfigProtectionScript,
  getBrowserSetupScript,
} from "../cloud-init";
import type { CloudProvider, ServerConfig, ServerResult } from "./types";

const LINODE_BASE = "https://api.linode.com/v4";

function getToken(): string {
  const token = process.env.LINODE_API_TOKEN;
  if (!token) throw new Error("LINODE_API_TOKEN not set");
  return token;
}

async function linodeFetch(path: string, options?: RequestInit) {
  const res = await fetch(`${LINODE_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${getToken()}`,
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Linode API ${res.status}: ${body}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

async function getSSHPublicKey(label: string): Promise<string> {
  const data = await linodeFetch("/profile/sshkeys");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const key = data.data.find((k: any) => k.label === label);
  if (!key)
    throw new Error(`SSH key "${label}" not found in Linode profile`);
  return key.ssh_key;
}

async function getFirewallId(label: string): Promise<number> {
  const data = await linodeFetch("/networking/firewalls");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fw = data.data.find((f: any) => f.label === label);
  if (!fw)
    throw new Error(`Firewall "${label}" not found in Linode`);
  return fw.id;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a random root password meeting Linode requirements:
 * 7-128 chars, uppercase, lowercase, number, special char.
 * This password is never used (SSH key auth only) but Linode requires it.
 */
function generateRootPass(): string {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghjkmnpqrstuvwxyz";
  const digits = "23456789";
  const special = "!@#$%^&*";
  const all = upper + lower + digits + special;
  const bytes = randomBytes(32);

  // Guarantee one of each required class in first 4 chars
  let pass =
    upper[bytes[0] % upper.length] +
    lower[bytes[1] % lower.length] +
    digits[bytes[2] % digits.length] +
    special[bytes[3] % special.length];

  for (let i = 4; i < 32; i++) {
    pass += all[bytes[i] % all.length];
  }
  return pass;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const LINODE_DEFAULTS = {
  sshKeyLabel: "instaclaw-deploy",
  firewallLabel: "instaclaw-firewall",
  type: "g6-standard-2",
  image: "linode/ubuntu24.04",
  region: "us-east",
  tag: "instaclaw",
} as const;

/**
 * Returns the snapshot image ID if set, otherwise falls back to linode/ubuntu24.04.
 */
function getImage(): string {
  return process.env.LINODE_SNAPSHOT_ID || LINODE_DEFAULTS.image;
}

/**
 * Generate lightweight cloud-init user_data for personalizing a snapshot-based VM.
 * Regenerates SSH host keys, machine-id, and resets the openclaw config.
 * Returns base64-encoded script, or undefined for fresh installs (which use
 * the full getInstallOpenClawUserData() script instead).
 */
function getSnapshotUserData(): string | undefined {
  if (!process.env.LINODE_SNAPSHOT_ID) return undefined;

  const script = `#!/bin/bash
set -euo pipefail
OPENCLAW_USER="openclaw"
CONFIG_DIR="/home/\${OPENCLAW_USER}/.openclaw"

rm -f /etc/ssh/ssh_host_* 2>/dev/null || true
dpkg-reconfigure openssh-server 2>/dev/null || ssh-keygen -A
systemd-machine-id-setup

# Embed deploy key directly (provider may not inject root keys for snapshots)
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

# Install config protection scripts
${getConfigProtectionScript()}

# Install browser (Chromium + Playwright + swap)
${getBrowserSetupScript()}

touch /tmp/.instaclaw-personalized
`;

  return script;
}

// ---------------------------------------------------------------------------
// CloudProvider implementation
// ---------------------------------------------------------------------------

export const linodeProvider: CloudProvider = {
  name: "linode",

  isConfigured(): boolean {
    return !!process.env.LINODE_API_TOKEN;
  },

  async createServer(config: ServerConfig): Promise<ServerResult> {
    const sshPublicKey = await getSSHPublicKey(LINODE_DEFAULTS.sshKeyLabel);
    const image = getImage();
    const isSnapshot = !!process.env.LINODE_SNAPSHOT_ID;

    // Snapshot VMs get a lightweight personalization script;
    // fresh installs get the full OpenClaw install script.
    const snapshotUserData = getSnapshotUserData();
    const userData =
      config.userData ??
      snapshotUserData ??
      getInstallOpenClawUserData();
    const userDataB64 = Buffer.from(userData).toString("base64");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: Record<string, any> = {
      label: config.name,
      region: LINODE_DEFAULTS.region,
      type: LINODE_DEFAULTS.type,
      image,
      root_pass: generateRootPass(),
      authorized_keys: [sshPublicKey],
      booted: true,
      tags: [LINODE_DEFAULTS.tag],
      metadata: {
        user_data: userDataB64,
      },
    };

    logger.info("Creating Linode instance", {
      route: "lib/providers/linode",
      name: config.name,
      image,
      isSnapshot,
    });

    // Attach firewall if available
    try {
      const firewallId = await getFirewallId(LINODE_DEFAULTS.firewallLabel);
      body.firewall_id = firewallId;
    } catch (err) {
      logger.warn("Failed to find Linode firewall (non-fatal)", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const data = await linodeFetch("/linode/instances", {
      method: "POST",
      body: JSON.stringify(body),
    });

    return {
      providerId: String(data.id),
      provider: "linode",
      ip: data.ipv4?.[0] ?? "",
      name: data.label,
      region: LINODE_DEFAULTS.region,
      serverType: LINODE_DEFAULTS.type,
      status: data.status,
    };
  },

  async waitForServer(
    providerId: string,
    timeoutMs = 120_000
  ): Promise<ServerResult> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const data = await linodeFetch(`/linode/instances/${providerId}`);

      if (data.status === "running" && data.ipv4?.[0]) {
        return {
          providerId: String(data.id),
          provider: "linode",
          ip: data.ipv4[0],
          name: data.label,
          region: LINODE_DEFAULTS.region,
          serverType: LINODE_DEFAULTS.type,
          status: data.status,
        };
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
    throw new Error(
      `Linode instance ${providerId} did not become running within ${timeoutMs / 1000}s`
    );
  },

  async deleteServer(providerId: string): Promise<void> {
    await linodeFetch(`/linode/instances/${providerId}`, { method: "DELETE" });
  },
};
