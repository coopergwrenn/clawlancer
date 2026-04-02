import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { connectSSH, NVM_PREAMBLE, type VMRecord } from "@/lib/ssh";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/agentbook/register-direct
 *
 * Registers the agent on AgentBook by calling the smart contract DIRECTLY
 * from the VM using the agent's private key. No gasless relay needed.
 *
 * Contract: 0xA23aB2712eA7BBa896930544C7d6636a96b944dA (World Chain)
 * Function: register(address agent, uint256 root, uint256 nonce, uint256 nullifierHash, uint256[8] proof)
 *
 * Auth: NextAuth session OR X-Mini-App-Token
 * Body: { proof, merkle_root, nullifier_hash, verification_level }
 */
export async function POST(req: NextRequest) {
  // Dual auth: NextAuth or mini app token
  const session = await auth();
  let userId = session?.user?.id;
  if (!userId) {
    const { validateMiniAppToken } = await import("@/lib/security");
    userId = (await validateMiniAppToken(req)) ?? undefined;
  }
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();
  const body = await req.json();
  const { proof, merkle_root, nullifier_hash } = body;

  if (!proof || !merkle_root || !nullifier_hash) {
    return NextResponse.json({ error: "Missing proof, merkle_root, or nullifier_hash" }, { status: 400 });
  }

  // Get the user's VM
  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("id, name, ip_address, ssh_port, ssh_user, agentbook_wallet_address, agentbook_registered")
    .eq("assigned_to", userId)
    .single();

  if (!vm) {
    return NextResponse.json({ error: "No VM assigned" }, { status: 404 });
  }

  if (!vm.agentbook_wallet_address) {
    return NextResponse.json({ error: "No agent wallet found on VM" }, { status: 404 });
  }

  if (vm.agentbook_registered) {
    return NextResponse.json({ error: "Already registered", registered: true }, { status: 409 });
  }

  try {
    const ssh = await connectSSH(vm as VMRecord);

    try {
      // Build the Node.js script that calls the contract directly
      // The script:
      //   1. Reads agent private key from disk
      //   2. Connects to World Chain RPC
      //   3. Calls AgentBook.register(agent, root, nonce, nullifierHash, proof)
      //   4. Waits for transaction receipt
      const registerScript = `
const { createWalletClient, createPublicClient, http, parseAbi } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");
const { defineChain } = require("viem");
const fs = require("fs");

const worldchain = defineChain({
  id: 480,
  name: "World Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://worldchain-mainnet.g.alchemy.com/public"] },
  },
});

const AGENTBOOK = "0xA23aB2712eA7BBa896930544C7d6636a96b944dA";
const ABI = parseAbi([
  "function register(address agent, uint256 root, uint256 nonce, uint256 nullifierHash, uint256[8] proof)",
  "function lookupHuman(address agent) view returns (uint256)",
  "function getNextNonce(address agent) view returns (uint256)",
]);

async function main() {
  // Read agent private key
  const keyHex = fs.readFileSync("/home/openclaw/.openclaw/wallet/agent.key", "utf-8").trim();
  const account = privateKeyToAccount(\`0x\${keyHex}\`);

  const walletClient = createWalletClient({
    account,
    chain: worldchain,
    transport: http(),
  });

  const publicClient = createPublicClient({
    chain: worldchain,
    transport: http(),
  });

  // Get nonce from contract
  const nonce = await publicClient.readContract({
    address: AGENTBOOK,
    abi: ABI,
    functionName: "getNextNonce",
    args: [account.address],
  });

  // Parse proof array from MiniKit format
  const proofStr = ${JSON.stringify(proof)};
  // MiniKit proof is a hex string — decode to 8 uint256 values
  let proofArray;
  if (typeof proofStr === "string" && proofStr.startsWith("0x")) {
    // Hex encoded proof — split into 8 x 32-byte chunks
    const hex = proofStr.slice(2);
    proofArray = [];
    for (let i = 0; i < 8; i++) {
      proofArray.push(BigInt("0x" + hex.slice(i * 64, (i + 1) * 64)));
    }
  } else if (Array.isArray(proofStr)) {
    proofArray = proofStr.map(p => BigInt(p));
  } else {
    throw new Error("Unknown proof format: " + typeof proofStr);
  }

  const root = BigInt(${JSON.stringify(merkle_root)});
  const nullifierHash = BigInt(${JSON.stringify(nullifier_hash)});

  console.log("Agent:", account.address);
  console.log("Nonce:", nonce.toString());
  console.log("Root:", root.toString().slice(0, 20) + "...");
  console.log("Nullifier:", nullifierHash.toString().slice(0, 20) + "...");

  // Call register on the contract
  const hash = await walletClient.writeContract({
    address: AGENTBOOK,
    abi: ABI,
    functionName: "register",
    args: [account.address, root, nonce, nullifierHash, proofArray],
  });

  console.log("TX:", hash);

  // Wait for confirmation
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 30000 });
  console.log("Status:", receipt.status);

  // Verify on-chain
  const humanId = await publicClient.readContract({
    address: AGENTBOOK,
    abi: ABI,
    functionName: "lookupHuman",
    args: [account.address],
  });

  console.log("Registered:", humanId !== 0n);
  console.log("RESULT:" + JSON.stringify({ txHash: hash, registered: humanId !== 0n, address: account.address }));
}

main().catch(err => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
`;

      // Write script to VM and execute
      const scriptB64 = Buffer.from(registerScript).toString("base64");
      await ssh.execCommand(
        `echo '${scriptB64}' | base64 -d > /tmp/agentbook-register-direct.cjs`
      );

      const result = await ssh.execCommand(
        `${NVM_PREAMBLE} && export NODE_PATH="$(npm root -g):$(npm root -g)/@worldcoin/agentkit-cli/node_modules" && node /tmp/agentbook-register-direct.cjs 2>&1; rm -f /tmp/agentbook-register-direct.cjs`,
        { execOptions: { timeout: 45000 } }
      );

      logger.info("AgentBook direct registration output", {
        route: "agentbook/register-direct",
        vmId: vm.id,
        stdout: result.stdout.slice(-500),
        stderr: result.stderr?.slice(-200),
      });

      // Parse result
      const resultMatch = result.stdout.match(/RESULT:(.+)/);
      if (resultMatch) {
        const regResult = JSON.parse(resultMatch[1]);

        if (regResult.registered) {
          // Update DB
          await supabase
            .from("instaclaw_vms")
            .update({
              agentbook_registered: true,
              agentbook_registered_at: new Date().toISOString(),
              agentbook_tx_hash: regResult.txHash,
            })
            .eq("id", vm.id);

          return NextResponse.json({
            registered: true,
            walletAddress: vm.agentbook_wallet_address,
            txHash: regResult.txHash,
          });
        }
      }

      // Check for common errors
      if (result.stdout.includes("insufficient funds") || result.stderr?.includes("insufficient funds")) {
        return NextResponse.json(
          { error: "Agent wallet has no ETH on World Chain for gas. Please fund it." },
          { status: 402 }
        );
      }

      return NextResponse.json(
        { error: "Registration failed", detail: result.stdout.slice(-300) },
        { status: 500 }
      );
    } finally {
      ssh.dispose();
    }
  } catch (err) {
    logger.error("AgentBook direct registration error", {
      error: String(err),
      vmId: vm?.id,
      route: "agentbook/register-direct",
    });
    return NextResponse.json(
      { error: "Registration failed", detail: String(err).slice(0, 200) },
      { status: 500 }
    );
  }
}
