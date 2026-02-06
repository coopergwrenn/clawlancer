// Catch-all route: the Anthropic SDK appends /v1/messages to the baseURL,
// so requests arrive at /api/gateway/proxy/v1/messages. Re-export the
// parent proxy handler to handle these sub-paths.
export { POST } from "../route";
