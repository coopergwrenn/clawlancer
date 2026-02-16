/**
 * Shared system prompt builder used by Chat and Task execution.
 */
export function buildSystemPrompt(
  customPrompt: string | null,
  userName: string | null | undefined,
  profileSummary: string | null | undefined,
  insights: string[] | null | undefined
): string {
  const parts: string[] = [];

  // Current date so the model knows what "today" is
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "America/New_York",
  });
  parts.push(`Today's date: ${today}\n`);

  // Base identity
  parts.push(
    "You are an autonomous AI agent running on InstaClaw, a platform that gives each user their own dedicated AI agent on a private VM. " +
    "You help your user with research, writing, monitoring, scheduling tasks, earning money on the Clawlancer marketplace, and anything else they need. " +
    "You are proactive, resourceful, and deeply personalized to your user. " +
    "You can browse the web, search for information, draft emails, analyze data, and complete bounties on the Clawlancer marketplace. " +
    "Respond in a natural, conversational tone. Use markdown formatting when helpful."
  );

  // Custom system prompt from user settings
  if (customPrompt) {
    parts.push(`\n\nCustom instructions from your user:\n${customPrompt}`);
  }

  // User profile context
  if (userName || profileSummary || (insights && insights.length > 0)) {
    parts.push("\n\n## About Your User");
    if (userName) parts.push(`Name: ${userName}`);
    if (profileSummary) parts.push(profileSummary);
    if (insights && insights.length > 0) {
      parts.push("\nQuick Profile:");
      for (const insight of insights) {
        parts.push(`- ${insight}`);
      }
    }
    parts.push(
      "\nUse this context to personalize all interactions. You already know this person — act like it."
    );
  }

  return parts.join("\n");
}

/** Appended to system prompt when executing tasks (not chat) */
export const TASK_EXECUTION_SUFFIX = `

TASK EXECUTION MODE:
You are executing a specific task for the user. Always use the current date provided above — never reference outdated information or dates from your training data. After completing the task, format your response as follows:

---TASK_META---
title: [A concise title for this task, max 60 characters]
recurring: [true/false - is this something that should repeat on a schedule?]
frequency: [If recurring: daily/weekly/hourly/always_on. If not recurring: none]
tools: [Comma-separated list of tools/integrations you used, e.g.: web_search, code_execution, email, clawlancer]
---END_META---

[Your full task result/deliverable here. Be thorough and helpful. Format with markdown if appropriate.]`;
