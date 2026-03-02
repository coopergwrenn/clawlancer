"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Key,
  Plus,
  Trash2,
  Eye,
  EyeOff,
  Pencil,
  ExternalLink,
} from "lucide-react";

interface EnvVar {
  id: string;
  name: string;
  maskedValue: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

const SUGGESTIONS = [
  {
    name: "BRAVE_API_KEY",
    label: "Enable web search",
    link: "https://brave.com/search/api/",
  },
  {
    name: "GITHUB_TOKEN",
    label: "Access GitHub repos",
    link: "https://github.com/settings/tokens",
  },
  {
    name: "NOTION_API_KEY",
    label: "Connect to Notion",
    link: "https://developers.notion.com/",
  },
  {
    name: "OPENAI_API_KEY",
    label: "Use OpenAI models",
    link: "https://platform.openai.com/api-keys",
  },
  {
    name: "GOOGLE_API_KEY",
    label: "Google services access",
    link: "https://console.cloud.google.com/apis/credentials",
  },
  {
    name: "TWITTER_BEARER_TOKEN",
    label: "Search X/Twitter",
    link: "https://developer.x.com/en/portal/dashboard",
  },
];

export default function EnvVarsPage() {
  const [vars, setVars] = useState<EnvVar[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [revealedValues, setRevealedValues] = useState<Record<string, string>>({});
  const [revealTimers, setRevealTimers] = useState<Record<string, NodeJS.Timeout>>({});
  const [editingVar, setEditingVar] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  const fetchVars = useCallback(async () => {
    try {
      const res = await fetch("/api/bot/env-vars");
      const data = await res.json();
      setVars(data.vars ?? []);
    } catch {
      // Silently handle
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchVars();
  }, [fetchVars]);

  async function handleAdd() {
    if (!newName.trim() || !newValue.trim()) return;
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/bot/env-vars", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newName.trim().toUpperCase(),
          value: newValue.trim(),
          description: newDescription.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to add variable");
        return;
      }
      setNewName("");
      setNewValue("");
      setNewDescription("");
      setShowAdd(false);
      await fetchVars();
    } catch {
      setError("Network error");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(name: string) {
    if (!confirm(`Delete ${name}? This will remove it from your VM.`)) return;
    try {
      await fetch("/api/bot/env-vars", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      await fetchVars();
    } catch {
      // Silently handle
    }
  }

  async function handleReveal(name: string) {
    try {
      const res = await fetch(`/api/bot/env-vars/reveal?name=${encodeURIComponent(name)}`);
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to reveal");
        return;
      }
      const data = await res.json();
      setRevealedValues((prev) => ({ ...prev, [name]: data.value }));

      // Auto-hide after 5 seconds
      const timer = setTimeout(() => {
        setRevealedValues((prev) => {
          const next = { ...prev };
          delete next[name];
          return next;
        });
      }, 5000);

      setRevealTimers((prev) => {
        if (prev[name]) clearTimeout(prev[name]);
        return { ...prev, [name]: timer };
      });
    } catch {
      setError("Failed to reveal value");
    }
  }

  function hideReveal(name: string) {
    setRevealedValues((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
    if (revealTimers[name]) {
      clearTimeout(revealTimers[name]);
    }
  }

  async function handleUpdate(name: string) {
    if (!editValue.trim()) return;
    try {
      await fetch("/api/bot/env-vars", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, value: editValue.trim() }),
      });
      setEditingVar(null);
      setEditValue("");
      await fetchVars();
    } catch {
      setError("Failed to update variable");
    }
  }

  function addSuggestion(name: string) {
    setNewName(name);
    setShowAdd(true);
  }

  // Filter out suggestions that already exist
  const availableSuggestions = SUGGESTIONS.filter(
    (s) => !vars.some((v) => v.name === s.name)
  );

  return (
    <div className="space-y-10" data-tour="page-api-keys">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl sm:text-4xl font-normal tracking-[-0.5px]" style={{ fontFamily: "var(--font-serif)" }}>API Keys & Secrets</h1>
          <p className="text-base mt-2" style={{ color: "var(--muted)" }}>
            Environment variables injected into your VM.
          </p>
        </div>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-colors"
          style={{ background: "#ffffff", color: "#000000" }}
        >
          <Plus className="w-3 h-3" />
          Add Variable
        </button>
      </div>

      {error && (
        <p className="text-sm" style={{ color: "var(--error)" }}>
          {error}
        </p>
      )}

      {/* Quick-add suggestions */}
      {availableSuggestions.length > 0 && (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {availableSuggestions.map((s) => (
            <button
              key={s.name}
              onClick={() => addSuggestion(s.name)}
              className="glass rounded-lg p-3 text-left transition-all hover:border-white/30 cursor-pointer"
              style={{ border: "1px solid var(--border)" }}
            >
              <div className="flex items-center justify-between">
                <p className="text-xs font-mono font-medium">{s.name}</p>
                <a
                  href={s.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="p-0.5"
                  style={{ color: "var(--muted)" }}
                >
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
              <p className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>
                {s.label}
              </p>
            </button>
          ))}
        </div>
      )}

      {/* Add new variable form */}
      {showAdd && (
        <div className="glass rounded-xl p-5 space-y-3" style={{ border: "1px solid var(--border)" }}>
          <input
            type="text"
            placeholder="VARIABLE_NAME"
            value={newName}
            onChange={(e) => setNewName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""))}
            className="w-full px-3 py-2 rounded-lg text-sm font-mono outline-none"
            style={{
              background: "var(--card)",
              border: "1px solid var(--border)",
              color: "var(--foreground)",
            }}
          />
          <input
            type="password"
            placeholder="Value (will be encrypted)"
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
            className="w-full px-3 py-2 rounded-lg text-sm font-mono outline-none"
            style={{
              background: "var(--card)",
              border: "1px solid var(--border)",
              color: "var(--foreground)",
            }}
          />
          <input
            type="text"
            placeholder="Description (optional)"
            value={newDescription}
            onChange={(e) => setNewDescription(e.target.value)}
            className="w-full px-3 py-2 rounded-lg text-sm outline-none"
            style={{
              background: "var(--card)",
              border: "1px solid var(--border)",
              color: "var(--foreground)",
            }}
          />
          <div className="flex gap-2">
            <button
              onClick={handleAdd}
              disabled={saving || !newName.trim() || !newValue.trim()}
              className="px-4 py-2 rounded-lg text-xs font-medium cursor-pointer disabled:opacity-50"
              style={{ background: "#ffffff", color: "#000000" }}
            >
              {saving ? "Adding..." : "Add Variable"}
            </button>
            <button
              onClick={() => {
                setShowAdd(false);
                setNewName("");
                setNewValue("");
                setNewDescription("");
              }}
              className="px-4 py-2 rounded-lg text-xs font-medium cursor-pointer"
              style={{
                background: "var(--card)",
                border: "1px solid var(--border)",
                color: "var(--muted)",
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Variables list */}
      {loading ? (
        <div className="glass rounded-xl p-8 text-center">
          <p className="text-sm" style={{ color: "var(--muted)" }}>Loading...</p>
        </div>
      ) : vars.length === 0 ? (
        <div className="glass rounded-xl p-8 text-center">
          <Key className="w-8 h-8 mx-auto mb-3" style={{ color: "var(--muted)" }} />
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            No environment variables set. Add one to enhance your bot&apos;s capabilities.
          </p>
        </div>
      ) : (
        <div className="glass rounded-xl overflow-hidden" style={{ border: "1px solid var(--border)" }}>
          {/* Header */}
          <div
            className="grid grid-cols-12 gap-2 px-4 py-2 text-xs font-medium"
            style={{ color: "var(--muted)", borderBottom: "1px solid var(--border)" }}
          >
            <span className="col-span-3">Name</span>
            <span className="col-span-4">Value</span>
            <span className="col-span-2 hidden sm:block">Added</span>
            <span className="col-span-3 text-right">Actions</span>
          </div>

          {vars.map((v, i) => (
            <div
              key={v.id}
              className="grid grid-cols-12 gap-2 px-4 py-3 items-center"
              style={{
                borderBottom: i < vars.length - 1 ? "1px solid var(--border)" : undefined,
              }}
            >
              {/* Name */}
              <div className="col-span-3">
                <code className="text-xs font-mono">{v.name}</code>
                {v.description && (
                  <p className="text-[10px] mt-0.5" style={{ color: "var(--muted)" }}>
                    {v.description}
                  </p>
                )}
              </div>

              {/* Value */}
              <div className="col-span-4">
                {editingVar === v.name ? (
                  <div className="flex gap-1">
                    <input
                      type="password"
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      className="flex-1 px-2 py-1 rounded text-xs font-mono outline-none"
                      style={{
                        background: "var(--card)",
                        border: "1px solid var(--border)",
                        color: "var(--foreground)",
                      }}
                      placeholder="New value"
                      autoFocus
                    />
                    <button
                      onClick={() => handleUpdate(v.name)}
                      className="px-2 py-1 rounded text-[10px] cursor-pointer"
                      style={{ background: "#ffffff", color: "#000000" }}
                    >
                      Save
                    </button>
                    <button
                      onClick={() => { setEditingVar(null); setEditValue(""); }}
                      className="px-2 py-1 rounded text-[10px] cursor-pointer"
                      style={{ color: "var(--muted)" }}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <code className="text-xs font-mono" style={{ color: "var(--muted)" }}>
                    {revealedValues[v.name] ?? v.maskedValue}
                  </code>
                )}
              </div>

              {/* Added date */}
              <div className="col-span-2 hidden sm:block">
                <span className="text-xs" style={{ color: "var(--muted)" }}>
                  {new Date(v.createdAt).toLocaleDateString()}
                </span>
              </div>

              {/* Actions */}
              <div className="col-span-3 flex justify-end gap-1">
                {revealedValues[v.name] ? (
                  <button
                    onClick={() => hideReveal(v.name)}
                    className="p-1.5 rounded cursor-pointer transition-colors hover:bg-white/5"
                    style={{ color: "var(--muted)" }}
                    title="Hide"
                  >
                    <EyeOff className="w-3.5 h-3.5" />
                  </button>
                ) : (
                  <button
                    onClick={() => handleReveal(v.name)}
                    className="p-1.5 rounded cursor-pointer transition-colors hover:bg-white/5"
                    style={{ color: "var(--muted)" }}
                    title="Reveal (auto-hides in 5s)"
                  >
                    <Eye className="w-3.5 h-3.5" />
                  </button>
                )}
                <button
                  onClick={() => {
                    setEditingVar(v.name);
                    setEditValue("");
                  }}
                  className="p-1.5 rounded cursor-pointer transition-colors hover:bg-white/5"
                  style={{ color: "var(--muted)" }}
                  title="Edit"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => handleDelete(v.name)}
                  className="p-1.5 rounded cursor-pointer transition-colors hover:bg-white/5"
                  style={{ color: "var(--error)" }}
                  title="Delete"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
