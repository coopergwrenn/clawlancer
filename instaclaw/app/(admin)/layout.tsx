"use client";

import { useSession } from "next-auth/react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect } from "react";
import {
  BarChart3,
  Server,
  Ticket,
  Users,
  ClipboardList,
} from "lucide-react";

const navItems = [
  { href: "/admin", label: "Overview", icon: BarChart3 },
  { href: "/admin/vms", label: "VMs", icon: Server },
  { href: "/admin/invites", label: "Invites", icon: Ticket },
  { href: "/admin/users", label: "Users", icon: Users },
  { href: "/admin/waitlist", label: "Waitlist", icon: ClipboardList },
];

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { data: session, status } = useSession();
  const pathname = usePathname();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    if (status !== "authenticated" || !session?.user?.email) {
      setIsAdmin(false);
      return;
    }

    // Verify admin status via server-side API call
    fetch("/api/admin/verify")
      .then((res) => res.json())
      .then((data) => setIsAdmin(data.isAdmin === true))
      .catch(() => setIsAdmin(false));
  }, [status, session?.user?.email]);

  if (status === "loading" || isAdmin === null) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p style={{ color: "var(--muted)" }}>Loading...</p>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold">Access Denied</h1>
          <p className="text-sm mt-2" style={{ color: "var(--muted)" }}>
            You don&apos;t have admin access.
          </p>
          <Link href="/dashboard" className="text-sm underline mt-4 inline-block">
            Go to Dashboard
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <nav className="border-b" style={{ borderColor: "var(--border)" }}>
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
          <Link href="/admin" className="flex items-center gap-2 text-lg font-bold tracking-tight">
            <Image src="/logo.png" alt="InstaClaw" width={24} height={24} className="invert" />
            InstaClaw <span style={{ color: "var(--muted)" }}>Admin</span>
          </Link>
          <div className="flex items-center gap-1">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-colors"
                style={{
                  color: pathname === item.href ? "#ffffff" : "var(--muted)",
                  background:
                    pathname === item.href
                      ? "rgba(255,255,255,0.08)"
                      : "transparent",
                }}
              >
                <item.icon className="w-4 h-4" />
                <span className="hidden sm:inline">{item.label}</span>
              </Link>
            ))}
          </div>
        </div>
      </nav>
      <main className="max-w-6xl mx-auto px-4 py-8">{children}</main>
    </div>
  );
}
