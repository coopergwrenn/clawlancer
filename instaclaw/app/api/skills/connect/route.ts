import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { deployIntegrationCredentials } from "@/lib/ssh";
import { logger } from "@/lib/logger";

export const maxDuration = 30;

// Integration-specific OAuth configs
// Each entry defines scopes, auth URL, and the env var key for storing tokens on the VM.
const OAUTH_CONFIGS: Record<
  string,
  {
    authUrl: string;
    scopes: string[];
    extraParams?: Record<string, string>;
    envPrefix: string;
  }
> = {
  "google-workspace": {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    scopes: [
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/drive.file",
    ],
    extraParams: {
      access_type: "offline",
      include_granted_scopes: "true",
      prompt: "consent",
    },
    envPrefix: "GOOGLE",
  },
};

// API key integrations: slug → env var key name + optional MCP config
const API_KEY_CONFIGS: Record<
  string,
  {
    envKey: string;
    validateUrl?: string;
    validateHeader?: string;
    mcpConfig?: {
      command: string;
      env?: Record<string, string>;
      scope?: string;
      description?: string;
    };
  }
> = {
  shopify: {
    envKey: "SHOPIFY_ACCESS_TOKEN",
    // Shopify Admin API validation — requires shop domain in the body too
  },
};

// Integrations that are coming soon (no active handler)
const COMING_SOON_SLUGS = new Set([
  "apple-notes",
  "apple-reminders",
  "trello",
  "slack",
]);

// Integrations with placeholder OAuth (skeleton handler, not wired up yet)
const PLACEHOLDER_OAUTH_SLUGS = new Set(["notion", "github"]);

const INTEGRATION_STATE_COOKIE = "ic_integration_state";

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { integrationSlug, apiKey, shopDomain } = body as {
      integrationSlug: unknown;
      apiKey?: unknown;
      shopDomain?: unknown;
    };

    if (typeof integrationSlug !== "string" || !integrationSlug) {
      return NextResponse.json(
        { error: "integrationSlug is required" },
        { status: 400 }
      );
    }

    // Check coming soon
    if (COMING_SOON_SLUGS.has(integrationSlug)) {
      return NextResponse.json(
        { error: "This integration is coming soon" },
        { status: 400 }
      );
    }

    // Check placeholder
    if (PLACEHOLDER_OAUTH_SLUGS.has(integrationSlug)) {
      return NextResponse.json(
        {
          error: `${integrationSlug} OAuth integration is coming soon. We're working on it!`,
          comingSoon: true,
        },
        { status: 400 }
      );
    }

    const supabase = getSupabase();

    // Look up integration in registry
    const { data: skill } = await supabase
      .from("instaclaw_skills")
      .select("id, slug, name, item_type, auth_type, status")
      .eq("slug", integrationSlug)
      .eq("item_type", "integration")
      .single();

    if (!skill) {
      return NextResponse.json(
        { error: `Integration not found: ${integrationSlug}` },
        { status: 404 }
      );
    }

    if (skill.status === "coming_soon") {
      return NextResponse.json(
        { error: "This integration is coming soon" },
        { status: 400 }
      );
    }

    // Get user's VM
    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("id, ip_address, ssh_port, ssh_user")
      .eq("assigned_to", session.user.id)
      .single();

    if (!vm) {
      return NextResponse.json({ error: "No VM assigned" }, { status: 404 });
    }

    // ── OAuth flow ──
    if (skill.auth_type === "oauth") {
      const oauthConfig = OAUTH_CONFIGS[integrationSlug];
      if (!oauthConfig) {
        return NextResponse.json(
          { error: `OAuth not configured for ${integrationSlug}` },
          { status: 500 }
        );
      }

      const state = crypto.randomUUID();
      // Encode integration slug + user info into state for the callback
      const statePayload = Buffer.from(
        JSON.stringify({ nonce: state, slug: integrationSlug })
      ).toString("base64url");

      const baseUrl = process.env.NEXTAUTH_URL || "https://instaclaw.io";
      const params = new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID!,
        redirect_uri: `${baseUrl}/api/skills/connect/callback`,
        response_type: "code",
        scope: oauthConfig.scopes.join(" "),
        state: statePayload,
        ...oauthConfig.extraParams,
      });

      const authUrl = `${oauthConfig.authUrl}?${params.toString()}`;

      logger.info("Integration OAuth initiated", {
        slug: integrationSlug,
        userId: session.user.id,
        route: "api/skills/connect",
      });

      // Return the auth URL — frontend opens it in a popup
      // Also set CSRF cookie for callback validation
      return NextResponse.json(
        { authUrl },
        {
          headers: {
            "Set-Cookie": `${INTEGRATION_STATE_COOKIE}=${state}; HttpOnly; ${
              process.env.NODE_ENV === "production" ? "Secure; " : ""
            }SameSite=Lax; Max-Age=600; Path=/`,
          },
        }
      );
    }

    // ── API key flow ──
    if (skill.auth_type === "api_key") {
      if (typeof apiKey !== "string" || !apiKey.trim()) {
        return NextResponse.json(
          { error: "apiKey is required for this integration" },
          { status: 400 }
        );
      }

      const keyConfig = API_KEY_CONFIGS[integrationSlug];
      if (!keyConfig) {
        return NextResponse.json(
          { error: `API key config not found for ${integrationSlug}` },
          { status: 500 }
        );
      }

      // For Shopify: validate the token against the shop's API
      if (integrationSlug === "shopify") {
        if (typeof shopDomain !== "string" || !shopDomain.trim()) {
          return NextResponse.json(
            { error: "shopDomain is required for Shopify (e.g. yourstore.myshopify.com)" },
            { status: 400 }
          );
        }

        // Validate shop domain format
        const cleanDomain = shopDomain.trim().toLowerCase();
        if (!/^[a-z0-9-]+\.myshopify\.com$/.test(cleanDomain)) {
          return NextResponse.json(
            { error: "shopDomain must be in format: yourstore.myshopify.com" },
            { status: 400 }
          );
        }

        // Test the token against the Shopify Admin API
        try {
          const shopifyRes = await fetch(
            `https://${cleanDomain}/admin/api/2024-01/shop.json`,
            {
              headers: { "X-Shopify-Access-Token": apiKey.trim() },
            }
          );
          if (!shopifyRes.ok) {
            return NextResponse.json(
              { error: "Shopify API key validation failed — check your token and shop domain" },
              { status: 400 }
            );
          }
        } catch {
          return NextResponse.json(
            { error: "Could not reach Shopify API — check your shop domain" },
            { status: 400 }
          );
        }

        // Deploy to VM
        const deployed = await deployIntegrationCredentials(vm, "shopify", {
          SHOPIFY_ACCESS_TOKEN: apiKey.trim(),
          SHOPIFY_SHOP_DOMAIN: cleanDomain,
        });

        if (!deployed) {
          return NextResponse.json(
            { error: "Failed to deploy credentials to VM" },
            { status: 500 }
          );
        }

        // Update DB state
        await supabase
          .from("instaclaw_vm_skills")
          .update({
            enabled: true,
            connected: true,
            connected_account: cleanDomain,
            credentials: { shopDomain: cleanDomain },
          })
          .eq("vm_id", vm.id)
          .eq("skill_id", skill.id);

        logger.info("Shopify integration connected", {
          shopDomain: cleanDomain,
          vmId: vm.id,
          userId: session.user.id,
          route: "api/skills/connect",
        });

        return NextResponse.json({ success: true, connectedAccount: cleanDomain });
      }

      // Generic API key flow (for future integrations)
      const envVars: Record<string, string> = {
        [keyConfig.envKey]: apiKey.trim(),
      };

      const deployed = await deployIntegrationCredentials(
        vm,
        integrationSlug,
        envVars,
        keyConfig.mcpConfig
      );

      if (!deployed) {
        return NextResponse.json(
          { error: "Failed to deploy credentials to VM" },
          { status: 500 }
        );
      }

      await supabase
        .from("instaclaw_vm_skills")
        .update({
          enabled: true,
          connected: true,
          connected_account: integrationSlug,
        })
        .eq("vm_id", vm.id)
        .eq("skill_id", skill.id);

      return NextResponse.json({ success: true });
    }

    return NextResponse.json(
      { error: `Unsupported auth type: ${skill.auth_type}` },
      { status: 400 }
    );
  } catch (err) {
    logger.error("Integration connect error", {
      error: String(err),
      route: "api/skills/connect",
    });
    return NextResponse.json(
      { error: "Failed to connect integration" },
      { status: 500 }
    );
  }
}
