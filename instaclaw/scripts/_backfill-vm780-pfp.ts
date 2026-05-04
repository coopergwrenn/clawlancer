/**
 * Backfill bankr_token_image_url on vm-780 for the announcement.
 * Picks the most recent token-images blob owned by Cooper's user_id and
 * points the current Bankr token row at it.
 */
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { resolve } from "path";

config({ path: resolve(process.cwd(), ".env.local") });

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

const COOPER_USER_ID = "0a102415-75e4-4fff-b792-773609c63ff0";
const VM_ID = "a44e8773-1818-4408-8135-21e9208e5601";
const BUCKET = "token-images";

async function main() {
  const { data: files, error } = await sb.storage.from(BUCKET).list("", { limit: 200, sortBy: { column: "created_at", order: "desc" } });
  if (error) { console.error(error); process.exit(1); }
  const cooperFiles = (files ?? []).filter((f) => f.name.startsWith(`${COOPER_USER_ID}_`));
  console.log(`Cooper PFP candidates: ${cooperFiles.length}`);
  for (const f of cooperFiles.slice(0, 5)) console.log(`  ${f.name}  ${f.created_at}`);

  if (cooperFiles.length === 0) {
    console.error("No PFP files found for Cooper. Aborting.");
    process.exit(1);
  }

  const newest = cooperFiles[0];
  const { data: pub } = sb.storage.from(BUCKET).getPublicUrl(newest.name);
  const url = pub.publicUrl;
  console.log(`\nBackfilling vm-780 with: ${url}`);

  const { data: updated, error: upErr } = await sb
    .from("instaclaw_vms")
    .update({ bankr_token_image_url: url })
    .eq("id", VM_ID)
    .select("bankr_token_address, bankr_token_symbol, bankr_token_image_url")
    .single();
  if (upErr) { console.error(upErr); process.exit(1); }
  console.log("\nAFTER:", JSON.stringify(updated, null, 2));
}

main();
