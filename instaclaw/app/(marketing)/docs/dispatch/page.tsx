import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Dispatch Mode — Remote Computer Control | InstaClaw",
  description:
    "Let your InstaClaw agent control your computer. Run shell commands, take screenshots, click, type, and more via a secure relay.",
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
        Let your agent control your computer — run shell commands, take
        screenshots, click buttons, type text, and navigate any app on your Mac
        or PC.
      </p>

      <Section title="How It Works">
        <p className="mb-4">
          Your agent runs on a dedicated server 24/7. Dispatch Mode creates a
          secure tunnel between your agent and your personal computer. When you
          run the relay, your agent can see your screen, run commands, and
          interact with any application — just like a remote assistant sitting at
          your desk.
        </p>
        <p>
          Your agent uses two methods depending on the task: <strong>direct
          shell execution</strong> for file operations, commands, and automation
          (fastest — no GUI needed), and <strong>visual control</strong>{" "}
          (screenshots + clicks) for interacting with app interfaces.
        </p>
      </Section>

      <Section title="Quick Start">
        <p className="mb-4">
          <strong>1.</strong> Go to{" "}
          <a href="/settings" className="underline">
            instaclaw.io/settings
          </a>{" "}
          and click <strong>&quot;Connect Your Computer&quot;</strong>. The
          command is copied to your clipboard automatically.
        </p>
        <p className="mb-4">
          <strong>2.</strong> Open Terminal and paste the command:
        </p>
        <CodeBlock>npx @instaclaw/dispatch@latest</CodeBlock>
        <p className="mt-4 mb-4">
          <strong>3.</strong> Press Enter. Your agent connects automatically via
          encrypted WebSocket. You&apos;ll see a confirmation in Terminal:
        </p>
        <CodeBlock>{"  ✓ Connected to your agent!\n  Mode: Supervised\n  Your agent can now control this computer."}</CodeBlock>
        <p className="mt-4 text-sm text-[var(--muted)]">
          The relay auto-reconnects if the connection drops. Press Ctrl+C to
          disconnect.
        </p>
      </Section>

      <Section title="Requirements">
        <ul className="list-disc pl-6 space-y-2">
          <li>Node.js 18 or later</li>
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
        <h3 className="font-semibold mb-3">
          Direct Shell Execution (primary method)
        </h3>
        <p className="mb-3 text-sm text-[var(--muted)]">
          Your agent runs shell commands directly on your computer and gets the
          output back — no Terminal window needed. This is the fastest way to
          complete most tasks.
        </p>
        <ul className="list-disc pl-6 space-y-2 mb-6">
          <li>
            Run any shell command and get stdout/stderr back
          </li>
          <li>
            Create, move, rename, and organize files and folders
          </li>
          <li>
            Open applications
          </li>
          <li>Install packages and run scripts</li>
          <li>Get system information</li>
        </ul>

        <h3 className="font-semibold mb-3">Visual Control (for GUI tasks)</h3>
        <p className="mb-3 text-sm text-[var(--muted)]">
          For tasks that need visual interaction — clicking buttons, filling
          forms, navigating apps — your agent sees your screen and controls your
          mouse and keyboard.
        </p>
        <ul className="list-disc pl-6 space-y-2">
          <li>Take screenshots of your screen</li>
          <li>Click at any position</li>
          <li>Type text via keyboard</li>
          <li>Press key combos (Cmd+C, Ctrl+V, etc.)</li>
          <li>Drag and drop between positions</li>
          <li>Scroll in any direction</li>
          <li>List and switch between open windows</li>
          <li>
            <strong>Batch actions</strong> — execute multiple visual actions in
            one round-trip for 2-3x faster task completion
          </li>
        </ul>
      </Section>

      <Section title="Example: Organize Desktop Screenshots">
        <p className="mb-3 text-sm text-[var(--muted)]">
          You: &quot;organize all the screenshots on my desktop into a
          Screenshots folder&quot;
        </p>
        <p className="mb-3">Your agent runs one command:</p>
        <CodeBlock>
          {"mkdir -p ~/Desktop/Screenshots && find ~/Desktop -maxdepth 1 -name 'Screenshot*' -type f -exec mv {} ~/Desktop/Screenshots/ \\; && ls ~/Desktop/Screenshots/ | wc -l"}
        </CodeBlock>
        <p className="mt-3 text-sm text-[var(--muted)]">
          Done in under 10 seconds. No clicking through Finder, no dragging
          files. The agent runs the command directly on your Mac and reports the
          result.
        </p>
      </Section>

      <Section title="Modes">
        <h3 className="font-semibold mb-2">Supervised (default)</h3>
        <p className="mb-4">
          Every action the agent wants to take is shown in your terminal. Press
          Enter to approve or &apos;n&apos; to deny. Screenshots and shell
          commands are shown before executing.
        </p>
        <h3 className="font-semibold mb-2">Autonomous</h3>
        <p className="mb-2">
          Auto-approves most actions so your agent can work without interruption.
          Dangerous actions (passwords, deletions, purchases, sudo) still require
          your confirmation. Enable with:
        </p>
        <CodeBlock>npx @instaclaw/dispatch@latest --autonomous</CodeBlock>
        <p className="mt-3 text-sm text-[var(--muted)]">
          Tip: Your agent will suggest switching to autonomous mode before
          starting multi-step tasks. You can press &apos;a&apos; in Terminal at
          any time to toggle between modes.
        </p>
      </Section>

      <Section title="Performance">
        <ul className="list-disc pl-6 space-y-2">
          <li>
            <strong>Direct shell execution:</strong> Commands run instantly on
            your machine and return output — no screenshots or GUI interaction
            needed for file operations
          </li>
          <li>
            <strong>Action batching:</strong> For visual tasks, your agent plans
            multiple steps (click, type, press Enter) and executes them in a
            single round-trip — <strong>2-3x faster</strong> than one at a time
          </li>
          <li>
            <strong>WebP screenshots:</strong> 50-60% smaller than JPEG,
            reducing transfer time without losing visual quality
          </li>
          <li>
            <strong>Smart verification:</strong> Screenshots only at decision
            points, not after every action — cutting vision costs by up to 70%
          </li>
          <li>
            <strong>TCP keepalive:</strong> Connection stays alive through NAT
            firewalls and home routers — no silent disconnects
          </li>
        </ul>
      </Section>

      <Section title="macOS Permissions">
        <p className="mb-4">
          macOS requires two permissions for visual computer control (shell
          execution works without these):
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
          Note: Enabling Accessibility may close your Terminal app — this is
          normal macOS behavior. Just reopen Terminal and run the same command
          again. Your pairing code will still work.
        </p>
        <p className="mt-2 text-sm text-[var(--muted)]">
          macOS Sequoia may re-prompt for Screen Recording permission monthly.
          This is an Apple security feature, not an InstaClaw issue.
        </p>
      </Section>

      <Section title="Security">
        <ul className="list-disc pl-6 space-y-2">
          <li>
            All communication encrypted via TLS (WebSocket Secure) with
            self-signed certificates
          </li>
          <li>
            HMAC-SHA256 authentication with timestamp + nonce — prevents replay
            attacks
          </li>
          <li>
            Supervised mode lets you approve every action before it executes
          </li>
          <li>
            Dangerous actions (passwords, deletions, purchases, sudo, rm -rf)
            always require confirmation, even in autonomous mode
          </li>
          <li>
            Shell commands are filtered for dangerous patterns (curl|bash, chmod
            777, etc.)
          </li>
          <li>
            Command output is capped at 4KB to prevent data exfiltration
          </li>
          <li>
            Press Ctrl+C at any time to immediately disconnect and stop all
            agent control
          </li>
          <li>
            Connection auto-reconnects on network blips but requires
            re-authentication each time
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
          Screenshots (as compressed WebP images), shell command output
          (stdout/stderr), and action results (success/failure). No files,
          passwords, or browsing history are ever sent. Command output is capped
          at 4KB.
        </FAQ>
        <FAQ q="Can I use this on multiple computers?">
          The relay connects one computer at a time. Run it on whichever machine
          you want your agent to control.
        </FAQ>
        <FAQ q="Why does my agent need to control my computer?">
          For tasks that require your installed apps, logged-in sessions, or
          local files — things your agent can&apos;t access from its server.
          Examples: organizing files on your desktop, filling out a form in your
          browser, editing a Figma file, running local scripts.
        </FAQ>
        <FAQ q="What if the connection drops?">
          The relay automatically reconnects with exponential backoff (1 second
          to 30 seconds). TCP keepalive prevents silent disconnects from NAT
          firewalls. If the relay can&apos;t reconnect, it shows a clear error
          message in your terminal.
        </FAQ>
        <FAQ q="Is the shell execution safe?">
          In supervised mode, every command is shown to you before executing. In
          autonomous mode, dangerous patterns (sudo, rm -rf, curl|bash) still
          require your approval. Output is capped at 4KB per command to prevent
          large data transfers.
        </FAQ>
        <FAQ q="How do I switch between supervised and autonomous mode?">
          Press &apos;a&apos; in the terminal window running the relay to toggle
          modes at any time. Or start with --autonomous flag.
        </FAQ>
      </Section>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
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
    <pre className="bg-black/5 rounded-lg p-4 text-sm font-mono overflow-x-auto whitespace-pre-wrap">
      {children}
    </pre>
  );
}

function FAQ({
  q,
  children,
}: {
  q: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-6">
      <h4 className="font-semibold mb-1">{q}</h4>
      <p className="text-[var(--muted)]">{children}</p>
    </div>
  );
}
