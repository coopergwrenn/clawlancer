/**
 * GoDaddy DNS API for automatic subdomain creation
 * Used to create DNS A records for each VM to enable TLS
 *
 * Production credentials configured: 2026-02-08
 */

import { logger } from "./logger";

const GODADDY_API = "https://api.godaddy.com/v1";
const DOMAIN = "instaclaw.io";

/**
 * Create a DNS A record for a VM: <vm-id>.vm.instaclaw.io → <ip>
 * Requires GODADDY_API_KEY and GODADDY_API_SECRET env vars.
 * Returns true on success, false if DNS is not configured.
 */
export async function createVMDNSRecord(
  vmId: string,
  ipAddress: string
): Promise<boolean> {
  const apiKey = process.env.GODADDY_API_KEY;
  const apiSecret = process.env.GODADDY_API_SECRET;

  if (!apiKey || !apiSecret) {
    logger.warn("GoDaddy DNS not configured, skipping TLS setup", {
      route: "lib/godaddy",
    });
    return false;
  }

  // Subdomain: vm-01.vm.instaclaw.io
  // Name for GoDaddy API: vm-01.vm
  const name = `${vmId}.vm`;

  try {
    // Check if record already exists
    const existingRes = await fetch(
      `${GODADDY_API}/domains/${DOMAIN}/records/A/${name}`,
      {
        method: "GET",
        headers: {
          Authorization: `sso-key ${apiKey}:${apiSecret}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (existingRes.ok) {
      // Record exists, update it
      const updateRes = await fetch(
        `${GODADDY_API}/domains/${DOMAIN}/records/A/${name}`,
        {
          method: "PUT",
          headers: {
            Authorization: `sso-key ${apiKey}:${apiSecret}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify([
            {
              data: ipAddress,
              ttl: 600, // 10 minutes - faster propagation for VMs
            },
          ]),
        }
      );

      if (!updateRes.ok) {
        const body = await updateRes.text();
        logger.error("Failed to update GoDaddy DNS record", {
          error: body,
          route: "lib/godaddy",
          vmId,
          name,
        });
        return false;
      }

      logger.info("Updated existing GoDaddy DNS record", {
        route: "lib/godaddy",
        vmId,
        hostname: `${name}.${DOMAIN}`,
      });
      return true;
    }

    // Record doesn't exist, create it
    const createRes = await fetch(
      `${GODADDY_API}/domains/${DOMAIN}/records`,
      {
        method: "PATCH",
        headers: {
          Authorization: `sso-key ${apiKey}:${apiSecret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify([
          {
            type: "A",
            name: name,
            data: ipAddress,
            ttl: 600,
          },
        ]),
      }
    );

    if (!createRes.ok) {
      const body = await createRes.text();
      logger.error("Failed to create GoDaddy DNS record", {
        error: body,
        route: "lib/godaddy",
        vmId,
        name,
      });
      return false;
    }

    logger.info("Created GoDaddy DNS record", {
      route: "lib/godaddy",
      vmId,
      hostname: `${name}.${DOMAIN}`,
    });
    return true;
  } catch (err) {
    logger.error("GoDaddy DNS API error", {
      error: String(err),
      route: "lib/godaddy",
      vmId,
    });
    return false;
  }
}

/**
 * Delete a DNS record for a VM
 */
export async function deleteVMDNSRecord(vmId: string): Promise<void> {
  const apiKey = process.env.GODADDY_API_KEY;
  const apiSecret = process.env.GODADDY_API_SECRET;

  if (!apiKey || !apiSecret) return;

  const name = `${vmId}.vm`;

  try {
    await fetch(`${GODADDY_API}/domains/${DOMAIN}/records/A/${name}`, {
      method: "DELETE",
      headers: {
        Authorization: `sso-key ${apiKey}:${apiSecret}`,
      },
    });
  } catch (err) {
    logger.error("Failed to delete GoDaddy DNS record", {
      error: String(err),
      route: "lib/godaddy",
      vmId,
    });
  }
}
