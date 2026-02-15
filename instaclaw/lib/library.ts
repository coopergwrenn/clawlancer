import { SupabaseClient } from "@supabase/supabase-js";
import { sanitizeAgentResult } from "@/lib/sanitize-result";

interface SaveToLibraryParams {
  userId: string;
  title: string;
  content: string;
  sourceTaskId?: string;
  sourceChatMessageId?: string;
  runNumber?: number;
}

/** Determine library type from title heuristics */
export function inferType(title: string): string {
  const t = title.toLowerCase();
  if (/research|investigate|find out|look into|explore/.test(t)) return "research";
  if (/draft|email|write|compose|letter|message/.test(t)) return "draft";
  if (/report|summary|summarize|briefing|earnings|weekly|daily|update/.test(t)) return "report";
  if (/analy|competitive|compare|benchmark|evaluate|assess/.test(t)) return "analysis";
  if (/code|script|build|function|api|debug|fix|implement/.test(t)) return "code";
  if (/post|tweet|thread|social|content|blog/.test(t)) return "post";
  return "other";
}

/** Generate a plain-text preview from markdown content */
export function generatePreview(content: string, maxLen = 150): string {
  const plain = content
    .replace(/[#*`_\[\]()>~-]/g, "")
    .replace(/\n+/g, " ")
    .trim();
  if (plain.length <= maxLen) return plain;
  return plain.slice(0, maxLen).replace(/\s+\S*$/, "") + "...";
}

/**
 * Save content to the user's library.
 * Failures are logged but never thrown — library save must not break tasks.
 */
export async function saveToLibrary(
  supabase: SupabaseClient,
  params: SaveToLibraryParams
) {
  try {
    // Safety net: sanitize content before saving
    const cleanContent = sanitizeAgentResult(params.content);
    const type = inferType(params.title);
    const preview = generatePreview(cleanContent);
    const finalTitle =
      params.runNumber && params.runNumber > 1
        ? `${params.title} (Run #${params.runNumber})`
        : params.title;

    const { data, error } = await supabase
      .from("instaclaw_library")
      .insert({
        user_id: params.userId,
        title: finalTitle,
        type,
        content: cleanContent,
        preview,
        source_task_id: params.sourceTaskId || null,
        source_chat_message_id: params.sourceChatMessageId || null,
        run_number: params.runNumber || 1,
      })
      .select()
      .single();

    if (error) {
      console.error("Failed to save to library:", error);
    }
    return data;
  } catch (err) {
    console.error("Library save error:", err);
    return null;
  }
}
