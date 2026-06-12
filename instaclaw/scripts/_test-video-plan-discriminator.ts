/**
 * Discrimination-gate tests (spread row 1, Rule 31). Pure functions — run
 * anywhere, no DB, no migration dependency.
 *
 * THE DISCRIMINATION STANDARD: over-match is as dangerous as under-match.
 * A platform sub classified video → platform dunning silently skipped.
 * A video sub classified platform → the Finding-1 catastrophe set.
 * Both directions get hostile cases.
 *
 * Usage: npx tsx scripts/_test-video-plan-discriminator.ts
 */
import {
  isVideoPlanSubscription,
  isVideoPlanInvoice,
  mapPlanStatus,
  type SubLike,
  type InvoiceLike,
} from "../lib/video-plan";

const PLAN_PRICE = "price_1ThWB9CsyFRN0uBDadGzXEGU";
const PLATFORM_PRICE = "price_PLATFORM_PRO_FAKE";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${detail}`); }
}

async function main() {
  console.log("— isVideoPlanSubscription —");
  // True positives
  check("metadata marker → video", isVideoPlanSubscription(
    { metadata: { plan_type: "video_creator_plan" } }, PLAN_PRICE));
  check("price-id match → video (admin-created, no metadata)", isVideoPlanSubscription(
    { items: { data: [{ price: { id: PLAN_PRICE } }] } }, PLAN_PRICE));
  check("multi-item, plan price second → video", isVideoPlanSubscription(
    { items: { data: [{ price: { id: PLATFORM_PRICE } }, { price: { id: PLAN_PRICE } }] } }, PLAN_PRICE));
  // True negatives (the platform-sub-must-NEVER-match direction)
  check("platform sub (tier price, no metadata) → NOT video", !isVideoPlanSubscription(
    { items: { data: [{ price: { id: PLATFORM_PRICE } }] } }, PLAN_PRICE));
  check("platform sub with UNRELATED metadata → NOT video", !isVideoPlanSubscription(
    { metadata: { plan_type: "something_else" }, items: { data: [{ price: { id: PLATFORM_PRICE } }] } }, PLAN_PRICE));
  check("prefix-similar price id → NOT video (exact equality only)", !isVideoPlanSubscription(
    { items: { data: [{ price: { id: PLAN_PRICE + "X" } }] } }, PLAN_PRICE));
  check("empty sub → NOT video", !isVideoPlanSubscription({}, PLAN_PRICE));
  check("null sub → NOT video", !isVideoPlanSubscription(null, PLAN_PRICE));
  check("env missing (no price id) + no metadata → NOT video", !isVideoPlanSubscription(
    { items: { data: [{ price: { id: PLAN_PRICE } }] } }, undefined));
  check("env missing + metadata marker → STILL video (belt+suspenders)", isVideoPlanSubscription(
    { metadata: { plan_type: "video_creator_plan" } }, undefined));

  console.log("— isVideoPlanInvoice —");
  const neverRetrieve = async () => { throw new Error("retrieve must not be called"); };
  check("line price match → video (no retrieve)", await isVideoPlanInvoice(
    { lines: { data: [{ price: { id: PLAN_PRICE } }] } } as InvoiceLike, PLAN_PRICE, neverRetrieve));
  check("subscription_details metadata → video (no retrieve)", await isVideoPlanInvoice(
    { subscription_details: { metadata: { plan_type: "video_creator_plan" } } } as InvoiceLike, PLAN_PRICE, neverRetrieve));
  check("platform invoice (tier line) → NOT video (no retrieve)", !(await isVideoPlanInvoice(
    { lines: { data: [{ price: { id: PLATFORM_PRICE } }] } } as InvoiceLike, PLAN_PRICE, neverRetrieve)));
  check("bare invoice, sub retrieve resolves video → video", await isVideoPlanInvoice(
    { subscription: "sub_x" } as InvoiceLike, PLAN_PRICE,
    async () => ({ metadata: { plan_type: "video_creator_plan" } } as SubLike)));
  const platformResolved = await isVideoPlanInvoice(
    { subscription: "sub_x" } as InvoiceLike, PLAN_PRICE,
    async () => ({ items: { data: [{ price: { id: PLATFORM_PRICE } }] } } as SubLike),
  );
  check("bare invoice, sub retrieve resolves platform → NOT video", !platformResolved);
  // THE FAIL-CLOSED-FOR-THE-PLATFORM direction: retrieve blows up → platform.
  check("retrieve failure → NOT video (platform dunning preserved)", !(await isVideoPlanInvoice(
    { subscription: "sub_x" } as InvoiceLike, PLAN_PRICE,
    async () => { throw new Error("stripe down"); })));
  check("no sub, no lines, no metadata → NOT video", !(await isVideoPlanInvoice(
    {} as InvoiceLike, PLAN_PRICE, neverRetrieve)));

  console.log("— mapPlanStatus (the F4 freeze switch) —");
  check("active → active", mapPlanStatus("active") === "active");
  check("past_due → past_due (FREEZES)", mapPlanStatus("past_due") === "past_due");
  check("unpaid → past_due (FREEZES)", mapPlanStatus("unpaid") === "past_due");
  check("canceled → canceled", mapPlanStatus("canceled") === "canceled");
  check("incomplete → canceled (never grants access pre-payment)", mapPlanStatus("incomplete") === "canceled");
  check("undefined → canceled (fail-frozen)", mapPlanStatus(undefined) === "canceled");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
