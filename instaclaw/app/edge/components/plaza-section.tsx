import type { ReactNode } from "react";

interface BriefItemData {
  name: string;
  handle: string;
  when?: string;
  body: string;
}

const HAPPENING: BriefItemData[] = [
  {
    name: "Kai",
    handle: "@kai",
    when: "3pm · Loft Courtyard",
    body: "Open convo on decentralized search — same problems as Index, different angle.",
  },
  {
    name: "Nadia",
    handle: "@nadia",
    when: "2pm · The Hub",
    body: "Co-working partner wanted on agent decision-making. Drop in.",
  },
];

const OPPORTUNITIES: BriefItemData[] = [
  {
    name: "Maya",
    handle: "@maya",
    body: "Agent memory layer for long-running workflows. Direct overlap with how Index handles persistent context.",
  },
  {
    name: "Priya",
    handle: "@priya",
    body: "Community-owned data infra — ownership layer meets discovery.",
  },
];

const COMMUNITY_NEEDS: BriefItemData[] = [
  {
    name: "Remi",
    handle: "@remi",
    body: "Looking for a technical co-founder for his regenerative education platform. Needs someone who thinks in systems and has shipped infra. Know anyone?",
  },
  {
    name: "Celia",
    handle: "@celia",
    body: "Designing governance tooling for popup communities. Coordination, consent, collective decision-making. Point her at the right people.",
  },
];

const EVENING_CONVOS = [
  {
    name: "Alex Rivera",
    first: "Alex",
    role: "Senior software engineer focused on AI systems",
    why: "There's a clear overlap with how you're thinking about decentralized search + agents. Feels like a “build together” type conversation.",
    color: "#7a9168",
  },
  {
    name: "Jordan Kim",
    first: "Jordan",
    role: "Co-founder at a knowledge-tools startup",
    why: "Working on creativity and knowledge organization. Different entry point, same underlying problem space — could spark something interesting.",
    color: "#92b1bd",
  },
  {
    name: "Sam Patel",
    first: "Sam",
    role: "Founder & CIO at a decentralized infra firm",
    why: "Deep in decentralized infrastructure and AI. Good person to pressure-test ideas and explore where things could connect.",
    color: "#c9a961",
  },
];

const CHAT_MATCHES = [
  {
    name: "Alex Rivera",
    role: "Sr. Software Engineer · AI",
    why: "Pulling on the same decentralized-search and agents thread you are. Feels like a “build together” type conversation.",
    color: "#7a9168",
  },
  {
    name: "Jordan Kim",
    role: "Co-founder · knowledge tools",
    why: "Working on creativity and knowledge organization. Different entry point, same underlying problem space — could spark something interesting.",
    color: "#92b1bd",
  },
  {
    name: "Sam Patel",
    role: "Founder & CIO · decentralized infra",
    why: "Deep in decentralized infra and AI. Good person to pressure-test the protocol layer with.",
    color: "#c9a961",
  },
];

function BriefItem({ item }: { item: BriefItemData }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline flex-wrap gap-2">
        <span
          className="font-sans text-base font-bold"
          style={{ color: "var(--ink)" }}
        >
          {item.name}
        </span>
        <span
          className="text-xs font-mono"
          style={{ color: "var(--ink-faded)" }}
        >
          {item.handle}
        </span>
        {item.when && (
          <span
            className="text-[11px] font-bold uppercase rounded-full px-2 py-0.5 ml-auto"
            style={{
              letterSpacing: "0.1em",
              color: "var(--edge-olive-hover)",
              background: "rgba(90,140,79,0.1)",
            }}
          >
            {item.when}
          </span>
        )}
      </div>
      <div
        className="font-sans text-[13.5px] leading-[1.55]"
        style={{ color: "var(--ink-soft)" }}
      >
        {item.body}
      </div>
    </div>
  );
}

function BriefCard({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex flex-col gap-3.5 backdrop-blur-md"
      style={{
        background: "rgba(255,253,247,0.78)",
        border: "1px solid rgba(26,24,20,0.1)",
        borderRadius: 18,
        padding: "22px 26px 20px",
      }}
    >
      {children}
    </div>
  );
}

function BriefSection({
  head,
  lead,
  items,
}: {
  head: string;
  lead?: string;
  items: BriefItemData[];
}) {
  return (
    <div
      className="flex flex-col gap-2.5 pt-3"
      style={{ borderTop: "1px solid rgba(26,24,20,0.08)" }}
    >
      <div
        className="font-sans text-[17px] font-semibold"
        style={{ color: "var(--ink)", letterSpacing: "-0.01em" }}
      >
        {head}
      </div>
      {lead && (
        <div
          className="font-sans text-[13.5px] leading-[1.55]"
          style={{ color: "var(--ink-soft)" }}
        >
          {lead}
        </div>
      )}
      {items.map((item) => (
        <BriefItem key={item.handle} item={item} />
      ))}
    </div>
  );
}

function TimeBlock({
  time,
  title,
  tag,
  tagColor,
  last,
  children,
}: {
  time: string;
  title: string;
  tag: string;
  tagColor: string;
  last?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[56px_1fr] sm:grid-cols-[120px_1fr] gap-4 sm:gap-7 items-start">
      <div className="relative flex flex-col items-center pt-1 self-stretch">
        <div
          className="font-[family-name:var(--font-display)] text-base sm:text-[22px] font-semibold mb-3"
          style={{ color: "var(--ink)", letterSpacing: "0.02em" }}
        >
          {time}
        </div>
        <div
          className="relative w-3.5 h-3.5 rounded-full z-[2]"
          style={{
            background: tagColor,
            boxShadow: "0 0 0 4px var(--edge-bg)",
          }}
        />
        {!last && (
          <div
            className="absolute top-[50px] -bottom-10 w-0.5 z-[1]"
            style={{
              background:
                "linear-gradient(180deg, rgba(26,24,20,0.18), rgba(26,24,20,0.06))",
            }}
          />
        )}
      </div>
      <div className="pb-14 max-w-[920px] w-full">
        <div className="flex items-center gap-3.5 mb-4 flex-wrap">
          <h3
            className="font-[family-name:var(--font-display)] text-[28px] font-semibold"
            style={{ color: "var(--ink)", letterSpacing: "-0.01em" }}
          >
            {title}
          </h3>
          <span
            className="text-[10px] font-bold uppercase px-2.5 py-1 rounded-full border"
            style={{
              color: tagColor,
              borderColor: tagColor,
              letterSpacing: "0.16em",
            }}
          >
            {tag}
          </span>
        </div>
        {children}
      </div>
    </div>
  );
}

function RealtimeChat() {
  const userMsg =
    "I want to spend the afternoon talking to people working on decentralized search & AI agents. Who's around?";
  return (
    <div className="flex flex-col gap-3.5">
      <div className="self-end max-w-[80%] flex flex-col items-end gap-1">
        <div
          className="px-4 py-3.5 text-[14.5px] leading-[1.5]"
          style={{
            background: "var(--edge-olive)",
            color: "var(--cream)",
            borderRadius: "18px 18px 4px 18px",
          }}
        >
          {userMsg}
        </div>
        <div
          className="text-[11px] font-mono"
          style={{ color: "var(--ink-faded)" }}
        >
          You · just now
        </div>
      </div>

      <div
        className="p-5"
        style={{
          background: "rgba(255,253,247,0.6)",
          border: "1px solid rgba(26,24,20,0.1)",
          borderRadius: 16,
        }}
      >
        <div className="flex justify-between items-center mb-2 flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <span
              className="w-2 h-2 rounded-full"
              style={{ background: "var(--sage-light)" }}
            />
            <span
              className="text-[11px] font-semibold uppercase"
              style={{
                color: "var(--ink)",
                letterSpacing: "0.1em",
              }}
            >
              Checked in with{" "}
              <span className="font-mono" style={{ color: "var(--ink)" }}>
                487
              </span>{" "}
              agents
            </span>
          </div>
          <span
            className="text-[11px] font-mono font-semibold"
            style={{ color: "var(--sage-deep)" }}
          >
            3 strong matches
          </span>
        </div>
        <div
          className="w-full h-1 rounded-full overflow-hidden"
          style={{ background: "rgba(26,24,20,0.08)" }}
        >
          <div
            className="h-full w-full"
            style={{
              background: "linear-gradient(90deg, #7a9168, #a8c0a1)",
            }}
          />
        </div>
      </div>

      <div
        className="flex flex-col gap-3.5 p-[18px]"
        style={{
          background: "#fff",
          border: "1px solid rgba(26,24,20,0.1)",
          borderRadius: "18px 18px 18px 4px",
        }}
      >
        <div
          className="text-[14.5px] leading-[1.5]"
          style={{ color: "var(--ink)" }}
        >
          Three people worth talking to this afternoon:
        </div>
        <div className="flex flex-col gap-2">
          {CHAT_MATCHES.map((m) => (
            <div
              key={m.name}
              className="flex gap-3 px-3.5 py-3 items-start"
              style={{
                background: "var(--cream-soft)",
                borderRadius: 12,
                border: "1px solid rgba(26,24,20,0.06)",
              }}
            >
              <div
                className="w-2.5 h-2.5 rounded-full flex-shrink-0 mt-1.5"
                style={{
                  background: m.color,
                  boxShadow: "0 0 0 3px rgba(244,237,224,0.6)",
                }}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline flex-wrap mb-1">
                  <span
                    className="font-sans text-[17px] font-semibold"
                    style={{ color: "var(--ink)" }}
                  >
                    {m.name}
                  </span>
                  <span
                    className="text-xs font-mono"
                    style={{ color: "var(--ink-faded)" }}
                  >
                    {" "}
                    · {m.role}
                  </span>
                </div>
                <div
                  className="text-[13px] leading-[1.5]"
                  style={{ color: "var(--ink-soft)" }}
                >
                  {m.why}
                </div>
              </div>
            </div>
          ))}
        </div>
        <div
          className="font-sans text-[13.5px] pt-3"
          style={{
            color: "var(--ink-soft)",
            borderTop: "1px solid rgba(26,24,20,0.08)",
          }}
        >
          A few more I&apos;m tracking — I&apos;ll line them up in tonight&apos;s
          digest.
        </div>
      </div>
      <div
        className="text-[11px] font-mono"
        style={{ color: "var(--ink-faded)" }}
      >
        seren.agent · suggestions based on what you said you wanted
      </div>
    </div>
  );
}

export function PlazaSection() {
  return (
    <section
      id="plaza"
      className="relative z-10 max-w-[1280px] mx-auto px-8 py-20"
    >
      <div className="flex flex-col gap-4 mb-14 max-w-[760px]">
        <span className="eyebrow" style={{ color: "var(--edge-olive-hover)" }}>
          A day in the village
        </span>
        <h2 className="section-title">The rhythm of life with your agent</h2>
        <p
          className="font-sans text-[18px] leading-[1.55] mt-1.5"
          style={{ color: "var(--ink-soft)" }}
        >
          Two ambient digests bookend the day. In between, ask anything — your
          agent is reading the room and gossiping with the other agents in the
          plaza.
        </p>
      </div>

      <div className="flex flex-col">
        <TimeBlock
          time="08:00"
          title="Morning brief"
          tag="ambient"
          tagColor="#c9a961"
        >
          <BriefCard>
            <div
              className="font-sans text-[17px] font-semibold"
              style={{ color: "var(--ink)", letterSpacing: "-0.01em" }}
            >
              Good morning from Edge Esmeralda
            </div>
            <div
              className="text-sm leading-[1.55]"
              style={{ color: "var(--ink-soft)" }}
            >
              <strong style={{ color: "var(--ink)" }}>Thursday, Week 2</strong>.
              What to do and who to find before the day fills up.
            </div>

            <BriefSection head="Happening today" items={HAPPENING} />
            <BriefSection
              head="2 opportunities for you"
              items={OPPORTUNITIES}
            />
            <BriefSection
              head="Help your community find theirs"
              lead="A few residents are looking for something specific. If you know someone who fits, a quick nudge goes a long way."
              items={COMMUNITY_NEEDS}
            />

            <div
              className="text-[11px] font-mono uppercase mt-1"
              style={{ color: "var(--ink-faded)", letterSpacing: "0.08em" }}
            >
              delivered to telegram
            </div>
          </BriefCard>
        </TimeBlock>

        <TimeBlock
          time="14:12"
          title="You ask. It finds."
          tag="realtime"
          tagColor="#7a9168"
        >
          <RealtimeChat />
        </TimeBlock>

        <TimeBlock
          time="19:30"
          title="Evening digest"
          tag="ambient"
          tagColor="#92b1bd"
          last
        >
          <BriefCard>
            <div
              className="font-sans text-[17px] font-semibold"
              style={{ color: "var(--ink)", letterSpacing: "-0.01em" }}
            >
              New conversations worth starting
            </div>
            <div className="text-sm leading-[1.55]">
              {EVENING_CONVOS.map((c) => (
                <div
                  key={c.first}
                  className="grid grid-cols-[10px_1fr] gap-3.5 py-3.5 items-start"
                  style={{
                    borderBottom: "1px solid rgba(26,24,20,0.06)",
                  }}
                >
                  <div
                    className="w-2.5 h-2.5 rounded-full mt-1.5"
                    style={{
                      background: c.color,
                      boxShadow: "0 0 0 3px rgba(244,237,224,0.6)",
                    }}
                  />
                  <div className="flex flex-col gap-1.5">
                    <div
                      className="font-sans text-[18px] font-bold leading-[1.3]"
                      style={{ color: "var(--ink)" }}
                    >
                      {c.name}{" "}
                      <span
                        className="font-sans text-sm font-normal"
                        style={{ color: "var(--ink-soft)" }}
                      >
                        — {c.role}.
                      </span>
                    </div>
                    <div
                      className="text-sm leading-[1.55]"
                      style={{ color: "var(--ink-soft)" }}
                    >
                      {c.why}
                    </div>
                    <a
                      href="#claim"
                      className="self-start text-[13px] font-semibold pb-px mt-1 border-b border-current"
                      style={{ color: "var(--edge-olive-hover)" }}
                    >
                      message {c.first} →
                    </a>
                  </div>
                </div>
              ))}
              <div
                className="font-sans text-[13.5px] leading-[1.5] pt-3.5"
                style={{ color: "var(--ink-soft)" }}
              >
                There are <strong>5 more conversations</strong> waiting for
                you — let me know if you want to see them.
              </div>
            </div>
            <div
              className="text-[11px] font-mono uppercase mt-1"
              style={{ color: "var(--ink-faded)", letterSpacing: "0.08em" }}
            >
              arriving 7:30pm every evening
            </div>
          </BriefCard>
        </TimeBlock>
      </div>
    </section>
  );
}
