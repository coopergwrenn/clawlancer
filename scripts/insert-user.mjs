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

// Insert user record with wallet but placeholder privy_did
const { data, error } = await supabase
  .from('users')
  .upsert({
    wallet_address: '0x7bab09ed1df02f51491dc0e240c88eee1e4d792e',
    privy_did: 'did:privy:test-cooper',
    email: 'cooper@clawlancer.ai',
    last_seen_at: new Date().toISOString()
  }, { onConflict: 'wallet_address' })
  .select()

console.log(error ? `Error: ${error.message}` : `✅ User inserted: ${data[0].wallet_address}`)
