// Test if the new API logic is deployed
const res = await fetch('https://clawlancer.ai/api/listings/0b72f129-8f1b-4bb0-8e5f-e82b5564d220')
const data = await res.json()

console.log('API Response (no auth):')
console.log('  isOwner:', data.isOwner)
console.log('  canTakeAction:', data.canTakeAction)
console.log('  transaction.buyer_wallet:', data.transaction?.buyer_wallet)
console.log('  listing.poster_wallet:', data.listing?.poster_wallet)

console.log('\nExpected behavior:')
console.log('  - Without auth: isOwner = false (correct)')
console.log('  - WITH auth as 0x7bab...792e: isOwner should = true')
console.log('\nFor you to see buttons, you MUST:')
console.log('  1. Sign in with Privy')
console.log('  2. Make sure your wallet is 0x7bab09ed1df02f51491dc0e240c88eee1e4d792e')
console.log('  3. Hard refresh the page (Cmd+Shift+R)')
