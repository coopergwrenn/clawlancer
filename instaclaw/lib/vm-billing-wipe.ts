/**
 * Per-user VIDEO-BILLING state to clear whenever a VM leaves its user
 * (release / reclaim / pool-return / dead-VM reassign).
 *
 * Finding 2 (video-plan pre-build audit, 2026-06-12): the pool-return wipe
 * surfaces cleared tokens/partner/etc. but NOT video_credit_balance — a
 * recycled VM carried the prior user's video credits to its next assignee.
 * (Message credit_balance was saved only by the assign path overwriting it.)
 * The five plan columns would have inherited the same hole.
 *
 * ONE definition, spread into EVERY wipe surface — grep for
 * VIDEO_BILLING_WIPE_FIELDS to enumerate them; a wipe site that builds its
 * field list by hand instead of spreading this is the regression.
 *
 * NOT wipe surfaces (deliberately excluded — both verified 2026-06-12):
 *   - health-check's duplicate-token "loser" clear: the VM is STILL ASSIGNED
 *     to its user; zeroing here would steal their balance.
 *   - health-check's token-migration old-VM clear: it only moves the bot
 *     token; the VM's actual release happens elsewhere (which wipes).
 *
 * Plan-column note: the user's NEXT grant self-heals onto whatever VM they
 * hold at the cycle boundary (webhooks resolve user → current VM); wiping
 * here only drops the in-period remainder — the same accepted wart as every
 * per-VM balance, documented in the architecture report.
 */
export const VIDEO_BILLING_WIPE_FIELDS = {
  video_credit_balance: 0,
  video_plan_stripe_sub_id: null,
  video_plan_status: null,
  video_plan_allowance_remaining: 0,
  video_plan_period_end: null,
  video_plan_last_invoice_id: null,
} as const;
