/**
 * GET /api/imessage/vcard
 *
 * Returns an RFC 6350 vCard for our Sendblue line. Used by the
 * "Save Contact" button on /channels (and on the Edge poster) to
 * preempt iMessage's first-contact spam heuristics: when a user has
 * the number saved in their contacts, our outbound messages route
 * through iMessage's normal channel (no Unknown Senders quarantine).
 *
 * Per spec §9 "Spam-filter avoidance, the existential question" —
 * vCard save is the highest-leverage anti-spam mitigation we ship.
 *
 * Public route. No auth, no DB. Heavily cacheable — the content is
 * stable.
 *
 * Format reference: https://datatracker.ietf.org/doc/html/rfc6350
 *
 * Why VERSION 3.0 (not 4.0):
 *   iOS Contacts supports both 3.0 and 4.0, but 3.0 has wider
 *   compatibility (Android, older clients). 4.0's newer features
 *   (KIND, GENDER, ANNIVERSARY) aren't needed here.
 *
 * Filename `instaclaw.vcf` because mobile browsers use the filename
 * to title the "Add Contact" sheet on iOS.
 */

import { NextResponse } from "next/server";

const VCARD_BODY = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  "N:Instaclaw;;;;",
  "FN:Instaclaw",
  "ORG:Instaclaw",
  "TEL;TYPE=CELL,VOICE:+14072425197",
  "URL:https://instaclaw.io",
  "NOTE:Your AI agent. Text to start a conversation.",
  "END:VCARD",
].join("\r\n");

// Cache for 1 year — vCard content is effectively immutable. If we
// ever rotate the Sendblue number, bump the URL (e.g., /api/imessage/vcard/v2)
// or purge via Vercel's deployment cache.
const CACHE_MAX_AGE_SECONDS = 31_536_000;

export function GET() {
  return new NextResponse(VCARD_BODY, {
    status: 200,
    headers: {
      "Content-Type": "text/vcard; charset=utf-8",
      "Content-Disposition": 'attachment; filename="instaclaw.vcf"',
      "Cache-Control": `public, max-age=${CACHE_MAX_AGE_SECONDS}, immutable`,
    },
  });
}
