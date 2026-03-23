import { getSession } from "@/lib/auth";
import { getAgentStatus } from "@/lib/supabase";
import { redirect } from "next/navigation";
import ChatOptions from "./chat-options";

export default async function ChatPage() {
  const session = await getSession();
  if (!session) redirect("/");

  const agent = await getAgentStatus(session.userId);

  // Extract bot username from token if available
  const botToken = agent?.telegram_bot_token;

  return (
    <div className="p-4">
      <h1 className="mb-4 text-xl font-bold">Chat with your agent</h1>
      <ChatOptions
        xmtpAddress={agent?.xmtp_address ?? null}
        botToken={botToken ?? null}
      />
    </div>
  );
}
