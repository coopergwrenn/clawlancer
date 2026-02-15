/**
 * Strips raw XML tool-use tags and other artifacts from agent responses
 * before storing or displaying results.
 */
export function sanitizeAgentResult(raw: string): string {
  let cleaned = raw;

  // Remove <search><query>...</query></search> blocks (with any whitespace/newlines between)
  cleaned = cleaned.replace(
    /<search>\s*<query>[\s\S]*?<\/query>\s*<\/search>/gi,
    ""
  );

  // Remove matched open/close tool-use XML blocks (greedy inner content)
  cleaned = cleaned.replace(
    /<(tool_use|tool_result|function_call|thinking|artifact|antartifact|result|antml_invoke|antml_parameter|tool_name|parameters)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi,
    ""
  );

  // Catch any remaining self-closing or orphaned XML tool tags
  cleaned = cleaned.replace(
    /<\/?(?:search|query|tool_use|tool_result|function_call|thinking|artifact|antartifact|result|antml_invoke|antml_parameter|tool_name|parameters)(?:\s[^>]*)?\/?>/gi,
    ""
  );

  // Clean up excessive blank lines left behind after tag removal (3+ newlines → 2)
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");

  // Trim leading/trailing whitespace
  return cleaned.trim();
}
