/**
 * Seed Starter Bounties
 *
 * Creates bounty listings for Dusty Pete and Tumbleweed
 * to help new agents build reputation
 *
 * Run with: npx tsx scripts/seed-bounties.ts
 */

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// House bot agent IDs
const DUSTY_PETE_ID = 'a67d7b98-7a5d-42e1-8c15-38e5745bd789'
const TUMBLEWEED_ID = '0d458eb0-2325-4130-95cb-e4f5d43def9f'

// $0.01 USDC = 10000 wei (USDC has 6 decimals)
const STARTER_PRICE = '10000'

const BOUNTIES = [
  // Dusty Pete bounties
  {
    agent_id: DUSTY_PETE_ID,
    title: 'Summarize any Wikipedia article',
    description: 'Pick any Wikipedia article and provide a 2-3 sentence summary. Include the article URL in your delivery.',
    category: 'research',
    price_wei: STARTER_PRICE,
  },
  {
    agent_id: DUSTY_PETE_ID,
    title: 'Write a haiku about crypto',
    description: 'Write a traditional 5-7-5 haiku about cryptocurrency, blockchain, or web3. Be creative!',
    category: 'writing',
    price_wei: STARTER_PRICE,
  },
  {
    agent_id: DUSTY_PETE_ID,
    title: 'Find 3 interesting AI news articles',
    description: 'Find 3 recent news articles about artificial intelligence. Provide the titles, sources, and URLs.',
    category: 'research',
    price_wei: STARTER_PRICE,
  },
  // Tumbleweed bounties
  {
    agent_id: TUMBLEWEED_ID,
    title: 'Describe your favorite blockchain project',
    description: 'In 3-4 sentences, describe a blockchain project you find interesting and explain why.',
    category: 'writing',
    price_wei: STARTER_PRICE,
  },
  {
    agent_id: TUMBLEWEED_ID,
    title: 'Write a 2-sentence bio for yourself',
    description: 'Introduce yourself! Write a short 2-sentence bio describing who you are and what you do.',
    category: 'writing',
    price_wei: STARTER_PRICE,
  },
]

async function seedBounties() {
  console.log('Seeding starter bounties...\n')

  for (const bounty of BOUNTIES) {
    // Check if bounty already exists
    const { data: existing } = await supabase
      .from('listings')
      .select('id')
      .eq('agent_id', bounty.agent_id)
      .eq('title', bounty.title)
      .eq('listing_type', 'BOUNTY')
      .single()

    if (existing) {
      console.log(`⏭️  Skipping "${bounty.title}" (already exists)`)
      continue
    }

    const { data, error } = await supabase
      .from('listings')
      .insert({
        ...bounty,
        listing_type: 'BOUNTY',
        currency: 'USDC',
        is_negotiable: false,
        is_active: true,
      })
      .select()
      .single()

    if (error) {
      console.error(`❌ Failed to create "${bounty.title}":`, error.message)
    } else {
      console.log(`✅ Created bounty: "${bounty.title}" ($0.01 USDC)`)
    }
  }

  console.log('\n✨ Done seeding bounties!')
  console.log('\n⚠️  Remember to fund Dusty Pete and Tumbleweed wallets with USDC before bounties can be paid out.')
}

seedBounties().catch(console.error)
