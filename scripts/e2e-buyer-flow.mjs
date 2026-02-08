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

async function e2eFlow() {
  // 1. Find the Miami restaurants listing
  console.log('Step 1: Finding Miami restaurants listing...')
  const { data: listing } = await supabase
    .from('listings')
    .select('id, title, price_wei, poster_wallet')
    .ilike('title', '%miami%restaurants%')
    .order('created_at', { ascending: false })
    .limit(1)
    .single()
  
  if (!listing) {
    console.error('❌ Listing not found!')
    return
  }
  
  console.log(`✅ Found listing: ${listing.title}`)
  console.log(`   ID: ${listing.id}`)
  console.log(`   Price: $${(parseFloat(listing.price_wei) / 1e6).toFixed(2)} USDC`)
  console.log(`   Poster: ${listing.poster_wallet}`)
  
  // 2. Get Dusty Pete's agent ID and API key
  console.log('\nStep 2: Getting Dusty Pete info...')
  const { data: dusty } = await supabase
    .from('agents')
    .select('id, name, api_key')
    .eq('name', 'Dusty Pete')
    .single()
  
  if (!dusty) {
    console.error('❌ Dusty Pete not found!')
    return
  }
  
  console.log(`✅ Found agent: ${dusty.name} (${dusty.id})`)
  
  // 3. Claim the bounty
  console.log('\nStep 3: Claiming bounty...')
  const claimRes = await fetch(`http://localhost:3000/api/listings/${listing.id}/claim`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${dusty.api_key}`
    },
    body: JSON.stringify({ agent_id: dusty.id })
  })
  
  if (!claimRes.ok) {
    const err = await claimRes.text()
    console.error('❌ Claim failed:', err)
    return
  }
  
  const claimData = await claimRes.json()
  console.log(`✅ Bounty claimed! Transaction ID: ${claimData.transaction.id}`)
  const txId = claimData.transaction.id
  
  // 4. Deliver work
  console.log('\nStep 4: Delivering work...')
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

  const deliverRes = await fetch(`http://localhost:3000/api/transactions/${txId}/deliver`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${dusty.api_key}`
    },
    body: JSON.stringify({ deliverable })
  })
  
  if (!deliverRes.ok) {
    const err = await deliverRes.text()
    console.error('❌ Delivery failed:', err)
    return
  }
  
  const deliverData = await deliverRes.json()
  console.log(`✅ Work delivered! State: ${deliverData.transaction.state}`)
  
  // 5. Check notification
  console.log('\nStep 5: Checking notification for buyer...')
  const { data: notifications } = await supabase
    .from('notifications')
    .select('*')
    .eq('user_wallet', listing.poster_wallet.toLowerCase())
    .order('created_at', { ascending: false })
    .limit(1)
  
  if (notifications && notifications.length > 0) {
    console.log(`✅ Notification created:`)
    console.log(`   Type: ${notifications[0].type}`)
    console.log(`   Title: ${notifications[0].title}`)
    console.log(`   Message: ${notifications[0].message}`)
  } else {
    console.log('⚠️  No notification found (might still be processing)')
  }
  
  // 6. Output detail page URL
  console.log('\n🎯 BOUNTY DETAIL PAGE:')
  console.log(`   https://clawlancer.ai/marketplace/${listing.id}`)
  console.log(`   Local: http://localhost:3000/marketplace/${listing.id}`)
  console.log('\n✅ COMPLETE! Ready to test Release Payment button.')
}

e2eFlow().catch(console.error)
