"use client";

import { useState, useEffect, useCallback } from "react";

interface VM {
  id: string;
  ip_address: string;
  status: string;
  health_status: string;
  assigned_to: string | null;
  region: string | null;
  created_at: string;
}

export default function AdminVMsPage() {
  const [vms, setVMs] = useState<VM[]>([]);
  const [newIP, setNewIP] = useState("");
  const [newRegion, setNewRegion] = useState("");
  const [adding, setAdding] = useState(false);

  const fetchVMs = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/vms");
      const data = await res.json();
      setVMs(data.vms ?? []);
    } catch {
      // Handle error
    }
  }, []);

  useEffect(() => {
    fetchVMs();
  }, [fetchVMs]);

  async function addVM(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true);
    try {
      await fetch("/api/admin/vms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ip_address: newIP, region: newRegion }),
      });
      setNewIP("");
      setNewRegion("");
      fetchVMs();
    } finally {
      setAdding(false);
    }
  }

  const statusColor = (status: string) => {
    if (status === "ready") return "var(--success)";
    if (status === "assigned") return "#ffffff";
    if (status === "failed") return "var(--error)";
    return "var(--muted)";
  };

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold">VM Pool</h1>

      {/* Add VM form */}
      <form onSubmit={addVM} className="glass rounded-xl p-4 flex gap-3 items-end">
        <div className="flex-1">
          <label className="text-xs block mb-1" style={{ color: "var(--muted)" }}>
            IP Address
          </label>
          <input
            type="text"
            value={newIP}
            onChange={(e) => setNewIP(e.target.value)}
            placeholder="1.2.3.4"
            required
            className="w-full px-3 py-2 rounded-lg text-sm outline-none"
            style={{
              background: "var(--card)",
              border: "1px solid var(--border)",
              color: "var(--foreground)",
            }}
          />
        </div>
        <div className="flex-1">
          <label className="text-xs block mb-1" style={{ color: "var(--muted)" }}>
            Region
          </label>
          <input
            type="text"
            value={newRegion}
            onChange={(e) => setNewRegion(e.target.value)}
            placeholder="us-east-1"
            className="w-full px-3 py-2 rounded-lg text-sm outline-none"
            style={{
              background: "var(--card)",
              border: "1px solid var(--border)",
              color: "var(--foreground)",
            }}
          />
        </div>
        <button
          type="submit"
          disabled={adding}
          className="px-4 py-2 rounded-lg text-sm font-semibold cursor-pointer disabled:opacity-50"
          style={{ background: "#ffffff", color: "#000000" }}
        >
          {adding ? "Adding..." : "Add VM"}
        </button>
      </form>

      {/* VM table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ color: "var(--muted)" }}>
              <th className="text-left py-2 px-3">IP</th>
              <th className="text-left py-2 px-3">Status</th>
              <th className="text-left py-2 px-3">Health</th>
              <th className="text-left py-2 px-3">Region</th>
              <th className="text-left py-2 px-3">Assigned To</th>
              <th className="text-left py-2 px-3">Created</th>
            </tr>
          </thead>
          <tbody>
            {vms.map((vm) => (
              <tr
                key={vm.id}
                className="border-t"
                style={{ borderColor: "var(--border)" }}
              >
                <td className="py-2 px-3 font-mono">{vm.ip_address}</td>
                <td className="py-2 px-3">
                  <span style={{ color: statusColor(vm.status) }}>
                    {vm.status}
                  </span>
                </td>
                <td className="py-2 px-3">
                  <span
                    style={{
                      color:
                        vm.health_status === "healthy"
                          ? "var(--success)"
                          : vm.health_status === "unhealthy"
                          ? "var(--error)"
                          : "var(--muted)",
                    }}
                  >
                    {vm.health_status}
                  </span>
                </td>
                <td className="py-2 px-3" style={{ color: "var(--muted)" }}>
                  {vm.region ?? "—"}
                </td>
                <td className="py-2 px-3 font-mono text-xs" style={{ color: "var(--muted)" }}>
                  {vm.assigned_to ? vm.assigned_to.slice(0, 8) + "..." : "—"}
                </td>
                <td className="py-2 px-3" style={{ color: "var(--muted)" }}>
                  {new Date(vm.created_at).toLocaleDateString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {vms.length === 0 && (
          <p className="text-center py-8 text-sm" style={{ color: "var(--muted)" }}>
            No VMs in the pool yet.
          </p>
        )}
      </div>
    </div>
  );
}
