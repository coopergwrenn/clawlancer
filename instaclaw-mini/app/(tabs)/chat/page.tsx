import { getSession } from "@/lib/auth";
import { getAgentStatus } from "@/lib/supabase";
import { redirect } from "next/navigation";
import CommandCenter from "./command-center";

export default async function ChatPage() {
  const session = await getSession();
  if (!session) redirect("/");

  let agent = null;
  try {
    agent = await getAgentStatus(session.userId);
  } catch { /* no agent */ }

  // The command center needs a fixed height container to pin header/input
  // and scroll only messages. We calculate: 100dvh - floating nav bar height (~76px)
  return (
    <div style={{ height: "calc(100dvh - 76px)", display: "flex", flexDirection: "column", overflow: "hidden", position: "sticky", top: 0 }}>
      <CommandCenter
        userId={session.userId}
        telegramBotUsername={agent?.telegram_bot_username as string | null ?? null}
        isOnline={agent?.health_status === "healthy"}
      />
    </div>
  );
}
