/**
 * The ways to support ticketd, defined once. The About page shows them as
 * cards; the finished Set up ticketd page reuses these values.
 *
 * `.github/FUNDING.yml` holds the same Buy me a coffee name for GitHub's
 * Sponsor button, and `support-links.test.ts` fails when the two disagree.
 */

export const REPOSITORY_URL = "https://github.com/vantoan19/ticketd";

/**
 * The maintainer's Buy me a coffee name, the part after
 * `https://buymeacoffee.com/`. Empty until the maintainer gives it: while it
 * is empty the Buy me a coffee card and its funding entry do not show.
 * Fill it in here and in `.github/FUNDING.yml` (`buy_me_a_coffee:`).
 */
export const BUY_ME_A_COFFEE_NAME: string = "";

/** The maintainer's Buy me a coffee page, or null while there is no name. */
export const BUY_ME_A_COFFEE_URL: string | null = BUY_ME_A_COFFEE_NAME
  ? `https://buymeacoffee.com/${BUY_ME_A_COFFEE_NAME}`
  : null;
