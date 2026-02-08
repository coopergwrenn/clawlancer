const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
require('dotenv').config({ path: '.env.local' });

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const BASE_URL = 'https://clawlancer.ai';
const TX_ID = '1b31b2da-6b6b-4eea-aa8b-3f962f655619';
const TUMBLEWEED_ID = '0d458eb0-2325-4130-95cb-e4f5d43def9f';
const DUSTY_PETE_ID = 'a67d7b98-7a5d-42e1-8c15-38e5745bd789';

async function ensureApiKeys() {
  const keys = {};
  for (const [name, id] of [['Tumbleweed', TUMBLEWEED_ID], ['Dusty Pete', DUSTY_PETE_ID]]) {
    const rawKey = 'clw_' + crypto.randomBytes(16).toString('hex');
    const hashedKey = crypto.createHash('sha256').update(rawKey).digest('hex');
    await sb.from('agents').update({ api_key: hashedKey }).eq('id', id);
    keys[name] = rawKey;
    console.log(`Key set for ${name}: ${rawKey.slice(0, 12)}...`);
  }
  return keys;
}

async function apiCall(method, path, apiKey, body) {
  const url = `${BASE_URL}${path}`;
  const opts = {
    method,
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  console.log(`\n>>> ${method} ${path}`);
  const res = await fetch(url, opts);
  const data = await res.json();
  console.log(`<<< ${res.status}`);
  console.log(JSON.stringify(data, null, 2));
  if (!res.ok) throw new Error(`${res.status}: ${data.error || JSON.stringify(data)}`);
  return data;
}

async function checkBalances() {
  const { createPublicClient, http, erc20Abi } = require('viem');
  const { base } = require('viem/chains');
  const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const client = createPublicClient({ chain: base, transport: http(process.env.ALCHEMY_BASE_URL) });

  const wallets = [
    { name: 'Tumbleweed', addr: '0xD7Dc8512114A6D6bd5978072f9B02554821a72FF' },
    { name: 'Dusty Pete', addr: '0x87BEE42CA86D743d9f628d6DA74F015A214fbdB8' },
    { name: 'Escrow', addr: '0xc3bB40b16251072eDc4E63C70a886f84eC689AD8' },
  ];

  const results = {};
  for (const w of wallets) {
    try {
      const eth = await client.getBalance({ address: w.addr });
      const usdc = await client.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [w.addr] });
      results[w.name] = { eth: Number(eth), usdc: Number(usdc) };
      console.log(`  ${w.name}: ETH=${(Number(eth) / 1e18).toFixed(6)}  USDC=$${(Number(usdc) / 1e6).toFixed(6)}`);
      await new Promise(r => setTimeout(r, 500)); // rate limit protection
    } catch (e) {
      console.log(`  ${w.name}: (rate limited, skipping)`);
    }
  }
  return results;
}

async function main() {
  console.log('=== DELIVER + RELEASE ===\n');

  const keys = await ensureApiKeys();

  // Step 4: Deliver
  console.log('\n--- STEP 4: Dusty Pete delivers work ---');
  const deliver = await apiCall('POST', `/api/transactions/${TX_ID}/deliver`, keys['Dusty Pete'], {
    deliverable: 'Top 5 AI Agent Frameworks (2024):\n\n1. AutoGPT - Recursive autonomous task decomposition using GPT-4\n2. CrewAI - Role-based multi-agent orchestration framework\n3. LangGraph - Stateful agent workflows on LangChain\n4. Microsoft AutoGen - Multi-agent conversation patterns\n5. Semantic Kernel - Plugin-based AI orchestration SDK\n\nEach enables different patterns of AI agent autonomy and collaboration.',
  });
  console.log(`\nDelivery TX Hash: ${deliver.tx_hash}`);

  // Small delay between transactions
  console.log('\nWaiting 5s before release...');
  await new Promise(r => setTimeout(r, 5000));

  // Step 5: Release
  console.log('\n--- STEP 5: Tumbleweed releases payment ---');
  const release = await apiCall('POST', `/api/transactions/${TX_ID}/release`, keys['Tumbleweed'], {});
  console.log(`\nRelease TX Hash: ${release.tx_hash}`);
  console.log(`Seller received: ${release.seller_received_wei} wei ($${(Number(release.seller_received_wei) / 1e6).toFixed(6)})`);
  console.log(`Fee: ${release.fee_wei} wei ($${(Number(release.fee_wei) / 1e6).toFixed(6)})`);

  // Wait and check balances
  console.log('\nWaiting 5s before balance check...');
  await new Promise(r => setTimeout(r, 5000));

  console.log('\n--- FINAL BALANCES ---');
  await checkBalances();

  // Check DB record
  console.log('\n--- FINAL DB RECORD ---');
  const { data: finalTx } = await sb
    .from('transactions')
    .select('id, state, escrow_id, tx_hash, release_tx_hash, contract_version, amount_wei, delivered_at, completed_at, deliverable_hash')
    .eq('id', TX_ID)
    .single();
  console.log(JSON.stringify(finalTx, null, 2));

  console.log('\n=== BASESCAN LINKS ===');
  console.log(`Escrow creation: https://basescan.org/tx/${finalTx.tx_hash}`);
  if (deliver.tx_hash) console.log(`Delivery:        https://basescan.org/tx/${deliver.tx_hash}`);
  console.log(`Release:         https://basescan.org/tx/${finalTx.release_tx_hash}`);
  console.log(`Contract:        https://basescan.org/address/0xc3bB40b16251072eDc4E63C70a886f84eC689AD8`);
}

main().catch(err => {
  console.error('\n!!! FAILED !!!', err.message);
  process.exit(1);
});
