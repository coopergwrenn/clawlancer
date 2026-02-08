#!/usr/bin/env node
/**
 * Reset InstaClaw User Account
 *
 * Completely resets a user's InstaClaw account so they can test the onboarding flow from scratch.
 * This will:
 * 1. Reclaim any assigned VM back to the pool
 * 2. Delete all user data (bots, subscriptions, credits, messages cascade automatically)
 * 3. Generate a fresh invite code
 *
 * Usage: node scripts/reset-instaclaw-user.mjs <email>
 */

import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ Missing Supabase environment variables');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false }
});

const email = process.argv[2];

if (!email) {
  console.error('❌ Usage: node scripts/reset-instaclaw-user.mjs <email>');
  process.exit(1);
}

async function resetUser() {
  console.log(`\n🔍 Looking for user: ${email}\n`);

  // 1. Find the user
  const { data: user, error: userError } = await supabase
    .from('instaclaw_users')
    .select('*')
    .eq('email', email)
    .single();

  if (userError || !user) {
    console.log('ℹ️  User not found - account is already clean\n');
    // Generate invite code anyway
    await generateInviteCode();
    return;
  }

  console.log(`✅ Found user: ${user.name || user.email} (ID: ${user.id})\n`);

  // 2. Check for assigned VM
  const { data: vm } = await supabase
    .from('instaclaw_vms')
    .select('*')
    .eq('assigned_to', user.id)
    .single();

  if (vm) {
    console.log(`🖥️  VM assigned: ${vm.ip_address} (${vm.status})`);
    console.log(`   Reclaiming VM back to pool...\n`);

    // Reclaim the VM
    const { error: reclaimError } = await supabase.rpc('instaclaw_reclaim_vm', {
      p_user_id: user.id
    });

    if (reclaimError) {
      console.error('⚠️  Warning: Could not reclaim VM:', reclaimError.message);
    } else {
      console.log('✅ VM reclaimed and reset to provisioning state\n');
    }
  } else {
    console.log('ℹ️  No VM assigned\n');
  }

  // 3. Delete pending user record if exists
  const { error: pendingError } = await supabase
    .from('instaclaw_pending_users')
    .delete()
    .eq('user_id', user.id);

  if (pendingError) {
    console.error('⚠️  Warning: Could not delete pending user:', pendingError.message);
  }

  // 4. Delete related records manually (in correct order to avoid FK constraints)
  console.log('🗑️  Deleting user account and all related data...\n');

  // Delete subscriptions first
  await supabase
    .from('instaclaw_subscriptions')
    .delete()
    .eq('user_id', user.id);

  // Delete credits
  await supabase
    .from('instaclaw_credits')
    .delete()
    .eq('user_id', user.id);

  // Delete messages through bots
  const { data: bots } = await supabase
    .from('instaclaw_bots')
    .select('id')
    .eq('user_id', user.id);

  if (bots && bots.length > 0) {
    for (const bot of bots) {
      await supabase
        .from('instaclaw_messages')
        .delete()
        .eq('bot_id', bot.id);
    }
  }

  // Delete bots
  await supabase
    .from('instaclaw_bots')
    .delete()
    .eq('user_id', user.id);

  // Finally delete the user
  const { error: deleteError } = await supabase
    .from('instaclaw_users')
    .delete()
    .eq('id', user.id);

  if (deleteError) {
    console.error('❌ Error deleting user:', deleteError.message);
    process.exit(1);
  }

  console.log('✅ User account deleted successfully\n');

  // 5. Generate fresh invite code
  await generateInviteCode();
}

async function generateInviteCode() {
  // Generate a random 12-character invite code (XXXX-XXXX-XXXX format)
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 12; i++) {
    if (i > 0 && i % 4 === 0) code += '-';
    code += chars[crypto.randomInt(chars.length)];
  }

  const { data: invite, error: inviteError } = await supabase
    .from('instaclaw_invites')
    .insert({
      code,
      email,
      max_uses: 1,
      is_active: true,
      created_by: 'reset-script'
    })
    .select()
    .single();

  if (inviteError) {
    console.error('❌ Error creating invite code:', inviteError.message);
    process.exit(1);
  }

  console.log('🎟️  Fresh invite code generated:\n');
  console.log(`   ${invite.code}\n`);
  console.log('✨ Account reset complete! You can now test the onboarding flow from scratch.\n');
}

resetUser().catch(err => {
  console.error('❌ Unexpected error:', err);
  process.exit(1);
});
