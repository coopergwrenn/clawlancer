export interface TourStep {
  selector: string;
  title: string;
  description: string;
  position?: "top" | "bottom" | "left" | "right" | "auto";
  navigateTo?: string;
  preAction?: "open-more";
  keepMoreOpen?: boolean;
  large?: boolean;
}

const tourSteps: TourStep[] = [
  {
    selector: '[data-tour="nav-dashboard"]',
    title: "Dashboard",
    description:
      "This is your home screen. Check in here to see how your agent is doing, your usage stats, and quick actions.",
  },
  {
    selector: '[data-tour="nav-command-center"]',
    title: "Command Center",
    description:
      "This is where you'll spend most of your time. Give your agent tasks, have conversations, and find everything it creates.",
  },
  {
    selector: '[data-tour="tab-tasks"]',
    title: "Tasks Tab",
    description:
      "Tell your agent what to do — like \"Research competitors in my industry\" or \"Draft a weekly newsletter.\" It runs each task and saves the result for you.",
    navigateTo: "/tasks",
  },
  {
    selector: '[data-tour="tab-chat"]',
    title: "Chat Tab",
    description:
      "Think of this as texting your agent. Ask questions, brainstorm ideas, or get quick answers — just like chatting with a coworker.",
  },
  {
    selector: '[data-tour="tab-library"]',
    title: "Library Tab",
    description:
      "Everything your agent creates ends up here. Pin the good stuff, search past work, or export anything as a file.",
  },
  {
    selector: '[data-tour="input-bar"]',
    title: "Type Here to Get Started",
    description:
      "This is where you give instructions. Just type what you need — your agent has full internet access and works on a private server dedicated to you.",
    position: "top",
  },
  {
    selector: '[data-tour="quick-chips"]',
    title: "Quick Actions",
    description:
      "Not sure what to try? Tap any of these for instant ideas. They're one-click shortcuts for popular tasks.",
    position: "top",
  },
  {
    selector: '[data-tour="nav-history"]',
    title: "History",
    description:
      "A complete record of everything — past conversations, completed tasks, and all results. Nothing gets lost.",
  },
  {
    selector: '[data-tour="nav-more"]',
    title: "More Options",
    description:
      "Your extra tools and settings live here. Let's take a quick peek inside.",
    preAction: "open-more",
  },
  {
    selector: '[data-tour="nav-files"]',
    title: "Files",
    description:
      "Upload documents for your agent to read, or download files it creates — like reports, spreadsheets, or images.",
    keepMoreOpen: true,
  },
  {
    selector: '[data-tour="nav-scheduled"]',
    title: "Scheduled Tasks",
    description:
      "Set tasks to repeat daily, weekly, or on any schedule. Your agent handles them automatically and delivers the results.",
    keepMoreOpen: true,
  },
  {
    selector: '[data-tour="nav-api-keys"]',
    title: "API Keys",
    description:
      "Give your agent access to services like Brave Search or custom APIs. Add keys here and it can use them in tasks.",
    keepMoreOpen: true,
  },
  {
    selector: '[data-tour="nav-settings"]',
    title: "Settings",
    description:
      "Make it yours — customize your agent's personality, choose its AI model, set a system prompt, and pick how results get delivered.",
    keepMoreOpen: true,
  },
  {
    selector: '[data-tour="nav-billing"]',
    title: "Billing",
    description:
      "View your plan, check usage, and manage payments. Everything billing-related is right here.",
    keepMoreOpen: true,
  },
  {
    selector: '[data-tour="input-bar"]',
    title: "One Last Thing: Recurring Tasks",
    description:
      "Here's the real power move. Type something like \"Every morning at 8am, summarize the top AI news\" — your agent will run it on schedule and send results straight to your Telegram. Set it and forget it.",
    navigateTo: "/tasks",
    position: "top",
    large: true,
  },
];

export default tourSteps;
