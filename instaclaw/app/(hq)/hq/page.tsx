"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence, LayoutGroup } from "motion/react";
import {
  Plus,
  X,
  GripVertical,
  Pencil,
  Trash2,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
} from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────

interface Task {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  assignee: string;
  position: number;
  created_at: string;
  updated_at: string;
}

const COLUMNS = [
  { id: "todo", label: "To Do" },
  { id: "in_progress", label: "In Progress" },
  { id: "in_review", label: "In Review" },
  { id: "done", label: "Done" },
] as const;

const PRIORITIES = ["low", "medium", "high", "urgent"] as const;

const PRIORITY_COLORS: Record<string, string> = {
  low: "#3b82f6",
  medium: "#f59e0b",
  high: "#f97316",
  urgent: "#ef4444",
};

const ASSIGNEES = ["Coop", "Dylan"];

// ── Helpers ────────────────────────────────────────────────────────────

async function api<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

// ── Helpers for column navigation ──────────────────────────────────────

const COLUMN_IDS: string[] = COLUMNS.map((c) => c.id);

function getPrevColumn(status: string): string | null {
  const idx = COLUMN_IDS.indexOf(status);
  return idx > 0 ? COLUMN_IDS[idx - 1] : null;
}

function getNextColumn(status: string): string | null {
  const idx = COLUMN_IDS.indexOf(status);
  return idx < COLUMN_IDS.length - 1 ? COLUMN_IDS[idx + 1] : null;
}

function getColumnLabel(id: string): string {
  return COLUMNS.find((c) => c.id === id)?.label || id;
}

// ── Task Card ──────────────────────────────────────────────────────────

function TaskCard({
  task,
  onEdit,
  onDelete,
  onMove,
}: {
  task: Task;
  onEdit: (t: Task) => void;
  onDelete: (id: string) => void;
  onMove: (taskId: string, newStatus: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const prev = getPrevColumn(task.status);
  const next = getNextColumn(task.status);

  return (
    <motion.div
      layout
      layoutId={task.id}
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.2 }}
      draggable
      onDragStart={(e) => {
        const de = e as unknown as DragEvent;
        de.dataTransfer?.setData("text/plain", task.id);
        (de.currentTarget as HTMLElement).classList.add("dragging-card");
      }}
      onDragEnd={(e) => {
        const de = e as unknown as DragEvent;
        (de.currentTarget as HTMLElement).classList.remove("dragging-card");
      }}
      className="glass rounded-lg p-3 cursor-grab active:cursor-grabbing group"
    >
      {/* Clickable header row */}
      <div
        className="flex items-start justify-between gap-2 cursor-pointer"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex items-start gap-2 flex-1 min-w-0">
          <GripVertical className="w-4 h-4 mt-0.5 shrink-0 opacity-30 group-hover:opacity-60 transition-opacity hidden sm:block" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ background: PRIORITY_COLORS[task.priority] }}
                title={task.priority}
              />
              <p className={`text-sm font-medium ${expanded ? "" : "truncate"}`}>{task.title}</p>
            </div>
            {!expanded && task.description && (
              <p className="text-xs truncate mt-1" style={{ color: "var(--muted)" }}>
                {task.description}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <ChevronDown
            className="w-4 h-4 transition-transform"
            style={{
              color: "var(--muted)",
              transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
            }}
          />
        </div>
      </div>

      {/* Expanded content */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="pt-2 mt-2" style={{ borderTop: "1px solid var(--border)" }}>
              {task.description ? (
                <p className="text-sm whitespace-pre-wrap mb-3" style={{ color: "var(--foreground)", lineHeight: 1.5 }}>
                  {task.description}
                </p>
              ) : (
                <p className="text-xs italic mb-3" style={{ color: "var(--muted)" }}>
                  No description
                </p>
              )}

              <div className="flex items-center gap-2 mb-3 flex-wrap">
                {task.assignee && (
                  <span
                    className="text-xs px-1.5 py-0.5 rounded"
                    style={{ background: "rgba(0,0,0,0.04)", color: "var(--muted)" }}
                  >
                    {task.assignee}
                  </span>
                )}
                <span
                  className="text-xs px-1.5 py-0.5 rounded capitalize"
                  style={{ background: "rgba(0,0,0,0.04)", color: "var(--muted)" }}
                >
                  {task.priority}
                </span>
              </div>

              {/* Actions row */}
              <div className="flex items-center justify-between">
                <div className="flex gap-1">
                  <button
                    onClick={(e) => { e.stopPropagation(); onEdit(task); }}
                    className="flex items-center gap-1 px-2 py-1 rounded-md text-xs transition-colors hover:bg-black/5 active:bg-black/5"
                    style={{ color: "var(--muted)" }}
                  >
                    <Pencil className="w-3 h-3" />
                    Edit
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); onDelete(task.id); }}
                    className="flex items-center gap-1 px-2 py-1 rounded-md text-xs transition-colors hover:bg-black/5 active:bg-black/5"
                    style={{ color: "var(--error)" }}
                  >
                    <Trash2 className="w-3 h-3" />
                    Delete
                  </button>
                </div>

                {/* Move buttons */}
                <div className="flex sm:hidden gap-1">
                  {prev && (
                    <button
                      onClick={(e) => { e.stopPropagation(); onMove(task.id, prev); }}
                      className="flex items-center gap-0.5 px-2 py-1 rounded-md text-xs transition-colors active:bg-black/5"
                      style={{ color: "var(--muted)" }}
                    >
                      <ChevronLeft className="w-3 h-3" />
                      {getColumnLabel(prev)}
                    </button>
                  )}
                  {next && (
                    <button
                      onClick={(e) => { e.stopPropagation(); onMove(task.id, next); }}
                      className="flex items-center gap-0.5 px-2 py-1 rounded-md text-xs transition-colors active:bg-black/5"
                      style={{ color: "var(--muted)" }}
                    >
                      {getColumnLabel(next)}
                      <ChevronRight className="w-3 h-3" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Collapsed: show assignee + actions on hover (desktop) */}
      {!expanded && (
        <div className="flex items-center justify-between mt-1.5">
          {task.assignee ? (
            <span
              className="text-xs px-1.5 py-0.5 rounded"
              style={{ background: "rgba(0,0,0,0.04)", color: "var(--muted)" }}
            >
              {task.assignee}
            </span>
          ) : <span />}
          <div className="flex gap-1 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
            <button
              onClick={(e) => { e.stopPropagation(); onEdit(task); }}
              className="p-1.5 sm:p-1 rounded hover:bg-black/5 transition-colors"
            >
              <Pencil className="w-3.5 h-3.5 sm:w-3 sm:h-3" style={{ color: "var(--muted)" }} />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(task.id); }}
              className="p-1.5 sm:p-1 rounded hover:bg-black/5 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5 sm:w-3 sm:h-3" style={{ color: "var(--error)" }} />
            </button>
          </div>
        </div>
      )}
    </motion.div>
  );
}

// ── Column ─────────────────────────────────────────────────────────────

function Column({
  column,
  tasks,
  onDrop,
  onEdit,
  onDelete,
  onMove,
  hideBorder,
}: {
  column: (typeof COLUMNS)[number];
  tasks: Task[];
  onDrop: (taskId: string, newStatus: string) => void;
  onEdit: (t: Task) => void;
  onDelete: (id: string) => void;
  onMove: (taskId: string, newStatus: string) => void;
  hideBorder?: boolean;
}) {
  const [over, setOver] = useState(false);

  return (
    <div
      className={`flex flex-col rounded-xl p-3 min-h-[200px] sm:min-h-[300px] ${over ? "drag-over-column" : ""}`}
      style={{
        background: hideBorder ? "transparent" : "rgba(0,0,0,0.02)",
        border: hideBorder ? "none" : "1px solid var(--border)",
        borderRadius: "0.75rem",
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const taskId = e.dataTransfer.getData("text/plain");
        if (taskId) onDrop(taskId, column.id);
      }}
    >
      {/* Column header hidden on mobile (tabs handle it) */}
      <div className="hidden sm:flex items-center justify-between mb-3 px-1">
        <h3 className="text-base font-normal tracking-[-0.3px]" style={{ fontFamily: "var(--font-serif)" }}>{column.label}</h3>
        <span
          className="text-xs px-1.5 py-0.5 rounded"
          style={{ background: "rgba(0,0,0,0.04)", color: "var(--muted)" }}
        >
          {tasks.length}
        </span>
      </div>
      <div className="flex flex-col gap-2 flex-1">
        <AnimatePresence mode="popLayout">
          {tasks.map((t) => (
            <TaskCard key={t.id} task={t} onEdit={onEdit} onDelete={onDelete} onMove={onMove} />
          ))}
        </AnimatePresence>
        {tasks.length === 0 && (
          <p className="text-xs text-center py-8 sm:py-12" style={{ color: "var(--muted)" }}>
            No tasks
          </p>
        )}
      </div>
    </div>
  );
}

// ── Task Modal ─────────────────────────────────────────────────────────

function TaskModal({
  task,
  onClose,
  onSave,
}: {
  task: Partial<Task> | null;
  onClose: () => void;
  onSave: (data: Partial<Task>) => void;
}) {
  const isEdit = !!task?.id;
  const [title, setTitle] = useState(task?.title || "");
  const [description, setDescription] = useState(task?.description || "");
  const [priority, setPriority] = useState(task?.priority || "medium");
  const [assignee, setAssignee] = useState(task?.assignee || "");
  const [status, setStatus] = useState(task?.status || "todo");
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    onSave({
      ...(task?.id ? { id: task.id } : {}),
      title: title.trim(),
      description: description.trim(),
      priority,
      assignee,
      status,
    });
  }

  const inputStyle = {
    background: "#ffffff",
    border: "1px solid var(--border)",
    color: "var(--foreground)",
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4"
      style={{ background: "rgba(0,0,0,0.3)", backdropFilter: "blur(4px)" }}
      onClick={onClose}
    >
      <motion.form
        initial={{ y: "100%", opacity: 1 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: "100%", opacity: 1 }}
        transition={{ type: "spring", damping: 30, stiffness: 300 }}
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        className="w-full sm:max-w-md rounded-t-2xl sm:rounded-xl p-5 space-y-4"
        style={{
          background: "var(--card)",
          border: "1px solid var(--border)",
          color: "var(--foreground)",
          boxShadow: "0 -4px 32px rgba(0,0,0,0.12)",
        }}
      >
        {/* Drag handle for mobile sheet */}
        <div className="flex justify-center sm:hidden mb-1">
          <div className="w-10 h-1 rounded-full" style={{ background: "rgba(0,0,0,0.15)" }} />
        </div>

        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">
            {isEdit ? "Edit Task" : "New Task"}
          </h2>
          <button type="button" onClick={onClose} className="p-1 rounded hover:bg-black/5">
            <X className="w-4 h-4" />
          </button>
        </div>

        <input
          ref={titleRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Task title"
          className="w-full px-3 py-2.5 sm:py-2 rounded-lg text-sm outline-none"
          style={inputStyle}
          required
        />

        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description (optional)"
          rows={3}
          className="w-full px-3 py-2.5 sm:py-2 rounded-lg text-sm outline-none resize-none"
          style={inputStyle}
        />

        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="text-xs mb-1 block" style={{ color: "var(--muted)" }}>
              Priority
            </label>
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
              className="w-full px-2 py-2 sm:py-1.5 rounded-lg text-sm outline-none"
              style={inputStyle}
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p.charAt(0).toUpperCase() + p.slice(1)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs mb-1 block" style={{ color: "var(--muted)" }}>
              Assignee
            </label>
            <select
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
              className="w-full px-2 py-2 sm:py-1.5 rounded-lg text-sm outline-none"
              style={inputStyle}
            >
              <option value="">Unassigned</option>
              {ASSIGNEES.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs mb-1 block" style={{ color: "var(--muted)" }}>
              Status
            </label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="w-full px-2 py-2 sm:py-1.5 rounded-lg text-sm outline-none"
              style={inputStyle}
            >
              {COLUMNS.map((c) => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-1 pb-2 sm:pb-0">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-2.5 sm:py-1.5 rounded-lg text-sm transition-colors hover:bg-black/5 text-center"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!title.trim()}
            className="px-4 py-2.5 sm:py-1.5 rounded-lg text-sm font-medium transition-opacity disabled:opacity-40 text-center"
            style={{ background: "rgba(0,0,0,0.08)" }}
          >
            {isEdit ? "Save" : "Create"}
          </button>
        </div>
      </motion.form>
    </motion.div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────

export default function HQPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [modal, setModal] = useState<Partial<Task> | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [mobileTab, setMobileTab] = useState("todo");

  const fetchTasks = useCallback(async () => {
    try {
      const data = await api<Task[]>("/api/hq/tasks");
      setTasks(data);
    } catch {
      // silent fail — will retry on next action
    }
  }, []);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  function openCreate() {
    setModal({});
    setShowModal(true);
  }

  function openEdit(task: Task) {
    setModal(task);
    setShowModal(true);
  }

  function closeModal() {
    setShowModal(false);
    setTimeout(() => setModal(null), 200);
  }

  async function handleSave(data: Partial<Task>) {
    closeModal();
    if (data.id) {
      setTasks((prev) =>
        prev.map((t) => (t.id === data.id ? { ...t, ...data } : t))
      );
      try {
        await api(`/api/hq/tasks/${data.id}`, {
          method: "PATCH",
          body: JSON.stringify(data),
        });
        fetchTasks();
      } catch {
        fetchTasks();
      }
    } else {
      const tempId = `temp-${Date.now()}`;
      const newTask: Task = {
        id: tempId,
        title: data.title || "",
        description: data.description || "",
        status: data.status || "todo",
        priority: data.priority || "medium",
        assignee: data.assignee || "",
        position: tasks.length,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      setTasks((prev) => [...prev, newTask]);
      try {
        await api<Task>("/api/hq/tasks", {
          method: "POST",
          body: JSON.stringify(data),
        });
        fetchTasks();
      } catch {
        setTasks((prev) => prev.filter((t) => t.id !== tempId));
      }
    }
  }

  async function handleDelete(id: string) {
    const prev = tasks;
    setTasks((t) => t.filter((x) => x.id !== id));
    try {
      await api(`/api/hq/tasks/${id}`, { method: "DELETE" });
    } catch {
      setTasks(prev);
    }
  }

  async function handleDrop(taskId: string, newStatus: string) {
    const task = tasks.find((t) => t.id === taskId);
    if (!task || task.status === newStatus) return;

    setTasks((prev) =>
      prev.map((t) => (t.id === taskId ? { ...t, status: newStatus } : t))
    );

    // On mobile, follow the task to its new column
    setMobileTab(newStatus);

    try {
      await api(`/api/hq/tasks/${taskId}`, {
        method: "PATCH",
        body: JSON.stringify({ status: newStatus }),
      });
    } catch {
      fetchTasks();
    }
  }

  const activeColumn = COLUMNS.find((c) => c.id === mobileTab) || COLUMNS[0];

  return (
    <LayoutGroup>
      {/* Header */}
      <div className="flex items-center justify-between mb-4 sm:mb-6">
        <h1 className="text-3xl sm:text-4xl font-normal tracking-[-0.5px]" style={{ fontFamily: "var(--font-serif)" }}>Task Board</h1>
        <button
          onClick={openCreate}
          className="glass flex items-center gap-1.5 px-3 sm:px-4 py-2 text-sm font-medium cursor-pointer rounded-lg transition-all hover:scale-[1.02] active:scale-[0.98]"
          style={{
            boxShadow:
              "0 0 12px 2px rgba(220, 103, 67, 0.15), 0 0 24px 4px rgba(220, 103, 67, 0.08), 0 2px 8px rgba(0,0,0,0.06)",
          }}
        >
          <Plus className="w-4 h-4" />
          <span className="hidden sm:inline">Add Task</span>
          <span className="sm:hidden">Add</span>
        </button>
      </div>

      {/* Mobile: Tab bar + single column */}
      <div className="sm:hidden">
        <div className="flex gap-1 mb-4 overflow-x-auto" style={{ WebkitOverflowScrolling: "touch" }}>
          {COLUMNS.map((col) => {
            const count = tasks.filter((t) => t.status === col.id).length;
            const isActive = mobileTab === col.id;
            return (
              <button
                key={col.id}
                onClick={() => setMobileTab(col.id)}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm whitespace-nowrap transition-colors shrink-0"
                style={{
                  background: isActive ? "rgba(0,0,0,0.07)" : "transparent",
                  color: isActive ? "var(--foreground)" : "var(--muted)",
                  fontWeight: isActive ? 600 : 400,
                }}
              >
                {col.label}
                {count > 0 && (
                  <span
                    className="text-xs px-1.5 py-0.5 rounded-full"
                    style={{
                      background: isActive ? "rgba(0,0,0,0.06)" : "rgba(0,0,0,0.04)",
                      color: "var(--muted)",
                    }}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <Column
          column={activeColumn}
          tasks={tasks.filter((t) => t.status === activeColumn.id)}
          onDrop={handleDrop}
          onEdit={openEdit}
          onDelete={handleDelete}
          onMove={handleDrop}
          hideBorder
        />
      </div>

      {/* Desktop: 4-column grid */}
      <div className="hidden sm:grid grid-cols-4 gap-4">
        {COLUMNS.map((col) => (
          <Column
            key={col.id}
            column={col}
            tasks={tasks.filter((t) => t.status === col.id)}
            onDrop={handleDrop}
            onEdit={openEdit}
            onDelete={handleDelete}
            onMove={handleDrop}
          />
        ))}
      </div>

      <AnimatePresence>
        {showModal && (
          <TaskModal task={modal} onClose={closeModal} onSave={handleSave} />
        )}
      </AnimatePresence>
    </LayoutGroup>
  );
}
