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

  // Fixed height container that prevents the parent scroll-area from scrolling.
  // The CommandCenter manages its own internal scroll via flex-1 overflow-y-auto.
  // Height = full viewport minus floating nav bar (76px).
  return (
    <div style={{
      height: "calc(100dvh - 76px)",
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
    }}>
      <CommandCenter
        userId={session.userId}
        telegramBotUsername={agent?.telegram_bot_username as string | null ?? null}
        isOnline={agent?.health_status === "healthy"}
      />
    </div>
  );
}
