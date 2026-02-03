/**
 * Create House Bots with Real Privy Wallets
 *
 * Run this script to provision the 5 house bots:
 *   npx tsx scripts/create-house-bots.ts
 *
 * Requirements:
 *   - NEXT_PUBLIC_PRIVY_APP_ID
 *   - PRIVY_APP_SECRET
 *   - NEXT_PUBLIC_SUPABASE_URL
 *   - SUPABASE_SERVICE_ROLE_KEY
 *   - TREASURY_ADDRESS
 */

import { PrivyClient } from '@privy-io/node';
import { createClient } from '@supabase/supabase-js';

// Load environment variables
import { config } from 'dotenv';
config({ path: '.env.local' });

// Initialize Privy client
const privy = new PrivyClient({
  appId: process.env.NEXT_PUBLIC_PRIVY_APP_ID || process.env.PRIVY_APP_ID!,
  appSecret: process.env.PRIVY_APP_SECRET!,
});

// Initialize Supabase client
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// House bot configurations
const HOUSE_BOTS = [
  { name: 'Dusty Pete', personality: 'hustler' },
  { name: 'Snake Oil Sally', personality: 'degen' },
  { name: 'Sheriff Claude', personality: 'cautious' },
  { name: 'Cactus Jack', personality: 'random' },
  { name: 'Tumbleweed', personality: 'hustler' },
];

// Initial listings for each personality
const LISTINGS: Record<string, Array<{ title: string; description: string; category: string; price_wei: string }>> = {
  hustler: [
    { title: 'Crypto Market Analysis', description: 'Daily analysis of top 10 tokens with price predictions and momentum indicators', category: 'analysis', price_wei: '5000000' },
    { title: 'Alpha Signals (24hr)', description: 'Real-time alerts on market movements and opportunities', category: 'analysis', price_wei: '10000000' },
  ],
  cautious: [
    { title: 'Smart Contract Audit', description: 'Security review of Solidity contracts under 500 lines. Thorough analysis.', category: 'code', price_wei: '25000000' },
    { title: 'Risk Assessment Report', description: 'Comprehensive risk analysis of any DeFi protocol', category: 'research', price_wei: '15000000' },
  ],
  degen: [
    { title: 'DEGEN PICKS', description: 'My top 3 most unhinged plays. WAGMI or rekt together. NFA.', category: 'analysis', price_wei: '2000000' },
    { title: 'Meme Coin Alpha', description: 'Early meme coin detection. Will probably lose money tbh.', category: 'research', price_wei: '3000000' },
  ],
  random: [
    { title: 'Mystery Box', description: 'You literally have no idea what you will get. Could be alpha. Could be nothing.', category: 'other', price_wei: '1000000' },
    { title: 'Chaos Consultation', description: 'I will give you advice. The quality is... unpredictable.', category: 'other', price_wei: '500000' },
  ],
};

async function createPrivyWallet(): Promise<{ walletId: string; address: string }> {
  const wallet = await privy.wallets().create({
    chain_type: 'ethereum',
  });

  const walletId = String(wallet.id);
  if (!walletId) {
    throw new Error('Privy wallet created without ID');
  }

  let address = String(wallet.address);
  if (address.includes(':')) {
    // Handle CAIP-10 format
    const parts = address.split(':');
    address = parts[parts.length - 1];
  }

  if (!address.match(/^0x[a-fA-F0-9]{40}$/)) {
    throw new Error(`Invalid wallet address: ${address}`);
  }

  return { walletId, address };
}

async function createHouseBot(bot: { name: string; personality: string }) {
  const treasuryAddress = process.env.TREASURY_ADDRESS?.trim().toLowerCase();

  if (!treasuryAddress) {
    throw new Error('TREASURY_ADDRESS not set');
  }

  console.log(`\nCreating ${bot.name}...`);

  // Check if already exists
  const { data: existing } = await supabase
    .from('agents')
    .select('id, wallet_address, privy_wallet_id')
    .eq('name', bot.name)
    .eq('owner_address', treasuryAddress)
    .single();

  if (existing) {
    console.log(`  Already exists: ${existing.wallet_address}`);
    if (existing.privy_wallet_id) {
      console.log(`  Has Privy wallet ID: ${existing.privy_wallet_id}`);
      return { status: 'exists', ...existing };
    } else {
      console.log(`  WARNING: Missing Privy wallet ID!`);
    }
  }

  // Create Privy wallet
  console.log(`  Creating Privy wallet...`);
  const wallet = await createPrivyWallet();
  console.log(`  Wallet created: ${wallet.address}`);
  console.log(`  Wallet ID: ${wallet.walletId}`);

  // If agent exists but missing wallet ID, update it
  if (existing) {
    const { error } = await supabase
      .from('agents')
      .update({
        wallet_address: wallet.address,
        privy_wallet_id: wallet.walletId,
      })
      .eq('id', existing.id);

    if (error) {
      throw new Error(`Failed to update agent: ${error.message}`);
    }

    console.log(`  Updated existing agent with new wallet`);
    return { status: 'updated', id: existing.id, wallet };
  }

  // Create new agent
  const { data: agent, error: insertError } = await supabase
    .from('agents')
    .insert({
      name: bot.name,
      wallet_address: wallet.address,
      owner_address: treasuryAddress,
      is_hosted: true,
      personality: bot.personality,
      privy_wallet_id: wallet.walletId,
    })
    .select()
    .single();

  if (insertError || !agent) {
    throw new Error(`Failed to create agent: ${insertError?.message}`);
  }

  console.log(`  Agent created: ${agent.id}`);

  // Create listings
  const listings = LISTINGS[bot.personality] || LISTINGS.random;
  for (const listing of listings) {
    const { error: listingError } = await supabase.from('listings').insert({
      agent_id: agent.id,
      title: listing.title,
      description: listing.description,
      category: listing.category,
      price_wei: listing.price_wei,
      currency: 'USDC',
    });

    if (listingError) {
      console.log(`  Warning: Failed to create listing: ${listingError.message}`);
    } else {
      console.log(`  Created listing: ${listing.title}`);
    }
  }

  return { status: 'created', id: agent.id, wallet };
}

async function main() {
  console.log('=== House Bot Provisioning ===\n');

  // Validate environment
  const required = [
    'NEXT_PUBLIC_PRIVY_APP_ID',
    'PRIVY_APP_SECRET',
    'NEXT_PUBLIC_SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'TREASURY_ADDRESS',
  ];

  const missing = required.filter(key =>
    !process.env[key] && !process.env[key.replace('NEXT_PUBLIC_', '')]
  );

  if (missing.length > 0) {
    console.error('Missing environment variables:', missing.join(', '));
    process.exit(1);
  }

  console.log('Environment validated.');
  console.log(`Treasury: ${process.env.TREASURY_ADDRESS?.trim()}`);

  const results: Array<{ name: string; status: string; wallet?: string; error?: string }> = [];

  for (const bot of HOUSE_BOTS) {
    try {
      const result = await createHouseBot(bot);
      results.push({
        name: bot.name,
        status: result.status,
        wallet: result.wallet?.address || (result as any).wallet_address,
      });
    } catch (err) {
      console.error(`  Error: ${err instanceof Error ? err.message : err}`);
      results.push({
        name: bot.name,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  console.log('\n=== Results ===\n');
  console.table(results);

  const successful = results.filter(r => r.status !== 'error').length;
  console.log(`\nCreated ${successful}/${HOUSE_BOTS.length} house bots.`);

  // Verify database state
  console.log('\n=== Verifying Database ===\n');
  const { data: agents } = await supabase
    .from('agents')
    .select('name, wallet_address, privy_wallet_id, personality')
    .eq('owner_address', process.env.TREASURY_ADDRESS?.trim().toLowerCase());

  if (agents) {
    for (const agent of agents) {
      const hasWalletId = !!agent.privy_wallet_id;
      console.log(`${agent.name}: ${hasWalletId ? '✅' : '❌'} Privy wallet ID`);
    }
  }
}

main().catch(console.error);
