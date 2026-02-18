/**
 * Top-level catch-all for /api/gateway/*.
 *
 * OpenClaw SDK constructs API URLs relative to the configured baseURL.
 * Different API formats produce different paths:
 *   - /api/gateway/v1/messages       (Anthropic Messages API — via /v1/ catch-all)
 *   - /api/gateway/responses          (OpenAI Responses API — openai-responses format)
 *   - /api/gateway/v1/responses       (alternate — via /v1/ catch-all)
 *   - /api/gateway/chat/completions   (OpenAI Chat format — possible future)
 *
 * More specific routes (/proxy, /proxy/[...path], /v1/[...path]) take
 * precedence in Next.js App Router. This catch-all handles anything
 * that falls through, forwarding to the same proxy handler.
 */
export { POST } from "../proxy/route";
