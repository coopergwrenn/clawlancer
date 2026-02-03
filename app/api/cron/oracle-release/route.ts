/**
 * Oracle Auto-Release Cron
 *
 * Runs every 5 minutes to auto-release escrows after dispute window passes.
 * Per PRD Section 5 (Oracle System):
 * - Checks feature flag before executing
 * - Verifies oracle wallet health
 * - Checks on-chain state via isAutoReleaseReady()
 * - Executes release via oracle wallet
 * - Logs to oracle_runs and creates reputation feedback
 */

import { NextRequest, NextResponse } from 'next/server';
import { createPublicClient, createWalletClient, http } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { createClient } from '@supabase/supabase-js';
import { checkOracleWalletHealth } from '@/lib/oracle/wallet';
import { safeOracleRelease } from '@/lib/oracle/retry';
import { sendAlert } from '@/lib/monitoring/alerts';
import { createReputationFeedback } from '@/lib/erc8004/reputation';
import { uuidToBytes32, ESCROW_V2_ABI } from '@/lib/blockchain/escrow-v2';

const isTestnet = process.env.NEXT_PUBLIC_CHAIN === 'sepolia';
const CHAIN = isTestnet ? baseSepolia : base;
const ESCROW_V2_ADDRESS = process.env.NEXT_PUBLIC_ESCROW_CONTRACT_V2_ADDRESS as `0x${string}`;
const MAX_RELEASES_PER_RUN = 20; // Vercel timeout safety

export async function POST(request: NextRequest) {
  const startTime = Date.now();

  // Verify cron secret
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Check feature flag
  if (process.env.ENABLE_AUTO_RELEASE !== 'true') {
    return NextResponse.json({ message: 'Auto-release disabled via feature flag' });
  }

  // Check oracle wallet health
  const walletHealth = await checkOracleWalletHealth();
  if (!walletHealth.healthy) {
    await sendAlert('critical', 'Oracle wallet critically low — auto-release halted', walletHealth);
    return NextResponse.json({ error: 'Oracle wallet empty' }, { status: 503 });
  }
  if (walletHealth.warningLevel === 'low') {
    await sendAlert('warning', 'Oracle wallet running low', walletHealth);
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // Log run start
  const { data: runRecord } = await supabase
    .from('oracle_runs')
    .insert({
      run_type: 'auto_release',
      started_at: new Date().toISOString()
    })
    .select()
    .single();

  // Find delivered transactions using V2 contract
  const { data: deliveredTxs, error } = await supabase
    .from('transactions')
    .select('*')
    .eq('state', 'DELIVERED')
    .eq('disputed', false)
    .eq('contract_version', 2)
    .not('escrow_id', 'is', null)
    .order('delivered_at', { ascending: true })
    .limit(MAX_RELEASES_PER_RUN);

  if (error) {
    await sendAlert('error', 'Oracle release query failed', { error });
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }

  if (!deliveredTxs || deliveredTxs.length === 0) {
    // Update run record
    if (runRecord) {
      await supabase
        .from('oracle_runs')
        .update({
          completed_at: new Date().toISOString(),
          processed_count: 0,
          success_count: 0,
          failure_count: 0
        })
        .eq('id', runRecord.id);
    }

    return NextResponse.json({ message: 'No transactions to process', processed: 0 });
  }

  const publicClient = createPublicClient({
    chain: CHAIN,
    transport: http(process.env.ALCHEMY_BASE_URL)
  });

  const account = privateKeyToAccount(process.env.ORACLE_PRIVATE_KEY as `0x${string}`);

  const walletClient = createWalletClient({
    account,
    chain: CHAIN,
    transport: http(process.env.ALCHEMY_BASE_URL)
  });

  const results: Array<{ txId: string; status: string; hash?: string; error?: string }> = [];

  for (const tx of deliveredTxs) {
    try {
      // Convert escrow_id to bytes32 if it's a UUID
      const escrowIdBytes32 = tx.escrow_id.startsWith('0x')
        ? tx.escrow_id as `0x${string}`
        : uuidToBytes32(tx.escrow_id);

      // Check if auto-release is ready ON-CHAIN
      const isReady = await publicClient.readContract({
        address: ESCROW_V2_ADDRESS,
        abi: ESCROW_V2_ABI,
        functionName: 'isAutoReleaseReady',
        args: [escrowIdBytes32]
      });

      if (!isReady) {
        results.push({ txId: tx.id, status: 'not_ready' });
        continue;
      }

      // Execute release with retry logic and idempotency check
      const releaseResult = await safeOracleRelease(
        escrowIdBytes32,
        publicClient,
        walletClient,
        ESCROW_V2_ADDRESS
      );

      if (!releaseResult.success) {
        if (releaseResult.alreadyReleased) {
          // Already released on-chain, just update our DB
          results.push({ txId: tx.id, status: 'already_released' });
          await supabase
            .from('transactions')
            .update({ state: 'RELEASED', updated_at: new Date().toISOString() })
            .eq('id', tx.id);
          continue;
        }
        throw new Error(releaseResult.error || 'Release failed');
      }

      const hash = releaseResult.txHash! as `0x${string}`;

      // Wait for confirmation
      await publicClient.waitForTransactionReceipt({ hash });

      // Update transaction state with tx_hash (VERIFIABLE)
      await supabase
        .from('transactions')
        .update({
          state: 'RELEASED',
          release_tx_hash: hash,
          updated_at: new Date().toISOString()
        })
        .eq('id', tx.id);

      // Create reputation feedback (includes tx_hash per Section 1)
      const feedback = createReputationFeedback(
        tx.seller_agent_id,
        tx.id,
        tx.escrow_id,
        tx.price_wei || tx.amount_wei,
        tx.currency || 'USDC',
        'released',
        Math.floor((Date.now() - new Date(tx.created_at).getTime()) / 1000),
        hash,
        tx.deliverable_hash
      );

      await supabase.from('reputation_feedback').insert({
        agent_id: tx.seller_agent_id,
        transaction_id: tx.id,
        rating: feedback.rating,
        context: feedback.context
      });

      // Create feed event
      await supabase.from('feed_events').insert({
        agent_id: tx.buyer_agent_id,
        agent_name: tx.buyer_agent_name,
        related_agent_id: tx.seller_agent_id,
        related_agent_name: tx.seller_agent_name,
        event_type: 'TRANSACTION_RELEASED',
        amount_wei: tx.price_wei || tx.amount_wei,
        currency: tx.currency || 'USDC',
        description: tx.listing_title
      });

      results.push({ txId: tx.id, status: 'released', hash });

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      results.push({ txId: tx.id, status: 'error', error: errorMsg });

      // Increment failure count for retry logic
      await supabase
        .from('transactions')
        .update({
          release_failures: (tx.release_failures || 0) + 1,
          updated_at: new Date().toISOString()
        })
        .eq('id', tx.id);

      // Alert if repeated failures
      if ((tx.release_failures || 0) >= 2) {
        await sendAlert('error', `Release failed 3+ times for ${tx.id}`, { error: errorMsg });
      }
    }
  }

  // Update run record
  const successful = results.filter(r => r.status === 'released').length;
  const failed = results.filter(r => r.status === 'error').length;

  if (runRecord) {
    await supabase
      .from('oracle_runs')
      .update({
        completed_at: new Date().toISOString(),
        processed_count: results.length,
        success_count: successful,
        failure_count: failed,
        metadata: { results, duration_ms: Date.now() - startTime }
      })
      .eq('id', runRecord.id);
  }

  if (failed > 0) {
    await sendAlert('warning', `Oracle release: ${failed} failures out of ${results.length}`, { results });
  }

  return NextResponse.json({
    processed: results.length,
    successful,
    failed,
    duration_ms: Date.now() - startTime,
    results
  });
}

// Support GET for Vercel cron
export async function GET(request: NextRequest) {
  return POST(request);
}

export const runtime = 'nodejs';
export const maxDuration = 60;
