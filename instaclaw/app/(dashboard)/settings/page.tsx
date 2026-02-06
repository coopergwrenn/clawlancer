"use client";

export default function SettingsPage() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-sm mt-1" style={{ color: "var(--muted)" }}>
          Configure your OpenClaw instance.
        </p>
      </div>

      <div className="glass rounded-xl p-8 text-center">
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Settings will be available here. For now, use the Control Panel to
          configure your OpenClaw instance directly.
        </p>
      </div>
    </div>
  );
}
