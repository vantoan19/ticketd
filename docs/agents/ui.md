# Interface work

The [design system and shared components](../../DESIGN.md#11-design-system-and-shared-components) define how ticketd looks. For a screen change, start with its section, such as [ticket detail](../../DESIGN.md#7-ticket-detail) or [first run](../../DESIGN.md#16-first-run). Every screen is built from two sources of truth:

- **Tokens:** the token blocks in `apps/desktop/src/styles.css`, covering colors, type, radii, and shadows in light and dark.
- **Components:** `apps/desktop/src/components/ui`, shadcn/ui copies restyled with the tokens.

## Steps

1. **Find the component.** Search `components/ui` for one that covers the need and use its variants and sizes. When one almost fits, extend it with a variant (section 11 says when a variant is right). When none fits, build the piece inside the feature; it moves into `components/ui` on its second real use.
2. **Style with tokens.** Take every color, radius, shadow, and font size from a token, and keep feature stylesheets to layout: position, size, spacing, and grid. When no token covers a role, ask the user before adding one.
3. **Check.** Run `./scripts/check` and apply the fixes its lint messages name. Then look at the result in the running app in light and dark, against the relevant `DESIGN.md` section, and include before and after screenshots when handing off a visible change.

Done when the check passes with `apps/desktop/eslint-suppressions.json` and the counts in `apps/desktop/src/test/design-tokens.test.ts` unchanged or lower, and the screen has been seen in both themes.

## Existing debt

Code older than these checks carries recorded findings: lint findings in `eslint-suppressions.json`, raw stylesheet values in the counts of `design-tokens.test.ts`. Both only shrink. When a change fixes an old finding, prune it in the same change: run `npx eslint --prune-suppressions` in `apps/desktop`, or lower the count.
