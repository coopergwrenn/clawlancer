import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { deployIntegrationCredentials } from "@/lib/ssh";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const INTEGRATION_STATE_COOKIE = "ic_integration_state";

// Token exchange and credential deployment configs per integration
const INTEGRATION_HANDLERS: Record<
  string,
  {
    tokenUrl: string;
    clientIdEnv: string;
    clientSecretEnv: string;
    envPrefix: string;
    // Function to extract connected account info from the tokens
    getAccountInfo?: (accessToken: string) => Promise<string | null>;
    // MCP server config to install on the VM
    mcpConfig?: {
      command: string;
      env?: Record<string, string>;
      scope?: string;
      description?: string;
    };
  }
> = {
  "google-workspace": {
    tokenUrl: "https://oauth2.googleapis.com/token",
    clientIdEnv: "GOOGLE_CLIENT_ID",
    clientSecretEnv: "GOOGLE_CLIENT_SECRET",
    envPrefix: "GOOGLE",
    getAccountInfo: async (accessToken: string) => {
      try {
        const res = await fetch(
          "https://www.googleapis.com/oauth2/v2/userinfo",
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (res.ok) {
          const data = await res.json();
          return data.email || null;
        }
      } catch {
        // Non-fatal
      }
      return null;
    },
  },
};

/**
 * GET /api/skills/connect/callback
 *
 * OAuth callback handler. Receives auth code from provider, exchanges for tokens,
 * deploys credentials to the user's VM, and updates DB state.
 * Redirects back to the skills page with success/error params.
 */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.redirect(new URL("/signin", req.url));
  }

  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code");
  const error = searchParams.get("error");
  const stateParam = searchParams.get("state");
  const redirectBase = "/skills";

  // ── Decode state payload ──
  let stateNonce: string | null = null;
  let integrationSlug: string | null = null;
  if (stateParam) {
    try {
      const decoded = JSON.parse(
        Buffer.from(stateParam, "base64url").toString("utf-8")
      );
      stateNonce = decoded.nonce;
      integrationSlug = decoded.slug;
    } catch {
      logger.error("Integration OAuth invalid state payload", {
        userId: session.user.id,
        route: "api/skills/connect/callback",
      });
      return redirectWithCleanup(req, `${redirectBase}?connect_error=invalid_state`);
    }
  }

  // ── CSRF validation ──
  const stateCookie = req.cookies.get(INTEGRATION_STATE_COOKIE)?.value;
  if (!stateNonce || !stateCookie || stateNonce !== stateCookie) {
    logger.error("Integration OAuth CSRF mismatch", {
      hasNonce: !!stateNonce,
      hasCookie: !!stateCookie,
      slug: integrationSlug,
      userId: session.user.id,
      route: "api/skills/connect/callback",
    });
    return redirectWithCleanup(req, `${redirectBase}?connect_error=csrf`);
  }

  // User denied
  if (error) {
    logger.warn("Integration OAuth denied by user", {
      error,
      slug: integrationSlug,
      userId: session.user.id,
      route: "api/skills/connect/callback",
    });
    return redirectWithCleanup(req, `${redirectBase}?connect_error=denied`);
  }

  if (!code || !integrationSlug) {
    logger.error("Integration OAuth callback missing code or slug", {
      hasCode: !!code,
      hasSlug: !!integrationSlug,
      userId: session.user.id,
      route: "api/skills/connect/callback",
    });
    return redirectWithCleanup(req, `${redirectBase}?connect_error=missing_code`);
  }

  const handler = INTEGRATION_HANDLERS[integrationSlug];
  if (!handler) {
    logger.error("No handler for integration slug", {
      slug: integrationSlug,
      route: "api/skills/connect/callback",
    });
    return redirectWithCleanup(req, `${redirectBase}?connect_error=unsupported`);
  }

  try {
    const supabase = getSupabase();
    const baseUrl = process.env.NEXTAUTH_URL || "https://instaclaw.io";

    // ── Exchange auth code for tokens ──
    const tokenRes = await fetch(handler.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env[handler.clientIdEnv]!,
        client_secret: process.env[handler.clientSecretEnv]!,
        redirect_uri: `${baseUrl}/api/skills/connect/callback`,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenRes.ok) {
      const errBody = await tokenRes.text();
      logger.error("Integration token exchange failed", {
        slug: integrationSlug,
        status: tokenRes.status,
        body: errBody.slice(0, 500),
        route: "api/skills/connect/callback",
      });
      return redirectWithCleanup(req, `${redirectBase}?connect_error=token_exchange`);
    }

    const tokenData = await tokenRes.json();
    const accessToken: string = tokenData.access_token;
    const refreshToken: string | undefined = tokenData.refresh_token;

    if (!accessToken) {
      logger.error("Token exchange returned no access_token", {
        slug: integrationSlug,
        route: "api/skills/connect/callback",
      });
      return redirectWithCleanup(req, `${redirectBase}?connect_error=no_token`);
    }

    // ── Get connected account info ──
    let connectedAccount: string | null = null;
    if (handler.getAccountInfo) {
      connectedAccount = await handler.getAccountInfo(accessToken);
    }

    // ── Get user's VM ──
    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("id, ip_address, ssh_port, ssh_user")
      .eq("assigned_to", session.user.id)
      .single();

    if (!vm) {
      logger.error("No VM found for user during OAuth callback", {
        userId: session.user.id,
        slug: integrationSlug,
        route: "api/skills/connect/callback",
      });
      return redirectWithCleanup(req, `${redirectBase}?connect_error=no_vm`);
    }

    // ── Deploy credentials to VM ──
    const envVars: Record<string, string> = {
      [`${handler.envPrefix}_ACCESS_TOKEN`]: accessToken,
    };
    if (refreshToken) {
      envVars[`${handler.envPrefix}_REFRESH_TOKEN`] = refreshToken;
    }

    const deployed = await deployIntegrationCredentials(
      vm,
      integrationSlug,
      envVars,
      handler.mcpConfig
    );

    if (!deployed) {
      logger.error("Failed to deploy integration credentials to VM", {
        slug: integrationSlug,
        vmId: vm.id,
        route: "api/skills/connect/callback",
      });
      return redirectWithCleanup(req, `${redirectBase}?connect_error=deploy_failed`);
    }

    // ── Update DB state ──
    const { data: skill } = await supabase
      .from("instaclaw_skills")
      .select("id")
      .eq("slug", integrationSlug)
      .single();

    if (skill) {
      await supabase
        .from("instaclaw_vm_skills")
        .update({
          enabled: true,
          connected: true,
          connected_account: connectedAccount,
          // Store refresh token in credentials JSONB (access tokens are short-lived
          // and deployed to the VM — only the refresh token needs DB persistence)
          credentials: refreshToken
            ? { refresh_token: refreshToken, connected_at: new Date().toISOString() }
            : { connected_at: new Date().toISOString() },
        })
        .eq("vm_id", vm.id)
        .eq("skill_id", skill.id);
    }

    logger.info("Integration connected successfully", {
      slug: integrationSlug,
      connectedAccount,
      vmId: vm.id,
      userId: session.user.id,
      route: "api/skills/connect/callback",
    });

    return redirectWithCleanup(
      req,
      `${redirectBase}?connected=${integrationSlug}`
    );
  } catch (err) {
    logger.error("Integration callback error", {
      error: String(err),
      slug: integrationSlug,
      route: "api/skills/connect/callback",
    });
    return redirectWithCleanup(req, `${redirectBase}?connect_error=callback_failed`);
  }
}

/** Redirect and clean up the CSRF state cookie */
function redirectWithCleanup(req: NextRequest, path: string): NextResponse {
  const res = NextResponse.redirect(new URL(path, req.url));
  res.cookies.set(INTEGRATION_STATE_COOKIE, "", { maxAge: 0, path: "/" });
  return res;
}
