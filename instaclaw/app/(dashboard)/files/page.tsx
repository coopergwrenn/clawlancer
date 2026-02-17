"use client";

import { useState, useEffect } from "react";
import { Folder, File, ArrowLeft, FolderOpen } from "lucide-react";

interface FileEntry {
  name: string;
  type: string;
  size: number;
  modified: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function FilesPage() {
  const [currentPath, setCurrentPath] = useState("~/.openclaw/workspace");
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [viewingFile, setViewingFile] = useState<string | null>(null);

  async function loadDirectory(path: string) {
    setLoading(true);
    setFileContent(null);
    setViewingFile(null);
    try {
      const res = await fetch(`/api/vm/files?path=${encodeURIComponent(path)}`);
      const data = await res.json();
      setFiles(data.files ?? []);
      setCurrentPath(path);
    } catch {
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }

  async function viewFile(filePath: string) {
    setViewingFile(filePath);
    try {
      const res = await fetch(
        `/api/vm/files?file=${encodeURIComponent(filePath)}`
      );
      const data = await res.json();
      setFileContent(data.content ?? "");
    } catch {
      setFileContent("Error loading file");
    }
  }

  useEffect(() => {
    loadDirectory(currentPath);
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

  return (
    <div className="space-y-10" data-tour="page-files">
      <div>
        <h1 className="text-3xl sm:text-4xl font-normal tracking-[-0.5px]" style={{ fontFamily: "var(--font-serif)" }}>File Browser</h1>
        <p className="text-base mt-2" style={{ color: "var(--muted)" }}>
          Browse files on your VM.
        </p>
      </div>

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
          {currentPath.replace("~/.openclaw/workspace", "~/workspace")}
        </code>
      </div>

      {viewingFile && fileContent !== null ? (
        /* File viewer */
        <div className="space-y-3">
          <button
            onClick={() => {
              setViewingFile(null);
              setFileContent(null);
            }}
            className="flex items-center gap-1.5 text-sm cursor-pointer"
            style={{ color: "var(--muted)" }}
          >
            <ArrowLeft className="w-4 h-4" />
            Back to directory
          </button>
          <div className="glass rounded-xl p-1" style={{ border: "1px solid var(--border)" }}>
            <div className="px-4 py-2 text-xs font-mono" style={{ color: "var(--muted)", borderBottom: "1px solid var(--border)" }}>
              {viewingFile?.replace("~/.openclaw/workspace", "~/workspace")}
            </div>
            <pre
              className="p-4 text-xs font-mono overflow-x-auto"
              style={{ color: "var(--foreground)", maxHeight: 500, overflowY: "auto" }}
            >
              {fileContent}
            </pre>
          </div>
        </div>
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
          {files.map((file, i) => (
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
                <File className="w-4 h-4 shrink-0" style={{ color: "var(--muted)" }} />
              )}
              <span className="text-sm flex-1 truncate">{file.name}</span>
              <span className="text-xs shrink-0" style={{ color: "var(--muted)" }}>
                {file.type === "directory" ? "—" : formatSize(file.size)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
