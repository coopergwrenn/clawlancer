/**
 * Ingest Edge Esmeralda 2026 attendees from a CSV (Timour's ticket export).
 *
 * Usage:
 *   tsx scripts/_ingest-edge-attendees.ts <path-to-csv> [--dry-run]
 *
 * Idempotent — running on the same CSV twice is a no-op. Running on an
 * updated CSV adds the new rows. Never deletes anyone (a refunded
 * attendee disappearing from a re-export is an ops decision, not an
 * automatic drop).
 *
 * Pipeline:
 *   1. Read + parse CSV (RFC 4180-compatible inline parser).
 *   2. Auto-detect header row: if the first row contains "@" anywhere
 *      we assume no header; otherwise the first row IS the header.
 *   3. Locate email column (case-insensitive header substring match).
 *      Locate ticket_id column similarly. Both optional except email.
 *   4. Normalize each row: lowercase + trim email. Drop rows with no @.
 *      Within-CSV dedup keyed on normalized email — first occurrence
 *      wins.
 *   5. Upsert into instaclaw_edge_attendees on conflict by email. Never
 *      clobber a non-null ticket_id with a new value (could indicate
 *      data drift — surface in a separate audit, not silent overwrite).
 *   6. Backfill link: for every attendee whose email matches an existing
 *      instaclaw_users row, flip users.is_edge_attendee=true AND stamp
 *      attendees.user_id + claimed_at. Race-safe (guards on .is(null)).
 *   7. Print summary.
 *
 * Env: loads .env.local for NEXT_PUBLIC_SUPABASE_URL +
 * SUPABASE_SERVICE_ROLE_KEY. No SSH, so .env.ssh-key is not needed
 * (Rule 18 doesn't apply here).
 */

import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { resolve } from "path";
import { readFileSync, statSync } from "fs";

config({ path: resolve(process.cwd(), ".env.local") });

// ─── CSV parsing ──────────────────────────────────────────────────────────

function parseCsv(text: string): string[][] {
  // RFC 4180-compatible: quoted fields, embedded commas, embedded
  // newlines inside quotes, escaped quotes ("").
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        field += c;
        i++;
      }
    } else if (c === '"') {
      inQuotes = true;
      i++;
    } else if (c === ",") {
      row.push(field);
      field = "";
      i++;
    } else if (c === "\n" || c === "\r") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      if (c === "\r" && text[i + 1] === "\n") i += 2;
      else i++;
    } else {
      field += c;
      i++;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

// Pick the column index whose header matches the FIRST needle (in priority
// order) anywhere. Iterates needles outer, headers inner — so "ticket_id"
// is preferred over "order id" if both happen to be present.
function pickColumn(headers: string[], ...needles: string[]): number {
  const lowered = headers.map((h) => h.toLowerCase());
  for (const needle of needles) {
    for (let i = 0; i < lowered.length; i++) {
      if (lowered[i].includes(needle)) return i;
    }
  }
  return -1;
}

interface IngestRow {
  email: string;
  ticket_id: string | null;
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const csvPath = args.find((a) => !a.startsWith("--"));

  if (!csvPath) {
    console.error(
      "Usage: tsx scripts/_ingest-edge-attendees.ts <csv-path> [--dry-run]"
    );
    process.exit(1);
  }

  let csvText: string;
  try {
    const stat = statSync(csvPath);
    if (!stat.isFile()) throw new Error("not a regular file");
    csvText = readFileSync(csvPath, "utf-8");
  } catch (err) {
    console.error(
      `Cannot read CSV at ${csvPath}: ${err instanceof Error ? err.message : err}`
    );
    process.exit(1);
  }

  // Strip UTF-8 BOM that Excel and some exporters add.
  if (csvText.charCodeAt(0) === 0xfeff) csvText = csvText.slice(1);

  const allRows = parseCsv(csvText);
  if (allRows.length === 0) {
    console.error("CSV parsed to zero rows.");
    process.exit(1);
  }

  // ── Header detection ──
  const firstRow = allRows[0];
  const firstRowHasEmail = firstRow.some((cell) => cell.includes("@"));
  const hasHeader = !firstRowHasEmail;

  let emailColIdx: number;
  let ticketColIdx: number;
  let dataRows: string[][];

  if (hasHeader) {
    emailColIdx = pickColumn(firstRow, "email");
    ticketColIdx = pickColumn(
      firstRow,
      "ticket_id",
      "ticket id",
      "ticket #",
      "ticket no",
      "order id",
      "order_id"
    );
    if (emailColIdx === -1) {
      console.error(
        `Header row detected but no email column found. Headers: ${firstRow.join(" | ")}`
      );
      process.exit(1);
    }
    dataRows = allRows.slice(1);
    console.log(
      `Detected header row. Email column [${emailColIdx}] = "${firstRow[emailColIdx]}". Ticket column ${
        ticketColIdx === -1
          ? "(none — emails only)"
          : `[${ticketColIdx}] = "${firstRow[ticketColIdx]}"`
      }`
    );
  } else {
    emailColIdx = firstRow.findIndex((cell) => cell.includes("@"));
    if (emailColIdx === -1) {
      console.error("No header and no @ in first row. CSV format unrecognized.");
      process.exit(1);
    }
    ticketColIdx = -1;
    dataRows = allRows;
    console.log(
      `No header row. Assuming column [${emailColIdx}] is email. No ticket_id column.`
    );
  }

  // ── Normalize + dedup ──
  const seen = new Set<string>();
  const rows: IngestRow[] = [];
  let dropped = 0;
  for (const r of dataRows) {
    const raw = (r[emailColIdx] ?? "").trim();
    if (!raw) {
      dropped++;
      continue;
    }
    const normalized = raw.toLowerCase();
    if (!normalized.includes("@") || !normalized.includes(".")) {
      dropped++;
      continue;
    }
    if (seen.has(normalized)) {
      dropped++;
      continue;
    }
    seen.add(normalized);
    const ticket =
      ticketColIdx >= 0 ? (r[ticketColIdx] ?? "").trim() || null : null;
    rows.push({ email: normalized, ticket_id: ticket });
  }

  console.log(
    `Parsed ${allRows.length} CSV rows → ${rows.length} unique attendees (${dropped} dropped: empty, malformed, or duplicate).`
  );

  if (rows.length === 0) {
    console.error("No valid attendee emails to ingest.");
    process.exit(1);
  }

  if (dryRun) {
    console.log("\n--dry-run set. Sample (first 5):");
    for (const r of rows.slice(0, 5)) {
      console.log(
        `  ${r.email}${r.ticket_id ? `   [ticket=${r.ticket_id}]` : ""}`
      );
    }
    console.log("\nDry-run complete. No DB writes.");
    return;
  }

  // ─── DB phase ───────────────────────────────────────────────────────────

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    console.error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local"
    );
    process.exit(1);
  }
  const sb = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  // Snapshot existing attendees to compute deltas before writing.
  const { data: preExisting, error: preErr } = await sb
    .from("instaclaw_edge_attendees")
    .select("email, ticket_id");
  if (preErr) {
    console.error("Failed to read existing attendees:", preErr.message);
    process.exit(1);
  }
  const existingByEmail = new Map<string, { ticket_id: string | null }>();
  for (const r of preExisting ?? []) {
    existingByEmail.set(r.email as string, {
      ticket_id: (r.ticket_id as string | null) ?? null,
    });
  }

  let newCount = 0;
  let ticketBackfillCount = 0;
  let unchangedCount = 0;
  for (const r of rows) {
    const existing = existingByEmail.get(r.email);
    if (!existing) newCount++;
    else if (existing.ticket_id === null && r.ticket_id !== null) ticketBackfillCount++;
    else unchangedCount++;
  }

  console.log(
    `Plan: ${newCount} new attendees, ${ticketBackfillCount} ticket_id backfills, ${unchangedCount} unchanged.`
  );

  // ── Upsert in chunks ──
  // Never clobber a non-null ticket_id (defensive — could indicate Timour
  // shipped a CSV with different ticket numbering and we shouldn't silently
  // overwrite the existing record).
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const payload = chunk.map((r) => {
      const existing = existingByEmail.get(r.email);
      const finalTicket =
        existing && existing.ticket_id !== null
          ? existing.ticket_id
          : r.ticket_id;
      return { email: r.email, ticket_id: finalTicket };
    });
    const { error: upErr } = await sb
      .from("instaclaw_edge_attendees")
      .upsert(payload, { onConflict: "email", ignoreDuplicates: false });
    if (upErr) {
      console.error(
        `Upsert chunk rows ${i}-${i + chunk.length} failed:`,
        upErr.message
      );
      process.exit(1);
    }
  }
  console.log(`✓ Upserted ${rows.length} attendee rows.`);

  // ─── Backfill: link existing users ──────────────────────────────────────
  // Users who signed up BEFORE the CSV landed need their is_edge_attendee
  // flag flipped and their attendees row stamped now that we have ground
  // truth. The signIn callback handles the inverse case (CSV landed first,
  // user signs up later).

  const emails = rows.map((r) => r.email);
  const FILTER_CHUNK = 200;
  const matchingUsers: { id: string; email: string }[] = [];
  for (let i = 0; i < emails.length; i += FILTER_CHUNK) {
    const slice = emails.slice(i, i + FILTER_CHUNK);
    // .select("*") per Rule 19 — column-grant misconfig could otherwise
    // return id=null silently, causing downstream UPDATEs to no-op.
    const { data: matches, error: matchErr } = await sb
      .from("instaclaw_users")
      .select("*")
      .in("email", slice);
    if (matchErr) {
      console.error("User match query failed:", matchErr.message);
      process.exit(1);
    }
    if (matches) {
      matchingUsers.push(
        ...(matches as { id: string; email: string }[]).map((m) => ({
          id: m.id,
          email: m.email,
        }))
      );
    }
  }
  console.log(
    `Found ${matchingUsers.length} existing users whose email matches an attendee.`
  );

  let userFlippedCount = 0;
  let attendeeStampedCount = 0;
  for (const u of matchingUsers) {
    // Flip the users cache — only if currently false (idempotent + cheap)
    const { count: userCount, error: userErr } = await sb
      .from("instaclaw_users")
      .update({ is_edge_attendee: true }, { count: "exact" })
      .eq("id", u.id)
      .eq("is_edge_attendee", false);
    if (userErr) {
      console.error(`Update users for ${u.email} failed:`, userErr.message);
      continue;
    }
    if (userCount && userCount > 0) userFlippedCount++;

    // Stamp the attendees row — only if not already linked (first-write wins)
    const { count: stampCount, error: stampErr } = await sb
      .from("instaclaw_edge_attendees")
      .update(
        { user_id: u.id, claimed_at: new Date().toISOString() },
        { count: "exact" }
      )
      .eq("email", u.email)
      .is("user_id", null);
    if (stampErr) {
      console.error(`Stamp attendee for ${u.email} failed:`, stampErr.message);
      continue;
    }
    if (stampCount && stampCount > 0) attendeeStampedCount++;
  }
  console.log(
    `✓ Flipped is_edge_attendee on ${userFlippedCount} existing users. Stamped ${attendeeStampedCount} attendees rows with user_id + claimed_at.`
  );

  // ─── Summary ────────────────────────────────────────────────────────────
  console.log("\nIngest complete.");
  console.log("─".repeat(60));
  console.log(`  CSV rows parsed:              ${allRows.length}`);
  console.log(`  Unique attendees:             ${rows.length}`);
  console.log(`  Dropped (empty/dup/malformed): ${dropped}`);
  console.log(`  New attendees ingested:       ${newCount}`);
  console.log(`  Ticket_id backfills:          ${ticketBackfillCount}`);
  console.log(`  Unchanged:                    ${unchangedCount}`);
  console.log(`  Existing users linked:        ${userFlippedCount}`);
  console.log(`  Attendees stamped:            ${attendeeStampedCount}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
