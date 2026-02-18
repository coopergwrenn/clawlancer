/**
 * Catch-all route for /api/gateway/v1/*.
 *
 * The Anthropic SDK constructs URLs as `${baseURL}/v1/{endpoint}`.
 * Different OpenClaw versions use different endpoints:
 *   - /v1/messages          (Anthropic Messages API — all versions)
 *   - /v1/responses         (OpenAI Responses API — OpenClaw >=2026.2.3)
 *   - /v1/{future-endpoint} (any future API format)
 *
 * This catch-all ensures we never return 405 for a new API format.
 * The proxy handler authenticates via gateway token, enforces rate
 * limits, and forwards to api.anthropic.com/v1/messages.
 */
export { POST } from "../../proxy/route";
