import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
dotenv.config({ path: join(__dirname, '..', '.env.local') })

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

async function run() {
  const listingId = '0b72f129-8f1b-4bb0-8e5f-e82b5564d220'
  const buyerWallet = '0x7bab09ed1df02f51491dc0e240c88eee1e4d792e'

  console.log('Step 1: Get Dusty Pete...')
  const { data: dusty } = await supabase
    .from('agents')
    .select('id, name, api_key')
    .eq('name', 'Dusty Pete')
    .single()

  console.log(`✅ ${dusty.name}`)

  console.log('\nStep 2: Create transaction...')
  const { data: tx, error: txError } = await supabase
    .from('transactions')
    .insert({
      listing_id: listingId,
      buyer_wallet: buyerWallet.toLowerCase(),
      seller_agent_id: dusty.id,
      amount_wei: '500000',
      currency: 'USDC',
      state: 'FUNDED',
      contract_version: 2,
      deadline: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    })
    .select()
    .single()

  if (txError) {
    console.error('Error:', txError)
    return
  }

  console.log(`✅ TX: ${tx.id}`)
  const txId = tx.id

  await supabase.from('listings').update({ is_active: false }).eq('id', listingId)

  console.log('\nStep 3: Deliver...')
  const deliverable = `# Top 5 Restaurants in Miami

1. **Zuma** (Brickell) - Japanese izakaya with waterfront views and exceptional robata grill
2. **Carbone** (South Beach) - Classic Italian-American, famous spicy rigatoni vodka  
3. **Stubborn Seed** (South Beach) - Top Chef winner's seasonal Florida-inspired tasting menus
4. **Hiyakawa** (Brickell) - Authentic omakase with premium sushi at chef's counter
5. **Cote** (Design District) - Modern Korean steakhouse, all-you-can-eat grilled meats

All require reservations. $$-$$$$ price range.`

  const res = await fetch(`https://clawlancer.ai/api/transactions/${txId}/deliver`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${dusty.api_key}` },
    body: JSON.stringify({ deliverable })
  })

  const data = await res.json()
  console.log(res.ok ? `✅ Delivered! State: ${data.transaction.state}` : `❌ ${JSON.stringify(data)}`)

  console.log('\nStep 4: Check notifications...')
  const { data: notifs } = await supabase
    .from('notifications')
    .select('type, title')
    .eq('user_wallet', buyerWallet.toLowerCase())
    .order('created_at', { ascending: false })
    .limit(2)

  console.log(`Found ${notifs?.length || 0}:`, notifs?.map(n => n.type))

  console.log('\n🎯 TEST HERE:')
  console.log(`https://clawlancer.ai/marketplace/${listingId}`)
}

run().catch(console.error)
