"use client";

import { useState, useEffect, useCallback } from "react";
import { Plus, Pencil, Trash2, MessageSquare, PanelLeft } from "lucide-react";

interface Conversation {
  id: string;
  title: string;
  last_message_preview: string;
  message_count: number;
  updated_at: string;
}

interface ChatSidebarProps {
  open: boolean;
  onClose: () => void;
  activeId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
}

export default function ChatSidebar({ open, onClose, activeId, onSelect, onNewChat }: ChatSidebarProps) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  const loadConversations = useCallback(async () => {
    try {
      const res = await fetch("/api/chat/conversations");
      if (res.ok) {
        const data = await res.json();
        setConversations(data.conversations || []);
      }
    } catch {}
    setLoading(false);
  }, []);

  // Load conversations when sidebar opens
  useEffect(() => {
    if (open) {
      setLoading(true);
      loadConversations();
    }
  }, [open, loadConversations]);

  async function rename(id: string, title: string) {
    if (!title.trim()) return;
    setConversations((prev) => prev.map((c) => c.id === id ? { ...c, title: title.trim() } : c));
    setRenamingId(null);
    try {
      await fetch(`/api/chat/conversations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim() }),
      });
    } catch { loadConversations(); }
  }

  async function archive(id: string) {
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (activeId === id) onNewChat();
    try {
      await fetch(`/api/chat/conversations/${id}`, { method: "DELETE" });
    } catch { loadConversations(); }
  }

  function handleSelect(id: string) {
    onSelect(id);
    // Auto-close on mobile (matching web app: window.innerWidth < 640)
    if (typeof window !== "undefined" && window.innerWidth < 640) {
      onClose();
    }
  }

  return (
    <>
      {/* Backdrop — matching web app: rgba(0,0,0,0.15) */}
      <div
        className="absolute inset-0 z-30"
        style={{
          background: open ? "rgba(0,0,0,0.3)" : "transparent",
          opacity: open ? 1 : 0,
          pointerEvents: open ? "auto" : "none",
          transition: "opacity 0.2s ease",
        }}
        onClick={onClose}
      />

      {/* Sidebar panel — matching web app structure exactly */}
      <div
        className="absolute top-0 left-0 bottom-0 z-40 flex flex-col w-[280px] max-w-[85vw]"
        style={{
          background: "rgba(18,18,18,0.92)",
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          borderRight: "1px solid rgba(255,255,255,0.06)",
          boxShadow: "4px 0 32px rgba(0,0,0,0.25), inset 1px 0 0 rgba(255,255,255,0.04)",
          transform: open ? "translateX(0)" : "translateX(-100%)",
          transition: "transform 0.35s cubic-bezier(0.22, 1, 0.36, 1)",
        }}
      >
        {/* Header — "Chats" + Plus + PanelLeft (matching web app) */}
        <div
          className="flex items-center justify-between h-11 px-3 shrink-0"
          style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}
        >
          <span className="text-[13px] font-semibold tracking-tight" style={{ color: "#eee" }}>
            Chats
          </span>
          <div className="flex items-center gap-0.5">
            <button
              onClick={() => { onNewChat(); onClose(); }}
              className="w-7 h-7 rounded-lg flex items-center justify-center cursor-pointer transition-all hover:bg-white/[0.06] active:scale-95"
              title="New Chat"
            >
              <Plus size={16} strokeWidth={2} style={{ color: "#999" }} />
            </button>
            <button
              onClick={onClose}
              className="w-7 h-7 rounded-lg flex items-center justify-center cursor-pointer transition-colors hover:bg-white/[0.06] active:scale-95"
              title="Close sidebar"
            >
              <PanelLeft size={16} style={{ color: "#999" }} />
            </button>
          </div>
        </div>

        {/* Conversation list */}
        <div className="flex-1 overflow-y-auto pt-1.5" style={{ scrollbarWidth: "thin", WebkitOverflowScrolling: "touch" }}>
          {loading ? (
            <div className="space-y-1 p-2 animate-pulse">
              {[1, 2, 3].map((i) => (
                <div key={i} className="rounded-lg p-3" style={{ opacity: 0.3 }}>
                  <div className="h-3.5 rounded-full mb-2 bg-white/[0.08]" style={{ width: "70%" }} />
                  <div className="h-2.5 rounded-full bg-white/[0.04]" style={{ width: "90%" }} />
                </div>
              ))}
            </div>
          ) : conversations.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
              <MessageSquare size={24} className="mb-2.5" style={{ color: "#555" }} />
              <p className="text-[13px]" style={{ color: "#888" }}>No conversations yet</p>
              <button
                onClick={() => { onNewChat(); onClose(); }}
                className="mt-2.5 text-xs font-medium cursor-pointer transition-colors hover:opacity-80"
                style={{ color: "#da7756" }}
              >
                Start a new chat
              </button>
            </div>
          ) : (
            <div className="px-1.5 space-y-px">
              {conversations.map((conv) => (
                <div
                  key={conv.id}
                  onClick={() => handleSelect(conv.id)}
                  className={`group/conv relative rounded-lg px-2.5 py-2 cursor-pointer transition-all ${
                    activeId === conv.id ? "" : "hover:bg-white/[0.04]"
                  }`}
                  style={
                    activeId === conv.id
                      ? { background: "rgba(255,255,255,0.07)" }
                      : undefined
                  }
                >
                  {renamingId === conv.id ? (
                    <input
                      autoFocus
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") rename(conv.id, renameDraft);
                        if (e.key === "Escape") setRenamingId(null);
                      }}
                      onBlur={() => renameDraft.trim() ? rename(conv.id, renameDraft) : setRenamingId(null)}
                      onClick={(e) => e.stopPropagation()}
                      className="w-full text-[13px] bg-transparent outline-none rounded px-1 -mx-1"
                      style={{ color: "#fff", boxShadow: "0 0 0 1.5px #da7756" }}
                    />
                  ) : (
                    <>
                      <div className="flex items-center justify-between gap-1">
                        <p className="text-[13px] font-medium truncate flex-1 leading-tight" style={{ color: "#ddd" }}>
                          {conv.title}
                        </p>
                        <div className="flex items-center gap-0 opacity-0 group-hover/conv:opacity-100 transition-opacity shrink-0">
                          <button
                            onClick={(e) => { e.stopPropagation(); setRenamingId(conv.id); setRenameDraft(conv.title); }}
                            className="p-1 rounded-md cursor-pointer hover:bg-white/[0.08] transition-colors"
                            title="Rename"
                          >
                            <Pencil size={12} style={{ color: "#999" }} />
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); archive(conv.id); }}
                            className="p-1 rounded-md cursor-pointer hover:bg-red-500/10 transition-colors"
                            title="Delete"
                          >
                            <Trash2 size={12} style={{ color: "#999" }} />
                          </button>
                        </div>
                      </div>
                      {conv.last_message_preview && (
                        <p className="text-[11px] truncate mt-0.5 leading-tight" style={{ color: "#666", opacity: 0.8 }}>
                          {conv.last_message_preview}
                        </p>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
