"use client";

import { usePathname } from "next/navigation";

const steps = [
  { path: "/connect", label: "Connect" },
  { path: "/plan", label: "Plan" },
  { path: "/deploying", label: "Deploy" },
];

export default function OnboardingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const currentIndex = steps.findIndex((s) => pathname.includes(s.path));

  return (
    <div className="min-h-screen flex flex-col">
      {/* Progress bar */}
      <div className="border-b" style={{ borderColor: "var(--border)" }}>
        <div className="max-w-2xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            {steps.map((step, i) => (
              <div key={step.path} className="flex items-center gap-3">
                <div
                  className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold transition-colors"
                  style={{
                    background:
                      i <= currentIndex ? "#ffffff" : "var(--card)",
                    color:
                      i <= currentIndex ? "#000000" : "var(--muted)",
                    border:
                      i <= currentIndex
                        ? "1px solid #ffffff"
                        : "1px solid var(--border)",
                  }}
                >
                  {i + 1}
                </div>
                <span
                  className="text-sm hidden sm:inline"
                  style={{
                    color: i <= currentIndex ? "#ffffff" : "var(--muted)",
                  }}
                >
                  {step.label}
                </span>
                {i < steps.length - 1 && (
                  <div
                    className="w-12 sm:w-24 h-px mx-2"
                    style={{
                      background:
                        i < currentIndex
                          ? "#ffffff"
                          : "var(--border)",
                    }}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-lg">{children}</div>
      </div>
    </div>
  );
}
