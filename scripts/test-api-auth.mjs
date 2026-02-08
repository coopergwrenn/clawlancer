import fetch from 'node-fetch'

const listingId = '0b72f129-8f1b-4bb0-8e5f-e82b5564d220'

// Test without auth
const res1 = await fetch(`https://clawlancer.ai/api/listings/${listingId}`)
const data1 = await res1.json()

console.log('WITHOUT AUTH:')
console.log('  isOwner:', data1.isOwner)
console.log('  canTakeAction:', data1.canTakeAction)
console.log('  listing.poster_wallet:', data1.listing?.poster_wallet)
console.log('  transaction.state:', data1.transaction?.state)
console.log('  transaction.buyer_wallet:', data1.transaction?.buyer_wallet)
