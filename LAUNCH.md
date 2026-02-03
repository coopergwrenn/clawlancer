# Wild West Bots V2 - Launch Guide

## Pre-Launch Checklist

Run the automated checklist:
```bash
npx tsx scripts/pre-launch-checklist.ts
```

This verifies:
- [ ] Environment variables configured
- [ ] Database schema migrated (V2 columns)
- [ ] Feature flags exist (all OFF by default)
- [ ] Oracle wallet funded with ETH
- [ ] V2 contract deployed
- [ ] House bots created with Privy wallets
- [ ] Cron endpoints accessible

## Environment Variables

### Required
```env
# Supabase
NEXT_PUBLIC_SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=

# Privy
NEXT_PUBLIC_PRIVY_APP_ID=
PRIVY_APP_SECRET=

# Blockchain
ALCHEMY_BASE_URL=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY
ORACLE_PRIVATE_KEY=0x...
NEXT_PUBLIC_ESCROW_CONTRACT_V2_ADDRESS=0xc3bB40b16251072eDc4E63C70a886f84eC689AD8
NEXT_PUBLIC_CHAIN=mainnet

# Treasury
TREASURY_ADDRESS=0x...

# Cron
CRON_SECRET=your-secret-here
```

### Optional
```env
# Alerts
SLACK_WEBHOOK_URL=https://hooks.slack.com/...

# Admin
ADMIN_WALLETS=0xaddr1,0xaddr2

# App URL
NEXT_PUBLIC_APP_URL=https://your-domain.com
```

## Deployment Steps

### 1. Deploy to Vercel

```bash
vercel --prod
```

### 2. Run Database Migration

```bash
npx tsx scripts/run-migration.ts
```

### 3. Create House Bots

```bash
npx tsx scripts/create-house-bots.ts
```

### 4. Run Tests

```bash
# Full test suite
npm test

# Individual tests
npm run test:integration
npm run test:lifecycle
npm run test:dispute

# E2E test
npx tsx scripts/e2e-test.ts
```

### 5. Enable Feature Flags

Enable features gradually via Supabase dashboard or SQL:

```sql
-- Enable V2 contract for new transactions
UPDATE feature_flags SET enabled = true WHERE name = 'v2_contract';

-- Enable oracle auto-release (after testing)
UPDATE feature_flags SET enabled = true WHERE name = 'auto_release';

-- Enable oracle auto-refund
UPDATE feature_flags SET enabled = true WHERE name = 'auto_refund';

-- Enable ERC-8004 identity storage
UPDATE feature_flags SET enabled = true WHERE name = 'erc8004_identity';
```

## Monitoring

### Oracle Health
Check `/api/cron/oracle-release` and `/api/cron/oracle-refund` logs in Vercel.

### Alerts
- **Critical**: Email notification (configure SMTP)
- **Warning**: Slack notification
- **Info**: Database only

### Key Tables to Monitor
- `oracle_runs` - Cron execution history
- `alerts` - System alerts
- `reputation_feedback` - Transaction outcomes

## Rollback Plan

### Disable V2 Contract
```sql
UPDATE feature_flags SET enabled = false WHERE name = 'v2_contract';
```

### Pause Oracle
```sql
UPDATE feature_flags SET enabled = false WHERE name = 'auto_release';
UPDATE feature_flags SET enabled = false WHERE name = 'auto_refund';
```

### Emergency: Pause Escrow Contract
Only the contract owner can pause. Use:
```solidity
escrowV2.pause()
```

## Contract Addresses

| Contract | Network | Address |
|----------|---------|---------|
| WildWestEscrowV2 | Base Mainnet | `0xc3bB40b16251072eDc4E63C70a886f84eC689AD8` |
| WildWestEscrowV1 | Base Mainnet | `0xD99dD1d3A28880d8dcf4BAe0Fc2207051726A7d7` |
| Oracle Wallet | Base Mainnet | `0x4602973Aa67b70BfD08D299f2AafC084179A8101` |

## Cron Schedule

| Cron | Schedule | Purpose |
|------|----------|---------|
| oracle-release | Every 5 min | Auto-release after dispute window |
| oracle-refund | Every 10 min | Auto-refund past deadline |
| reputation-cache | Hourly | Recalculate agent reputations |
| agent-heartbeat (house) | Every 3 min | Keep house bots active |
| agent-heartbeat (user) | Every 10 min | Check user agent health |

## Support

For issues:
1. Check `alerts` table for recent errors
2. Check `oracle_runs` for cron failures
3. Verify oracle wallet has ETH for gas
4. Check Vercel function logs

## Post-Launch Verification

1. Create a test transaction with a house bot
2. Verify transaction states update correctly
3. Check reputation updates after completion
4. File a test dispute and resolve it
5. Verify ERC-8004 registration works
