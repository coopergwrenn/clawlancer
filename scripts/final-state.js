const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function main() {
  // All V2 transactions
  console.log('=== ALL V2 ON-CHAIN TRANSACTIONS ===\n');
  const { data: v2Txs } = await sb
    .from('transactions')
    .select('id, state, amount_wei, tx_hash, release_tx_hash, contract_version, buyer_agent_id, seller_agent_id, delivered_at, completed_at, deliverable_hash, escrow_id')
    .eq('contract_version', 2)
    .order('completed_at', { ascending: true });

  const TUMBLEWEED_ID = '0d458eb0-2325-4130-95cb-e4f5d43def9f';

  for (let i = 0; i < v2Txs.length; i++) {
    const t = v2Txs[i];
    const buyer = t.buyer_agent_id === TUMBLEWEED_ID ? 'Tumbleweed' : 'Dusty Pete';
    const seller = t.seller_agent_id === TUMBLEWEED_ID ? 'Tumbleweed' : 'Dusty Pete';
    console.log(`--- Transaction #${i + 1} ---`);
    console.log(`  ID:            ${t.id}`);
    console.log(`  State:         ${t.state}`);
    console.log(`  Amount:        $${(t.amount_wei / 1e6).toFixed(2)} USDC`);
    console.log(`  Buyer:         ${buyer}`);
    console.log(`  Seller:        ${seller}`);
    console.log(`  Escrow ID:     ${t.escrow_id}`);
    console.log(`  Create TX:     ${t.tx_hash}`);
    console.log(`  Release TX:    ${t.release_tx_hash}`);
    console.log(`  Delivered:     ${t.delivered_at}`);
    console.log(`  Completed:     ${t.completed_at}`);
    console.log(`  Deliverable:   ${t.deliverable_hash}`);
    console.log(`  BaseScan:`);
    console.log(`    Create:  https://basescan.org/tx/${t.tx_hash}`);
    console.log(`    Release: https://basescan.org/tx/${t.release_tx_hash}`);
    console.log('');
  }

  console.log(`Total V2 on-chain transactions: ${v2Txs.length}`);

  // On-chain balances
  const { createPublicClient, http, erc20Abi } = require('viem');
  const { base } = require('viem/chains');
  const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const client = createPublicClient({ chain: base, transport: http(process.env.ALCHEMY_BASE_URL) });

  console.log('\n=== FINAL ON-CHAIN BALANCES ===\n');
  const wallets = [
    { name: 'Tumbleweed', addr: '0xD7Dc8512114A6D6bd5978072f9B02554821a72FF' },
    { name: 'Dusty Pete', addr: '0x87BEE42CA86D743d9f628d6DA74F015A214fbdB8' },
    { name: 'Escrow Contract', addr: '0xc3bB40b16251072eDc4E63C70a886f84eC689AD8' },
  ];

  for (const w of wallets) {
    try {
      const eth = await client.getBalance({ address: w.addr });
      const usdc = await client.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [w.addr] });
      console.log(`  ${w.name}: ETH=${(Number(eth) / 1e18).toFixed(6)}  USDC=$${(Number(usdc) / 1e6).toFixed(6)}`);
      await new Promise(r => setTimeout(r, 400));
    } catch (e) {
      console.log(`  ${w.name}: (error)`);
    }
  }

  // Net accounting
  console.log('\n=== NET ACCOUNTING ===\n');
  // Starting: Tumbleweed $5.00, Dusty Pete $4.00
  // Bounty #1: Tumbleweed paid $0.50, Dusty Pete received $0.495 (1% fee = $0.005)
  // Bounty #2: Dusty Pete paid $1.00, Tumbleweed received $0.99 (1% fee = $0.01)
  console.log('  Starting balances: Tumbleweed=$5.00, Dusty Pete=$4.00');
  console.log('  Bounty #1: Tumbleweed→Dusty Pete $0.50 (fee $0.005)');
  console.log('  Bounty #2: Dusty Pete→Tumbleweed $1.00 (fee $0.01)');
  console.log('  Expected: Tumbleweed=$5.49, Dusty Pete=$3.495, Fees=$0.015');

  console.log('\n=== CONTRACT ON BASESCAN ===');
  console.log('  https://basescan.org/address/0xc3bB40b16251072eDc4E63C70a886f84eC689AD8');
}

main().catch(console.error);
