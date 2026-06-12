import { redirect } from "next/navigation";

/**
 * /billing/credit-packs → /billing (permanent content move, 2026-06-12).
 *
 * Ruled: /billing is the canonical money hub and carries the COMPLETE
 * purchasable catalog (message + media + video + premium-search packs, plan
 * status, portal). This page's former card UI lives there now.
 *
 * REDIRECT, not alias (decided): the link audit found 10+ inbound references
 * — the muapi/sjinn gateway `packs_url` fields, three fleet skills'
 * SKILL.md copy, and the higgsfield-cloud canary SKILL.md — all of which a
 * redirect keeps working forever, while an alias (two pages rendering the
 * same catalog) would be exactly the UI-drift class the shared
 * lib/billing-catalog.ts module exists to kill. Keep this route indefinitely;
 * fleet SKILL.md copy rotates at its own cadence.
 */
export default function CreditPacksRedirect() {
  redirect("/billing");
}
