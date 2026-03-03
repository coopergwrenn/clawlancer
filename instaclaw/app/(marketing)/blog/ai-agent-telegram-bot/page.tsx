import { createMetadata } from "@/lib/seo";
import { JsonLd } from "@/components/marketing/json-ld";
import { CtaBanner } from "@/components/marketing/cta-banner";
import Link from "next/link";

export const metadata = createMetadata({
  title: "How to Build a Telegram Bot with an AI Agent",
  description: "Step-by-step guide to connecting an OpenClaw AI agent to Telegram. Your agent becomes a persistent, intelligent bot that remembers everything and acts on your behalf.",
  path: "/blog/ai-agent-telegram-bot",
});

export default function AiAgentTelegramBotPage() {
  return (
    <>
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "Article",
          headline: "How to Build a Telegram Bot with an AI Agent",
          description: "Step-by-step guide to connecting an OpenClaw AI agent to Telegram. Your agent becomes a persistent, intelligent bot that remembers everything and acts on your behalf.",
          datePublished: "2026-03-03",
          author: {
            "@type": "Organization",
            name: "InstaClaw",
          },
        }}
      />

      <article
        className="mx-auto max-w-2xl px-6 py-16 sm:py-24"
        style={{ color: "#333334" }}
      >
        <Link
          href="/blog"
          className="text-sm hover:underline"
          style={{ color: "#DC6743" }}
        >
          &larr; Back to Blog
        </Link>

        <header className="mt-8 mb-12">
          <h1
            className="text-3xl sm:text-4xl font-normal tracking-[-0.5px] mb-4"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            How to Build a Telegram Bot with an AI Agent
          </h1>
          <p className="text-sm" style={{ color: "#6b6b6b" }}>
            March 3, 2026 &middot; 8 min read
          </p>
        </header>

        <section className="mb-12">
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            Telegram bots are everywhere. They order food, track packages, send reminders, and answer questions. But most of them are rigid, scripted, and forgetful. They respond to specific commands and nothing else. They have no memory, no context, and no ability to act independently.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            An <strong style={{ color: "#333334" }}>AI agent telegram bot</strong> is different. It&apos;s not just a chatbot that responds to slash commands. It&apos;s a persistent, intelligent assistant that remembers your conversations, understands natural language, learns your preferences, and takes action on your behalf. It can schedule tasks, pull data from APIs, send proactive notifications, and integrate with other tools — all through a simple Telegram interface.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            This guide shows you how to build an <strong style={{ color: "#333334" }}>openclaw telegram</strong> integration from scratch. You&apos;ll learn how to connect OpenClaw — the open-source AI agent framework — to Telegram, configure memory persistence, add custom commands, and deploy your bot so it&apos;s always online and always ready.
          </p>
        </section>

        <section className="mb-12">
          <h2
            className="text-xl sm:text-2xl font-normal tracking-[-0.5px] mb-4"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            Why Build an AI Telegram Bot with OpenClaw?
          </h2>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            Telegram is one of the most bot-friendly platforms in existence. The <strong style={{ color: "#333334" }}>Telegram Bot API</strong> is well-documented, flexible, and allows you to build everything from simple notification services to complex interactive applications. But traditional Telegram bots are limited by their programming. They only do what you explicitly tell them to do.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            <strong style={{ color: "#333334" }}>OpenClaw</strong> changes that. It&apos;s a framework that gives your bot memory, reasoning, and the ability to execute multi-step tasks. When you connect OpenClaw to Telegram, you get a bot that can handle natural language requests, remember past interactions, maintain context across sessions, and trigger actions without being explicitly prompted.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            Unlike a standard <strong style={{ color: "#333334" }}>ai telegram bot</strong> that just wraps a language model, an OpenClaw-powered bot has a structured agent loop. It can plan, execute, reflect, and learn. It stores conversations in a vector database, tracks tasks in a queue, and integrates with external APIs. You can ask it to &quot;remind me to email John tomorrow,&quot; and it will schedule that task, store the context, and send you a notification at the right time.
          </p>
        </section>

        <section className="mb-12">
          <h2
            className="text-xl sm:text-2xl font-normal tracking-[-0.5px] mb-4"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            Prerequisites: What You Need Before You Start
          </h2>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            Before you begin building your <strong style={{ color: "#333334" }}>telegram ai agent</strong>, make sure you have the following:
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            <strong style={{ color: "#333334" }}>A Telegram Bot Token:</strong> You get this by talking to <strong style={{ color: "#333334" }}>@BotFather</strong> on Telegram. Open Telegram, search for BotFather, and type <code>/newbot</code>. Follow the prompts to name your bot and get your API token. Save this token — you&apos;ll need it later.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            <strong style={{ color: "#333334" }}>An OpenClaw Instance:</strong> You need a running OpenClaw agent. You can self-host OpenClaw by cloning the repository and following the setup instructions, or you can <Link href="/blog/deploy-openclaw-no-code" className="underline" style={{ color: "#DC6743" }}>deploy OpenClaw with no code using InstaClaw</Link>. InstaClaw provisions everything you need — agent runtime, memory storage, job queue, and environment variables — in about 60 seconds.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            <strong style={{ color: "#333334" }}>An OpenAI API Key:</strong> OpenClaw uses large language models for reasoning. You&apos;ll need an API key from OpenAI, Anthropic, or another supported provider. OpenClaw is model-agnostic, so you can use GPT-4, Claude, or even self-hosted models.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            <strong style={{ color: "#333334" }}>A Server or Hosting Environment:</strong> Your Telegram bot needs to be online 24/7 to receive and respond to messages. You can use a cloud VM, a container service, or a managed platform. InstaClaw handles this automatically with always-on infrastructure and automatic restarts.
          </p>
        </section>

        <section className="mb-12">
          <h2
            className="text-xl sm:text-2xl font-normal tracking-[-0.5px] mb-4"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            Step 1: Configure Your Telegram Bot
          </h2>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            Once you have your bot token from BotFather, you need to configure your bot&apos;s settings. Go back to BotFather and use the following commands:
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            <strong style={{ color: "#333334" }}>/setdescription</strong> — Add a description that tells users what your bot does. For example: &quot;Your personal AI assistant. Ask me anything, schedule tasks, or get reminders.&quot;
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            <strong style={{ color: "#333334" }}>/setabouttext</strong> — A shorter version that appears in the bot&apos;s profile. Example: &quot;AI agent powered by OpenClaw.&quot;
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            <strong style={{ color: "#333334" }}>/setcommands</strong> — Define the commands your bot responds to. Even though your <strong style={{ color: "#333334" }}>ai telegram bot</strong> understands natural language, it&apos;s helpful to provide structured commands for common actions. Example commands might include:
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            <code>start</code> — Introduce the bot and explain how to use it<br />
            <code>help</code> — Show available commands and example queries<br />
            <code>reset</code> — Clear conversation history and start fresh<br />
            <code>status</code> — Check pending tasks and scheduled reminders
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            Once your bot is configured, you&apos;re ready to connect it to OpenClaw.
          </p>
        </section>

        <section className="mb-12">
          <h2
            className="text-xl sm:text-2xl font-normal tracking-[-0.5px] mb-4"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            Step 2: Connect OpenClaw to Telegram
          </h2>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            OpenClaw supports multiple communication channels through its modular interface system. To connect it to Telegram, you&apos;ll use the <strong style={{ color: "#333334" }}>Telegram adapter</strong> that listens for incoming messages and sends responses back through the Telegram API.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            If you&apos;re self-hosting OpenClaw, you&apos;ll need to install the Telegram client library and configure the webhook or polling mechanism. The most common approach is to use <strong style={{ color: "#333334" }}>python-telegram-bot</strong> or <strong style={{ color: "#333334" }}>node-telegram-bot-api</strong> depending on your runtime.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            Here&apos;s the basic flow: Your bot receives a message from Telegram. The adapter captures the message text and user ID, formats it as an agent input, and passes it to the OpenClaw agent loop. The agent processes the input, generates a response, and returns it to the adapter. The adapter then sends the response back to Telegram using the Bot API.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            You&apos;ll need to set environment variables for your bot token and OpenClaw configuration. If you&apos;re using InstaClaw, the Telegram integration is available as a pre-configured option. You just add your bot token in the dashboard, and InstaClaw handles the rest — no code required. Check out <Link href="/how-it-works" className="underline" style={{ color: "#DC6743" }}>how InstaClaw works</Link> to see how the platform manages integrations and deployments.
          </p>
        </section>

        <section className="mb-12">
          <h2
            className="text-xl sm:text-2xl font-normal tracking-[-0.5px] mb-4"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            Step 3: Enable Memory and Context Persistence
          </h2>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            One of the biggest advantages of an <strong style={{ color: "#333334" }}>openclaw telegram</strong> bot is memory. Unlike stateless bots that forget everything after each message, OpenClaw stores conversation history in a vector database. This allows your bot to reference past interactions, maintain long-term context, and learn from previous conversations.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            OpenClaw uses <strong style={{ color: "#333334" }}>embeddings</strong> to store and retrieve memory. Every message is converted into a vector representation and stored in a semantic memory layer. When your bot receives a new message, it searches the memory database for relevant context and includes that information in the agent&apos;s reasoning process.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            This means you can ask your bot, &quot;What did I say about the project deadline?&quot; and it will search through past conversations to find the relevant information. You can also build persistent workflows. For example, if you tell your bot, &quot;Remind me to follow up with Sarah next week,&quot; it will store that task and proactively send you a notification at the scheduled time.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            To enable memory, you need to configure a vector database backend. OpenClaw supports several options including Pinecone, Weaviate, and Qdrant. If you&apos;re using InstaClaw, memory storage is included and pre-configured. The platform provisions a dedicated vector database instance for your agent and handles backups automatically.
          </p>
        </section>

        <section className="mb-12">
          <h2
            className="text-xl sm:text-2xl font-normal tracking-[-0.5px] mb-4"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            Step 4: Add Custom Skills and Actions
          </h2>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            A basic <strong style={{ color: "#333334" }}>telegram ai agent</strong> can chat and answer questions. But the real power comes from giving your agent custom skills — functions that let it interact with external APIs, query databases, send notifications, or trigger workflows.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            OpenClaw uses a <strong style={{ color: "#333334" }}>skill system</strong> that allows you to define reusable actions. Each skill is a function that the agent can call when it determines that a specific action is needed. For example, you might create a skill called <code>schedule_reminder</code> that adds an event to your calendar, or <code>fetch_weather</code> that pulls current weather data from an API.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            Skills are defined as JSON schemas with function signatures, parameter descriptions, and example usage. When your agent receives a user request, it uses the language model to determine which skill to invoke and generates the appropriate function call. The skill executes, returns a result, and the agent incorporates that result into its response.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            For example, if you ask your bot, &quot;What&apos;s the weather in New York?&quot; the agent recognizes that it needs to fetch weather data, calls the <code>fetch_weather</code> skill with the parameter <code>city: &quot;New York&quot;</code>, receives the result, and responds with the current conditions.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            You can build skills for almost anything: querying your company&apos;s CRM, checking inventory levels, sending Slack messages, updating Notion databases, or even placing orders through an e-commerce API. The <Link href="/docs" className="underline" style={{ color: "#DC6743" }}>InstaClaw documentation</Link> includes guides and examples for building and deploying custom skills.
          </p>
        </section>

        <section className="mb-12">
          <h2
            className="text-xl sm:text-2xl font-normal tracking-[-0.5px] mb-4"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            Step 5: Handle Telegram-Specific Features
          </h2>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            Telegram supports rich message formats that go beyond plain text. Your <strong style={{ color: "#333334" }}>ai telegram bot</strong> can send photos, documents, buttons, inline keyboards, and even interactive polls. To take full advantage of Telegram&apos;s features, you&apos;ll want to configure your OpenClaw adapter to support these formats.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            <strong style={{ color: "#333334" }}>Inline keyboards</strong> allow you to present users with button options. For example, if your bot asks, &quot;Do you want to schedule this task?&quot; you can provide &quot;Yes&quot; and &quot;No&quot; buttons instead of requiring a typed response. The user taps a button, and your bot receives the callback.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            <strong style={{ color: "#333334" }}>File uploads</strong> are another powerful feature. Your agent can analyze images, process documents, or extract data from PDFs. When a user sends a file to your bot, the Telegram adapter downloads it, passes it to the agent, and the agent can invoke skills to process the file.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            <strong style={{ color: "#333334" }}>Group chat integration</strong> is also supported. You can add your bot to Telegram groups and configure it to respond to mentions, specific keywords, or all messages. This is useful for team collaboration scenarios where the bot acts as a shared assistant.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            All of these features require configuration in your Telegram adapter. If you&apos;re building from scratch, you&apos;ll need to handle the Telegram API payloads and format responses accordingly. InstaClaw provides pre-built templates for common Telegram features, so you can enable them without writing custom code.
          </p>
        </section>

        <section className="mb-12">
          <h2
            className="text-xl sm:text-2xl font-normal tracking-[-0.5px] mb-4"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            Step 6: Deploy and Monitor Your Bot
          </h2>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            Once your <strong style={{ color: "#333334" }}>openclaw telegram</strong> bot is configured and tested locally, it&apos;s time to deploy it. Your bot needs to run continuously to receive and respond to messages. If your server goes down, your bot goes offline.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            If you&apos;re self-hosting, you&apos;ll need to set up a production-ready environment with process management, logging, and automatic restarts. Most developers use Docker containers with orchestration tools like Kubernetes or simpler solutions like PM2 for Node.js or systemd for Python services.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            You&apos;ll also need to configure webhooks. Telegram can push messages to a URL endpoint instead of requiring your bot to poll the API. This is more efficient and scales better. Set up a public HTTPS endpoint, register it with Telegram using the <code>setWebhook</code> API call, and configure your OpenClaw adapter to listen on that endpoint.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            Monitoring is essential. You need to track uptime, response times, error rates, and memory usage. Set up alerting so you know when something breaks. Most teams use tools like Prometheus, Grafana, or Datadog for observability.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            InstaClaw handles all of this automatically. When you deploy an OpenClaw agent through InstaClaw, the platform provisions the infrastructure, configures webhooks, sets up monitoring, and provides a dashboard where you can view logs, metrics, and usage statistics. If your agent crashes, InstaClaw restarts it automatically. You get alerts if something goes wrong. <Link href="/pricing" className="underline" style={{ color: "#DC6743" }}>Plans start at $29/month</Link> for fully managed hosting with always-on infrastructure.
          </p>
        </section>

        <section className="mb-12">
          <h2
            className="text-xl sm:text-2xl font-normal tracking-[-0.5px] mb-4"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            Step 7: Test and Iterate
          </h2>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            Your first version won&apos;t be perfect. You&apos;ll discover edge cases, unclear responses, and skills that need refinement. The key to building a great <strong style={{ color: "#333334" }}>telegram ai agent</strong> is iteration.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            Start by testing common workflows. Ask your bot typical questions and see how it responds. Try natural language variations to ensure it understands different phrasings. Test memory by referencing past conversations and verifying that context is retrieved correctly.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            Pay attention to latency. If your bot takes too long to respond, users will lose interest. Optimize your skills, reduce unnecessary API calls, and use caching where appropriate. OpenClaw&apos;s agent loop includes performance metrics that help you identify bottlenecks.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            Collect feedback from real users. Ask them what works, what doesn&apos;t, and what features they wish the bot had. Use that feedback to prioritize improvements. Over time, your agent will become more capable, more accurate, and more useful.
          </p>
        </section>

        <section className="mb-12">
          <h2
            className="text-xl sm:text-2xl font-normal tracking-[-0.5px] mb-4"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            Real-World Use Cases for AI Telegram Bots
          </h2>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            Once you have a working <strong style={{ color: "#333334" }}>ai telegram bot</strong> powered by OpenClaw, the possibilities are nearly endless. Here are some practical use cases:
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            <strong style={{ color: "#333334" }}>Personal productivity assistant:</strong> Schedule tasks, set reminders, track to-dos, and get daily summaries of your schedule. Your bot can integrate with Google Calendar, Notion, or Todoist to keep everything in sync.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            <strong style={{ color: "#333334" }}>Customer support automation:</strong> Deploy a bot in your company&apos;s Telegram support channel. It can answer common questions, look up order statuses, and escalate complex issues to human agents.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            <strong style={{ color: "#333334" }}>Team collaboration tool:</strong> Add your bot to a team group chat. It can summarize discussions, track action items, send daily standups, and integrate with project management tools like Jira or Linear.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            <strong style={{ color: "#333334" }}>Data retrieval and reporting:</strong> Connect your bot to internal databases or APIs. Team members can ask, &quot;What were last month&apos;s sales numbers?&quot; and get instant answers without logging into dashboards.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            <strong style={{ color: "#333334" }}>Content curation:</strong> Build a bot that monitors RSS feeds, news sites, or social media and sends you personalized updates based on your interests. It can summarize articles, extract key points, and notify you when important topics trend.
          </p>
        </section>

        <section className="mb-12">
          <h2
            className="text-xl sm:text-2xl font-normal tracking-[-0.5px] mb-4"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            Why InstaClaw Makes Telegram Bot Development Easier
          </h2>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            Building a production-ready <strong style={{ color: "#333334" }}>telegram ai agent</strong> from scratch requires expertise in multiple domains: agent frameworks, Telegram APIs, database management, deployment, monitoring, and security. It can take weeks to get everything working reliably.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            InstaClaw eliminates that complexity. You get a fully configured OpenClaw instance with Telegram integration built in. Add your bot token, configure your skills, and deploy. The platform handles infrastructure, memory storage, job scheduling, webhook configuration, and monitoring. You focus on defining what your agent should do, not how to keep it running.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            InstaClaw also provides pre-built templates for common Telegram features like inline keyboards, file uploads, and group chat integration. You can enable these features with a few clicks instead of writing integration code. The dashboard gives you real-time visibility into your bot&apos;s activity, including message volume, response times, and memory usage.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            If you want to experiment with <strong style={{ color: "#333334" }}>openclaw telegram</strong> bots without managing infrastructure, InstaClaw is the fastest way to get started. Plans include everything you need to run a production agent, and you can scale as your usage grows.
          </p>
        </section>

        <section className="mb-12 border-t pt-8" style={{ borderColor: "#e5e5e5" }}>
          <h2
            className="text-xl sm:text-2xl font-normal tracking-[-0.5px] mb-4"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            Related Pages
          </h2>
          <ul className="space-y-2">
            <li>
              <Link
                href="/blog/deploy-openclaw-no-code"
                className="text-sm underline"
                style={{ color: "#DC6743" }}
              >
                Deploy OpenClaw with No Code
              </Link>
            </li>
            <li>
              <Link
                href="/how-it-works"
                className="text-sm underline"
                style={{ color: "#DC6743" }}
              >
                How InstaClaw Works
              </Link>
            </li>
            <li>
              <Link
                href="/docs"
                className="text-sm underline"
                style={{ color: "#DC6743" }}
              >
                InstaClaw Documentation
              </Link>
            </li>
            <li>
              <Link
                href="/pricing"
                className="text-sm underline"
                style={{ color: "#DC6743" }}
              >
                Pricing
              </Link>
            </li>
          </ul>
        </section>
      </article>

      <CtaBanner />
    </>
  );
}