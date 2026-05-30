/**
 * The Floor — the page (docs/prd/the-floor.md).
 *
 * Watch your agent work in real time. Sits under the (dashboard) group, so the
 * dashboard layout + the activity endpoint's own `auth()` gate ownership: the
 * feed only ever returns the logged-in user's own agent.
 *
 * Thin by design — all behavior lives in <FloorView> (client), which runs the
 * engine and mounts the R3F canvas (dynamic, ssr:false).
 */

import { FloorView } from "@/components/floor/floor-view";

export const metadata = {
  title: "The Floor · InstaClaw",
  description: "Watch your AI agent work, live.",
};

export default function FloorPage() {
  return <FloorView />;
}
