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

  // Position fixed breaks out of the parent scroll-area entirely.
  // The CommandCenter manages its own scroll via flex-1 overflow-y-auto.
  // Bottom 76px reserved for the floating nav bar.
  return (
    <div style={{
      position: "fixed",
      top: 0,
      left: 0,
      right: 0,
      bottom: "76px",
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
      zIndex: 10,
      background: "#000",
    }}>
      <CommandCenter
        userId={session.userId}
        telegramBotUsername={agent?.telegram_bot_username as string | null ?? null}
        isOnline={agent?.health_status === "healthy"}
      />
    </div>
  );
}
