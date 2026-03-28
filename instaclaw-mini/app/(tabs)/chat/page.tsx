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

  return (
    <>
      {/* Override parent scroll-area to prevent it from scrolling the chat page */}
      <style>{`
        .scroll-area { overflow: hidden !important; }
      `}</style>
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
    </>
  );
}
