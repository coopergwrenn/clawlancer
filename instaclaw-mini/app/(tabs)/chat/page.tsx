import { getSession } from "@/lib/auth";
import { getAgentStatus } from "@/lib/supabase";
import { redirect } from "next/navigation";
import ChatOptions from "./chat-options";

export default async function ChatPage() {
  const session = await getSession();
  if (!session) redirect("/");

  let agent = null;
  try {
    agent = await getAgentStatus(session.userId);
  } catch (err) {
    console.error("[Chat] Error fetching agent:", err);
  }

  return (
    <div className="p-4">
      <h1 className="mb-1 text-xl font-bold tracking-tight">Chat</h1>
      <p className="mb-5 text-xs text-muted">Talk to your agent</p>
      <ChatOptions
        xmtpAddress={agent?.xmtp_address ?? null}
        telegramBotUsername={agent?.telegram_bot_username ?? null}
      />
    </div>
  );
}
