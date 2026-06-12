/**
 * Failure-mode tests for lib/higgsfield-upload.ts pure helpers (build order
 * §6, Rule 31). Magic-byte sniffing (incl. hostile inputs), object-name
 * round-trip, and the cleanup-ordering invariant the 48h TTL relies on.
 *
 * Usage: npx tsx scripts/_test-higgsfield-upload.ts
 */
import { sniffImageType, buildObjectName, parseObjectEpoch } from "../lib/higgsfield-upload";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${detail}`); }
}

console.log("— sniffImageType —");
check("JPEG", sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])) === "jpg");
check("PNG", sniffImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])) === "png");
check("WEBP", sniffImageType(Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 2, 3, 4]), Buffer.from("WEBP")])) === "webp");
check("GIF rejected", sniffImageType(Buffer.from("GIF89a....")) === null);
check("PDF rejected", sniffImageType(Buffer.from("%PDF-1.4")) === null);
check("HTML rejected (SSRF-ish payload)", sniffImageType(Buffer.from("<html><script>")) === null);
check("MP4 rejected", sniffImageType(Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypisom")])) === null);
check("empty rejected", sniffImageType(Buffer.alloc(0)) === null);
check("1-byte rejected", sniffImageType(Buffer.from([0xff])) === null);
check("truncated PNG header rejected", sniffImageType(Buffer.from([0x89, 0x50, 0x4e])) === null);
check("RIFF-but-WAVE rejected", sniffImageType(Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 2, 3, 4]), Buffer.from("WAVE")])) === null);

console.log("— object names: build → parse round-trip + chronological sort —");
const t1 = 1781300000000, t2 = 1781300000001;
const n1 = buildObjectName("4922f655-f0c1-4161-b8ff-79b24e1a3166", "jpg", t1, "abc123def456");
const n2 = buildObjectName("4922f655-f0c1-4161-b8ff-79b24e1a3166", "png", t2, "zzz999");
check("shape", /^src_\d{14}_4922f655_abc123def456\.jpg$/.test(n1), n1);
check("epoch round-trips", parseObjectEpoch(n1) === t1);
check("name order == time order (cleanup invariant)", [n2, n1].sort()[0] === n1);
check("foreign name → null (cleanup skips it)", parseObjectEpoch(".emptyFolderPlaceholder") === null);
check("malformed epoch → null", parseObjectEpoch("src_notanumber_x_y.jpg") === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
