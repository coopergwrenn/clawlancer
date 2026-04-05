import type { CloudProvider } from "./types";
import { hetznerProvider } from "./hetzner";
import { digitalOceanProvider } from "./digitalocean";
import { linodeProvider } from "./linode";

export type { CloudProvider, ServerConfig, ServerResult } from "./types";

// Linode is the ONLY provider for new VM provisioning.
// Hetzner and DigitalOcean are legacy — existing VMs only, accessible via getProvider()
// but never used for new provisioning (pool-monitor, onboarding, etc.).
const PROVIDERS: CloudProvider[] = [linodeProvider];

export function getProvider(name: "hetzner" | "digitalocean" | "linode"): CloudProvider {
  const provider = PROVIDERS.find((p) => p.name === name);
  if (!provider) throw new Error(`Unknown provider: ${name}`);
  if (!provider.isConfigured())
    throw new Error(`Provider ${name} is not configured (missing API token)`);
  return provider;
}

/**
 * Returns the first configured provider (hetzner preferred, digitalocean fallback).
 */
export function getAvailableProvider(): CloudProvider {
  const provider = PROVIDERS.find((p) => p.isConfigured());
  if (!provider)
    throw new Error("No cloud provider configured. Set HETZNER_API_TOKEN, DIGITALOCEAN_API_TOKEN, or LINODE_API_TOKEN.");
  return provider;
}

/**
 * Returns all configured providers.
 */
export function getAllProviders(): CloudProvider[] {
  return PROVIDERS.filter((p) => p.isConfigured());
}
