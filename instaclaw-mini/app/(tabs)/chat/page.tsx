import { getSession } from "@/lib/auth";
import { getAgentStatus } from "@/lib/supabase";
import { redirect } from "next/navigation";
import ChatOptions from "./chat-options";

export default async function ChatPage() {
  const session = await getSession();
  if (!session) redirect("/");

  const agent = await getAgentStatus(session.userId);

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
