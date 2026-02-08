/**
 * End-to-End On-Chain Bounty Test
 *
 * Tests the full lifecycle: post → claim (on-chain) → deliver → release
 * Uses real USDC on Base mainnet.
 */

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
require('dotenv').config({ path: '.env.local' });

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const BASE_URL = 'https://clawlancer.ai';

const TUMBLEWEED_ID = '0d458eb0-2325-4130-95cb-e4f5d43def9f';
const DUSTY_PETE_ID = 'a67d7b98-7a5d-42e1-8c15-38e5745bd789';

// Generate and store API keys for both agents
async function ensureApiKeys() {
  const keys = {};
  for (const [name, id] of [['Tumbleweed', TUMBLEWEED_ID], ['Dusty Pete', DUSTY_PETE_ID]]) {
    const rawKey = 'clw_' + crypto.randomBytes(16).toString('hex');
    const hashedKey = crypto.createHash('sha256').update(rawKey).digest('hex');

    const { error } = await sb
      .from('agents')
      .update({ api_key: hashedKey })
      .eq('id', id);

    if (error) {
      console.error(`Failed to set key for ${name}:`, error);
      process.exit(1);
    }
    keys[name] = rawKey;
    console.log(`API key set for ${name}: ${rawKey.slice(0, 12)}...`);
  }
  return keys;
}

async function apiCall(method, path, apiKey, body) {
  const url = `${BASE_URL}${path}`;
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);

  console.log(`\n>>> ${method} ${path}`);
  const res = await fetch(url, opts);
  const data = await res.json();
  console.log(`<<< ${res.status}`);
  console.log(JSON.stringify(data, null, 2));

  if (!res.ok) {
    throw new Error(`API call failed: ${res.status} ${data.error || JSON.stringify(data)}`);
  }
  return data;
}

async function checkBalances(label) {
  const { createPublicClient, http, erc20Abi } = require('viem');
  const { base } = require('viem/chains');
  const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const client = createPublicClient({ chain: base, transport: http(process.env.ALCHEMY_BASE_URL) });

  console.log(`\n--- ${label} ---`);
  const wallets = [
    { name: 'Tumbleweed (buyer)', addr: '0xD7Dc8512114A6D6bd5978072f9B02554821a72FF' },
    { name: 'Dusty Pete (seller)', addr: '0x87BEE42CA86D743d9f628d6DA74F015A214fbdB8' },
    { name: 'Escrow Contract', addr: '0xc3bB40b16251072eDc4E63C70a886f84eC689AD8' },
  ];

  const balances = {};
  for (const w of wallets) {
    const eth = await client.getBalance({ address: w.addr });
    const usdc = await client.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [w.addr] });
    const ethStr = (Number(eth) / 1e18).toFixed(6);
    const usdcStr = (Number(usdc) / 1e6).toFixed(6);
    console.log(`  ${w.name}: ETH=${ethStr}  USDC=$${usdcStr}`);
    balances[w.name] = { eth: Number(eth), usdc: Number(usdc) };
  }
  return balances;
}

async function main() {
  console.log('=== END-TO-END ON-CHAIN BOUNTY TEST ===\n');

  // Step 0: Generate API keys
  console.log('--- STEP 0: Generate API keys ---');
  const keys = await ensureApiKeys();

  // Step 1: Check balances BEFORE
  const before = await checkBalances('BALANCES BEFORE');

  // Step 2: Post a bounty from Tumbleweed (or reuse existing one)
  console.log('\n--- STEP 2: Post bounty from Tumbleweed ---');
  let listingId = process.env.REUSE_LISTING_ID;
  if (listingId) {
    console.log(`Reusing existing listing: ${listingId}`);
  } else {
    const listing = await apiCall('POST', '/api/listings', keys['Tumbleweed'], {
      agent_id: TUMBLEWEED_ID,
      title: 'E2E Test: Summarize top 5 AI agent frameworks',
      description: 'Write a brief summary of the top 5 AI agent frameworks in 2024. Include name, key features, and use case for each. This is an end-to-end test of the on-chain escrow system.',
      category: 'research',
      listing_type: 'BOUNTY',
      price_wei: '500000', // $0.50 USDC
      currency: 'USDC',
    });
    listingId = listing.listing?.id || listing.id;
    console.log(`Listing created: ${listingId}`);
  }

  // Step 3: Dusty Pete claims the bounty (on-chain escrow creation)
  console.log('\n--- STEP 3: Dusty Pete claims bounty (ON-CHAIN) ---');
  console.log('This will: approve USDC → createEscrow on V2 contract → wait for receipt');
  const claim = await apiCall('POST', `/api/listings/${listingId}/claim`, keys['Dusty Pete'], {});
  console.log(`\nCLAIM RESULT:`);
  console.log(`  Transaction ID: ${claim.transaction_id}`);
  console.log(`  Escrow ID: ${claim.escrow_id}`);
  console.log(`  TX Hash: ${claim.tx_hash}`);
  console.log(`  Contract Version: ${claim.contract_version}`);
  console.log(`  BaseScan: ${claim.basescan_url}`);

  const txId = claim.transaction_id;

  // Step 3.5: Verify on-chain balance change
  const afterClaim = await checkBalances('BALANCES AFTER CLAIM');

  // Step 4: Dusty Pete delivers work
  console.log('\n--- STEP 4: Dusty Pete delivers work (ON-CHAIN markDelivered) ---');
  const deliver = await apiCall('POST', `/api/transactions/${txId}/deliver`, keys['Dusty Pete'], {
    deliverable: 'Top 5 AI Agent Frameworks:\n1. AutoGPT - Autonomous GPT-4 agent, recursive task decomposition\n2. CrewAI - Multi-agent orchestration, role-based collaboration\n3. LangGraph - Stateful agent workflows built on LangChain\n4. Microsoft AutoGen - Multi-agent conversation framework\n5. Semantic Kernel - Microsoft SDK for AI orchestration with plugins\n\nEach framework enables different patterns of AI agent autonomy and collaboration.',
  });
  console.log(`Delivery TX Hash: ${deliver.tx_hash}`);

  // Step 5: Tumbleweed releases payment (ON-CHAIN)
  console.log('\n--- STEP 5: Tumbleweed releases payment (ON-CHAIN release) ---');
  const release = await apiCall('POST', `/api/transactions/${txId}/release`, keys['Tumbleweed'], {});
  console.log(`Release TX Hash: ${release.tx_hash}`);
  console.log(`Seller received: ${release.seller_received_wei} wei`);
  console.log(`Fee: ${release.fee_wei} wei`);

  // Step 6: Final verification
  const after = await checkBalances('BALANCES AFTER RELEASE');

  // Step 7: Check DB record
  console.log('\n--- FINAL DB RECORD ---');
  const { data: finalTx } = await sb
    .from('transactions')
    .select('id, state, escrow_id, tx_hash, release_tx_hash, contract_version, amount_wei, delivered_at, completed_at, deliverable_hash')
    .eq('id', txId)
    .single();
  console.log(JSON.stringify(finalTx, null, 2));

  // Summary
  console.log('\n=== SUMMARY ===');
  console.log(`Bounty: $0.50 USDC`);
  console.log(`State: ${finalTx.state}`);
  console.log(`Contract Version: ${finalTx.contract_version}`);
  console.log(`Escrow ID: ${finalTx.escrow_id}`);
  console.log(`Creation TX: ${finalTx.tx_hash}`);
  console.log(`Release TX: ${finalTx.release_tx_hash}`);

  const tumbleweedUsdcChange = (after['Tumbleweed (buyer)'].usdc - before['Tumbleweed (buyer)'].usdc) / 1e6;
  const dustyPeteUsdcChange = (after['Dusty Pete (seller)'].usdc - before['Dusty Pete (seller)'].usdc) / 1e6;
  console.log(`\nTumbleweed USDC change: $${tumbleweedUsdcChange.toFixed(6)}`);
  console.log(`Dusty Pete USDC change: $${dustyPeteUsdcChange.toFixed(6)}`);

  console.log(`\nBaseScan links:`);
  console.log(`  Escrow creation: https://basescan.org/tx/${finalTx.tx_hash}`);
  console.log(`  Release:         https://basescan.org/tx/${finalTx.release_tx_hash}`);
  console.log(`  Contract:        https://basescan.org/address/0xc3bB40b16251072eDc4E63C70a886f84eC689AD8`);
}

main().catch(err => {
  console.error('\n!!! TEST FAILED !!!');
  console.error(err);
  process.exit(1);
});
