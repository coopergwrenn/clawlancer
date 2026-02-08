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

async function flow() {
  const listingId = '0b72f129-8f1b-4bb0-8e5f-e82b5564d220'
  const buyerWallet = '0x7bab09ed1df02f51491dc0e240c88eee1e4d792e'
  
  console.log('Step 1: Get Dusty Pete API key...')
  const { data: dusty } = await supabase
    .from('agents')
    .select('id, name, api_key')
    .eq('name', 'Dusty Pete')
    .single()
  
  console.log(`✅ ${dusty.name} (${dusty.id.substring(0, 8)}...)`)
  
  console.log('\nStep 2: Claim bounty...')
  const claimRes = await fetch('https://clawlancer.ai/api/listings/' + listingId + '/claim', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${dusty.api_key}`
    },
    body: JSON.stringify({ agent_id: dusty.id })
  })
  
  const claimData = await claimRes.json()
  if (!claimRes.ok) {
    console.error('❌ Claim failed:', claimData)
    return
  }
  
  console.log(`✅ Claimed! TX: ${claimData.transaction.id}`)
  const txId = claimData.transaction.id
  
  console.log('\nStep 3: Deliver work...')
  const deliverable = `# Top 5 Restaurants in Miami

1. **Zuma** (Brickell)
   Japanese izakaya-style dining with stunning waterfront views. Known for their contemporary robata grill dishes and creative sushi. Perfect for special occasions.

2. **Carbone** (South Beach)
   Classic Italian-American cuisine in a retro setting. Famous for their spicy rigatoni vodka and tableside Caesar salad. Reservations book months in advance.

3. **Stubborn Seed** (South Beach)
   Creative American cuisine by Top Chef winner Jeremy Ford. Seasonal tasting menus with Florida-inspired ingredients. Intimate and innovative.

4. **Hiyakawa** (Brickell)
   Authentic Japanese omakase experience with premium sushi. Chef's counter seating for an immersive dining experience. Exceptional quality and presentation.

5. **Cote** (Design District)
   Korean steakhouse with a modern twist. All-you-can-eat grilled meats and banchan. Fun, interactive dining experience with high-quality cuts.

All restaurants require reservations. Best for dinner, price range: $$-$$$$.`

  const deliverRes = await fetch('https://clawlancer.ai/api/transactions/' + txId + '/deliver', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${dusty.api_key}`
    },
    body: JSON.stringify({ deliverable })
  })
  
  const deliverData = await deliverRes.json()
  if (!deliverRes.ok) {
    console.error('❌ Delivery failed:', deliverData)
    return
  }
  
  console.log(`✅ Delivered! State: ${deliverData.transaction.state}`)
  
  console.log('\nStep 4: Check notification...')
  const { data: notif } = await supabase
    .from('notifications')
    .select('type, title, message, created_at')
    .eq('user_wallet', buyerWallet.toLowerCase())
    .order('created_at', { ascending: false })
    .limit(1)
    .single()
  
  if (notif) {
    console.log(`✅ Notification: ${notif.type}`)
    console.log(`   ${notif.title}`)
    console.log(`   ${notif.message.substring(0, 80)}...`)
  }
  
  console.log('\n🎯 BOUNTY DETAIL PAGE:')
  console.log(`   https://clawlancer.ai/marketplace/${listingId}`)
  console.log('\n✅ READY TO TEST RELEASE PAYMENT!')
}

flow().catch(console.error)
