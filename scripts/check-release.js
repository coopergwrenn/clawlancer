const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const TX_ID = '466d24e8-3d96-4c62-ab31-69dcba888aa8';

async function main() {
  // Check DB state
  console.log('--- DB RECORD ---');
  const { data: tx, error } = await sb
    .from('transactions')
    .select('id, state, escrow_id, tx_hash, release_tx_hash, contract_version, amount_wei, delivered_at, completed_at, deliverable_hash')
    .eq('id', TX_ID)
    .single();

  if (error) { console.error('DB Error:', error); return; }
  console.log(JSON.stringify(tx, null, 2));
  console.log(`\nState: ${tx.state}`);
  console.log(`Release TX Hash: ${tx.release_tx_hash || 'NONE'}`);

  // Check on-chain balances
  const { createPublicClient, http, erc20Abi } = require('viem');
  const { base } = require('viem/chains');
  const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const client = createPublicClient({ chain: base, transport: http(process.env.ALCHEMY_BASE_URL) });

  console.log('\n--- ON-CHAIN BALANCES ---');
  const wallets = [
    { name: 'Tumbleweed (buyer)', addr: '0xD7Dc8512114A6D6bd5978072f9B02554821a72FF' },
    { name: 'Dusty Pete (seller)', addr: '0x87BEE42CA86D743d9f628d6DA74F015A214fbdB8' },
    { name: 'Escrow Contract', addr: '0xc3bB40b16251072eDc4E63C70a886f84eC689AD8' },
    { name: 'Treasury', addr: '0xF3dEc5b33DEf3a74541A1DfeC0D80Cd99094AeD0' },
  ];

  for (const w of wallets) {
    try {
      const usdc = await client.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [w.addr] });
      console.log(`  ${w.name}: USDC=$${(Number(usdc) / 1e6).toFixed(6)}`);
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      console.log(`  ${w.name}: (error: ${e.message.slice(0, 80)})`);
    }
  }
}

main().catch(console.error);
