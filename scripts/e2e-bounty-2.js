/**
 * E2E Bounty #2 — Reversed roles
 * Dusty Pete posts a $1 bounty, Tumbleweed claims/delivers, Dusty Pete releases.
 */
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
require('dotenv').config({ path: '.env.local' });

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const BASE_URL = 'https://clawlancer.ai';

const TUMBLEWEED_ID = '0d458eb0-2325-4130-95cb-e4f5d43def9f';
const DUSTY_PETE_ID = 'a67d7b98-7a5d-42e1-8c15-38e5745bd789';

async function ensureApiKeys() {
  const keys = {};
  for (const [name, id] of [['Tumbleweed', TUMBLEWEED_ID], ['Dusty Pete', DUSTY_PETE_ID]]) {
    const rawKey = 'clw_' + crypto.randomBytes(16).toString('hex');
    const hashedKey = crypto.createHash('sha256').update(rawKey).digest('hex');
    const { error } = await sb.from('agents').update({ api_key: hashedKey }).eq('id', id);
    if (error) { console.error(`Failed to set key for ${name}:`, error); process.exit(1); }
    keys[name] = rawKey;
    console.log(`API key set for ${name}: ${rawKey.slice(0, 12)}...`);
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
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  console.log(`<<< ${res.status}`);
  console.log(JSON.stringify(data, null, 2));
  if (!res.ok) throw new Error(`${res.status}: ${data.error || text}`);
  return data;
}

async function checkBalances(label) {
  const { createPublicClient, http, erc20Abi } = require('viem');
  const { base } = require('viem/chains');
  const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const client = createPublicClient({ chain: base, transport: http(process.env.ALCHEMY_BASE_URL) });

  console.log(`\n--- ${label} ---`);
  const wallets = [
    { name: 'Tumbleweed', addr: '0xD7Dc8512114A6D6bd5978072f9B02554821a72FF' },
    { name: 'Dusty Pete', addr: '0x87BEE42CA86D743d9f628d6DA74F015A214fbdB8' },
    { name: 'Escrow Contract', addr: '0xc3bB40b16251072eDc4E63C70a886f84eC689AD8' },
  ];

  const balances = {};
  for (const w of wallets) {
    try {
      const eth = await client.getBalance({ address: w.addr });
      const usdc = await client.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [w.addr] });
      console.log(`  ${w.name}: ETH=${(Number(eth) / 1e18).toFixed(6)}  USDC=$${(Number(usdc) / 1e6).toFixed(6)}`);
      balances[w.name] = { eth: Number(eth), usdc: Number(usdc) };
      await new Promise(r => setTimeout(r, 400));
    } catch (e) {
      console.log(`  ${w.name}: (error: ${e.message.slice(0, 60)})`);
    }
  }
  return balances;
}

async function main() {
  console.log('=== E2E BOUNTY #2 — Dusty Pete → Tumbleweed ($1.00) ===\n');

  // Step 0: API keys
  console.log('--- STEP 0: Generate API keys ---');
  const keys = await ensureApiKeys();

  // Step 1: Balances before
  const before = await checkBalances('BALANCES BEFORE');

  // Step 2: Dusty Pete posts a $1 bounty
  console.log('\n--- STEP 2: Dusty Pete posts $1 bounty ---');
  const listing = await apiCall('POST', '/api/listings', keys['Dusty Pete'], {
    agent_id: DUSTY_PETE_ID,
    title: 'Security audit of smart contract interaction patterns',
    description: 'Review common smart contract interaction patterns (approve+transfer, escrow, multi-sig) and identify the top 3 security risks for each. Provide mitigation strategies. This is E2E test #2 of the on-chain escrow system.',
    category: 'analysis',
    listing_type: 'BOUNTY',
    price_wei: '1000000', // $1.00 USDC
    currency: 'USDC',
  });
  const listingId = listing.listing?.id || listing.id;
  console.log(`Listing created: ${listingId}`);

  // Step 3: Tumbleweed claims the bounty (on-chain)
  console.log('\n--- STEP 3: Tumbleweed claims bounty (ON-CHAIN) ---');
  console.log('approve USDC → waitReceipt → createEscrow → waitReceipt');
  const claim = await apiCall('POST', `/api/listings/${listingId}/claim`, keys['Tumbleweed'], {});
  console.log(`\n  Transaction ID: ${claim.transaction_id}`);
  console.log(`  TX Hash: ${claim.tx_hash}`);
  console.log(`  BaseScan: ${claim.basescan_url}`);
  const txId = claim.transaction_id;

  // Check balances after claim
  const afterClaim = await checkBalances('BALANCES AFTER CLAIM');

  // Step 4: Tumbleweed delivers work
  console.log('\n--- STEP 4: Tumbleweed delivers work (ON-CHAIN markDelivered) ---');
  await new Promise(r => setTimeout(r, 3000));
  const deliver = await apiCall('POST', `/api/transactions/${txId}/deliver`, keys['Tumbleweed'], {
    deliverable: 'Smart Contract Interaction Security Audit:\n\n## 1. Approve + Transfer Pattern\nRisks: (a) Unlimited approval exploits — attacker drains via approved contract. (b) Front-running approval changes. (c) Stale approvals on abandoned contracts.\nMitigations: Use exact-amount approvals, increaseAllowance/decreaseAllowance, permit2.\n\n## 2. Escrow Pattern\nRisks: (a) Reentrancy on release/refund. (b) Locked funds if no timeout. (c) Oracle manipulation for auto-release.\nMitigations: CEI pattern, mandatory deadlines, multi-sig oracle or dispute resolution.\n\n## 3. Multi-Sig Pattern\nRisks: (a) Key compromise below threshold. (b) Signer collusion. (c) Replay attacks across chains.\nMitigations: Hardware wallets for signers, time-locked execution, chain-specific nonces.',
  });
  console.log(`Delivery TX Hash: ${deliver.tx_hash}`);

  // Step 5: Dusty Pete releases payment (on-chain)
  console.log('\n--- STEP 5: Dusty Pete releases payment (ON-CHAIN) ---');
  await new Promise(r => setTimeout(r, 5000));
  const release = await apiCall('POST', `/api/transactions/${txId}/release`, keys['Dusty Pete'], {});
  console.log(`Release TX Hash: ${release.tx_hash}`);

  // Step 6: Final verification
  await new Promise(r => setTimeout(r, 5000));
  const after = await checkBalances('FINAL BALANCES');

  // DB record
  console.log('\n--- FINAL DB RECORD ---');
  const { data: finalTx } = await sb
    .from('transactions')
    .select('id, state, escrow_id, tx_hash, release_tx_hash, contract_version, amount_wei, delivered_at, completed_at, deliverable_hash')
    .eq('id', txId)
    .single();
  console.log(JSON.stringify(finalTx, null, 2));

  // Count all V2 transactions
  console.log('\n--- ALL V2 TRANSACTIONS ---');
  const { data: v2Txs } = await sb
    .from('transactions')
    .select('id, state, amount_wei, tx_hash, release_tx_hash, contract_version')
    .eq('contract_version', 2);
  console.log(`Total V2 transactions: ${v2Txs.length}`);
  for (const t of v2Txs) {
    console.log(`  ${t.id} | state=${t.state} | $${(t.amount_wei / 1e6).toFixed(2)} | create=${t.tx_hash?.slice(0,16)}... | release=${t.release_tx_hash?.slice(0,16) || 'n/a'}...`);
  }

  // Summary
  console.log('\n=== SUMMARY ===');
  console.log(`Bounty: $1.00 USDC`);
  console.log(`State: ${finalTx.state}`);
  console.log(`Contract Version: ${finalTx.contract_version}`);

  if (before['Tumbleweed'] && after['Tumbleweed']) {
    const twChange = (after['Tumbleweed'].usdc - before['Tumbleweed'].usdc) / 1e6;
    console.log(`Tumbleweed USDC change: ${twChange >= 0 ? '+' : ''}$${twChange.toFixed(6)}`);
  }
  if (before['Dusty Pete'] && after['Dusty Pete']) {
    const dpChange = (after['Dusty Pete'].usdc - before['Dusty Pete'].usdc) / 1e6;
    console.log(`Dusty Pete USDC change: ${dpChange >= 0 ? '+' : ''}$${dpChange.toFixed(6)}`);
  }

  console.log(`\n=== BASESCAN LINKS ===`);
  console.log(`Escrow creation: https://basescan.org/tx/${finalTx.tx_hash}`);
  if (deliver.tx_hash) console.log(`Delivery:        https://basescan.org/tx/${deliver.tx_hash}`);
  console.log(`Release:         https://basescan.org/tx/${finalTx.release_tx_hash}`);
  console.log(`Contract:        https://basescan.org/address/0xc3bB40b16251072eDc4E63C70a886f84eC689AD8`);
}

main().catch(err => {
  console.error('\n!!! FAILED !!!', err.message);
  process.exit(1);
});
