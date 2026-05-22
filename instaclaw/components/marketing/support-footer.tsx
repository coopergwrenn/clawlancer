/**
 * SupportFooter — single source of truth for the support contact line.
 *
 * Renders "Need help? help@instaclaw.io" as a `mailto:` link, styled to
 * inherit the surrounding text color so it can drop into any page's
 * footer without explicit theming. Sized as deferential context (12px,
 * 70% opacity by default), upgradable to a slightly bolder treatment
 * via the `prominent` prop for pages where support is itself the
 * primary action surface (e.g., post-failure error states).
 *
 * Why a single component instead of hardcoding the email in each footer:
 * one place to change the help email if we ever rebrand the support
 * inbox. Six surfaces currently mount this; one search-and-replace
 * would otherwise be required across the codebase.
 *
 * 2026-05-22 audit finding F3: support contact (mailto:help@instaclaw.io)
 * previously existed ONLY on /deploying. Every other Edge funnel page
 * left an attendee with no path forward when something failed (Stripe
 * checkout error on /plan, OAuth error on /signin, bot-token error on
 * /connect, etc.). For 1000 hand-selected builders, that's a Day-1
 * reputation gap. This component closes it across all surfaces.
 */
export const SUPPORT_EMAIL = "help@instaclaw.io";

interface SupportFooterProps {
  /**
   * When true, renders with slightly more visual presence (full opacity,
   * underlined by default). Use for error-state surfaces where the
   * support link should be the visible escape hatch. Default is the
   * deferential "context line" treatment.
   */
  prominent?: boolean;
  /**
   * Optional className passed through to the wrapping span. Lets pages
   * with specific layout needs (right-aligned, centered, etc.) wrap
   * the link without re-styling the link itself.
   */
  className?: string;
}

export function SupportFooter({
  prominent = false,
  className = "",
}: SupportFooterProps) {
  return (
    <span className={className}>
      <a
        href={`mailto:${SUPPORT_EMAIL}`}
        className={
          prominent
            ? "underline underline-offset-4 hover:opacity-80 transition-opacity"
            : "underline-offset-4 hover:underline transition-opacity"
        }
        style={{
          color: "inherit",
          opacity: prominent ? 1 : 0.7,
          fontSize: "inherit",
        }}
      >
        Need help? {SUPPORT_EMAIL}
      </a>
    </span>
  );
}
