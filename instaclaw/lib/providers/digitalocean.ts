import { logger } from "../logger";
import { getInstallOpenClawUserData } from "../cloud-init";
import type { CloudProvider, ServerConfig, ServerResult } from "./types";

const DO_BASE = "https://api.digitalocean.com/v2";

function getToken(): string {
  const token = process.env.DIGITALOCEAN_API_TOKEN;
  if (!token) throw new Error("DIGITALOCEAN_API_TOKEN not set");
  return token;
}

async function doFetch(path: string, options?: RequestInit) {
  const res = await fetch(`${DO_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${getToken()}`,
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`DigitalOcean API ${res.status}: ${body}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

async function getSSHKeyFingerprint(name: string): Promise<string> {
  const data = await doFetch("/account/keys");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const key = data.ssh_keys.find((k: any) => k.name === name);
  if (!key)
    throw new Error(`SSH key "${name}" not found in DigitalOcean`);
  return key.fingerprint;
}

async function getFirewallId(name: string): Promise<string> {
  const data = await doFetch("/firewalls");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fw = data.firewalls.find((f: any) => f.name === name);
  if (!fw)
    throw new Error(`Firewall "${name}" not found in DigitalOcean`);
  return fw.id;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DO_DEFAULTS = {
  sshKeyName: "instaclaw-deploy",
  firewallName: "instaclaw-firewall",
  size: "s-2vcpu-4gb",
  image: "ubuntu-24-04-x64",
  region: "nyc1",
  tag: "instaclaw",
} as const;

/**
 * Returns the snapshot image ID if set, otherwise falls back to ubuntu-24-04-x64.
 */
function getImage(): string {
  return process.env.DIGITALOCEAN_SNAPSHOT_ID || DO_DEFAULTS.image;
}

/**
 * Generate lightweight cloud-init user_data for personalizing a snapshot-based VM.
 * Regenerates SSH host keys, machine-id, and resets the openclaw config.
 * Returns the script string, or undefined for fresh installs (which use
 * the full getInstallOpenClawUserData() script instead).
 */
function getSnapshotUserData(): string | undefined {
  if (!process.env.DIGITALOCEAN_SNAPSHOT_ID) return undefined;

  return `#!/bin/bash
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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDropletIPv4(
  droplet: { networks: { v4: { ip_address: string; type: string }[] } }
): string {
  const pub = droplet.networks.v4.find(
    (n: { type: string }) => n.type === "public"
  );
  return pub?.ip_address ?? "";
}

// ---------------------------------------------------------------------------
// CloudProvider implementation
// ---------------------------------------------------------------------------

export const digitalOceanProvider: CloudProvider = {
  name: "digitalocean",

  isConfigured(): boolean {
    return !!process.env.DIGITALOCEAN_API_TOKEN;
  },

  async createServer(config: ServerConfig): Promise<ServerResult> {
    const sshFingerprint = await getSSHKeyFingerprint(DO_DEFAULTS.sshKeyName);
    const image = getImage();

    // Snapshot VMs get a lightweight personalization script;
    // fresh installs get the full OpenClaw install script.
    const snapshotUserData = getSnapshotUserData();
    const userData =
      config.userData ?? snapshotUserData ?? getInstallOpenClawUserData();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: Record<string, any> = {
      name: config.name,
      region: DO_DEFAULTS.region,
      size: DO_DEFAULTS.size,
      image,
      ssh_keys: [sshFingerprint],
      tags: [DO_DEFAULTS.tag],
      user_data: userData,
    };

    const data = await doFetch("/droplets", {
      method: "POST",
      body: JSON.stringify(body),
    });

    const droplet = data.droplet;

    // Apply firewall via tag (DigitalOcean firewalls attach by tag)
    try {
      const firewallId = await getFirewallId(DO_DEFAULTS.firewallName);
      await doFetch(`/firewalls/${firewallId}/tags`, {
        method: "POST",
        body: JSON.stringify({ tags: [DO_DEFAULTS.tag] }),
      });
    } catch (err) {
      logger.warn("Failed to apply DO firewall (non-fatal)", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return {
      providerId: String(droplet.id),
      provider: "digitalocean",
      ip: getDropletIPv4(droplet) || "",
      name: droplet.name,
      region: DO_DEFAULTS.region,
      serverType: DO_DEFAULTS.size,
      status: droplet.status,
    };
  },

  async waitForServer(
    providerId: string,
    timeoutMs = 120_000
  ): Promise<ServerResult> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const data = await doFetch(`/droplets/${providerId}`);
      const droplet = data.droplet;
      const ip = getDropletIPv4(droplet);

      if (droplet.status === "active" && ip) {
        return {
          providerId: String(droplet.id),
          provider: "digitalocean",
          ip,
          name: droplet.name,
          region: DO_DEFAULTS.region,
          serverType: DO_DEFAULTS.size,
          status: droplet.status,
        };
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
    throw new Error(
      `Droplet ${providerId} did not become active within ${timeoutMs / 1000}s`
    );
  },

  async deleteServer(providerId: string): Promise<void> {
    await doFetch(`/droplets/${providerId}`, { method: "DELETE" });
  },
};
