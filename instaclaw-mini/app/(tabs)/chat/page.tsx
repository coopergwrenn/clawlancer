import { getSession } from "@/lib/auth";
import { getAgentStatus } from "@/lib/supabase";
import { redirect } from "next/navigation";
import ChatInterface from "./chat-interface";

export default async function ChatPage() {
  const session = await getSession();
  if (!session) redirect("/");

  let agent = null;
  try {
    agent = await getAgentStatus(session.userId);
  } catch { /* no agent */ }

  return (
    <ChatInterface
      telegramBotUsername={agent?.telegram_bot_username as string | null ?? null}
      xmtpAddress={agent?.xmtp_address as string | null ?? null}
      isOnline={agent?.health_status === "healthy"}
    />
  );
}
