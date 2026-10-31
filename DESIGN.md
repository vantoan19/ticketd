# ticketd interface design

The desktop workspace borrows the clarity, neutral palette and Geist typography of the [Vercel design guide](https://www.ui-skills.com/design-md/vercel). That guide describes authored reports; ticketd is a working application. Its persistent navigation, dense ticket list and editable detail pane take precedence over report layouts and Vercel branding. Workflows, readable errors and unsaved drafts always take precedence over visual treatment.

## Foundations

- Use locally bundled Geist Sans for interface text and Geist Mono for short ticket references and operational identifiers. Use 13px body text, 11–12px secondary text and 22px page and ticket titles. Keep headings semibold and body text regular or medium.
- Follow the system light or dark preference. Light surfaces range from white to #f5f5f5 with #171717 primary text; dark surfaces range from #0a0a0a to #262626 with #ededed primary text. Use #e5e5e5 light borders and #262626–#404040 dark borders. Muted text is #666666 in light and #a1a1a1 in dark. Primary actions invert the foreground and surface; reserve red for errors.
- Use 1px borders, 5–6px control radii and 8–9px dialog radii. Shadows are reserved for floating surfaces. Avoid gradients, decorative cards and colored navigation accents.
- Controls must show hover, keyboard focus, disabled and selected states. Use a visible focus outline and communicate selection or errors through text or semantics as well as color.

## Workspace composition

Keep navigation compact and persistent, ticket rows aligned for scanning, and the selected ticket alongside the list when space allows. Use spacing and thin dividers to group related information. Maintain clear labels, keyboard access and useful empty, loading and error states. Dialogs should stay focused on one action and preserve existing editing behavior.

The shared semantic variables in `apps/desktop/src/styles.css` are the source of truth: `background` and `surface` distinguish workspace planes; `foreground` and `muted-foreground` establish text hierarchy; `border`, `accent`, `primary`, `ring`, and the error roles describe interaction. Keep shared shadcn controls on those roles. Bundle fonts locally so the workspace remains legible offline. Use the regular and semibold font files at their actual weights.

Use a 4px spacing rhythm, 32–36px controls and approximately 46px ticket rows. Keep the list denser than the detail pane because people repeatedly scan tickets before opening one. Titles lead; references, metadata and supporting text remain subordinate but readable. Avoid text smaller than 11px except nonessential branding. Respect reduced-motion preferences for transitions.

Do align comparable rows and keep actions near their context. Do use labels and visible focus for controls. Don't use color alone for status, add decorative panels to sparse states, or copy Vercel logos. The workspace currently follows the operating system theme rather than providing its own theme switch.

The ticket workspace uses a resizable list and detail split with a keyboard-accessible divider. Expanding a ticket keeps the list and its scroll position in place for return; on narrow windows the list and detail take turns in the main area. Keep detail drafts mounted during these presentation changes.
