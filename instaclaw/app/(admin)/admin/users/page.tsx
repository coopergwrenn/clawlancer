"use client";

import { useState, useEffect } from "react";

interface User {
  id: string;
  email: string;
  name: string | null;
  created_at: string;
  onboarding_complete: boolean;
  vm_status: string | null;
}

export default function AdminUsersPage() {
  const [users, setUsers] = useState<User[]>([]);

  useEffect(() => {
    fetch("/api/admin/stats?type=users")
      .then((r) => r.json())
      .then((data) => setUsers(data.users ?? []))
      .catch(() => {});
  }, []);

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold">Users</h1>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ color: "var(--muted)" }}>
              <th className="text-left py-2 px-3">Email</th>
              <th className="text-left py-2 px-3">Name</th>
              <th className="text-left py-2 px-3">Onboarded</th>
              <th className="text-left py-2 px-3">VM Status</th>
              <th className="text-left py-2 px-3">Joined</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr
                key={user.id}
                className="border-t"
                style={{ borderColor: "var(--border)" }}
              >
                <td className="py-2 px-3">{user.email}</td>
                <td className="py-2 px-3" style={{ color: "var(--muted)" }}>
                  {user.name ?? "—"}
                </td>
                <td className="py-2 px-3">
                  <span
                    style={{
                      color: user.onboarding_complete
                        ? "var(--success)"
                        : "var(--muted)",
                    }}
                  >
                    {user.onboarding_complete ? "Yes" : "No"}
                  </span>
                </td>
                <td className="py-2 px-3" style={{ color: "var(--muted)" }}>
                  {user.vm_status ?? "—"}
                </td>
                <td className="py-2 px-3" style={{ color: "var(--muted)" }}>
                  {new Date(user.created_at).toLocaleDateString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {users.length === 0 && (
          <p className="text-center py-8 text-sm" style={{ color: "var(--muted)" }}>
            No users yet.
          </p>
        )}
      </div>
    </div>
  );
}
