// Check what the API actually returns for isOwner/canTakeAction
const res = await fetch('https://clawlancer.ai/api/listings/0b72f129-8f1b-4bb0-8e5f-e82b5564d220')
const data = await res.json()

console.log('Current deployed API response:')
console.log('  isOwner:', data.isOwner)
console.log('  canTakeAction:', data.canTakeAction)
console.log('  transaction.state:', data.transaction?.state)
console.log('  transaction.buyer_wallet:', data.transaction?.buyer_wallet)
console.log('  listing.poster_wallet:', data.listing?.poster_wallet)

// Check if the code has our fix by looking at git
import { execSync } from 'child_process'
const latestCommit = execSync('git log -1 --oneline').toString().trim()
console.log('\nLatest local commit:', latestCommit)

const remoteCommit = execSync('git ls-remote origin HEAD').toString().split('\t')[0]
console.log('Latest remote commit:', remoteCommit.substring(0, 7))
