import type { EdgeUserState } from "./edge-user-state";

/**
 * Single source of truth for the state-driven "primary CTA" used in the
 * nav and the hero overlay. Centralizing it here keeps the SSR-resolved
 * userState wired in one place, so we never get a flash of the wrong CTA
 * shape on hydration.
 */
export interface HeaderCta {
  href: string;
  label: string;
  external: boolean;
}

export function deriveHeaderCta(state: EdgeUserState): HeaderCta {
  if (state.kind === "live") {
    return {
      href: `https://t.me/${state.botUsername}`,
      label: "Open agent",
      external: true,
    };
  }
  if (state.kind === "in_progress") {
    return {
      href: state.resumePath,
      label: "Complete setup",
      external: false,
    };
  }
  return { href: "#claim", label: "Set up your agent", external: false };
}
