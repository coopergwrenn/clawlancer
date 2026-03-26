import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Dispatch Mode — Remote Computer Control | InstaClaw",
  description: "Let your InstaClaw agent control your computer. Screenshots, clicks, typing, and more via a secure relay.",
};

export default function DispatchDocsPage() {
  return (
    <div className="max-w-3xl mx-auto px-4 py-16">
      <h1
        className="text-4xl font-normal tracking-[-1px] mb-6"
        style={{ fontFamily: "var(--font-serif)" }}
      >
        Dispatch Mode
      </h1>
      <p className="text-lg text-[var(--muted)] mb-12">
        Let your agent control your computer — take screenshots, click buttons,
        type text, and navigate any app on your Mac or PC.
      </p>

      <Section title="How It Works">
        <p>
          Your agent runs on a dedicated server 24/7. Dispatch Mode creates a
          secure tunnel between your agent and your personal computer. When you
          run the relay, your agent can see your screen and interact with any
          application — just like a remote assistant sitting at your desk.
        </p>
      </Section>

      <Section title="Quick Start">
        <p className="mb-4">
          <strong>Easiest way:</strong> Go to{" "}
          <a href="/settings" className="underline">instaclaw.io/settings</a> and
          click <strong>&quot;Connect Your Computer&quot;</strong>. It downloads a small
          file — double-click it and you&apos;re connected.
        </p>
        <p className="mb-4">
          <strong>Or from your terminal:</strong>
        </p>
        <CodeBlock>npx @instaclaw/dispatch</CodeBlock>
        <p className="mt-4">
          You&apos;ll be asked for a pairing code (shown on your Settings page).
          Enter it and the relay connects automatically via encrypted WebSocket.
        </p>
      </Section>

      <Section title="Requirements">
        <ul className="list-disc pl-6 space-y-2">
          <li>Node.js 18 or later</li>
          <li>Pro or Power tier subscription</li>
          <li>
            <strong>macOS:</strong> Grant Accessibility and Screen Recording
            permissions to your terminal app (Terminal, iTerm, Warp, etc.)
          </li>
          <li>
            <strong>Windows:</strong> No special permissions needed
          </li>
          <li>
            <strong>Linux:</strong> X11 display server (Wayland not yet
            supported)
          </li>
        </ul>
      </Section>

      <Section title="What Your Agent Can Do">
        <ul className="list-disc pl-6 space-y-2">
          <li>Take screenshots of your screen</li>
          <li>Click at any position</li>
          <li>Type text via keyboard</li>
          <li>Press key combos (Cmd+C, Ctrl+V, etc.)</li>
          <li>Drag and drop between positions</li>
          <li>Scroll in any direction</li>
          <li>List open windows</li>
          <li>Open and control any desktop application</li>
          <li>
            <strong>Batch actions</strong> — execute multiple actions in one
            round-trip (click, type, press Enter) for 2-3x faster task
            completion
          </li>
        </ul>
      </Section>

      <Section title="Modes">
        <h3 className="font-semibold mb-2">Supervised (default)</h3>
        <p className="mb-4">
          Every action the agent wants to take is shown in your terminal. Press
          Enter to approve or &apos;n&apos; to deny. Screenshots are
          auto-approved.
        </p>
        <h3 className="font-semibold mb-2">Autonomous</h3>
        <p>
          Auto-approves most actions. Dangerous actions (passwords, delete,
          purchases) still require your confirmation. Enable with:
        </p>
        <CodeBlock>npx @instaclaw/dispatch --autonomous</CodeBlock>
      </Section>

      <Section title="Speed">
        <p className="mb-4">
          Dispatch v0.5 introduced <strong>action batching</strong> and
          optimized screenshots for significantly faster computer control.
        </p>
        <ul className="list-disc pl-6 space-y-2">
          <li>
            <strong>Batch actions:</strong> Your agent plans multiple steps
            (click, type, press Enter) and executes them in a single round-trip
            instead of one at a time — <strong>2-3x faster</strong> for
            multi-step tasks
          </li>
          <li>
            <strong>WebP screenshots:</strong> 50-60% smaller than the previous
            JPEG format, reducing transfer time without losing visual quality
          </li>
          <li>
            <strong>Smart verification:</strong> Your agent only takes
            screenshots at decision points, not after every keystroke — cutting
            vision costs by up to 70%
          </li>
        </ul>
        <p className="mt-4 text-sm text-[var(--muted)]">
          A typical 20-step task that previously took 1-3 minutes now completes
          in 25-45 seconds.
        </p>
      </Section>

      <Section title="macOS Permissions">
        <p className="mb-4">
          macOS requires two permissions for computer control:
        </p>
        <ol className="list-decimal pl-6 space-y-3">
          <li>
            <strong>Accessibility</strong> — allows mouse clicks and keyboard
            input.
            <br />
            <span className="text-sm text-[var(--muted)]">
              System Settings → Privacy &amp; Security → Accessibility → enable
              your terminal app
            </span>
          </li>
          <li>
            <strong>Screen Recording</strong> — allows screenshots.
            <br />
            <span className="text-sm text-[var(--muted)]">
              System Settings → Privacy &amp; Security → Screen Recording →
              enable your terminal app
            </span>
          </li>
        </ol>
        <p className="mt-4 text-sm text-[var(--muted)]">
          Note: macOS Sequoia may re-prompt for Screen Recording permission
          monthly. This is an Apple security feature, not an InstaClaw issue.
        </p>
      </Section>

      <Section title="Security">
        <ul className="list-disc pl-6 space-y-2">
          <li>
            All communication is encrypted via TLS (WebSocket Secure)
          </li>
          <li>
            Authentication uses your unique gateway token — only your agent can
            send commands
          </li>
          <li>
            Supervised mode lets you approve every action before it executes
          </li>
          <li>
            Dangerous actions (passwords, deletions, purchases) always require
            confirmation, even in autonomous mode
          </li>
          <li>
            Press Ctrl+C at any time to immediately disconnect and stop all
            agent control
          </li>
        </ul>
      </Section>

      <Section title="FAQ">
        <FAQ q="Does my agent have access to my computer when the relay isn't running?">
          No. Your agent can only control your computer while the relay is
          actively running in your terminal. Close it and the connection is
          severed immediately.
        </FAQ>
        <FAQ q="What data does the relay send to my agent?">
          Screenshots (as compressed WebP images) and command results (success/failure).
          No files, passwords, or browsing history are ever sent.
        </FAQ>
        <FAQ q="Can I use this on multiple computers?">
          The relay connects one computer at a time. Run it on whichever machine
          you want your agent to control.
        </FAQ>
        <FAQ q="Why does my agent need to control my computer?">
          For tasks that require your installed apps, logged-in sessions, or
          local files — things your agent can&apos;t access from its server. Examples:
          editing a Figma file, filling out a form in your browser, organizing
          files on your desktop.
        </FAQ>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-12">
      <h2
        className="text-2xl font-normal tracking-[-0.5px] mb-4"
        style={{ fontFamily: "var(--font-serif)" }}
      >
        {title}
      </h2>
      <div className="text-[var(--foreground)] leading-relaxed">{children}</div>
    </section>
  );
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="bg-black/5 rounded-lg p-4 text-sm font-mono overflow-x-auto">
      {children}
    </pre>
  );
}

function FAQ({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <div className="mb-6">
      <h4 className="font-semibold mb-1">{q}</h4>
      <p className="text-[var(--muted)]">{children}</p>
    </div>
  );
}
