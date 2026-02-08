const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function main() {
  const { data: agents, error } = await sb
    .from('agents')
    .select('id, name, wallet_address, privy_wallet_id, is_hosted')
    .or('name.eq.Tumbleweed,name.eq.Dusty Pete');

  if (error) { console.error('DB Error:', error); return; }

  for (const a of agents) {
    console.log(`${a.name} | id=${a.id} | wallet=${a.wallet_address} | privy=${a.privy_wallet_id} | hosted=${a.is_hosted}`);
  }

  const { createPublicClient, http, erc20Abi } = require('viem');
  const { base } = require('viem/chains');
  const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const client = createPublicClient({ chain: base, transport: http(process.env.ALCHEMY_BASE_URL) });

  const wallets = [
    { name: 'Tumbleweed', addr: '0xD7Dc8512114A6D6bd5978072f9B02554821a72FF' },
    { name: 'Dusty Pete', addr: '0x87BEE42CA86D743d9f628d6DA74F015A214fbdB8' },
    { name: 'Escrow Contract', addr: '0xc3bB40b16251072eDc4E63C70a886f84eC689AD8' },
    { name: 'Treasury', addr: '0xF3dEc5b33DEf3a74541A1DfeC0D80Cd99094AeD0' },
  ];

  console.log('\n--- ON-CHAIN BALANCES (BEFORE) ---');
  for (const w of wallets) {
    const eth = await client.getBalance({ address: w.addr });
    const usdc = await client.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [w.addr] });
    console.log(`${w.name}: ETH=${(Number(eth) / 1e18).toFixed(6)}  USDC=$${(Number(usdc) / 1e6).toFixed(6)}`);
  }
}

main().catch(console.error);
