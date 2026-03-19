"use client";

import { useState, useEffect, Suspense, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { Folder, File, ArrowLeft, FolderOpen, Download, Image, Film, FileText, Lock, Clock, Send, RefreshCw } from "lucide-react";

interface FileEntry {
  name: string;
  type: string;
  size: number;
  modified: string;
}

interface Delivery {
  id: string;
  filename: string;
  file_size_bytes: number;
  mime_type: string;
  telegram_method: string | null;
  telegram_file_id: string | null;
  caption: string | null;
  dashboard_url: string | null;
  storage_path: string | null;
  download_url: string | null;
  created_at: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

function telegramMethodLabel(method: string | null): string {
  if (!method) return "";
  if (method === "sendPhoto") return "Photo";
  if (method === "sendVideo") return "Video";
  if (method === "sendDocument") return "Document";
  return method;
}

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"]);
const VIDEO_EXTS = new Set([".mp4", ".webm", ".mov"]);
const TEXT_EXTS = new Set([
  ".md", ".txt", ".py", ".sh", ".ts", ".tsx", ".js", ".jsx", ".json",
  ".yaml", ".yml", ".toml", ".cfg", ".conf", ".env", ".css", ".html",
  ".xml", ".csv", ".log", ".sql", ".rs", ".go", ".rb", ".lua", ".bat",
]);

function getExt(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

const PROTECTED_FILES = new Set([
  "soul.md", "capabilities.md", "quick-reference.md", "tools.md",
  "bootstrap.md", "user.md",
  ".env", "auth-profiles.json", "wallet.json",
]);
const PROTECTED_DIRS = new Set(["skills", ".openclaw"]);

function isProtected(name: string, type: string): boolean {
  if (type === "directory" && PROTECTED_DIRS.has(name)) return true;
  const lower = name.toLowerCase();
  return PROTECTED_FILES.has(lower) || lower.startsWith(".env");
}

function getFileIcon(name: string) {
  const ext = getExt(name);
  if (IMAGE_EXTS.has(ext)) return <Image className="w-4 h-4 shrink-0" style={{ color: "#a855f7" }} />;
  if (VIDEO_EXTS.has(ext)) return <Film className="w-4 h-4 shrink-0" style={{ color: "#f97316" }} />;
  if (TEXT_EXTS.has(ext)) return <FileText className="w-4 h-4 shrink-0" style={{ color: "#22c55e" }} />;
  return <File className="w-4 h-4 shrink-0" style={{ color: "var(--muted)" }} />;
}

export default function FilesPage() {
  return (
    <Suspense fallback={<div className="p-8 text-center"><p className="text-sm" style={{ color: "var(--muted)" }}>Loading...</p></div>}>
      <FilesPageInner />
    </Suspense>
  );
}

function FilesPageInner() {
  const searchParams = useSearchParams();
  const [activeTab, setActiveTab] = useState<"browser" | "deliveries">("browser");
  const [currentPath, setCurrentPath] = useState("~/.openclaw/workspace");
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [viewingFile, setViewingFile] = useState<string | null>(null);
  const [binaryData, setBinaryData] = useState<{ content: string; mime: string } | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [deepLinked, setDeepLinked] = useState(false);

  // Delivery history state
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [deliveriesLoading, setDeliveriesLoading] = useState(false);
  const [deliveriesLoaded, setDeliveriesLoaded] = useState(false);

  const loadDeliveries = useCallback(async () => {
    setDeliveriesLoading(true);
    try {
      const res = await fetch("/api/vm/files/delivered?limit=50");
      const data = await res.json();
      setDeliveries(data.deliveries ?? []);
      setDeliveriesLoaded(true);
    } catch (err) {
      console.error("[Files] loadDeliveries error:", err);
    } finally {
      setDeliveriesLoading(false);
    }
  }, []);

  async function loadDirectory(path: string) {
    setLoading(true);
    setFileContent(null);
    setViewingFile(null);
    setBinaryData(null);
    try {
      const res = await fetch(`/api/vm/files?path=${encodeURIComponent(path)}`);
      const data = await res.json();
      setFiles(data.files ?? []);
      setCurrentPath(path);
    } catch (err) {
      console.error(`[FileBrowser] loadDirectory ${path} error:`, err);
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }

  async function viewFile(filePath: string) {
    setViewingFile(filePath);
    setFileContent(null);
    setBinaryData(null);
    setFileLoading(true);
    try {
      const res = await fetch(
        `/api/vm/files?file=${encodeURIComponent(filePath)}`
      );
      if (!res.ok) {
        console.error(`[FileBrowser] viewFile ${filePath} failed: HTTP ${res.status}`);
      }
      const data = await res.json();
      if (data.binary) {
        setBinaryData({ content: data.content, mime: data.mime });
      } else {
        setFileContent(data.content ?? "");
      }
    } catch (err) {
      console.error(`[FileBrowser] viewFile ${filePath} error:`, err);
      setFileContent("Error loading file");
    } finally {
      setFileLoading(false);
    }
  }

  function downloadFile(filePath: string) {
    const url = `/api/vm/files?file=${encodeURIComponent(filePath)}&download=1`;
    const a = document.createElement("a");
    a.href = url;
    a.download = filePath.split("/").pop() || "file";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  useEffect(() => {
    const fileParam = searchParams.get("file");
    const pathParam = searchParams.get("path");

    if (fileParam && !deepLinked) {
      setDeepLinked(true);
      // Navigate to parent directory then open file
      const parts = fileParam.split("/");
      parts.pop();
      const dir = parts.join("/") || "~/.openclaw/workspace";
      loadDirectory(dir).then(() => viewFile(fileParam));
    } else if (pathParam && !deepLinked) {
      setDeepLinked(true);
      loadDirectory(pathParam);
    } else {
      loadDirectory(currentPath);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function navigateUp() {
    const parts = currentPath.split("/");
    if (parts.length > 1) {
      parts.pop();
      loadDirectory(parts.join("/") || "~");
    }
  }

  function handleClick(file: FileEntry) {
    if (file.type === "directory") {
      loadDirectory(`${currentPath}/${file.name}`);
    } else {
      viewFile(`${currentPath}/${file.name}`);
    }
  }

  const displayPath = (p: string) => p.replace("~/.openclaw/workspace", "~/.openclaw/workspace");

  // File viewer content
  function renderFileViewer() {
    if (!viewingFile) return null;

    const ext = getExt(viewingFile);
    const fileName = viewingFile.split("/").pop() || "file";
    const isImage = IMAGE_EXTS.has(ext);
    const isVideo = VIDEO_EXTS.has(ext);

    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <button
            onClick={() => {
              setViewingFile(null);
              setFileContent(null);
              setBinaryData(null);
            }}
            className="flex items-center gap-1.5 text-sm cursor-pointer"
            style={{ color: "var(--muted)" }}
          >
            <ArrowLeft className="w-4 h-4" />
            Back to directory
          </button>
          <button
            onClick={() => downloadFile(viewingFile)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm cursor-pointer transition-colors hover:bg-white/5"
            style={{ color: "var(--muted)", border: "1px solid var(--border)" }}
          >
            <Download className="w-3.5 h-3.5" />
            Download
          </button>
        </div>
        <div className="glass rounded-xl overflow-hidden" style={{ border: "1px solid var(--border)" }}>
          <div className="px-4 py-2 text-xs font-mono flex items-center justify-between" style={{ color: "var(--muted)", borderBottom: "1px solid var(--border)" }}>
            <span>{displayPath(viewingFile)}</span>
            <span>{fileName}</span>
          </div>

          {fileLoading ? (
            <div className="p-8 text-center">
              <p className="text-sm" style={{ color: "var(--muted)" }}>Loading...</p>
            </div>
          ) : binaryData && isImage ? (
            <div className="p-4 flex justify-center" style={{ background: "rgba(0,0,0,0.02)" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`data:${binaryData.mime};base64,${binaryData.content}`}
                alt={fileName}
                className="max-w-full max-h-[500px] rounded-lg object-contain"
              />
            </div>
          ) : binaryData && isVideo ? (
            <div className="p-4 flex justify-center" style={{ background: "rgba(0,0,0,0.02)" }}>
              <video
                controls
                className="max-w-full max-h-[500px] rounded-lg"
                src={`data:${binaryData.mime};base64,${binaryData.content}`}
              />
            </div>
          ) : binaryData ? (
            <div className="p-8 text-center">
              <p className="text-sm mb-3" style={{ color: "var(--muted)" }}>
                Binary file — preview not available
              </p>
              <button
                onClick={() => downloadFile(viewingFile)}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm cursor-pointer transition-colors"
                style={{ background: "rgba(0,0,0,0.06)", color: "var(--foreground)" }}
              >
                <Download className="w-4 h-4" />
                Download {fileName}
              </button>
            </div>
          ) : (
            <pre
              className="p-4 text-xs font-mono overflow-x-auto whitespace-pre-wrap break-words"
              style={{ color: "var(--foreground)", maxHeight: 600, overflowY: "auto" }}
            >
              {fileContent}
            </pre>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-10" data-tour="page-files">
      <div>
        <h1 className="text-3xl sm:text-4xl font-normal tracking-[-0.5px]" style={{ fontFamily: "var(--font-serif)" }}>Files</h1>
        <p className="text-base mt-2" style={{ color: "var(--muted)" }}>
          Browse files on your VM and view delivery history.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 p-1 rounded-lg" style={{ background: "rgba(0,0,0,0.06)" }}>
        <button
          onClick={() => setActiveTab("browser")}
          className="flex items-center gap-2 px-4 py-2 rounded-md text-sm transition-colors cursor-pointer"
          style={{
            background: activeTab === "browser" ? "var(--card-bg)" : "transparent",
            color: activeTab === "browser" ? "var(--foreground)" : "var(--muted)",
            boxShadow: activeTab === "browser" ? "0 1px 2px rgba(0,0,0,0.1)" : "none",
          }}
        >
          <FolderOpen className="w-4 h-4" />
          File Browser
        </button>
        <button
          onClick={() => {
            setActiveTab("deliveries");
            if (!deliveriesLoaded) loadDeliveries();
          }}
          className="flex items-center gap-2 px-4 py-2 rounded-md text-sm transition-colors cursor-pointer"
          style={{
            background: activeTab === "deliveries" ? "var(--card-bg)" : "transparent",
            color: activeTab === "deliveries" ? "var(--foreground)" : "var(--muted)",
            boxShadow: activeTab === "deliveries" ? "0 1px 2px rgba(0,0,0,0.1)" : "none",
          }}
        >
          <Send className="w-4 h-4" />
          Delivery History
        </button>
      </div>

      {activeTab === "browser" ? (
        <>
          {/* Breadcrumb */}
          <div className="flex items-center gap-2">
            <button
              onClick={navigateUp}
              disabled={currentPath === "~" || currentPath === "~/.openclaw/workspace"}
              className="p-1.5 rounded-lg cursor-pointer disabled:opacity-30 transition-colors hover:bg-white/5"
              style={{ color: "var(--muted)" }}
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <code className="text-sm font-mono" style={{ color: "var(--muted)" }}>
              {displayPath(currentPath)}
            </code>
          </div>

          {viewingFile ? (
            renderFileViewer()
          ) : loading ? (
            <div className="glass rounded-xl p-8 text-center">
              <p className="text-sm" style={{ color: "var(--muted)" }}>Loading...</p>
            </div>
          ) : files.length === 0 ? (
            <div className="glass rounded-xl p-8 text-center">
              <FolderOpen className="w-8 h-8 mx-auto mb-3" style={{ color: "var(--muted)" }} />
              <p className="text-sm" style={{ color: "var(--muted)" }}>
                This directory is empty.
              </p>
            </div>
          ) : (
            <div className="glass rounded-xl overflow-hidden" style={{ border: "1px solid var(--border)" }}>
              {files.map((file, i) => {
                const locked = isProtected(file.name, file.type);
                return locked ? (
                  <div
                    key={file.name}
                    className="w-full flex items-center gap-3 px-4 py-3 text-left opacity-50"
                    style={{
                      borderBottom:
                        i < files.length - 1 ? "1px solid var(--border)" : undefined,
                    }}
                  >
                    <Lock className="w-4 h-4 shrink-0" style={{ color: "var(--muted)" }} />
                    <span className="text-sm flex-1 truncate">{file.name}</span>
                    <span className="text-xs shrink-0" style={{ color: "var(--muted)" }}>System</span>
                  </div>
                ) : (
                  <button
                    key={file.name}
                    onClick={() => handleClick(file)}
                    className="w-full flex items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-white/3 cursor-pointer"
                    style={{
                      borderBottom:
                        i < files.length - 1 ? "1px solid var(--border)" : undefined,
                    }}
                  >
                    {file.type === "directory" ? (
                      <Folder className="w-4 h-4 shrink-0" style={{ color: "#3b82f6" }} />
                    ) : (
                      getFileIcon(file.name)
                    )}
                    <span className="text-sm flex-1 truncate">{file.name}</span>
                    <span className="text-xs shrink-0" style={{ color: "var(--muted)" }}>
                      {file.type === "directory" ? "—" : formatSize(file.size)}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </>
      ) : (
        /* Delivery History Tab */
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm" style={{ color: "var(--muted)" }}>
              Files your agent delivered via Telegram.
            </p>
            <button
              onClick={loadDeliveries}
              disabled={deliveriesLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm cursor-pointer transition-colors hover:bg-white/5 disabled:opacity-50"
              style={{ color: "var(--muted)", border: "1px solid var(--border)" }}
            >
              <RefreshCw className={`w-3.5 h-3.5 ${deliveriesLoading ? "animate-spin" : ""}`} />
              Refresh
            </button>
          </div>

          {deliveriesLoading && deliveries.length === 0 ? (
            <div className="glass rounded-xl p-8 text-center">
              <p className="text-sm" style={{ color: "var(--muted)" }}>Loading delivery history...</p>
            </div>
          ) : deliveries.length === 0 ? (
            <div className="glass rounded-xl p-8 text-center">
              <Send className="w-8 h-8 mx-auto mb-3" style={{ color: "var(--muted)" }} />
              <p className="text-sm" style={{ color: "var(--muted)" }}>
                No deliveries yet. Your agent can deliver files by running:<br />
                <code className="text-xs mt-1 inline-block">~/scripts/deliver_file.sh &lt;filepath&gt;</code>
              </p>
            </div>
          ) : (
            <div className="glass rounded-xl overflow-hidden" style={{ border: "1px solid var(--border)" }}>
              {deliveries.map((d, i) => (
                <div
                  key={d.id}
                  className="flex items-center gap-3 px-4 py-3"
                  style={{
                    borderBottom: i < deliveries.length - 1 ? "1px solid var(--border)" : undefined,
                  }}
                >
                  {getFileIcon(d.filename)}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm truncate">{d.filename}</p>
                    <div className="flex items-center gap-3 mt-0.5">
                      <span className="text-xs" style={{ color: "var(--muted)" }}>
                        {formatSize(d.file_size_bytes)}
                      </span>
                      {d.telegram_method && (
                        <span className="text-xs flex items-center gap-1" style={{ color: "#3b82f6" }}>
                          <Send className="w-3 h-3" />
                          {telegramMethodLabel(d.telegram_method)}
                        </span>
                      )}
                      <span className="text-xs flex items-center gap-1" style={{ color: "var(--muted)" }}>
                        <Clock className="w-3 h-3" />
                        {formatRelativeTime(d.created_at)}
                      </span>
                      {d.caption && (
                        <span className="text-xs truncate max-w-[200px]" style={{ color: "var(--muted)" }} title={d.caption}>
                          {d.caption}
                        </span>
                      )}
                    </div>
                  </div>
                  {d.download_url && (
                    <a
                      href={d.download_url}
                      download={d.filename}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors hover:bg-white/5 shrink-0"
                      style={{ color: "var(--muted)", border: "1px solid var(--border)" }}
                    >
                      <Download className="w-3.5 h-3.5" />
                      Download
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
