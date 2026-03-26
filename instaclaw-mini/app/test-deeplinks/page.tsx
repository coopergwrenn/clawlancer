"use client";

import { MiniKit } from "@worldcoin/minikit-js";

const AGENT_ADDRESS = "0x82299a82bec359767e4ff4dbf498691f87d3d10e";
const APP_ID = "app_a4e2de774b1bda0426e78cda2ddb8cfd";

const links = [
  {
    label: "A: world.org/profile?address=...&action=chat",
    url: `https://world.org/profile?address=${AGENT_ADDRESS}&action=chat`,
  },
  {
    label: "B: /{address}/draft (Quick Actions)",
    url: `https://worldcoin.org/mini-app?app_id=${APP_ID}&path=%2F${AGENT_ADDRESS}%2Fdraft`,
  },
  {
    label: "C: /{address}/draft?message=Hey",
    url: `https://worldcoin.org/mini-app?app_id=${APP_ID}&path=%2F${AGENT_ADDRESS}%2Fdraft%3Fmessage%3DHey`,
  },
  {
    label: "D: world.org/chat?address=...",
    url: `https://world.org/chat?address=${AGENT_ADDRESS}`,
  },
  {
    label: "E: world.org/profile?address=... (no action)",
    url: `https://world.org/profile?address=${AGENT_ADDRESS}`,
  },
  {
    label: "F: worldapp:// deep link",
    url: `worldapp://chat/${AGENT_ADDRESS}`,
  },
  {
    label: "G: world.org/chat (just chat tab)",
    url: `https://world.org/chat`,
  },
  {
    label: "H: xmtp.chat DM link",
    url: `https://xmtp.chat/dm/${AGENT_ADDRESS}`,
  },
];

export default function TestDeeplinks() {
  async function handleMiniKitChat() {
    try {
      const result = await MiniKit.commandsAsync.chat({
        message: "Hey agent!",
        to: [AGENT_ADDRESS],
      });
      alert("Result: " + JSON.stringify(result.finalPayload));
    } catch (e) {
      alert("Error: " + (e instanceof Error ? e.message : String(e)));
    }
  }

  return (
    <div style={{ padding: "20px", fontFamily: "sans-serif", background: "#f8f7f4", minHeight: "100dvh", color: "#333" }}>
      <h1 style={{ fontSize: "20px", fontWeight: "bold", marginBottom: "8px" }}>World Chat Deep Link Test</h1>
      <p style={{ fontSize: "12px", color: "#888", marginBottom: "20px" }}>
        Agent: {AGENT_ADDRESS.slice(0, 10)}...{AGENT_ADDRESS.slice(-8)}
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {links.map((link, i) => (
          <a
            key={i}
            href={link.url}
            style={{
              display: "block",
              padding: "14px 16px",
              borderRadius: "12px",
              background: "#fff",
              border: "1px solid rgba(0,0,0,0.1)",
              textDecoration: "none",
              color: "#333",
              fontSize: "13px",
              lineHeight: "1.4",
            }}
          >
            <div style={{ fontWeight: "600", marginBottom: "4px" }}>{link.label}</div>
            <div style={{ fontSize: "10px", color: "#888", wordBreak: "break-all" }}>{link.url}</div>
          </a>
        ))}

        <button
          onClick={handleMiniKitChat}
          style={{
            padding: "14px 16px",
            borderRadius: "12px",
            background: "#DC6743",
            color: "#fff",
            border: "none",
            fontSize: "13px",
            fontWeight: "600",
            cursor: "pointer",
          }}
        >
          I: MiniKit.commandsAsync.chat(to: [address])
        </button>

        <div style={{ padding: "14px 16px", borderRadius: "12px", background: "#fff", border: "1px solid rgba(0,0,0,0.1)", fontSize: "11px", color: "#888" }}>
          <strong>Notes:</strong><br />
          - Tap each link INSIDE World App<br />
          - Report what opens (chat list, profile, direct DM, error)<br />
          - Andy said backend blocks non-registered users — testing if deep link bypasses that
        </div>
      </div>
    </div>
  );
}
