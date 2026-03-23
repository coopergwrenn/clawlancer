import { getSession } from "@/lib/auth";
import { getSkillsList } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { Sparkles } from "lucide-react";

export default async function SkillsPage() {
  const session = await getSession();
  if (!session) redirect("/");

  const skills = await getSkillsList(session.userId);

  return (
    <div className="p-4">
      <h1 className="mb-1 text-xl font-bold tracking-tight">Skills</h1>
      <p className="mb-5 text-xs text-muted">Capabilities your agent has access to</p>

      {skills.length === 0 ? (
        <div className="animate-fade-in-up flex flex-col items-center gap-4 py-16 text-center" style={{ opacity: 0 }}>
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-white/[0.03]">
            <Sparkles size={28} className="text-muted" />
          </div>
          <p className="max-w-[240px] text-sm leading-relaxed text-muted">
            No skills configured yet. Your agent will get skills after
            deployment completes.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {skills.map((skill, i) => (
            <div
              key={skill.skill_name}
              className="animate-fade-in-up glass-card flex items-center justify-between rounded-xl px-4 py-3.5"
              style={{ opacity: 0, animationDelay: `${i * 0.04}s` }}
            >
              <div className="flex items-center gap-3">
                <div
                  className="flex h-8 w-8 items-center justify-center rounded-full"
                  style={{
                    background: skill.enabled
                      ? "radial-gradient(circle at 40% 35%, rgba(220,103,67,0.18), rgba(220,103,67,0.06) 70%)"
                      : "rgba(255,255,255,0.04)",
                    boxShadow: skill.enabled
                      ? "inset 0 1.5px 3px rgba(255,255,255,0.15), 0 1px 3px rgba(220,103,67,0.08)"
                      : "none",
                  }}
                >
                  <Sparkles size={14} className={skill.enabled ? "text-accent" : "text-muted"} />
                </div>
                <span className="text-sm font-medium capitalize">
                  {skill.skill_name.replace(/-/g, " ")}
                </span>
              </div>
              <span
                className={`status-badge rounded-full border px-2.5 py-0.5 text-[10px] font-semibold ${
                  skill.enabled
                    ? "border-success/30 text-success"
                    : "border-white/10 text-muted"
                }`}
              >
                {skill.enabled ? "Active" : "Off"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
