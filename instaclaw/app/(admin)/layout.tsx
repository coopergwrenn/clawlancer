"use client";

import { useSession } from "next-auth/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  Server,
  Ticket,
  Users,
  ClipboardList,
} from "lucide-react";

const ADMIN_EMAILS = (process.env.NEXT_PUBLIC_ADMIN_EMAILS ?? "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

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

  if (status === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p style={{ color: "var(--muted)" }}>Loading...</p>
      </div>
    );
  }

  const email = session?.user?.email?.toLowerCase();
  if (!email || !ADMIN_EMAILS.includes(email)) {
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
          <Link href="/admin" className="text-lg font-bold tracking-tight">
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
