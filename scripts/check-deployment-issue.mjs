#!/usr/bin/env node
/**
 * Check deployment issue for user
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false }
});

const email = 'coopergrantwrenn@gmail.com';

async function investigate() {
  console.log('🔍 Investigating deployment issue for:', email);
  console.log('');

  // Check user
  const { data: user } = await supabase
    .from('instaclaw_users')
    .select('*')
    .eq('email', email)
    .single();

  if (!user) {
    console.log('❌ User not found');
    return;
  }

  console.log('✅ User found:', user.id);
  console.log('   Name:', user.name);
  console.log('   Created:', user.created_at);
  console.log('');

  // Check pending user
  const { data: pending } = await supabase
    .from('instaclaw_pending_users')
    .select('*')
    .eq('user_id', user.id)
    .single();

  if (pending) {
    console.log('📋 Pending User Record:');
    console.log('   Created at:', pending.created_at);
    console.log('   Tier:', pending.tier);
    console.log('   API Mode:', pending.api_mode);
    console.log('   Stripe Session:', pending.stripe_session_id);
    console.log('');
  } else {
    console.log('ℹ️  No pending user record');
    console.log('');
  }

  // Check VM assignment
  const { data: vm } = await supabase
    .from('instaclaw_vms')
    .select('*')
    .eq('assigned_to', user.id)
    .single();

  if (vm) {
    console.log('🖥️  VM Assignment:');
    console.log('   Status:', vm.status);
    console.log('   Health Status:', vm.health_status);
    console.log('   IP Address:', vm.ip_address);
    console.log('   Gateway URL:', vm.gateway_url || '❌ Not set');
    console.log('   Configure Attempts:', vm.configure_attempts || 0);
    console.log('   Assigned at:', vm.assigned_at);
    console.log('   Last health check:', vm.last_health_check || 'Never');
    console.log('');
  } else {
    console.log('❌ No VM assigned to user');
    console.log('');
  }

  // Check available VMs in pool
  const { data: readyVMs, count: readyCount } = await supabase
    .from('instaclaw_vms')
    .select('*', { count: 'exact' })
    .eq('status', 'ready');

  console.log('📊 VM Pool Status:');
  console.log('   Available VMs (ready):', readyCount);
  console.log('');

  if (readyVMs && readyVMs.length > 0) {
    console.log('   Ready VMs:');
    readyVMs.forEach(v => {
      console.log(`   - ${v.ip_address} (${v.region || 'unknown region'})`);
    });
    console.log('');
  }

  // Check all VMs status
  const { data: allVMs } = await supabase
    .from('instaclaw_vms')
    .select('status')
    .order('created_at', { ascending: false });

  if (allVMs) {
    const statusCounts = allVMs.reduce((acc, vm) => {
      acc[vm.status] = (acc[vm.status] || 0) + 1;
      return acc;
    }, {});

    console.log('📈 All VMs by Status:');
    Object.entries(statusCounts).forEach(([status, count]) => {
      console.log(`   ${status}: ${count}`);
    });
    console.log('');
  }

  // Diagnosis
  console.log('🔬 Diagnosis:');
  if (!vm) {
    if (readyCount === 0) {
      console.log('   ⚠️  ISSUE: No VMs available in the pool');
      console.log('   → Need to provision more VMs');
    } else {
      console.log('   ⚠️  ISSUE: VM not assigned despite available VMs');
      console.log('   → Check Stripe webhook or assignment logic');
    }
  } else if (vm.status === 'assigned' && !vm.gateway_url) {
    console.log('   ⚠️  ISSUE: VM assigned but configuration not started');
    console.log('   → Configure script may not have been triggered');
    console.log('   → Try manual retry: POST /api/vm/retry-configure');
  } else if (vm.health_status === 'configure_failed') {
    console.log('   ⚠️  ISSUE: Configuration script failed');
    console.log('   → Check VM logs for errors');
    console.log('   → Configure attempts:', vm.configure_attempts || 0);
  }
}

investigate().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
