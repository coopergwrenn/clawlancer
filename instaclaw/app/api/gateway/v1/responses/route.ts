/**
 * OpenAI Responses API-compatible endpoint.
 *
 * OpenClaw >=2026.2.3 uses the openai-responses API format by default,
 * which constructs URLs as `${baseURL}/v1/responses`.
 * When an all-inclusive VM has baseURL = "https://instaclaw.io/api/gateway",
 * requests arrive here. We re-export the proxy handler.
 */
export { POST } from "../../proxy/route";
