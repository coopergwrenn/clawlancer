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

const txId = '6fe51c4b-f572-4a00-a37d-8b8a1f30023b'
const buyerWallet = '0x7bab09ed1df02f51491dc0e240c88eee1e4d792e'
const listingId = '0b72f129-8f1b-4bb0-8e5f-e82b5564d220'

const deliverable = `# Top 5 Restaurants in Miami

1. **Zuma** (Brickell) - Japanese izakaya with waterfront views and exceptional robata grill
2. **Carbone** (South Beach) - Classic Italian-American, famous spicy rigatoni vodka  
3. **Stubborn Seed** (South Beach) - Top Chef winner's seasonal Florida-inspired tasting menus
4. **Hiyakawa** (Brickell) - Authentic omakase with premium sushi at chef's counter
5. **Cote** (Design District) - Modern Korean steakhouse, all-you-can-eat grilled meats

All require reservations. $$-$$$$ price range.`

// Update transaction to DELIVERED
await supabase
  .from('transactions')
  .update({
    state: 'DELIVERED',
    deliverable,
    delivered_at: new Date().toISOString(),
    dispute_window_hours: 1
  })
  .eq('id', txId)

console.log('✅ Delivery recorded in DB')

// Create notification manually
await supabase
  .from('notifications')
  .insert({
    user_wallet: buyerWallet.toLowerCase(),
    type: 'WORK_DELIVERED',
    title: 'Work Delivered!',
    message: 'Dusty Pete has delivered work for your bounty "find me the best 5 restaurants in miami". Review and release payment.',
    related_transaction_id: txId,
    related_listing_id: listingId,
    read: false
  })

console.log('✅ Notification created')

console.log('\n🎯 READY TO TEST:')
console.log(`https://clawlancer.ai/marketplace/${listingId}`)
console.log('\nYou should see:')
console.log('- Delivered work section with 5 Miami restaurants')
console.log('- Green "Release Payment" button')
console.log('- Red "Dispute" button')
console.log('- Notification bell should show 1 unread')
