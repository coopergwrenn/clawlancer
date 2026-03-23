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
      <h1 className="mb-4 text-xl font-bold">Skills</h1>

      {skills.length === 0 ? (
        <div className="flex flex-col items-center gap-4 py-12 text-center">
          <Sparkles size={40} className="text-muted" />
          <p className="text-sm text-muted">
            No skills configured yet. Your agent will get skills after
            deployment completes.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {skills.map((skill) => (
            <div
              key={skill.skill_name}
              className="flex items-center justify-between rounded-xl border border-border bg-card px-4 py-3"
            >
              <div>
                <p className="text-sm font-medium capitalize">
                  {skill.skill_name.replace(/-/g, " ")}
                </p>
              </div>
              <span
                className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                  skill.enabled
                    ? "bg-success/15 text-success"
                    : "bg-card-hover text-muted"
                }`}
              >
                {skill.enabled ? "On" : "Off"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
