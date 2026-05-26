// Probe instaclaw_pending_users column-by-column NOT NULL status
// by attempting a synthetic INSERT and reading the error. Read-only:
// we wrap in a fake row that will fail every time so nothing is written.
//
// Actually safer: just use the PostgREST OPTIONS to get the column list,
// then a series of explicit INSERTs that drop one column at a time and
// see which ones trigger 23502. Too slow.
//
// Better path: use the supabase-js client which exposes the SQL via
// /rest/v1/. We can hit a Supabase-provided RPC if one exists.
//
// Final path: use the supabase service-role to hit pg-meta via the
// supabase dashboard's REST API. The pgbouncer / pgrest layer doesn't
// expose information_schema directly without a wrapper function.
//
// Use what we have: do a deliberate insert with only the bare-min
// columns, capture the error, fix the column, repeat. This is what
// the deploy will actually do at scale.

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(url, key);

async function tryInsert(row: Record<string, unknown>): Promise<{ ok: boolean; err?: string; code?: string }> {
  const { error } = await sb.from("instaclaw_pending_users").insert(row).select().single();
  if (error) return { ok: false, err: error.message, code: (error as any).code };
  // If we did succeed, immediately delete the row.
  if (typeof row.channel_identity === "string") {
    await sb
      .from("instaclaw_pending_users")
      .delete()
      .eq("channel_identity", row.channel_identity);
  }
  return { ok: true };
}

async function main() {
  // Start with what our handler tries. Same shape as the failure.
  let row: Record<string, unknown> = {
    channel: "imessage",
    channel_identity: "+19999999999",
    short_code: "zz" + Math.floor(Math.random() * 1000000).toString(36).slice(0, 6),
  };

  for (let i = 0; i < 10; i++) {
    const r = await tryInsert(row);
    console.log(`attempt ${i + 1}: ok=${r.ok} code=${r.code ?? "-"} err=${r.err ?? ""}`);
    if (r.ok) { console.log("INSERTED OK with row:", row); return; }
    if (r.code === "23502") {
      // null value in column "X" of relation "Y"
      const m = r.err?.match(/column "([^"]+)"/);
      if (m) {
        const col = m[1];
        // Provide a synthetic value that satisfies the type.
        // Use a sentinel UUID for any column ending _id or named user_id
        if (col === "user_id" || col === "vm_id" || col.endsWith("_id")) {
          row[col] = "00000000-0000-0000-0000-000000000000";
        } else if (col.includes("phone")) {
          row[col] = "+19999999999";
        } else if (col.includes("email")) {
          row[col] = "schema-test@example.com";
        } else if (col.includes("at") || col.includes("expires")) {
          row[col] = new Date(Date.now() + 86400_000).toISOString();
        } else {
          row[col] = "schema-test";
        }
        console.log(`  → adding ${col} =`, row[col]);
      } else {
        console.error("could not parse column name from err:", r.err);
        return;
      }
    } else {
      console.error("unrecognized error code; bailing", r);
      return;
    }
  }
  console.log("exhausted 10 iterations; final row:", row);
}

main();
