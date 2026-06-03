export interface TourStep {
  selector: string;
  title: string;
  description: string;
  position?: "top" | "bottom" | "left" | "right" | "auto";
  navigateTo?: string;
  preAction?: "open-more";
  keepMoreOpen?: boolean;
  large?: boolean;
  // Sidebar mode only: this step targets a left-rail nav item. On mobile the
  // rail lives behind the hamburger, so SpotlightTour opens the drawer before
  // positioning; on desktop the rail is always visible (no-op). Page-content
  // steps leave this unset so the drawer stays closed and the page is visible.
  sidebarNav?: boolean;
}

const tourSteps: TourStep[] = [
  // ── Dashboard page tour ──────────────────────────────────
  {
    selector: '[data-tour="nav-dashboard"]',
    title: "Dashboard",
    description:
      "This is your home screen. We'll walk through everything here so you know exactly where to check on your agent, your usage, and your plan.",
    navigateTo: "/dashboard",
  },
  {
    selector: '[data-tour="dash-usage"]',
    title: "Your Daily Usage",
    description:
      "This shows how many units you've used today out of your daily allowance. It resets every night at midnight UTC. Different AI models cost different amounts: Haiku is 1 unit, Sonnet is 4, and Opus is 19.",
    navigateTo: "/dashboard",
  },
  {
    selector: '[data-tour="dash-credits"]',
    title: "Credits & Buy More",
    description:
      "If you hit your daily limit, credits keep you going. Tap the orange \"Buy Credits\" button to grab a pack. They kick in instantly and never expire. If you find yourself running low often, upgrading your plan is usually the better deal.",
    navigateTo: "/dashboard",
  },
  {
    selector: '[data-tour="dash-plan"]',
    title: "Your Plan",
    description:
      "Here's your current subscription. If you find yourself running out of daily units regularly, consider upgrading to the next plan. You'll get a higher daily limit and it's more cost-effective than buying credit packs.",
    navigateTo: "/dashboard",
  },
  {
    selector: '[data-tour="dash-status"]',
    title: "Agent Health & Status",
    description:
      "This tells you if your agent's server is healthy and running. A green \"healthy\" status means everything is working perfectly. If your bot ever stops responding or feels stuck, scroll down and hit \"Restart Bot\" to get it back on track.",
    navigateTo: "/dashboard",
  },
  {
    selector: '[data-tour="dash-model"]',
    title: "Switch AI Models",
    description:
      "Choose which Claude model your agent uses by default. Here's the best part: you can also switch models just by telling your bot. Say \"use Sonnet\" or \"switch to Opus\" in chat and it changes instantly.",
    navigateTo: "/dashboard",
    large: true,
  },
  {
    selector: '[data-tour="dash-verify"]',
    title: "Verify You're Human",
    description:
      "Optional, but worth it. Verifying with World ID proves a real human is behind your agent, which wires premium tools into it (Exa, Manus, Browserbase, and more), gives it an on-chain identity, and unlocks higher autonomy as it earns standing.",
    navigateTo: "/dashboard",
  },
  {
    selector: '[data-tour="dash-marketplace"]',
    title: "Virtuals Marketplace",
    description:
      "Turn this on and your agent can pick up paid jobs from the Virtuals Protocol marketplace when it's not busy with your tasks. After enabling, message your bot to complete the one-time Virtuals authentication. Your own tasks always come first.",
    navigateTo: "/dashboard",
  },
  {
    selector: '[data-tour="dash-reset"]',
    title: "Fresh Start",
    description:
      "If your agent ever feels off, or you just want a clean slate, tap here to reset everything: memory, conversation history, and identity. Your agent starts over as if it was just deployed. This also restarts background processes if anything seems stuck. Totally optional, but good to know it's here.",
    navigateTo: "/dashboard",
  },
  {
    selector: '[data-tour="dash-pro-tip"]',
    title: "Pro Tip: Talk to Your Bot",
    description:
      "Almost everything on this dashboard, you can do just by chatting with your bot. Want to add a new tool or service? Just paste an API key into chat and your agent sets it up instantly. And here's what makes it special: your agent has persistent memory. It learns your preferences, remembers past work, and gets smarter every day the more you use it.",
    navigateTo: "/dashboard",
    large: true,
  },

  // ── Navigation + Command Center tour ─────────────────────
  {
    selector: '[data-tour="nav-command-center"]',
    title: "Command Center",
    description:
      "Now let's check out the Command Center. This is where the magic happens. Give your agent any task, have conversations, and find everything it creates. Just tell it what you need and it figures out the rest.",
  },
  {
    selector: '[data-tour="tab-tasks"]',
    title: "Tasks Tab",
    description:
      "Tell your agent what to do, like \"Research competitors in my industry\" or \"Draft a weekly newsletter.\" It runs each task and saves the result for you.",
    navigateTo: "/tasks",
  },
  {
    selector: '[data-tour="tab-chat"]',
    title: "Chat Tab",
    description:
      "Think of this as texting your agent. Ask questions, brainstorm ideas, or get quick answers, just like you would with a coworker.",
    navigateTo: "/tasks",
  },
  {
    selector: '[data-tour="tab-library"]',
    title: "Library Tab",
    description:
      "Everything your agent creates ends up here. Pin the good stuff, search past work, or export anything as a file.",
    navigateTo: "/tasks",
  },
  {
    selector: '[data-tour="input-bar"]',
    title: "Type Here to Get Started",
    description:
      "This is where you give instructions. Just type what you need. Your agent has full internet access and works on a private server dedicated to you.",
    navigateTo: "/tasks",
    position: "top",
  },
  {
    selector: '[data-tour="quick-chips"]',
    title: "Quick Actions",
    description:
      "Not sure what to try? Tap any of these for instant ideas. They're one-click shortcuts for popular tasks.",
    navigateTo: "/tasks",
    position: "top",
  },
  {
    selector: '[data-tour="page-heartbeat"]',
    title: "Heartbeat",
    description:
      "This is your agent's pulse. It automatically wakes up on a schedule to check messages, process tasks, and stay on top of things. You can control how often it checks in. More frequent means more responsive, but uses more of its separate daily heartbeat credits.",
    navigateTo: "/heartbeat",
  },
  {
    selector: '[data-tour="nav-history"]',
    title: "History",
    description:
      "A complete record of everything: past conversations, completed tasks, and all results. Nothing gets lost.",
  },
  {
    selector: '[data-tour="nav-more"]',
    title: "More Options",
    description:
      "Your extra tools and settings live here. Let's take a quick peek inside.",
    preAction: "open-more",
    keepMoreOpen: true,
  },
  {
    selector: '[data-tour="page-files"]',
    title: "Files",
    description:
      "This is your file manager. Upload documents for your agent to read, or download files it creates, like reports, spreadsheets, or images.",
    navigateTo: "/files",
  },
  {
    selector: '[data-tour="page-scheduled"]',
    title: "Scheduled Tasks",
    description:
      "This is where your recurring tasks live. Set tasks to repeat daily, weekly, or on any schedule. Your agent handles them automatically and delivers the results.",
    navigateTo: "/scheduled",
  },
  {
    selector: '[data-tour="page-api-keys"]',
    title: "API Keys",
    description:
      "Want to connect a new service? Just paste any API key into your chat with your agent and it handles everything. It saves the key, sets up the integration, and has that skill ready to use. You can also manage all your keys here manually.",
    navigateTo: "/env-vars",
  },
  {
    selector: '[data-tour="settings-plan"]',
    title: "Settings: Your Plan",
    description:
      "Here you can view and manage your current subscription. Tap \"Manage Plan\" to upgrade, change payment methods, or view invoices through Stripe.",
    navigateTo: "/settings",
  },
  {
    selector: '[data-tour="settings-bot-info"]',
    title: "Settings: Bot Info",
    description:
      "A quick reference for your bot's details: its username, the server it runs on, your plan type, and which messaging channels are active.",
    navigateTo: "/settings",
  },
  {
    selector: '[data-tour="settings-gmail"]',
    title: "Settings: Gmail Personalization",
    description:
      "Optionally connect your Gmail so your agent can learn about you from inbox patterns. It only reads metadata, never full emails. This helps your agent give more personalized responses.",
    navigateTo: "/settings",
  },
  {
    selector: '[data-tour="page-billing-card"]',
    title: "Billing",
    description:
      "View your plan, check usage, and manage payments. Everything billing-related is right here.",
    navigateTo: "/billing",
  },
  {
    selector: '[data-tour="input-bar"]',
    title: "One Last Thing: Recurring Tasks",
    description:
      "Here's the real power move. Type something like \"Every morning at 8am, summarize the top AI news\" and your agent runs it on schedule, delivering results to your Telegram. It gets smarter over time too, learning what matters to you and refining every result.",
    navigateTo: "/tasks",
    position: "top",
    large: true,
  },
];

export default tourSteps;

/**
 * Adapt a single step for sidebar mode. Only the four nav-chrome steps differ
 * from top-nav; every page-content step passes through unchanged (its
 * data-tour selector lives on the page body, which the restructure never
 * touches). Keeping the array the SAME LENGTH (replace nav-more, don't remove)
 * means a saved tourStep index stays meaningful if the flag flips mid-tour.
 */
function adaptStepForSidebar(step: TourStep): TourStep {
  switch (step.selector) {
    case '[data-tour="nav-dashboard"]':
      // Dashboard is demoted to "Overview" (Account & Plan). Reframe: this is
      // the control panel, but the home base is Command Center.
      return {
        ...step,
        title: "Your Overview",
        // No "next" promise — 9 dashboard-detail steps run before the Command
        // Center step, so the parenthetical sets the mental model without
        // implying it's the immediate next stop.
        description:
          "You're on your Overview — the control panel for your agent: its health, your usage, and your plan all live here. (Your everyday home is the Command Center — we'll get there.) Let's start with the essentials.",
        sidebarNav: true,
      };
    case '[data-tour="nav-command-center"]':
      // Now the explicit home of the workspace.
      return {
        ...step,
        title: "Command Center — your home",
        description:
          "This is your Command Center, the heart of your workspace. Give your agent any task, have a conversation, and find everything it creates — all in one place. It's where you'll spend your time.",
        sidebarNav: true,
      };
    case '[data-tour="nav-history"]':
      // Resurrected: in the top-nav this step silently auto-skipped (History
      // only existed inside the closed "···" menu). In the sidebar it's a
      // visible rail item, so the step finally lands on something real.
      return { ...step, sidebarNav: true };
    case '[data-tour="nav-more"]':
      // No "···" menu in the sidebar — everything is visible. Replace the
      // open-the-menu step with one that frames the Account & Plan section.
      return {
        selector: '[data-tour="nav-manage-section"]',
        title: "Account & Plan",
        // Viewport-agnostic ("here" reads right on both the desktop rail and
        // the mobile drawer; no "down here"/"in the sidebar" assumptions).
        description:
          "Your account lives here — Overview, Credits, Billing, Settings, and API Keys. No buried menus; it's all one click away.",
        position: "right",
        sidebarNav: true,
      };
    default:
      return step;
  }
}

/**
 * Return the tour for the active nav chrome. `topnav` is the canonical array
 * verbatim (zero behaviour change when the sidebar flag is off); `sidebar`
 * maps each step through the adapter above.
 */
export function buildTourSteps(navMode: "topnav" | "sidebar"): TourStep[] {
  if (navMode === "sidebar") return tourSteps.map(adaptStepForSidebar);
  return tourSteps;
}
