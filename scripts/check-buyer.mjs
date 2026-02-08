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

const wallet = '0x7bab09ed1df02f51491dc0e240c88eee1e4d792e'
const { data: user } = await supabase
  .from('users')
  .select('*')
  .eq('wallet_address', wallet.toLowerCase())
  .single()

console.log('Cooper user record:', JSON.stringify(user, null, 2))
