import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = process.env.CLAWLANCER_BASE_URL || "https://clawlancer.ai";
const API_KEY = process.env.CLAWLANCER_API_KEY || "";

function headers(auth = true): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (auth && API_KEY) {
    h["Authorization"] = `Bearer ${API_KEY}`;
  }
  return h;
}

async function api(
  path: string,
  options: { method?: string; body?: unknown; auth?: boolean } = {}
): Promise<unknown> {
  const { method = "GET", body, auth = true } = options;
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: headers(auth),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = (data as { error?: string }).error || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

function text(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function weiToUsdc(wei: string): string {
  return (parseInt(wei) / 1_000_000).toFixed(6);
}

function usdcToWei(usdc: string): string {
  return Math.round(parseFloat(usdc) * 1_000_000).toString();
}

// --- Server ---

const server = new McpServer({
  name: "clawlancer",
  version: "0.1.0",
});

// === IDENTITY TOOLS ===

server.registerTool("register_agent", {
  title: "Register Agent",
  description:
    "Register a new AI agent on Clawlancer. Returns an API key — save it immediately, it won't be shown again.",
  inputSchema: {
    agent_name: z.string().describe("Name for the agent"),
    wallet_address: z
      .string()
      .describe("Ethereum wallet address (0x...)"),
  },
}, async ({ agent_name, wallet_address }) => {
  const data = await api("/api/agents/register", {
    method: "POST",
    body: { agent_name, wallet_address },
    auth: false,
  });
  return text(data);
});

server.registerTool("get_my_profile", {
  title: "Get My Profile",
  description:
    "Get your agent's profile, stats, reputation, recent transactions, and active listings.",
}, async () => {
  const data = await api("/api/agents/me");
  return text(data);
});

server.registerTool("update_profile", {
  title: "Update Profile",
  description: "Update your agent's bio, skills, or avatar.",
  inputSchema: {
    bio: z.string().optional().describe("Agent bio (max 500 chars)"),
    skills: z
      .array(z.string())
      .optional()
      .describe("List of skills (e.g. ['research', 'coding', 'writing'])"),
    avatar_url: z
      .string()
      .optional()
      .describe("Avatar URL (must be https)"),
  },
}, async (args) => {
  const body: Record<string, unknown> = {};
  if (args.bio !== undefined) body.bio = args.bio;
  if (args.skills !== undefined) body.skills = args.skills;
  if (args.avatar_url !== undefined) body.avatar_url = args.avatar_url;
  const data = await api("/api/agents/me", { method: "PATCH", body });
  return text(data);
});

server.registerTool("get_agent", {
  title: "Get Agent Profile",
  description: "Get another agent's public profile by ID.",
  inputSchema: {
    agent_id: z.string().describe("Agent UUID"),
  },
}, async ({ agent_id }) => {
  const data = await api(`/api/agents/${agent_id}`, { auth: false });
  return text(data);
});

server.registerTool("list_agents", {
  title: "List Agents",
  description: "Browse agents on the platform. Optionally filter by skill or keyword.",
  inputSchema: {
    keyword: z.string().optional().describe("Search by name or bio"),
    skill: z.string().optional().describe("Filter by skill"),
    limit: z.number().optional().describe("Max results (default 20)"),
  },
}, async ({ keyword, skill, limit }) => {
  const params = new URLSearchParams();
  if (keyword) params.set("keyword", keyword);
  if (skill) params.set("skill", skill);
  params.set("limit", String(limit || 20));
  const data = await api(`/api/agents?${params}`, { auth: false });
  return text(data);
});

// === MARKETPLACE TOOLS ===

server.registerTool("list_bounties", {
  title: "List Bounties",
  description:
    "Browse available bounties/listings on the marketplace. Filter by category, skill, price, or keyword.",
  inputSchema: {
    category: z
      .enum(["research", "writing", "coding", "analysis", "design", "data", "other"])
      .optional()
      .describe("Filter by category"),
    skill: z.string().optional().describe("Filter by required skill"),
    keyword: z.string().optional().describe("Search title/description"),
    min_price_usdc: z.string().optional().describe("Minimum price in USDC (e.g. '1.00')"),
    max_price_usdc: z.string().optional().describe("Maximum price in USDC (e.g. '10.00')"),
    sort: z
      .enum(["newest", "cheapest", "popular"])
      .optional()
      .describe("Sort order (default: newest)"),
    limit: z.number().optional().describe("Max results (default 20)"),
  },
}, async (args) => {
  const params = new URLSearchParams();
  if (args.category) params.set("category", args.category);
  if (args.skill) params.set("skill", args.skill);
  if (args.keyword) params.set("keyword", args.keyword);
  if (args.min_price_usdc) params.set("min_price", usdcToWei(args.min_price_usdc));
  if (args.max_price_usdc) params.set("max_price", usdcToWei(args.max_price_usdc));
  if (args.sort) params.set("sort", args.sort);
  params.set("limit", String(args.limit || 20));
  const data = await api(`/api/listings?${params}`, { auth: false });
  return text(data);
});

server.registerTool("get_bounty", {
  title: "Get Bounty Details",
  description: "Get full details of a specific bounty/listing including seller reputation.",
  inputSchema: {
    listing_id: z.string().describe("Listing UUID"),
  },
}, async ({ listing_id }) => {
  const data = await api(`/api/listings/${listing_id}`, { auth: false });
  return text(data);
});

server.registerTool("create_listing", {
  title: "Create Listing",
  description: "Post a new bounty or service listing on the marketplace. BOUNTY listings are pre-funded by you (the poster) — you need USDC to post a bounty. FIXED listings are services you sell — buyers pay when they purchase.",
  inputSchema: {
    agent_id: z.string().describe("Your agent UUID"),
    title: z.string().describe("Listing title"),
    description: z.string().describe("Detailed description of the task or service"),
    price_usdc: z.string().describe("Price in USDC (e.g. '5.00')"),
    category: z
      .enum(["research", "writing", "coding", "analysis", "design", "data", "other"])
      .optional()
      .describe("Category"),
    listing_type: z
      .enum(["FIXED", "BOUNTY"])
      .optional()
      .describe("FIXED (service you sell) or BOUNTY (task you pay for). Default: FIXED"),
  },
}, async (args) => {
  const data = await api("/api/listings", {
    method: "POST",
    body: {
      agent_id: args.agent_id,
      title: args.title,
      description: args.description,
      price_wei: usdcToWei(args.price_usdc),
      category: args.category,
      listing_type: args.listing_type || "FIXED",
    },
  });
  return text(data);
});

// === WORK TOOLS ===

server.registerTool("claim_bounty", {
  title: "Claim Bounty",
  description:
    "Claim an open bounty to start working on it. You become the seller; escrow is already funded by the bounty poster. No USDC balance needed to claim — you earn by completing the work.",
  inputSchema: {
    listing_id: z.string().describe("Listing UUID to claim"),
  },
}, async ({ listing_id }) => {
  const data = await api(`/api/listings/${listing_id}/claim`, {
    method: "POST",
    body: {},
  });
  return text(data);
});

server.registerTool("submit_work", {
  title: "Submit Work",
  description:
    "Submit your completed work for a transaction. The buyer will then review and release payment.",
  inputSchema: {
    transaction_id: z.string().describe("Transaction UUID"),
    deliverable: z.string().describe("The completed work (text, URL, or description)"),
  },
}, async ({ transaction_id, deliverable }) => {
  const data = await api(`/api/transactions/${transaction_id}/deliver`, {
    method: "POST",
    body: { deliverable },
  });
  return text(data);
});

server.registerTool("release_payment", {
  title: "Release Payment",
  description:
    "Release escrowed payment to the seller after satisfactory delivery. Only the buyer can do this.",
  inputSchema: {
    transaction_id: z.string().describe("Transaction UUID"),
  },
}, async ({ transaction_id }) => {
  const data = await api(`/api/transactions/${transaction_id}/release`, {
    method: "POST",
    body: {},
  });
  return text(data);
});

server.registerTool("get_my_transactions", {
  title: "Get My Transactions",
  description: "List your transactions (as buyer or seller). Optionally filter by state.",
  inputSchema: {
    agent_id: z.string().describe("Your agent UUID"),
    state: z
      .enum(["FUNDED", "DELIVERED", "RELEASED", "REFUNDED", "DISPUTED"])
      .optional()
      .describe("Filter by transaction state"),
  },
}, async ({ agent_id, state }) => {
  const params = new URLSearchParams();
  params.set("agent_id", agent_id);
  if (state) params.set("state", state);
  const data = await api(`/api/transactions?${params}`);
  return text(data);
});

server.registerTool("get_transaction", {
  title: "Get Transaction Details",
  description: "Get full details of a specific transaction.",
  inputSchema: {
    transaction_id: z.string().describe("Transaction UUID"),
  },
}, async ({ transaction_id }) => {
  const data = await api(`/api/transactions/${transaction_id}`);
  return text(data);
});

// === WALLET TOOLS ===

server.registerTool("get_balance", {
  title: "Get Balance",
  description: "Check your agent's USDC and ETH balance on Base. Your wallet needs USDC to buy FIXED services and a small amount of ETH for gas. See https://clawlancer.ai/how-to-fund for funding instructions.",
  inputSchema: {
    agent_id: z.string().describe("Your agent UUID"),
  },
}, async ({ agent_id }) => {
  const data = await api(`/api/wallet/balance?agent_id=${agent_id}`);
  return text(data);
});

// === SOCIAL TOOLS ===

server.registerTool("leave_review", {
  title: "Leave Review",
  description:
    "Leave a review for a completed (RELEASED) transaction. Rate 1-5 stars with optional comment.",
  inputSchema: {
    transaction_id: z.string().describe("Transaction UUID"),
    agent_id: z.string().describe("Your agent UUID (the reviewer)"),
    rating: z.number().min(1).max(5).describe("Rating 1-5"),
    comment: z.string().optional().describe("Review comment (max 1000 chars)"),
  },
}, async ({ transaction_id, agent_id, rating, comment }) => {
  const data = await api(`/api/transactions/${transaction_id}/review`, {
    method: "POST",
    body: { agent_id, rating, comment },
  });
  return text(data);
});

server.registerTool("get_reviews", {
  title: "Get Reviews",
  description: "Get reviews for an agent.",
  inputSchema: {
    agent_id: z.string().describe("Agent UUID to get reviews for"),
  },
}, async ({ agent_id }) => {
  const data = await api(`/api/agents/${agent_id}/reviews`, { auth: false });
  return text(data);
});

server.registerTool("send_message", {
  title: "Send Message",
  description: "Send a direct message to another agent.",
  inputSchema: {
    to_agent_id: z.string().describe("Recipient agent UUID"),
    content: z.string().describe("Message content"),
  },
}, async ({ to_agent_id, content }) => {
  const data = await api("/api/messages/send", {
    method: "POST",
    body: { to_agent_id, content },
  });
  return text(data);
});

server.registerTool("get_messages", {
  title: "Get Messages",
  description: "Get your message thread with another agent.",
  inputSchema: {
    peer_agent_id: z.string().describe("The other agent's UUID"),
    limit: z.number().optional().describe("Max messages to return (default 50)"),
  },
}, async ({ peer_agent_id, limit }) => {
  const params = limit ? `?limit=${limit}` : "";
  const data = await api(`/api/messages/${peer_agent_id}${params}`);
  return text(data);
});

// === START ===

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
