# ticketd interface design

## Purpose and authority

This document defines the target visual and interaction design for ticketd's desktop application and the design system it is built from (section 11). It is a specification for design work and review; the current interface is not evidence that these rules have been implemented. Dimensions are logical CSS pixels at 100% zoom. Minimum heights must grow for wrapped text and accessibility settings.

Use [GLOSSARY.md](GLOSSARY.md) for domain language, [the product specification](docs/mvp-spec.md) for behavior, and [the architecture](docs/architecture.md) for technical boundaries. This guide defines how those behaviors are presented. It does not add accounts, collaboration, or a board. The experimental native Chat screens (product specification section 21) are off by default and follow this guide’s tokens and components; their layout is specified in section 15. For tickets owned by an external source, starting with GitHub Issues ([#98](https://github.com/vantoan19/ticketd/issues/98)), it defines how ownership, freshness, and source content are presented; that issue defines the synchronization behavior. Track implementation and deviations in GitHub Issues, not in this document.

### Reference and adaptation

The visual reference is the third-party [Vercel design language analysis by design-bites](https://github.com/educlopez/design-bites/blob/main/design-mds/vercel.com/DESIGN.md). Use its published numeric values for the light palette, type scale, control sizes, spacing scale, radii, focus treatment, and elevation. It is a third-party observation rather than an official Vercel specification. The tables below distinguish those source values from ticketd-specific layout assignments and dark-theme extensions.

Use a Linear-style issue workspace with the Vercel palette and components. Ticketd needs its own application composition: a persistent workspace, a scan-friendly ticket list, a readable document, and reliable editing feedback. Map the reference roles onto these application surfaces without inventing replacement token values. Ticketd uses an explicit compact application heading of 24px/32px with weight 600 and -0.6px tracking. This is a ticketd density adaptation, not a value copied from the reference. The 32/40 display role is reserved for expanded titles and first run. Workspace pane widths and responsive transitions are ticketd layout decisions. Vercel branding does not belong in this workspace. Use the reference’s shadow boundaries and spacing-led grouping.

The workspace structure also borrows interaction patterns that Linear, GitHub Issues, and Orca share: a ticket list grouped by status, a wrapping property bar above the document, an external issue’s description shown as a read-only source card, and its comments and events on one connected timeline. Borrow these structures, not those products’ styling or branding.

## 1. Visual character and hierarchy

The interface should feel composed, legible, and predictable. A person should identify the current view, selected ticket, status, and next action without inspecting a collection of equally prominent controls.

Use three levels of emphasis:

1. **Work content:** ticket titles, descriptions, updates, and meaningful results. These have the strongest text contrast and the largest share of the screen.
2. **Context:** status, project, Plan, relationships, and evidence. These stay readable and close to the content they describe.
3. **Operations:** follow, reminder configuration, filters, editing controls, and administrative actions. These have compact triggers and reveal their forms when requested.

Visual simplicity must not erase useful information. Existing prerequisites, duplicate links, evidence, and scheduled reminders need visible summaries. Hiding everything behind accordions is not an acceptable substitute for hierarchy.

### Composition rules

- Establish grouping with alignment and spacing first. Use a shadow boundary where navigation or independently scrolling planes meet. Separate document sections with spacing.
- Use flat document sections. Do not wrap each property, empty state, or relationship type in its own card. Use cards sparingly: the read-only description from an external source is the one card on a ticket. Comments, updates and evidence are rows on the page, not cards (see Documents and activity).
- Give each action surface one primary action. The workspace's New ticket action and a focused dialog's submit action may coexist.
- Keep headings, body text, inputs, and section actions on consistent left and right edges.
- Keep small supporting text readable. Do not use low contrast, tiny text, or excessive truncation to make a screen seem cleaner.
- Avoid repeated toolbars, duplicate headings, decorative gradients, large status fills, and animations that move the work under the pointer.

## 2. Color system

### Reference light palette

These values come directly from the linked reference. The semantic names map them to ticketd; do not substitute approximate grays or another blue.

| Role / token                                  | Reference value       | Ticketd use                                  |
| --------------------------------------------- | --------------------- | -------------------------------------------- |
| Canvas / `--background`                       | `#FAFAFA`             | Workspace canvas and navigation              |
| Elevated / `--surface`, `--popover`           | `#FFFFFF`             | Content panel, menus, dialogs                |
| Row hover / `--hover`                         | `#F7F7F7`             | Hover on selectable rows and cards           |
| Recessed / `--recessed`                       | `#F2F2F2`             | Quiet control surfaces and placeholders      |
| Primary text / `--foreground`                 | `#171717`             | Titles, authored content, active values      |
| Secondary text / `--muted-foreground`         | `#4D4D4D`             | Navigation, labels, readable captions        |
| Decorative/disabled / `--disabled-foreground` | `#6B6B6B`             | Disabled labels and placeholders             |
| Selection / `--accent`                        | `#EBEBEB`             | Selection, current navigation, control hover |
| Tooltip / `--tooltip`, `--tooltip-foreground` | `#171717` / `#FFFFFF` | The tooltip chip                             |
| Interactive / `--interactive`, `--ring`       | `#0072F5`             | Focus, link decoration, interactive accents  |
| Input focus / `--input-focus`                 | `#005FCC`             | Input focus outline                          |
| Boundary / `--shadow-border-base`             | `0 0 0 1px #00000014` | Shadow-based surface boundary                |
| Header boundary / `--header-boundary`         | `0 1px 0 0 #0000001A` | Pane header separator                        |

`--muted` and `--secondary` are shadcn aliases of `--recessed` and `--secondary-foreground` of `--muted-foreground`; new code uses the semantic names. `--popover` is `--surface` in light and one step above it in dark, so menus, popovers, selects and command lists never share the panel's fill; dialogs and sheets stay on `--surface` over their scrim. Use `#4D4D4D` for necessary small text, including timestamps. The reference’s `#8F8F8F` is not a readable-body-text substitute; disabled labels use `#6B6B6B` (5.3:1 on white) because they stay readable without opacity dimming. Tooltips are one small dark chip in both themes. If shared components use `muted-foreground` for captions, map it to the secondary text role and keep the decorative/disabled role separate.

Primary actions invert the existing primary/elevated pair: `#171717` fill and `#FFFFFF` text. Ghost actions begin transparent with secondary text and promote to primary text on `#EBEBEB` hover. Standard prose links may retain primary text with an underline, as in the reference’s standard-link treatment; use the blue token for focus and link decoration. Never reduce contrast merely to make all links blue. Source links use the accessible text-link role `--link-foreground`: `#005FCC` in light and `#52AEFF` in dark; focus and decorative interactive accents keep their existing tokens. Recessed notices and footer bands retain a shadow boundary when their fill alone is too close to the surrounding surface.

The reference also supplies indicator colors: blue `#0062D1`, cyan `#52AEFF`, teal `#45DEC5` / `#067A6E`, green `#398E4A` / `#45A557` / `#6CDA75`, orange `#FF990A`, red `#E5484D`, pink `#EA3E83`, and purple `#7820BC` / `#BF89EC`. Reserve these for small indicators, approximately 10px, when the meaning requires color. Do not introduce colored status panels. Ticketd keeps status icons neutral; status color appears only as a small dot beside a word (see Status and state vocabulary), never as a fill, panel, or icon tint.

The Automation canvas is the one exception, because a flow is read by the kind of each step and a run by where each step stands. There a card's 28px icon tile takes a color: in the editor the trigger is blue (`--interactive`), Run agent is solid (`--foreground`), If is violet, Change ticket teal and Notify me pink; in a run the tile takes the step's status color instead, and Taken over is violet. The three added tokens use the reference indicators: `--violet` `#7820BC` light and `#BF89EC` dark, `--teal` `#067A6E` and `#45DEC5`, `--pink` `#EA3E83` in both. Every tile still sits beside the step's kind and its status in words.

### Dark theme and error extensions

The linked reference does not specify a dark palette or complete error callouts. The following are explicit ticketd extensions, not claimed source values. Keep the reference’s sizes, spacing, typography, and elevation structure in both themes.

| Role                  | Dark extension        |
| --------------------- | --------------------- |
| Canvas                | `#0A0A0A`             |
| Elevated              | `#171717`             |
| Popover               | `#1F1F1F`             |
| Recessed              | `#1A1A1A`             |
| Row hover             | `#1F1F1F`             |
| Primary text          | `#EDEDED`             |
| Secondary text        | `#A1A1A1`             |
| Disabled              | `#8A8A8A`             |
| Selection             | `#262626`             |
| Tooltip               | `#2E2E2E` / `#EDEDED` |
| Destructive label     | `#FF6166`             |
| Shadow boundary       | `0 0 0 1px #FFFFFF24` |
| Focus and interactive | `#0072F5`             |
| Input focus           | `#005FCC`             |

Errors use local `error-surface` / `error-foreground` pairs: `#FEF2F2` / `#991B1B` in light and `#2B1414` / `#FECACA` in dark. Destructive labels on neutral surfaces (menu items, destructive buttons) use `--destructive`: `#991B1B` in light and `#FF6166` in dark (6.2:1 on `#171717`, 5.6:1 on the popover), because `#FECACA` reads as white there; text on `--error-surface` keeps `--error-foreground`. These roles exist for readable failure explanations, not status decoration.

The theme preference is System, Light, or Dark, chosen in Settings. System is the default and follows the operating system preference live; Light and Dark override it. Theme changes apply immediately without reloading. Sidebar and portaled surfaces use the same semantic roles. Every overlay has an opaque surface; never depend on a parent pane’s background.

Normal text must meet 4.5:1 contrast against its actual surface; large text and essential non-text indicators need 3:1. Decorative shadow boundaries need not act as a control’s sole identifier. Verify composed states rather than treating this palette as proof of accessibility. Use labels, shapes, and focus outlines to keep the reference’s subtle surfaces usable. Never apply opacity to an entire panel of readable content.

### Status and state vocabulary

Use the shared `StatusIcon` plus text at 16px (rows and headers), 14px (cards and chips), or 12px (minimum). Its custom SVG family uses a 16-unit grid, neutral tokens and fill to show progress; the status registry also supplies history. Named glyphs announce the status; beside a visible status word they are decorative. Where color adds meaning (Ready, Blocked, unread, checked), use a small status dot (about 10px or less) placed beside a word. A dot never appears alone, and it is the only place status color is used.

| Meaning            | Icon treatment                                          | Visible label       |
| ------------------ | ------------------------------------------------------- | ------------------- |
| Todo               | Empty circle                                            | Todo                |
| In progress        | Ring with a right-half pie                              | In progress         |
| In review          | Ring with a three-quarter pie                           | In review           |
| Done               | Solid disc with a surface-coloured check                | Done                |
| Canceled           | Circle with slash                                       | Canceled            |
| Ready              | Status dot beside the word, on Todo tickets             | Ready               |
| Blocked            | Status dot beside the word, with the reason             | Blocked by T-KQ18   |
| Duplicate          | Circle with equals sign, beside a canonical-ticket link | Duplicate of T-KQ10 |
| Source unavailable | Status dot beside the words                             | Source unavailable  |
| Unread             | Status dot plus accessible unread state                 | Unread              |

Status rings have radius 6 and stroke 1.5; the inner pies have radius 3.75.
Done uses a radius-7 disc and a 1.6 check stroke. Todo and Done use
`--muted-foreground`, moving states `--foreground`, and Canceled and Duplicate
`--disabled-foreground`. These drawings do not take Lucide's global stroke.
A changed status sweeps clockwise in `--dur-4` with `--ease-in-out`; Done fills
and its check draws in `--dur-settle` with `--motion-swift`. Initial glyphs and
recorded history stay still. Reduced motion makes changes instant.

`PlanRing` and `PlanSplitBar` are Plan-aware shared recipes in `features/plans`.
They consume `PlanCounts` from `show_plan`, including all non-trashed members,
independent of list filters. Countable work is Todo + In progress + In review +
Done; Canceled and Duplicate are excluded. The 16px ring (20px on Plan cards)
uses radius 6, stroke 2, a `--track` track, a `--seg-review` arc for Done plus
moving work, and a round-capped `--foreground` Done arc on top, starting at the
top. The 6px split bar has a 3px radius and 2px gaps, with Done, In review and
In progress segments in `--seg-done`, `--seg-review` and `--seg-progress`; Todo
remains track. Zero countable work shows only track, including all-excluded
Plans. Both announce “Board polish, 0 of 5 done, 2 moving”, where moving counts
only In progress and In review. Decorative mode suppresses repeated speech.

Ready and Blocked are availability indicators, not extra statuses. Canceled and Duplicate must never look completed. Duplicate is a status of its own: it never looks Canceled or Done, and it always names its canonical ticket, or the source’s reference when that ticket is not in the workspace. Trashed tickets remain readable and show a restoration action; avoid a full-page faded treatment.

Each dot color keeps one meaning across every view:

| Dot    | Value     | Meaning                                                                                                                      |
| ------ | --------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Green  | `#45A557` | Ready, and other positive states such as an external source that is open and synced                                          |
| Orange | `#FF990A` | Blocked, and other states that need attention: Source unavailable, an unrecognized closure reason, an unresolved publication |
| Blue   | `#0062D1` | Unread                                                                                                                       |

Transient and settled states, such as Refreshing GitHub… or Closed on GitHub, use words without a dot.

### Next-generation surface roles

| Token             | Light     | Dark      |
| ----------------- | --------- | --------- |
| `--card`          | `#FFFFFF` | `#1F1F1F` |
| `--card-hover`    | `#FBFBFB` | `#242424` |
| `--well`          | `#F5F5F5` | `#1B1B1B` |
| `--track`         | `#E8E8E8` | `#2E2E2E` |
| `--faint`         | `#8F8F8F` | `#5C5C5C` |
| `--seg-done`      | `#171717` | `#EDEDED` |
| `--seg-review`    | `#707070` | `#8F8F8F` |
| `--seg-progress`  | `#B8B8B8` | `#4F4F4F` |
| `--primary-hover` | `#383838` | `#D4D4D4` |

Faint is decorative only, never necessary text. Dark layers rise from panel through well to card and popover. Light wells sink below white cards. Segment colours describe Plan progress. Existing hover, dark popover, tooltip and destructive values stay as specified above. A blocking theme bootstrap reads the stored choice before module loading. The native window starts hidden and shows after its theme and window/webview background requests finish, including startup recovery. An independent native watchdog reveals a still-hidden window after five seconds if module loading or native painting stalls. The first successful frontend reveal cancels the watchdog, so later actions to hide the app are respected. When no application has rendered, it shows “Couldn’t start ticketd” with a quit-and-reopen step on its own theme-matched canvas, independent of application CSS.

## 3. Typography

Bundle Geist Sans and Geist Mono locally. Use the reference’s actual 400, 500, and 600 weights; include a real medium face before using 500. Do not synthesize 550, 650, or 700. Sans handles the interface and prose; Mono handles code, references, paths, and identifiers. Enable standard ligatures for prose, and preserve exact identifier legibility.

### Reference scale and ticketd assignments

| Role           | Size / line | Weight   | Tracking | Token / use                                                                 |
| -------------- | ----------- | -------- | -------- | --------------------------------------------------------------------------- |
| Display        | 32 / 40     | 600      | -1.1px   | `--text-section`, `--text-section-line`; expanded titles, first run         |
| Document title | 28 / 36     | 600      | -0.84px  | `--text-doc-title`, `--text-doc-title-line`; split Ticket and triage titles |
| Title          | 24 / 32     | 600      | -0.6px   | `--text-title`, `--text-title-line`; management and dialog titles           |
| Reading        | 16 / 26     | 400      | Normal   | `--text-reading`, `--text-reading-line`; long-form readers                  |
| Document       | 15 / 24     | 400      | Normal   | `--text-doc`, `--text-doc-line`; split-pane prose                           |
| Interface      | 14 / 20     | 400, 500 | Normal   | `--text-ui`, `--text-ui-line`; controls and navigation                      |
| Code           | 13 / 20     | 400 mono | Normal   | `--text-code`; references, paths, commands                                  |
| Preview        | 13 / 18     | 400      | Normal   | `--text-preview`, `--text-preview-line`; compact single-line summaries      |
| Caption        | 12 / 16     | 400      | Normal   | `--text-caption`, `--text-caption-line`; metadata and keyboard chips        |

These next-generation roles are available to each surface as it is updated. Adding a role does not resize existing prose or titles. Keyboard chips always use caption size, including inside tooltips and buttons. Nothing is smaller than 12px. Display and document-title tracking use `--text-section-tracking` and `--text-doc-title-tracking`.
Use the source’s form tokens for shared inputs: 14px/20px default and 16px/24px large. Its observed native input size is 13.3px; ticketd’s themed form controls use the explicit 14px form token rather than relying on browser-native metrics. Root text size is 16px, so the reference’s `.875rem` form size resolves to 14px. The root stays 16px for rem maths, but `body`, dialogs, sheets, popovers and menus set the 14/20 working role, so text that no class sizes never renders at 16px; the 16px reading role is opt-in. Prose (paragraphs, captions, ledes, empty-state sentences) wraps with `text-wrap-style: pretty` and headings with `balance`, so blocks do not end in one-word lines.

Do not shrink the entire workspace to a 13px root or scale down type to fit an extra pane. Choose the appropriate existing role instead: captions are 12px, navigation, ticket rows, descriptions, and updates are 14px/20px in the working panes. Semibold is reserved for display/section-title emphasis; small section headings use the real medium weight.

Authored headings use these same roles: first-level headings may use the 32px section-title role, with lower levels using the 14px heading roles and spacing to express hierarchy. The ticket title remains the strongest application heading through placement. Preserve authored strong emphasis using the available semibold face without changing all surrounding interface labels to semibold.

List titles may truncate within their column; details show the complete title. Detail titles, validation errors, and consequential operation explanations wrap. Do not use compressed tracking on body text or reduce font size when a title is long.

## 4. Spacing, sizing, and elevation

### Reference spacing values

| Token               | Value | Ticketd use                              |
| ------------------- | ----- | ---------------------------------------- |
| `--geist-space`     | 4px   | Small related offsets                    |
| `--geist-space-2x`  | 8px   | Icon/label and tightly related controls  |
| `--geist-space-3x`  | 12px  | Compact control groups                   |
| `--geist-space-4x`  | 16px  | Form groups and compact panel insets     |
| `--geist-space-6x`  | 24px  | Standard gutter and content gap          |
| `--geist-space-8x`  | 32px  | Document section separation              |
| `--geist-space-10x` | 40px  | Standard control height / page spacing   |
| `--geist-space-16x` | 64px  | Header height / large section separation |
| `--geist-space-24x` | 96px  | Reserved large composition spacing       |
| `--geist-space-32x` | 128px | Reserved large composition spacing       |
| `--geist-space-48x` | 192px | Reserved large composition spacing       |
| `--geist-space-64x` | 256px | Reserved large composition spacing       |

Semantic aliases retain the source values: small 32px, medium 40px, large 48px, gap 24px, half-gap 12px, quarter-gap 8px, double-gap 48px. These are a vocabulary, not a requirement to insert large blank areas into every ticket.

Use 8px label-to-input spacing, 4px input-to-hint spacing, 16px between fields, and 24px before a form action row. Avoid accumulated margin plus padding plus a divider at one section boundary. One-pixel optical alignment and focus rings do not require four-pixel rounding.

### Reference sizes and corners

| Element                                | Value  | Application                                           |
| -------------------------------------- | ------ | ----------------------------------------------------- |
| Small control                          | 32px   | Every button, dialog primaries included; pickers      |
| Default control                        | 40px   | Search and form inputs                                |
| Large control                          | 48px   | Deliberately prominent actions / coarse-pointer forms |
| Default radius `--radius`              | 6px    | Inputs, buttons, small controls                       |
| Segment radius `--radius-segment`      | 4px    | Segments, keys and other small inner shapes           |
| Content radius `--radius-card`         | 8px    | Content cards, rows and code blocks                   |
| Elevated panel radius `--radius-panel` | 12px   | Content panel, cards, menus, dialogs, sheets          |
| Pill radius `--radius-pill`            | 9999px | Tags or compact badges only                           |
| Header height                          | 48px   | List pane header and detail pane header               |
| Sub-navigation height                  | 46px   | Compact pane/header row                               |
| Page gutter                            | 24px   | Workspace and management content gutters              |
| Standard content width                 | 1200px | Management content maximum                            |
| Wide content width                     | 1400px | Wide content views where useful                       |

Stylesheets hold no literal radii or raw colors; they map to tokens as follows. Literal 6px is `--radius`, 12px is `--radius-panel`, and 999px and 9999px are `--radius-pill`. Literal 2px, 3px and 4px are `--radius-segment`. Content corners at 8px use `--radius-card`; 10px maps to `--radius-panel`. Control outlines drawn at `#00000024` use `--shadow-border-base` (8% in light, 14% in dark), which is a lighter outline in light than the literal was. A dialog keeps its ring from `--shadow-modal` and has no border of its own. A placeholder is text and uses `--disabled-foreground`; `--control-boundary` is for outlines and empty tracks. Hairlines at `#0000000f` use `--group-hairline` (`#0000000D` in light, `#FFFFFF14` in dark), and the dialog shadow `0 8px 32px #0003` uses `--shadow-modal`, and the board drag preview shadow uses `--shadow-menu`. The only `!important` left beats inline styles from the panel library on the ticket workspace, or implements reduced motion; each has a comment.

Pane widths and row columns are ticketd geometry, defined below. The application shell fills the window; the reference’s page-width limits apply to content views, not to the combined navigation/content-panel shell. Use the supplied 48px size for coarse-pointer targets rather than inventing a new control size.

Lucide icons remain 16px inside ordinary controls, with consistent stroke weight. Icon-only actions have accessible names and hover/focus tooltips. Header icons have a 28px hit area; other controls retain their specified sizes, with a 44px minimum for coarse pointers.

### Tooltip

One tooltip in both themes, a small dark chip: `--tooltip` (`#171717` light, `#2E2E2E` dark) with `--tooltip-foreground`, 12/16 text, 4px 8px padding, `--radius`, at most 240px wide and wrapping, no arrow, and `--shadow-tooltip`, whose dark ring is the 14% `--shadow-border-base`. This replaces the reference's elevated white chip.

- **Timing:** one provider for the app, 400ms before the first label and 300ms in which the next opens at once. A tooltip opens on hover and on keyboard focus only, never on focus that a closing menu or dialog returns to its opener, and closes when a menu, select or dialog opens over its trigger. With nothing to say it is not mounted, so it can never catch Escape.
- **Placement:** 6px from the trigger with 8px collision padding; below header and toolbar triggers, right of sidebar and rail triggers, above inline items. It never covers the row or line the pointer is on.
- **Content:** the label of an icon-only control, with its shortcut after it as inverted Kbd chips ("New ticket C"); the exact time on a focusable `<time>`; the full text of a truncated name, only while it is cut. A tooltip is never the only place an explanation lives, and a full path is shown in one but never used as a button's label. Native `title` attributes are banned on DOM elements by lint.

### Boundaries, shadows, and focus

Use shadow-based boundaries on surfaces. Keep layout dimensions stable with `box-sizing: border-box`; do not draw both a CSS border and a matching shadow ring. Native checkboxes, semantic table grids, and graph edges may retain their necessary line treatment. Scrollbars are a slim rounded thumb on no track and without arrows, tinted from the text color, so they sit quietly in both themes. Do not use horizontal rules between document blocks or sections; space and the section heading set sections apart (see Ticket detail).

Use the source’s light-theme definitions, composed with the theme’s boundary role:

| Token            | Reference definition                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------- |
| Border base      | `0 0 0 1px #00000014`                                                                    |
| Border           | Border base plus `0 0 0 1px var(--ds-background-200)`                                    |
| Small elevation  | Border plus `0 2px 2px #0000000A`                                                        |
| Medium elevation | Border plus `0 2px 2px #0000000A, 0 8px 8px -8px #0000000A`                              |
| Large elevation  | Border plus `0 2px 2px #0000000A, 0 8px 16px -4px #0000000A`                             |
| Menu             | Border plus `0 1px 1px #00000005, 0 4px 8px -4px #0000000A, 0 16px 24px -8px #0000000F`  |
| Modal            | Border plus `0 1px 1px #00000005, 0 8px 16px -4px #0000000A, 0 24px 32px -8px #0000000F` |
| Tooltip          | Border plus `0 1px 1px #00000005, 0 4px 8px #0000000A`                                   |
| Focus            | `0 0 0 2px var(--ds-background-100), 0 0 0 4px #0072F5`, drawn as an outline (below)     |
| Input focus      | `1px` outline in `#005FCC`                                                               |
| Modal backdrop   | `var(--ds-background-200)` at `0.8` opacity                                              |

For light theme, map `--ds-background-100` to elevated white and `--ds-background-200` to canvas `#FAFAFA`. Dark equivalents use the explicit dark surfaces above. Dark elevation preserves these dimensions and uses the dark boundary role; tune visibility through the documented theme mapping rather than changing the light reference values. The reference's black-alpha drop layers vanish on `#0A0A0A` and `#171717`, so in dark the menu, large and tooltip elevations use `0 1px 2px #0000004D, 0 8px 24px -6px #00000080` after the 14% ring, and the modal adds `0 24px 48px -12px #000000A6`.

Overlay surfaces: menus, selects, listboxes and command lists use `--popover` with the menu elevation; popovers holding a form use `--popover` with the large elevation; dialogs and sheets use `--surface` with the modal elevation over the 80% canvas scrim. No rule may remove an overlay's shadow.

The document plane, ticket rows, and inline sections remain flat. Floating menus and dialogs use their corresponding elevation. Overlays always have an explicit opaque background and foreground, including when rendered through a portal.

Focus keeps the reference's look but is drawn with `outline`, never `box-shadow`, so it never shares a property with a control's edge or an overlay's elevation: `outline: 2px solid var(--ring)` at a 2px offset on free-standing controls, at −2px on rows inside lists and scrollers (where an outer ring would be clipped or cover the neighbors), and the 1px `--input-focus` outline on text fields. Focus is independent of hover and selection, and uses system-visible outlines under forced colors. After a pointer interaction the modality reset clears `outline` only, so a menu or button focused by script after a click keeps its shadow. Focus moved by script to a container or heading (a pane, a menu or dialog frame, a title after a bulk change, a mention target) never shows a ring. A guard test rejects focus drawn with `box-shadow`, a pointer reset that touches `box-shadow`, `inset var(--focus-ring)`, and any rule that removes an overlay's shadow.

### Next-generation foundation sizing and elevation

Lucide icons use `--icon-stroke: 1.75` everywhere. Header controls use `--header-control-height: 28px`, inside the existing pane header geometry; coarse pointers retain a 44px minimum. Existing control and panel radii stay 6px and 12px; `--radius-card: 8px` is available for content cards, rows and code blocks.

| Shadow token         | Light                                                                       | Dark                                                                         |
| -------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `--shadow-panel`     | `0 0 0 1px #00000012, 0 1px 3px #0000000A`                                  | `0 0 0 1px #FFFFFF17`                                                        |
| `--shadow-card`      | `0 0 0 1px #0000000F, 0 1px 2px #0000000D`                                  | `0 0 0 1px #FFFFFF12, 0 1px 2px #00000066`                                   |
| `--shadow-card-lift` | `0 0 0 1px #00000014, 0 12px 28px -8px #00000033, 0 4px 8px -4px #0000001A` | `0 0 0 1px #FFFFFF24, 0 16px 32px -8px #000000B3, 0 4px 10px -4px #00000080` |

The content panel uses `--shadow-panel`. Menu, modal and tooltip shadows retain their existing values.

## 5. Workspace layout

### Wide-window composition

Navigation stays on the canvas surface. Every view sits in one inset, elevated content panel: 12px radius, the small elevation shadow ring, and 8px from the window edges. There is no global top bar. The list pane has its own header and the detail pane has its own header, both inside the panel.

```text
┌──────────────┬───────────────────────────────────────────────────────────────────────┐
│ ticketd   +  │ ┌─────────────────────────┬─────────────────────────────────────────┐ │
│              │ │ All tickets      ⟳ ⌕ ≡  │ T-KQ42 ⧉ repo #98 ↗  2 of 11 ˄ ˅ … ⤢ ✕  │ │
│ Inbox     3  │ │ All 11 GitHub 7 Local 4 ├───────────────────────────┬─────────────┤ │
│ All tickets  │ ├─────────────────────────┤ Ticket title              │ Status      │ │
│ Ready     4  │ │ ◐ In progress  2     +  │ ● Open on GitHub · #98    │ Source      │ │
│ In progress  │ │ ◐ T-KQ42 Selected   #98 │ ┌ GitHub · Read-only ──┐  │ Project     │ │
│              │ │ ◐ T-KQ43 Ticket title   │ │ Description          │  │ Plan        │ │
│ Projects  ⚙  │ │ ◌ In review    1     +  │ └──────────────────────┘  │ Tags        │ │
│ Plans     ⚙  │ │ ◌ T-KQ44 Other title #91│ Subtickets   ▬▬ 1 of 2    │ Relations   │ │
│ Archived …   │ │ ○ Todo         3     +  │ GitHub conversation       │ Attention   │ │
│              │ │ ○ T-KQ45 Ticket title   │ Activity                  │             │ │
│ ● GitHub     │ └─────────────────────────┴───────────────────────────┴─────────────┘ │
│ Trash        │                                                                       │
│ Settings     │                                                                       │
└──────────────┴───────────────────────────────────────────────────────────────────────┘
```

Workspace notices use the continuity rule in section 12; ordinary navigation never inserts chrome above the panes. The way back to a graph a view was opened from is a ReturnCrumb, "← Workspace graph /", in the leading slot of the view's first header, before its title; the shell provides it (and the narrow navigation button) to PaneHeader and PageHeader through one slot, so a view never builds its own.

The drawing describes hierarchy, not additional duplicate search fields. Search belongs in the list pane header. Unread attention lives in the sidebar Inbox count, not in a top bar. The sidebar footer shows each configured source’s sync state and opens its settings.

| Region          | Geometry and behavior                                                                                                                                      |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Navigation      | 232px navigation allocation, 12px horizontal padding and 208px rows; independently scrollable groups; collapsible to a 56px icon rail that does not scroll |
| Content panel   | One elevated panel, 12px radius, small shadow ring, 8px from the window edges                                                                              |
| List header     | 48px: view title and count, Refresh, then Search, Filters, and Display (32px small controls); active filters show as one line of chips under it            |
| Source filter   | Below the list header once a source is configured: All, GitHub, and Local with counts                                                                      |
| Detail header   | 48px, never wraps, with a 20px leading gutter: ticket reference, source link, list position (its slot kept as “–”), and actions (see Ticket detail)        |
| List pane       | 360px navigator in split mode, resizable from 300px to 480px; the document takes the remaining width                                                       |
| Detail pane     | At least 480px in split mode; start near 55% of content panel width                                                                                        |
| Document column | 40px desktop gutters, 16px on narrow windows; max 680px including gutters (760px full width)                                                               |
| Property rail   | Removed; a single wrapping property bar sits beneath the ticket title                                                                                      |
| Resize handle   | 1px visual separator with an 8px hit area; visible focus and keyboard resizing                                                                             |
| Expanded detail | Document centred at most 760px including gutters, with 15px/24px prose; keep navigation and return context                                                 |
| Board peek      | On the board an open card shows in a 520px panel over the right of the board (modal shadow, panel radius); the columns never resize; Escape closes it      |

With nothing open, the list (or board) takes the full width of the panel; the detail pane appears only when a ticket opens. List and detail scroll independently, and the window itself never scrolls. In the list pane only the rows (and paging) scroll: the title, toolbar, source tabs and filter chips stay fixed above them. Sticky chrome has an opaque surface and must not cover focused fields or anchor targets. The first detail viewport should show the title, properties, and the beginning of the description. Reminders, evidence forms, and an empty update editor must not push the title down.

### Responsive rules

Measure the available content panel width after navigation, not just the screen width. Preserve readable minimums rather than squeezing three panes together.

| Available space              | Behavior                                                                                                                                                                                                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Content width at least 880px | List and detail may share the workspace; enforce both pane minimums                                                                                                                                                                                                          |
| Content width below 880px    | Selecting a ticket replaces the list in the content area; explicit Back returns to its prior position                                                                                                                                                                        |
| Window below 768px           | Navigation moves into a sheet; a Search icon in the pane header opens the palette. The sheet is opened by a 28px "Open navigation" icon button in the leading slot of the view's own header (never a bar above it), with the Chats-waiting or Inbox-unread dot on its corner |
| Window near 390px            | One content column, 16px gutters, wrapping property values, full-width action forms where needed                                                                                                                                                                             |
| Ticket at every width        | The same wrapping property bar stays under the title at every width                                                                                                                                                                                                          |

A navigation sheet is at most 280px or viewport width minus 32px. Popovers retain 16px viewport clearance and collide away from edges. Forms that cannot fit a popover use a sheet/dialog with a scrollable body. At short heights, keep form actions reachable without clipping the body.

Switching pane modes, resizing, or opening navigation must not remount drafts, reset selection, or lose list scroll position. Horizontal scrolling belongs only inside code, wide tables, or the graph canvas. At 200% zoom, reflow the shell rather than shrinking the type.

## 6. Navigation and ticket list

Filter choices apply after the picker closes, retaining ticket rows while choosing.
Pointer moves into a submenu keep its choices mounted through a temporary focus
return to the parent menu; Escape or dismissal applies the staged values.

### Navigation

The sidebar sits on the canvas surface, top to bottom:

- **Top row:** 48px drag region with native traffic-light room, then 28px Collapse sidebar and New ticket icon buttons. New ticket opens in one click or C; read-only workspaces disable both paths with “The workspace is read-only”. No wordmark or create chevron. Capture a thought and New Chat live in the command palette.
- **Jump:** a 32px button labelled “Search or jump to…” with search glyph and the platform’s palette shortcut. It opens the same command palette as Mod+K.
- **Work views:** Inbox, All tickets, Ready, In progress, then Chats while enabled. Automations remains available through the command palette while Chat is enabled. Zero counts are hidden. Blue means unread; orange means needs you, always accompanied by a meaningful accessible name and count. Working Chats show a spinner and count. Unread Inbox and finished Chats use a blue dot without a visible number; their accessible names retain unread counts. Inbox’s orange Needs you count depends on the shared Needs you classifier.
- **Groups:** Projects, Plans, Context, in that order. Projects and Plans headings link to their management pages; empty groups are omitted. No project is last. Plans use their existing full-Plan counts for a 16px progress ring and done/countable label; failed reads omit progress rather than inventing it. Archived Plans remains reachable from Plans, with no sidebar row. Context holds Documents, Attachments and Workspace graph.
- **Footer:** Settings then Trash are 28px icon buttons in a 48px footer with tooltips and registered G S / G X shortcuts, also offered by the palette. Source status remains above them when configured.
- **Title bar:** on Windows the app draws its own 32px title bar on the canvas in place of the native one. It is the window's drag handle, and double-clicking it maximizes; Minimize, Maximize or Restore, and Close sit at its end, and Close turns the system red on hover. The window keeps its native resize edges and shadow. macOS keeps its transparent native bar.
- **Collapse:** a button beside New ticket collapses the sidebar to a 56px rail of icons. Like a navigation rail, it holds a few fixed destinations and never scrolls. Inbox, the three ticket views, Documents and Workspace graph keep their icons. Projects and Plans each fold into one icon that opens a menu headed by the group's name: the entries with their row icons, a check on the current one, then a separator and the group's page. One hairline separates each group (work views, Projects, Plans, Context), in the expanded order. Each label becomes its icon's tooltip, counts hide, and an unread dot (8px) sits on the icon's top-right corner, cut out of the row by a 2px ring in the row's own fill. The source footer repeats its two lines as a tooltip only on the rail. The window's minimum size, 480 by 600, keeps the rail whole.

Group headings (Projects, Plans, Context) are 12px secondary-text labels in both themes, not primary-weight headings. Use a 28px heading with 14px top margin; rows follow directly. Active navigation uses the `--accent` fill and primary text, plus semantic current-state markup. Inactive rows use secondary text; hover promotes the text and uses the quieter `--recessed` fill, so a hovered row never looks current. Hover does not change row size. Counts align at the trailing edge and remain secondary. Unread attention appears as the Inbox count or a status dot beside its label; there is no top-bar indicator and no permanent high-contrast banner.

### Approved deviations from the base design

- Ticket status group headers are quiet 36px rows without bands or rules. Other inset bands (dialog footers, code and notices) use `--recessed`; canvas appears only outside the content panel.
- Tag pills use the shadow-boundary ring (`0 0 0 1px #FFFFFF24` in dark) so they keep their shape on dark surfaces; pane edges and inputs use the same boundary, and links use `--link-foreground` (`#52AEFF` in dark).
- Sidebar section labels are 12px secondary labels in both themes.
- Single-status views (a list narrowed to one status, such as Ready or an applied status filter) render no group header (the list title already names the status) and show a one-line view description under the title, rather than the full workflow-ordered set of groups.
- Option cards use a 2px selected edge instead of the 1px boundary used elsewhere, so the selection stays legible without a fill change.
- The unlinked project choice is labeled "No project" (not "None" or "Unassigned") in project pickers, the sidebar, and ticket properties.

### List anatomy

The 40px bulk bar exposes selected count, Status, Project, Plan, Tags, More and Clear selection directly. More holds Select all listed, Select all matching and Clear selection. The same existing menus and atomic bulk operations apply. Below a 600px pane, labels collapse to their existing glyphs with full accessible names and tooltips; the bar keeps one line and the rows stay in place. Failures use the existing floating failure slot and retain selection for Retry.

Ticket lists use a 36px ledger by default. Each row has 8px outer margins, 4px/10px horizontal padding and `--radius-card`. Its lanes are a reserved 24px checkbox, 16px status glyph plus 10px gap, 62px mono Reference, a flexible title, 148px state after 20px gap, 128px tags after 12px gap, 132px context after 20px gap, and a right-aligned 30px time after 14px gap. Closed titles use muted text. Externally owned source pills stay beside the title.

- Groups remain in workflow order: In progress, In review, Todo, Done, Canceled, Duplicate. Each has a quiet 36px header with 6px top margin except the first, a status glyph, name, whole-result count, and Add on hover or focus. Todo adds “· N ready” when its whole group is loaded; a partially paged group does not invent a readiness total. Duplicate's action opens its review. Headers and rows retain their existing stable keys and keyboard focus.
- The board reads left to right in workflow order (Todo first) while the list puts active work first (In progress first). The two orders differ deliberately.
- Once an external source is configured, a source filter below the list header offers All, GitHub, and Local with counts. It narrows the groups; it does not regroup the list by source.
- Checkbox hit areas occupy a reserved 24px column. With a mouse, reveal unchecked controls on row hover or keyboard focus; show all controls during bulk selection. On touch devices keep them visible. Selection never shifts the row or creates an extra row of controls inside it.
- The list header's Display button opens a menu that holds the layout choices: Layout (List or Board) and Rows (One line or Detailed). Layout choices never sit in the header as a row of toggles.
- One line rows keep fixed lanes. Below a 1000px list container, tags hide; below 800px, context hides; below 620px, state keeps its icon and accessible name while its words hide. Reference, title and time stay visible. Ready is summarised in Todo's group header rather than repeated in flat rows.
- State lanes use the shared active Chat summaries already fetched for Inbox attention. A linked approval takes precedence over linked working, then Blocked by, a due reminder, Ready for review for an agent's latest update on an In review ticket, and Duplicate of. Sync review and unavailable-source warnings remain visible. The reserved lane does not resize when a Chat changes state; Working uses the harness mark and reduced-motion-aware spinner, and approval uses the attention dot beside its words.
- Updates, detailed rows and Inbox entries map only known editing-agent names (Claude, Claude Code, claude-code and Codex, case-insensitive) to the existing official harness paths. Unknown attribution stays a neutral bot or update icon and retains its text; it never earns a publisher mark by inference.
- Detailed rows are 56px: the same first line, then the latest agent update's readable brief under the title, or the context text when no agent update exists. This uses `progress_summary` from the existing `find_tickets_with_updates` page, with no per-row read. Row density remains a per-computer preference; existing choices are preserved.
- Metadata that does not fit moves to details; the title keeps its useful width. Long titles must not overlap trailing actions.
- An open ticket uses a neutral selected fill without a decorative leading stripe. Bulk selection is communicated separately by checkboxes. Keyboard focus uses the focus ring.
- Row hover uses `--hover` (`#F7F7F7` light, `#1F1F1F` dark), quieter than the `--accent` selection and distinct from the recessed group header. Hover actions also appear on focus; essential actions cannot be hover-only.
- Interaction states follow one matrix. Selectable rows and cards (tickets, Inbox entries, Documents, Plans, Chats, graph lists) hover on `--hover`, and the open or selected one uses `--accent` with `aria-current` or `aria-selected`. Controls (ghost and outline buttons, rail rows, menu items) hover on `--accent`. Pressed toggles and open triggers keep the `--accent` fill with primary text (`aria-pressed`, `[data-state=open]`); the inverted primary fill is reserved for one primary action per surface. A segmented control's chosen segment is `--surface` with the small elevation in light and `--accent` in dark, where the surface is darker than the track. Nav rows on the canvas hover on `--recessed`. Disabled controls use `--disabled-foreground` with no opacity; filled ones keep `--recessed`.

There is no permanent “0 selected” bar. When tickets are selected, a compact 40px action bar floats 8px above the bottom of the list on the popover surface with the menu shadow and panel radius, so the rows never move: the count, Status, Project, Plan, Tags, More and a Clear selection icon button with Esc in its tooltip. Project and Plan open their existing choices directly; Tags offers explicit addition/removal. More holds "Select all 18", then "Select all 59 matching" (which reaches tickets not yet listed), and Clear selection. Every control has its own semantic label and tooltip. The Status menu checks a status every selected ticket shares, says "2 of 3" otherwise, and notes that Duplicate is set from a ticket's review. Do not display four inline forms and their submit buttons at once. Keep the count visible after validation errors; show which ticket prevents the batch and state that nothing changed. A failure replaces the controls in their existing slot, retains the count, wraps its complete reason, and focuses Retry or Clear selection. A successful outcome uses the pane status line (section 12); focus returns to the list. Below a 600px pane, the direct controls collapse to their glyphs with accessible labels and tooltips so the same bar stays on one line. Escape clears a selection even from a focused row checkbox. Tag addition/removal uses a 480px dialog populated from the workspace vocabulary before filtering locally; loading never claims that tags are absent. A selection belongs to its view: another scope, search, filter or layout drops it (the board has no bar); showing more keeps it.

An open, checked or focused ticket keeps its group and position when its status, Plan or project changes, including live updates and removal from the current filter. Its glyph and property values show saved data immediately. The main list, the navigator and Plan lists use the same placement rule. Moving to another row with J/K or arrows, changing the open ticket, or clicking elsewhere releases the held placement; opening its picker or palette keeps it. A held row also releases after three seconds without keyboard or pointer input while the pointer is away from it. Regrouping is instant. The arrival uses only the `--hover` fill fading over `--dur-arrival` (1.2 seconds); reduced motion skips the fade.

The list is one Tab stop: rows use a roving tabindex, so Tab enters at the open (or last focused) row and leaves the list; ↑/↓ or J/K move, Home and End jump to the ends, Enter opens and Space selects. Shift-click on a checkbox or Shift+↑/↓ extends the selection from the last ticket toggled, and Mod+A selects every listed ticket.

The list pages with one "Show 50 more" under the rows. The new rows land where the button was: for 400ms a click there is ignored, and keyboard focus moves to the first new row, so nothing opens by accident.

Ticket headers show only title, count, Filter and Display. Search belongs to the command palette and refresh happens automatically; a failed refresh offers Retry beside the retained list. The same empty-view rule applies to All tickets, Ready and In progress: hide controls only when the unfiltered scope itself is empty.

Filter is a menu with Status, Availability, Plan, Tags and Parent submenus. Tags stay in vocabulary order while checked. Both the trigger and empty-state explanation count active dimensions, so several tags count as one filter. Active chips retain the shared chip anatomy and Clear filters.

Active filters use one 44px bar directly beneath the header, with 26px chips and a trailing Clear filters control. No bar or blank gap is inserted in unfiltered S01. The picker stages its checked values until it closes, so choosing a first value, typing in a picker, and toggling tags never move the ledger behind an open menu. Closing applies the draft and reflows the list once. The chip row never wraps, hides excess chips behind “+N more”, and reserves Clear filters even at 480px. Bulk controls and the status line keep their separate bottom slots. Source filtering remains separate and preserves the selected source when ordinary filters clear.

### Board

Columns sit in well surfaces with panel corners, 36px headers and 10px gaps; the board has 12px padding (16px at its leading edge). Cards use the card surface, card corners and card shadow, with 10px/12px/11px padding, 6px gaps and wrapping metadata. Live Chats supply the shared harness mark and working or approval state; an agent-authored In review ticket says “Ready for review”. Columns share the width between 220 and 320px on the surface, so the whole workflow fits at 1280px; Canceled and Duplicate fold to 40px vertical headers (icon, name, count) that open on click, and a card moved into a folded column opens it after the save is confirmed. Fold controls wait during a drag or pending save. Cards follow the row anatomy: status icon, Reference and source pill; the title in up to three lines; then Blocked, one context item and tags. The status trigger is a 24px outlined icon in the card's corner, revealed on hover or focus, opening a "Status" menu with status icons. A drop or status choice moves the card at once with "Saving…" on it and a hatched slot of its measured height where it was; the outcome is the status line with Undo, and a failure puts the card back with the reason and Retry on the card. A lifted card uses the lift shadow, a slight scale and tilt; saving settles it with the shared motion tokens. Arrow keys move between cards and columns, and S opens the shared status drill for the focused card. Allowed columns take a hairline while dragging, the target the focus ring, and a refused column says "Can't move here" in its header. An empty column shows one muted line ("No tickets", or "No matches" while filters narrow it) and keeps Add in its header; when nothing matches at all the board shows the view's one empty state. "Counts reflect current filters." appears only while filters are on.

The command palette lists the open ticket's actions, Go to destinations and active named Plans, then Create (New ticket, Capture a thought, New Chat, New Plan). It joins existing global ticket search with in-memory ticket labels, recent Documents and existing Document search, and active Plans. Ordered-letter fuzzy matching uses the same character positions for filtering and emphasis. A `T-` prefix offers references alone; `>` offers commands alone. Plan progress comes from `show_plan`; Inbox Needs you comes from the shared attention classifier and Ready from sidebar counts. The palette keeps its 96px top position and lets only the results list shrink and scroll before its footer can be clipped.

## 7. Ticket detail

### Required reading order

1. **Detail header:** the ticket reference with Copy; for an externally owned ticket, its source location (`owner / repo #98`) as a link that opens the source; then the ticket’s position in the current list (“2 of 11”, or “–” when it has none, so the icons never move) with Previous and Next, Follow, the actions menu, expand, and close. Follow failures and Retry use the existing pane status line so the header and prose keep their position. Follow reflects changes made elsewhere without reopening the ticket. The header keeps this shape in every state: Restore lives in the Trash notice and the menu, Export Markdown with files in the menu, and copy results and failures go to the status line. Nothing is inserted above the title. Avoid repeating “Ticket details” above the reference and title; with nothing selected there is no header band.
2. **Title:** wraps to its content height. Reading must not look like an empty resizable form. Editing retains a clear focus treatment.
3. **State line:** one 14px line under the title. An externally owned ticket shows its source state as a dot and words (Open on GitHub, Source unavailable), then its external number, author, and opening date; a closed one reads “Closed on GitHub as completed” without a dot. The detail header owns the normal updated time; a local ticket adds no duplicate timestamp row. Once a source exists, a local ticket can identify itself as “Local ticket”. A ticket outside the list's current results adds “Not in the current results”.
4. **Description:** primary reading surface, with editing on demand. An externally owned description is a read-only source card (see Documents and activity).
5. **Linked:** the subtickets, parent, blockers, tickets this blocks, related and discovery relationships, duplicates and backlinks. The shared section heading carries a unique-ticket count and subticket progress. On an externally owned ticket, a caption states that subtickets stay local. Empty content folds into one quiet row of adds: “+ Subticket · + Link · + Evidence · + File”.
6. **Evidence and Files:** flat sections with concise existing information and contextual add/edit actions. Files combines Documents and Attachments.
7. **Source conversation:** tickets that have an external source. The source’s comments and events, read-only, with a link to comment at the source. After ownership is taken the retrieved conversation stays, as the history of the source; it is no longer refreshed.
8. **Activity:** authored updates, distinguishable recorded changes, and explicit update submission, with an All | Updates toggle. Consecutive recorded changes between authored updates fold into one 32px summary with their actual count and categories. Its keyboard-operable disclosure expands every original record, value, attribution and time in place; groups never cross an authored update, and Updates shows only authored updates. Activity follows the description; empty relationship sections are folded away. On an externally owned ticket, a caption states that updates stay in ticketd and are never sent to the source.

For In progress and In review tickets, the reserved agent slot shows the latest authored update with its supplied editing agent and relative reporting time. It opens that update in Activity. Editing an older update does not make it the latest report.

While Chat is on, linked Chats remain reachable from the property bar and the ticket actions menu. The chip names the count and highest-ranked status; its menu lists each Chat and ends with Chat about this ticket. A ticket in Trash keeps existing Chat links and hides the create action.

The **property bar** replaces the rail at every width. Its 28px ghost chips and 28px Add property button align at the top of each wrapped row under the title: Status, Project, Plan, tags, reminder, Follow and a trailing add menu for Reminder, Blocked by, Parent and Link. Empty values say “No project”, “No Plan” and “No tags”. Chips and S/P/L/T/H open the same scoped command choices, share mutation handling and offer Undo. Duplicate opens its review. Pane-local popovers stay inside the ticket pane. Follow keeps a reserved caption space for “Not saved · Retry”; a failed write never inserts a new flex item or moves the reminder.

When a Chat begins after the ticket opened without an agent slot, Working stays compact in the detail header. A later pending approval keeps that compact header location with the orange attention mark, “Approval needed” (shortened to “Review” below a 600px ticket pane) and the accessible “Review request” action; it opens the same Chat request as the reserved strip. Resolving the request clears the compact approval cue without inserting a strip. The strip is reserved on the next opening.

The existing latest authored update occupies the reserved 44px agent slot beneath the chips. It remains reachable as a link to Activity, including failure and retry states. Live agent behavior is defined separately from this layout.

**Linked work** follows the description as one “Linked” section with a unique-ticket count and the all-subticket completion count and neutral 64px progress track. Subtickets, Parent, Blocked by, Blocks, Related to, discovery and duplicate relationships share one set of 34px reference rows on a 96px label grid. A subticket that also blocks this ticket appears once, annotated “blocks this”; its row menu retains both removal actions. Ticket backlinks remain within Linked. Section add controls use the same quiet plus icon. Removing a relationship acts immediately and offers Undo in the status line; the next 400ms of clicks on that slot are ignored. Successful relationship rereads retire optimistic removal flags, so re-adding a removed link is visible immediately. Removing a duplicate link keeps its confirmation and Review dependencies action.

**Evidence** and **Files** follow Linked, then Activity. Evidence has a kind icon, name and type/time caption, with the value at the right; narrow panes put the value below. Its initial read reserves neutral row placeholders in that same anatomy, revealed after 300ms without a pulse and announced once as “Loading evidence”. Known records stay visible during later reads and read failures; an empty result is shown only after a successful read. Files combines Documents and Attachments as intrinsic-width 44px file cards in a wrapping row with 8px gaps and one Attach menu (File… / Document…). The shared Card file variant uses a 28px recessed thumbnail, a 14/18 name and a 12/14 caption; its action slot is reserved. Detaching a file preserves its bytes and offers Undo; removing evidence acts immediately from its menu and offers Undo as well. A failed removal retains the record and retries the same removal intent. Evidence Undo uses the existing add API and therefore assigns a new record identity and timestamps while restoring its content and attribution. Retrying one Undo reuses its request ID. Empty sections fold into one quiet add row: Subticket, Link, Evidence and File. The existing File menu still offers both Attachments and Documents there. Truly empty Activity stays mounted but folded; R or Write an update in the palette reveals the existing composer in place, retaining its draft and initial 80px reservation. A scrolled Ticket header replaces its updated-time text with the truncated title after the reference within the same 48px band.

**Source** appears only once a source is configured (or the ticket has one): until then there is no Source section, no “Local” anywhere, and no Publish item in the actions menu.

The Ticket opens beside a 360px navigator, resizable from 300px to 480px, only when the content panel is at least 880px wide. Below that boundary it opens full width; Back or Escape restores focus to the same list row without resetting the list scroll. The Open tickets preference keeps Beside the list and Full width. Navigator rows are 52px with the title on line one and the reference plus current context or latest update on line two. A narrow list without an open Ticket keeps the chosen ledger density; width alone never switches it to navigator rows. Each mode renders its own reference and state text once. J/K swap the open document in place. Opening narrows the list immediately and fades only the document for 140ms; reduced motion makes the change instant.

A ticket in Trash shows one compact neutral notice at the top of the document column, “In Trash. Relationships are kept. [Restore]”; the header and property bar keep their shape, values stay at full contrast without hover, and add and remove actions are hidden. Moving to Trash and Restore report in the status line, with Undo.

The document column is centred at 680px including 40px gutters, with 28px/36px title type and 15px/24px prose. Full width expands the column to 760px with 40px top padding and a 32px/40px title. Read-only workspace state disables description and title editing; the description control explains the reason through its tooltip.

Use 8px from title to state line and 24px from state line to the description. Use 40px between major sections. The ticket stays one scrolling page, without tabs or an outline. Each major section (Linked, Evidence, Files, Source conversation, Activity) opens with a section header: one row holding the section's title, count, and actions. Space sets sections apart, not divider lines or cards; shadow boundaries belong to pane edges, floating surfaces, and the source description card. Empty Ticket sections share the quiet add row under the description.

A save state belongs next to the edited content, in 12px supporting text. Stable Saved feedback must not take an entire standalone section. Pending save, Saving, and failures remain visible and accessible. Never hide a failure to achieve a cleaner screenshot.

Source context keeps a stable 32px state row while editing. A normal local Ticket has no extra state row; title save feedback overlays its existing description gap, and description feedback stays in the floating bar, so neither moves the prose. Click the description or press E to edit in place, without an Edit button or session row. The frame sits outside the prose. Formatting, the Markdown source switch and Done with Esc live in a shared 40px floating bar at the bottom centre of the visible pane. Saving remains visible while a write runs; Saved clears after 3s; Not saved stays with Retry and the retained draft. Escape returns focus to the reading surface, allowing the next ⌘K to open the global palette; inside the editor ⌘K retains its Link meaning. Documents reuse the floating controls. The Activity composer reserves its initial text and controls height so opening it does not move the timeline. The brief and Details share one controls slot, owned by the field being edited, so attachment and source actions apply to that field without duplicate icons.

The live agent strip reserves a 44px minimum slot under the property bar only when the ticket opens with a linked Chat or an agent-authored latest update. Working, approval and idle content share that slot and fade in 140ms. A Chat that starts after an opening without a reserved slot uses a compact Working mark in the detail header until the next opening. The strip uses the shared ranked Chat summaries, subscribes to live steps through the existing Chat client, and opens the existing Chat request dock. Its polite status includes state and step changes; its elapsed clock is hidden from assistive technology. Idle outcomes use the existing latest update, preserve unseen Chat state, and open their update in Activity. Sidebar counts and background notifications remain owned by the existing Chat pipeline. Attaching live work follows the existing Chat-open seen semantics, including marking any prior unseen turn seen; it is not a read-only snapshot API.

Ticket property chips open anchored choice popovers within the ticket pane. The chips and S/P/L/T/H palette drills share one options and mutation controller, including current values, Duplicate review, custom reminder ambiguity checks and Undo. Follow lives in the header; linked Chats remain in the agent strip, header menu and palette. The property bar shows a reminder only when one is set, and its trailing + keeps Reminder, Blocked by, Parent and Link available. Experimental labels use the shared 18px filled, segment-radius badge with medium caption type.

### Visibility and action placement

| Information/action       | Default presentation                                               | Editing surface                                         |
| ------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------- |
| Follow                   | Eye toggle in the detail header                                    | Immediate action with pending/error feedback            |
| Reminder                 | Scheduled-time chip; + offers an unset reminder                    | Focused popover; expand to sheet when space requires    |
| Status/project/Plan/tags | Ghost chips in the wrapping property bar                           | Anchored picker; explicit clear/add/remove choices      |
| Source                   | Rail Source section: identity link, freshness, ownership, actions  | Explicit Refresh, Publish, Retry, or Take ownership     |
| Description              | Rendered document, or an unobtrusive Add description action        | In-place rich editor for local tickets only             |
| Parent/subtickets        | Subtickets with progress under the description; parent in the rail | Search/select action near the group heading             |
| Blocking dependencies    | Rail Relationships with each blocker’s status; reason in the row   | Focused add/remove workflow and graph access            |
| Related/discovered work  | Rail Relationships grouped by relationship meaning                 | Add relationship action with explicit direction         |
| Duplicate                | Duplicate status, with the canonical ticket in Relationships       | Mark as duplicate workflow in the actions menu          |
| Evidence                 | Named records with type, value/link, and date                      | Add evidence or Edit opens a focused form               |
| Backlinks                | Count and source excerpts; expandable when lengthy                 | Navigate to the source passage                          |
| Source conversation      | External comments and events in source order, read-only            | Comment at the source                                   |
| Activity                 | Updates and history readable in one chronological area             | Write an update; edit/delete beside the relevant update |

Relationships are one flat rail section, grouped by meaning: parent, blocked by, blocks, related, discovered while, and duplicate of. Use at most one disclosure level for supporting content. Do not nest Relationships → category → form disclosures. Existing blockers and duplicate identity must not be buried behind a collapsed group. Empty optional groups collapse into a single Add relationship action; do not stack “No parent,” “No subtickets,” “No prerequisites,” and “No related tickets.”

Destructive actions belong in a labeled menu or focused review surface. Describe the result precisely: Trash ticket, Remove relationship, or Delete update. Duplicate handling is not a generic delete operation.

### Externally owned tickets

A ticket is either Local or owned by an external source. Retained provenance is not ownership: after Take ownership the ticket reads Local, and the rail adds “was owner/repo#n.”

- **Ownership cues:** show the owner in three places: the list row’s source pill, the detail header’s source link, and the rail’s Source section. A local ticket has no source pill.
- **Read-only content:** the title, description, and source comments of an externally owned ticket are read-only. Do not show editing affordances on them. The description card’s header says Read-only and links to edit at the source.
- **Local progress:** while the issue is open, the Status picker offers Todo, In progress, and In review, with a caption that closing states follow the source. Once it is closed, the picker’s choices are disabled and its caption explains that reopening at the source returns the ticket to Todo. The rail’s Status caption says that progress is kept in ticketd.
- **Freshness:** the rail shows “Synced 4 min ago” beside a green dot and says which fields the source owns. While refreshing, the list header and the rail read “Refreshing GitHub…” without a dot.
- **Unavailable source:** a recessed notice at the top of the document column states what failed and since when, says that nothing was deleted or completed, and offers Retry and Take ownership…; the rail only shows the state. The list row and the rail carry the orange Source unavailable dot.
- **Publishing:** once a source that publishes is connected, an eligible local ticket (Todo, In progress, or In review) offers Publish to GitHub… as a row in the rail’s Source section and in the actions menu; an ineligible one states one short reason. While the preview reads again after an edit the last answer stays, so the action never blinks. Publication goes through a dialog that previews the issue exactly as it will be sent.

## 8. Documents and activity

Follow the [canonical Markdown editing decision](docs/adr/0005-plate-editor-with-canonical-markdown.md). Reading and focusing a document never rewrite it. Unsupported rich content retains a source-editing path.

- Description and Document editing keeps the reading geometry: the ticket uses 15/24 prose (16/26 expanded), and the frame sits outside the text. Formatting lives in the floating edit bar (see Ticket detail). The slash menu opens at the caret with an icon, block name and Markdown shortcut on every row, and says "No matching blocks" rather than closing. An accessible reading group retains headings, links, and attachment controls; only clicks within the prose start editing, so portalled menus keep their own interaction.
- Quick composers (the update composer, Capture, New ticket) have no docked toolbar: formatting is a small bar over the selected text, slash, and Markdown shortcuts; only Insert attachment and the source switch sit in the composer's own row.
- **New ticket (S06):** the shared DialogShell's create variant is 640px wide at 96px from the top, with a 48px compact header, title at 24/32, a borderless description and wrapping 28px outline property chips (Status, Project, Plan, Tags, Blocked by). The editor placeholder is “Markdown works here; type / for blocks.” The 56px footer holds Create more, Cancel and Create ticket with its registered shortcut; an empty title disables Create without extra visible hint text. Expand changes the shell's size while preserving its mounted editor, selection, source mode and draft. Create more keeps the initial properties and confirms the created reference before returning focus to Title. Draft property choices reuse the ticket ChoiceList presentation and write nothing before Create. Initial dependencies use existing idempotent insertions after the replayable create; a partial failure names the created ticket and keeps Retry on that same submission.
- **Capture (S09):** the shared shell's nonmodal capture variant is a 560px card at top 96, on `--popover`, with a 40px New Document header and persistent save state. Its title precedes the borderless body. A 48px footer shows the optional removable Linked to {reference} chip, Kept in Documents and Esc. Closing uses the existing save, conflict and draft recovery controller. Text-only drafts can fall back to a workspace-keyed browser copy after a verified write/readback when workspace recovery fails; reopening restores the exact canonical Markdown and pending request. Attachment references in any recoverable state disallow that fallback because browser text cannot protect file bytes. The card then stays open with Retry, Copy text and explicit discard; it never claims those bytes were retained.

- Source mode is the exception, not a heavy fallback: regular weight, the `--syntax-*` colours, no ligatures, and its reason as one caption ("Source editing · has raw HTML"). Mixed bullet and checklist items and attachment images edit richly.
- Selection formatting, slash commands, and block movement have keyboard alternatives. Controls must not steal editor selection unexpectedly.
- Paragraphs use the document type scale and 12px separation. Lists use 20px indentation with 4px between items. Checklist controls align with the first text line. Completed item text is muted with a faint strike in reading and rich editing; nested child items keep their own completion state.
- Code uses a recessed surface, 12px padding, language label, and Copy action. Scroll code horizontally inside its boundary. Long prose and URLs wrap.
- Code and Mermaid share one **BlockHeader** in reading and editing: the label at the left (the language, "Mermaid"); Source, Copy and Expand as icon buttons at the right. In the editor the language is a small field in that header, always there, so code never moves when the caret enters. A Mermaid block keeps its preview while editing, with its source in a disclosure beneath.
- Read-only checklist boxes are drawn: a tick on the recessed fill when done, a `--control-boundary` ring when not; never a disabled-looking control. An attachment image written into Markdown shows as the picture (up to the column width), and a click opens the shared preview; a file that is not a picture reads as its label.
- In 16px reading contexts (Documents, the expanded ticket), h2 to h6 use the shared 18/28 reading heading role, weight 600 and −0.2px tracking. Expanded Ticket headings after another block have 32px above them in both reading and rich editing.
- Tables stay within a horizontal scroll region (labeled in reading). Reading and rich editing share 14/20 cells with 8px 12px 8px 0 padding and horizontal group hairlines, no outer or vertical border. Headers are transparent, muted 12/16 medium with 0px top padding and a bottom border hairline. Preserve cell readability instead of shrinking the whole table.
- Mermaid diagrams fit the reading column and provide source and expand actions. Rendering errors stay beside the diagram; source remains editable and savable.
- An update is a content entry, not a chat bubble. Show timestamp and supplied editing-agent attribution without inventing human identity.
- An external source’s description is read-only and sits in a source card: 12px radius, the boundary ring, and a 40px header bar on the recessed surface naming the author and action (“vantoan19 opened this issue on GitHub · Oct 31”), Read-only, and a link to edit or view it at the source. The header’s source name and Read-only mark are the provenance signal.
- The source conversation is one connected timeline, like Activity. A comment is a comment row with no card: a 28px badge on the line, a caption header naming the author, “commented on GitHub”, the time, Read-only, and a View link, then the comment body. Its events, such as closed as completed, closed as a duplicate, reopened, or an assignment change, are compact rows: a 28px circular icon, the actor, the event, and the time.
- **Documents** use a fixed 340px navigator beside their reader; below an 880px content panel the list and reader take turns. Its 48px PaneHeader holds the count, Search and New icon buttons. Search or / while the list has focus unfolds local SearchInput into that same header; Escape clears and folds it back, while ⌘K remains global. Recent / All / Trash occupy one 48px row beneath it. Escape from the reader returns to the preserved list position after editing ends. Pinned and Recent have recessed 36px group bands and counts; 52px navigator rows show title, Plan context or origin and tags, and a trailing compact updated time. The list has one row tab stop: J/K, arrows and Home/End move focus, Enter opens, P pins, and Right arrow focuses the exact-time tooltip (Left or Escape returns). Tags and pin controls remain pointer-accessible without adding tab stops. Pin regrouping and recent ordering wait until pointer and keyboard focus leave the navigator. “Show 50 more” and Show update details retain their existing queries and behavior.
- The Document reader has a fixed 48px crumb / Edit E / pin / More header, one scrolling column up to 720px including 40px side gutters, 44px top padding (24px side gutters in a single-pane reader and 16px below a 480px pane), a 32/40 title, caption metadata, 16/26 prose with 18/28 headings, local Mermaid figures, and Linked connections below the body. Existing Plan links supply context and navigation; no new stored data is introduced. Trash uses a compact notice above the title without moving it. The title edits in place at its own size without a box; formatting and save feedback use the shared floating bar. One stable 32px metadata row keeps Updated in Read and Edit and names the saved record’s storage state: “Saved on this computer”, “Synced to Drive” only after confirmation, or “Needs review”. Pending or unlisted uploads never claim to be synced. This status remains after the floating bar’s local Saved feedback fades; Needs review stays visible alongside an unsaved draft. The metadata and floating bar have distinct accessible status names.
- Activity is one timeline under its composer, joined by a single 2px line as on a GitHub issue. Updates are comment rows on the line, with no card, whose header names the supplied agent and the time. Recorded changes are compact event rows, visually quieter than updates, with their 28px icon on the line; changes made together share one row. All | Updates hides the event rows.
- The update composer is **one frame from the first frame**: idle, a 40px field "Write an update…"; opened, the editor sits in the same frame at the timeline's 14/20 and the frame grows only downward as the text grows (to 40vh, then it scrolls), so nothing above it moves. Its bottom row reads "Draft saved · [attach, source] · + · Discard draft · Post update ⌘↵"; ⌘↵ posts from anywhere in the frame. "+" is a menu: Add details, Use a Document as details… (a title-search picker under the "+", never a raw ID). An attached Document is a record chip with its own ×; while one is attached "+" is gone rather than disabled. Blur is not submission; whitespace-only text cannot be posted.
- An update's header is one line that never wraps: "codex · 5 h ago · edited", then "Latest" as a small tag; the exact times are in tooltips. Its "…" (Reply, Edit update, Delete update) waits in its slot until the row is hovered or focused. Edit happens in the row: its body becomes the editor with Cancel edit and Save update under it. Reply starts the composer with a quote and scrolls it into view. Delete asks in a small popover anchored to the "…" ("Delete this update?", Cancel, destructive Delete update), and the result is said in the pane's status line. Details show as a Document chip. A recorded change keeps its time in a right-aligned column. An update opened from a link flashes `--accent` once, with no ring.
- With the Updates filter on and only recorded changes present, Activity says "No updates yet" with Show all activity, never "No updates or recorded changes".

Description autosave and explicit Post update submission remain different interactions. External CLI updates refresh saved values while preserving drafts. A conflict notice offers Reload saved content and Save my draft, with enough text to explain the overwrite. Do not move the notice out of view when a refresh occurs.

## 9. Attention, reminders, evidence, and duplicate review

### Attention inbox

The Inbox is the 392px list half of a triage split: an entry opens its ticket beside it. Groups are Needs you (an orange 6px dot and count), Updates, and Earlier (read entries before today). Needs you starts with Chat approvals using their first linked ticket, then agent-attributed transitions to In review while the ticket remains In review and the latest status-history transition matches that review cycle, then current due reminders. Read state does not resolve attention. The current reminder query distinguishes a due reminder from a historical cleared or snoozed occurrence. Needs you always appears ahead of paged updates, including older attention entries.

The initial loading state reserves a neutral 36px group heading and the final row anatomy, using the shared delayed, still Skeleton. It announces “Loading Inbox” without claiming an urgency group before the read completes. Rows retain the same heading, unread-dot, icon, reference, title, summary and trailing-time positions on arrival; background refreshes keep the saved entries.

Rows have an 8px horizontal inset, 8px radius, 10px vertical padding, a 10px unread-dot lane, a 22px icon lane and trailing relative time. Known harness names use their marks; other attribution retains its name without inventing an identity. The reference and title sit above the summary. Needs you alone turns the sidebar count orange; other unread entries use a blue dot without a visible number. The All / Unread toggle is removed. Mark all read appears only for shown unread entries and routes Chat approvals through Chat read actions. E and H stay on an opened Inbox row; Snooze has a visible “Snooze until” heading. With no Needs you entries, “You're all caught up” appears while updates remain available. Show read entries brings the older read entries into view.

The desktop's own unattributed changes do not notify the person. Opening a ticket entry marks it read; an entry for a deleted update says “Update deleted”. Read rows remain legible. Row actions overlay the time on hover or focus. Older updates load with “Show 50 more”. Navigation to an update reveals and focuses the relevant content without silently changing ticket status. Follow and reminder settings remain personal to the local person. Inbox remembers its split independently from the ticket List and Board.

The selected entry has a triage Card above its Ticket, with a 13/20 context header: the trigger and attributed harness, the existing latest update brief, and actual pull request or verification evidence when available. The linked Ticket's reference and title stay in the Ticket below rather than repeating inside the card; unlinked or still-loading approvals retain their identification. Evidence uses one 12/16 inline caption row. Move to Done accepts an agent review; Clear reminder clears the current due reminder; Review in Chat opens the existing Chat detail and request dock inside the same split. Reply quotes the entry into the Ticket’s existing Activity composer, including when empty Activity is folded. An unlinked Chat explains why Ticket actions are disabled while keeping review available.

J/K and the detail header walk Inbox entries. Selection holds the queue, grouping and order through read changes, resolutions, reminder changes and incoming updates. After an approval is answered in the embedded Chat and the host confirms no requests remain, focus returns to the held Inbox entry so J/K continue triage while the Chat stays visible. Further pending requests take focus in order; a failed answer keeps its choices available, and host updates do not take focus from a composer being typed in. Moving on or leaving the reading interaction releases that snapshot. The Ticket’s editors stay mounted while the approval Chat occupies its detail pane. The document cross-fades using the shared 140ms token, and reduced motion removes the fade.

Inbox mutations share one status line, with a 10-second Undo, persistent failure and explicit Retry using the original write request IDs. Undo restores captured status, reminder and read values. Explicit review Undo also retains a validated, device-local restoration projection scoped to the Workspace: it names the original entry and the exact observed Undo status transition, survives reload, and expires when the host reports another transition. It never changes attribution or treats a later local review as the old agent review. Mark all read touches only shown unread entries and sends Chat identities through Chat read actions. Read-only controls explain why changes are unavailable.

### Reminders

A reminder editor contains a heading, date/time input, short local-time hint, and one primary schedule/reschedule action. Show the current scheduled time when one exists, with Snooze and Dismiss as secondary actions. Ambiguous daylight-saving times require an explicit choice; invalid times show an inline error. Custom times that have passed are refused with “This time has passed. Choose a future time.” The palette, property picker and legacy reminder editor share this validation and recheck the chosen instant on submission, so a draft that expires while open cannot schedule silently.

Use the locale's date/time presentation. Show exact time and zone where choosing a time needs precision. Do not put storage timestamps, request IDs, or UTC serialization explanations in ordinary helper copy. Due attention appears in the inbox; the interface must not promise delivery while the app is closed.

### Implementation evidence

Each record is a row with the same three lines at any width: the name (14/500) with its actions at the right; a caption "Pull request · 2 h ago · codex"; then the value: a readable link (a GitHub pull request reads "example/app #57"), a short commit reference with the full hash in a tooltip, a branch, worktree path, or verification result. Copy and "…" (Edit, Delete) wait in their slot until the row is hovered or focused. Pasting a pull request link into the dialog fills its type and name. Delete asks in a popover anchored to the row's "…".

The value is the open action where it is an address; Copy stays available for every value. Do not imply that a pasted pull request URL is connected to live platform status. Keep Edit and Delete subordinate to the evidence itself. With no evidence the section folds into the ticket's quiet add row.

### Duplicate dependency review

Use a dialog or expanded review pane, not a small popover. Show the duplicate and canonical ticket by reference and title, the resulting Duplicate status, and each affected dependency with its current and proposed endpoints.

Each edge has an explicit retain, remove, or replace choice where valid. The final action states what will be applied. A stale preview or cycle error keeps the review visible and requests a fresh preview; no partial success presentation is allowed. Removing a duplicate designation must explain that dependency replacements are reviewed separately. Preserve access to the duplicate's description and history.

## 10. Projects, Plans, graph, and settings

A Plan is a scoped list. Its views reuse the ticket list's typography, filters, row density and selection. Over both panes it has one 48px pane header and a reserved two-row summary, so loading, failure, renaming and view changes never move the controls or list.

- **Header:** the 16px Plan ring, name and full ticket count, then the List/Board/Flow switch, outline "+ Add tickets" and More (Rename F2, Link a Document…, Open graph, Filter and display…, Archive Plan). Filter and display opens the existing shared controls; global search stays in the command palette. Rename occupies the title's slot, with More retained. An archived Plan shows Archived, Reactivate and Open graph. The switch has the same position in every view. Below a 640px pane, the shared responsive PaneHeader reserves two rows, keeping the Plan name and count above the actions. The summary reserves a 184px narrow layout: purpose, progress, a wrapping legend and the spec action stay within the pane across loading, success and failure.
- **Summary:** padding 18px 20px and 12px between two 24px rows. Purpose uses 16/24, edits in place and truncates. The second row has the shared 280px split bar, authoritative done/countable counts (including zero), a compact status and Ready legend, and the spec Document pill at the right. Canceled and Duplicate are explicitly not counted. The page split bar uses the accent track. Loading reserves both rows with a still skeleton; errors and rename hints use the progress row. The spec's existing menu opens, sets or stops it as spec, or removes it; other Documents remain behind "+N". The ledger context lane shows parent or project, never the current Plan. Remove-from-Plan tooltips open above their row.
- **Feedback:** archiving, Remove from Plan, removing or unsetting a Document and adding tickets act at once and say so on the status line with Undo; a failure is the status line's failure with Retry, never a banner pushed into the header. Archive/reactivate stays distinct from completing tickets.

The Next up link uses the shared RecordLink row variant: muted mono 13px reference, plain 14px truncated title and no idle underline. Focus remains visible and the link opens its ticket independently of the Plan card. Workspace graph Plan labels and authoritative membership are structural metadata independent of matching records and displayed edges. Type, search and relationship filters retain truthful island grouping while Graph, List and item counts describe the same matching identities.

The **Plans** and **Projects** pages are management pages: PageHeader with its count, a one-sentence lede and one sm primary ("New Plan", which names the Plan in a small dialog and opens it; "New project"). Plans uses the centered management-page layout (860px maximum, 44px top and 40px side gutters; 24px and 16px when narrow). Active / Archived and the primary New Plan action share the header row. Cards sit 14px apart on `--card`, with `--radius-panel` and `--shadow-card`, 20px padding and 16px below. Each card shows a 20px `PlanRing`, name, derived project caption, optional purpose, authoritative done/countable counts, the newest member update time, `PlanSplitBar` and its status legend. Canceled and Duplicate remain separately named as not counted. Next up links to the first Ready member in Flow order (In progress, In review, Ready, Blocked; most open dependents unblocked first, then descending natural reference, matching the S10/S12 drawings), and the spec Document has its own link. A Plan with no Ready work says so. Cards keep their order during updates. The shared summary Card reserves the ring, heading, progress, legend, next-ticket and failure slots from its first frame; still skeletons occupy only data that is loading. Counts remain authoritative, and a failed refresh keeps the last data. Unavailable progress is omitted without collapsing its slot; the existing retry direction occupies the reserved caption. Narrow management headers wrap controls below their title and copy before the title can split within a word. Archived cards mute the name and reveal Reactivate on hover or focus (with Undo). New Plan uses N on this page and is also in the command palette. A project row is its icon, name and "10 tickets · 8 open · 2 checkouts", Open tickets and one "…" (Rename…, Copy project ID, Register checkout…); it opens in place to its checkouts, each a muted middle-truncated path with Copy path, Show in Finder and Remove revealed on hover or focus. Removing a checkout acts at once with Undo. Rows are 48px with a full-row `--hover` fill; a second removal within 400ms of the last is ignored so a double-click never removes the row that moved up.

### Graphs

There is one graph experience, built from one kit in `components/ui/graph-kit` (`ui-graph-` classes; feature stylesheets keep layout under `tgraph-`, `cgraph-` and `plan-dependencies-`). Three surfaces use it: the **Workspace graph** (sidebar), an item's **Graph** (a ticket, Document or Plan; "Open graph" in the ticket header menu, the rail's Relationships, a Document and a Plan), and a Plan's **Flow**. A ticket's Graph opens on Dependencies, the tickets joined to it by "blocks" with Ready and Blocked; "All connections" is one click away in the row under the header.

- **Header:** a PaneHeader with the ReturnCrumb (`← T-FV1 /`), the title and its count ("5 tickets", "7 items"), and Graph | List at the right, always present; an option that cannot apply is disabled. One 44px row under it holds what to show, the filters and "Update details"; at a narrow pane it wraps rather than clipping.
- **Canvas:** `--surface` with `--border` dots, filling the space beside the panel. It opens and fits at 100% and never below: a larger graph pans, and List is the way to see everything at once. The legend is one 28px row inside the canvas, top-right, naming only the kinds drawn, with the same words as the lines; nothing shows without lines. Zoom is bottom-left inside the canvas: −, the percentage (click for 100%), +, Fit; − and + disable at 50% and 200%; the readout is not a live region; "{n} not in view" follows when cards are outside or cut. A one-line caption beside it states scope ("7 items · 9 connections · Load more", "Showing up to 5 links…", "Dashed: 1 ticket outside this Plan"). Empty, isolated and failed states are a centred EmptyState in the canvas.
- **Lines:** all in `--muted-foreground`, told apart by pattern, never colour: "blocks" is the only line with an arrowhead (a small one, pointing at the ticket that waits); parent of and discovered are solid, related and Plan structure dashed, references dotted. A line shows its name only beside the selected card.
- **Node card:** 224×64, two lines that never wrap: line 1 is the status or kind icon, the mono Reference, the state word (truncating) and, for a ticket, the Ready or Blocked dot word at the end; line 2 is the title, truncating. Hover `--hover`; selected is `--accent` with a 1px `--interactive` ring; focus is the outline; a ticket outside the scope (a Plan's outside blocker) is dashed `--control-boundary`. Every card is a button.
- **Panel:** a fixed 280px column at the right, on `--surface` with a hairline: a 12px line with the icon and Reference or kind, the title 14/20/500, a caption ("Todo · Board polish · Desktop app"), then sections titled by relationship from the item's side ("Blocked by 1", "Blocks 2", "In Plan 5") of graph rows, and a pinned footer: "Open T-FV2" (primary sm) and "Center here" (ghost sm, left out for the centre). A row is `[icon][Reference][caption]` over the title (two lines at most); it selects a drawn item or centres the graph on one that is not. A panel that could not load says so with Retry; "Show more" pages long lists. Below a 640px pane the panel moves under the canvas at 40% of the height.
- **Workspace graph:** opens Graph by default. Its header says “Workspace graph · N items · M connections”, followed by Filter and Graph/List. Below a 640px pane the shared responsive PaneHeader keeps the name and count above the actions in two reserved rows. Filter holds the existing item search, Type, Relationship, Tag and update-details controls; F opens it, Shift+V switches the view, and both commands are in the palette. Plan islands use authoritative, fully paginated membership and linked Documents, with the full PlanCounts ring. Every loaded item appears in both views: a Plan is its selectable island label; its tickets and Documents are 216×60 graph-kit cards; items outside every Plan use 28px chips beneath the islands, with a nonshrinking glyph/reference group followed by an ellipsized short title. The wells express membership and linked Documents; the panel names every relationship, including structure. Blocking, related and spec connections retain their line patterns, with only selected incident lines emphasized. Center here pans this canvas; the list’s Focus on this item action opens its context graph. Missing authoritative members or Documents fail visibly with Retry, rather than showing a partial island. Required membership, blocking and spec relationships are joined across hydration batches. Remaining cross-batch graph limits are explicitly stated in the scope caption. The workspace’s existing candidate-page limit and Load more remain visible.
- **Plan Flow:** replaces the Plan Dependencies canvas beneath the unchanged header and summary. Open members (excluding Done, Canceled and Duplicate) occupy Now with no unresolved prerequisites, Next when all prerequisites are in Now or outside the Plan, and Later for deeper chains and cycles. An outside blocker counts as depth zero and is named “(outside this Plan)”; cycles say “(they block each other)”. Unresolved canceled or duplicate prerequisites still hold work back, consistent with readiness. Status priority is In progress, In review, Ready, Blocked, then most open dependents unblocked, then descending natural reference (the drawings show FV15 before FV14). Started work is never forced into Now. Shared graph-kit Flow wells and three-line card variants use the board surface, card radius and shadow. Each 40px lane header stacks its name above the muted caption, aligned to the same left edge. Selected cards highlight only incident edges; SVG arrows always point right, while same-lane/cyclic links remain explained by the reason. J/K and arrows select cards, Enter opens a ticket, and Shift+G on a focused Flow card opens the full graph (also available in the palette). Horizontal overflow preserves lane order in narrow panes. “Open the full graph” opens Workspace graph scoped to authoritative, fully paginated Plan membership and its linked Documents; graph limits remain explicit. The Plan's Add tickets picker reuses the shared core search, including partial references.

Relationship names come from one glossary (GLOSSARY.md, "Graph relationships"); counts say "connections".

Settings are described in the next section.

### Attachments

The Attachments library uses a 360px navigator beside the preview. Below an 880px panel, the panes take turns; Back and Escape return to the same row and scroll position. Live refresh waits while the navigator is hovered or contains keyboard focus.

- **List pane:** a 48px pane header with "Attachments", its count when the whole library is listed, then Search (expands in place), Filters (a menu: All files, In use, Unused, Quarantined; a chosen filter shows as one filter chip under the header), "…" (Clean up unused files…, Storage settings) and an Add files icon button. Search unfolds in the title slot at the same 48px height; / opens it and Escape clears it, folds it and returns focus to its trigger. An empty library shows only the title, Add files and the EmptyState.
- **Rows:** 56px navigator rows reuse the Documents navigator surface. A 32px thumbnail (radius 6) precedes the 14px name and 12px caption, "PNG image · 2.1 KB · Used in 1"; time occupies a fixed trailing slot. A state word leads the caption where one applies (Quarantined, Deleted, Deleting as neutral badges; Missing with its attention dot); storage appears when the file is not simply on this computer. The row menu retains Open, Rename…, Download, Restore, Remove from ticketd… and Delete permanently…. ↑/↓, J/K, Home and End move focus; Enter opens the focused file. One row is a tab stop. Paging is "Show 50 more". The hint card reads: "Drop files anywhere on a ticket or Document to attach them. They are kept on this computer."
- **Preview:** the shared 48px PaneHeader shows the family glyph and name, outline Open (Open in Drive), Export and Copy link, More, and Back to Attachments in the library. The viewer retains Close and is top anchored like other dialogs. Rename edits the name in place; Replace… swaps the viewer for the picker. The stage keeps 340px height with 20px/24px outside gutters and radius 12 across loading, media, missing and failure states. Images use a recessed/accent checkerboard; audio and video keep playback controls and text uses a mono excerpt. Unsupported formats keep Open and Export, with Retry only for failures that can recover. Missing files retain the attention Alert, replacement/backup recovery routes and disabled Open with its reason; quarantine retains Restore file. The facts grid uses 120px labels, a flexible value column and 12px row gaps: Stored, Type, Size, Added and Used in. Original name appears when it differs. Used in retains navigable record links and the kind of each reference. Action failures follow facts so they do not move the stage. /, Add files (⌘⇧U), Open (O), More (.) and Back (Escape) are registered and available through the palette while the library is active.
- **Attach file / Add files / Replace:** one DialogShell md whose body keeps one height across the Upload, Existing files and Google Drive tabs. Upload has a dashed `--control-boundary` drop zone that fills on drag-over ("Drop to upload"), "Any file type · Up to 100 MB each", and where uploads go. Queue rows read "31 KB of 2 MB", "Attached" or, for a file over the limit, "Too large: 101 MB. The limit is 100 MB." with Change limit (Settings › Attachments) and Remove; row actions are never primary. Existing files is search first (a pasted ticketd link finds its file), with checkboxes on the left and "Insert selected" in the footer, the count in the note. An unconfigured Google Drive says so in one line with the way to its settings, never a disabled button.
- **Clean up and confirms:** Clean up is DialogShell md with Select all, the unused files, the protected ones folded under "Protected" with their reasons, "2 selected · 3.5 KB" in the note and a constant "Move to quarantine"; moving offers Undo in the status line. Delete permanently and Remove from ticketd are DialogShell sm confirms with a question title; the primary is left out when something still protects the file. Sizes are written "100 MB", never MiB or ".0".

### Settings

Settings is a dedicated page made of pages: the section nav opens exactly one section at a time, and nothing scrolls to a card. It replaces the sidebar with its own nav, and the content panel keeps the same inset and shadow ring. Every page is composed from one shell and the shared components, using semantic tokens only.

**Nav.** The nav is 232px wide. From the top: **Back to {the view Settings was opened from}** ("Back to tickets", "Back to Attachments"); a **Search settings** entry, a 32px nav row like the others (never drawn as an input), which shows a non-empty query as muted words and a ⌘F hint (Ctrl+F outside macOS) and opens the Search page, where that shortcut (⌘F on macOS, Ctrl+F elsewhere, never both) also leads while Settings is open; then the groups below. Each item has a 16px icon, the active item uses the accent fill with `aria-current="page"`, and every item opens its own page. Below 768px the nav is the navigation sheet (at most 280px, or the window less 32px), opened from the open page's name in the panel bar ("☰ Appearance ▾"), which carries an attention dot while a section needs setup. Links from elsewhere, such as the Attachment Library's, open the page that holds the setting.

| Group       | Sections                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------ |
| Preferences | Appearance, Attention                                                                            |
| Workspace   | Location, Attachments, Backups, Export                                                           |
| Agents      | Command line, Agent skills, Chat (Experimental badge)                                            |
| Connections | Google Drive, then one entry per available source (GitHub), added only when its connector exists |
| Help        | Keyboard shortcuts, About                                                                        |

The list lives in `settings-sections.ts`; a section is added there with its page. Two indicators sit at the end of an item and carry a spoken label: an attention dot, "Needs setup", on Command line (the tool is not found or needs attention), on Agent skills (a detected agent lacks the skill, or its copy needs attention) and on Chat (Chat is on and no harness can start a Chat); and a positive dot, "Connected", on a source with a saved configuration. The page says the same words in the same tone. Pages that change what an indicator reads ask for it again, so the dot follows without reopening Settings.

**Page shell.** A page is the panel bar and a centered column.

- **Panel bar:** sticky, 48px, with the breadcrumb `Group / Page` at 14/20 (group muted, page in the foreground color at 500) and an end slot. The end slot reads "Changes apply right away" with a check icon on pages whose controls apply immediately (Appearance, Attention, Attachments, Chat), shows a source's save state on source pages, and is empty elsewhere.
- **Column:** a 640px content measure, centred within a column with 32px side padding, 36px above and 80px below.
- **Page header:** the shared IconTile (40px, panel radius, recessed fill, border ring, 20px icon), the page title as the `h1` (24/32, 600) and a one-sentence lede (14/20, muted, at most 560px). The `h1` takes focus when a page opens; Search focuses its input instead. A badge may sit beside the title.
- **Sections:** 32px apart. A level 2 heading row holds the title, an optional caption (12/16, muted, at most 520px) and actions at the end, such as Check again, Sync now or a status label; 12px separate it from the content.
- **Lists and rows:** a list is a surface with the panel radius and the shadow ring, its rows divided by the group hairline. A row has an optional leading IconTile (in a list every row has one or none does), a title (14/500) with a description (12/16 muted) and trailing StatusLabels and controls, all 32px (`sm`) and 8px apart, at least 64px tall with 12px × 16px padding. Focus inside a list is an inset outline. The top-aligned variant serves switches and wrapping text; the stacked variant serves full-width controls.
- **List footer:** a list may end in a recessed footer (12/16, muted) for explanations, results and secondary actions. Keep export and backup explanations and their success and failure messages in the footer beside their actions. A failed JSON export offers Retry, reopening the save chooser at the previous path before another write; canceling writes nothing.
- **Choices and controls:** use ChoiceTiles for an exclusive choice that deserves a title, a sentence or a preview, a segmented control for two to four short options, and a switch for an on/off preference. A status is always a StatusLabel: a dot beside its word, never a coloured icon, bar, underline or tile corner. A path is PathText (file name, then its folder shortened in the middle, the full path in a tooltip) with Copy path and one RevealButton ("Show in Finder") beside it. A command to run is a CommandBlock, and ordered instructions are Steps.

**Saving.** Each page uses one of three models and says which.

- **Immediate:** Appearance, Attention, Attachments' destination and Chat apply when changed. There is no Save button; the panel bar says "Changes apply right away". A failure appears beside the control.
- **Save on blur:** a text value, such as the upload limit, saves when the field loses focus and says "Saved" beside it for two seconds. Drive keeps its failed name or interval draft, says "Not saved" in the reserved caption, and offers Retry for the same setting assignment. Editing that draft clears the old recovery action. Invalid input and failures are stated next to the field and the previous value stays in force; the next valid value clears the message, even when it is the value already saved.
- **Explicit Save:** a source is the exception. Its discovery rules are a draft with a save bar stuck to the bottom of the panel: a status (dot and sentence: Saved configuration, Unsaved changes, or the rules changed and need a new preview), **Discard changes**, **Preview matches** (hidden once the preview is current) and primary **Save**. Save stays unavailable until Preview matches has run for the current rules and something changed. Saving turns discovery on and says that matching issues are imported on the next refresh. A saved source also shows its sync schedule and when it last synced ("Synced 4 min ago"), with Sync now in the Sync header. Its Connection section keeps two facts apart: the saved connection ("Connected as X" or "Not connected", the words the ticket menu uses) and the account check ("Signed in as X").

**Pages.**

- **Theme:** Appearance offers System, Light and Dark as neutral ChoiceTiles with 96px miniature windows and a 2px foreground selection ring. System shows both themes through scoped tokens; Light and Dark each show their represented theme, while the outer tile follows the app theme. System is the default, follows the operating system live and says which theme it is right now; the choice applies without reloading.
- **Open tickets:** two grouped radio rows: "Beside the list — The list narrows so you can move with J and K while you read." and "Full width — The ticket takes the whole panel; Esc returns to the list." The saved preference applies to the next ticket opened from a list.
- **Agent skills:** one list for the ticketd skill: its overall status, a sentence on what it does, and one action that installs or updates it for every supported agent found on this computer ("Install for Claude Code and Codex"). A second list has a row per agent with its status and skill folder. A copy that was edited or not written by ticketd is left out of that action and offers Replace… on its row, which goes through a review dialog that says the current file is saved as a backup. Check again sits in the section header. Its first loading row uses the same SettingsRow anatomy as the known status, so the next section stays in place. Rechecking retains the known agents and setup status; a failed read offers Retry without claiming none were found.
- **Command line:** the status of the ticketd executable, with not-found shown as Steps toward Check again, then the quick reference as CommandBlocks whose colored words are placeholders to replace. Initial loading reserves the actual status and three-step guide anatomy. Rechecking keeps the known status and guide; a reserved feedback row reports checking failures with Retry, so the quick reference stays in place.
- **Restore review:** an unrestorable or unreadable file is titled "Review backup" and offers another file. The scrolling review body has a divider below the fixed header; opening Attachment details reveals the existing completeness information within that scroll region.
- **Backups:** one list of three rows: Last backup (the file as PathText, Checked, Show in Finder), Back up now and Restore from a backup, both outline sm; "Backing up…" only once the save sheet returns a path. What a backup contains reads Included and Not included in words with muted icons. Safety backups list their file and offer Restore…, which opens the same review.
- **Google Drive:** one horizontal Steps row (Connect, Choose a workspace, First sync, In sync; a check when done, the current step in primary, no green) above the content for the current stage. Choices are ChoiceTiles, and the Files are not encrypted notice stays visible before connecting.
- **Keyboard shortcuts:** a filter, then groups of keys in one right-aligned column, each with a spoken label; an empty filter offers Clear filter. The scope order is Everywhere, Lists, Ticket, Plans, Chat, Dialogs and menus, First run, independent of contextual action priority.
- **Chat:** the Show Chat switch, then, while Chat is on, a Harnesses list: one row per harness with its official mark, its status in words, the version or the reason, Copy command where a terminal step helps, and Check again in the section header.
- **Search:** a labelled input, a status line, and results grouped by section as link rows with the match highlighted (semibold with an underline, not color alone). With no query it shows only the input and its status line; a query with no match shows an unboxed empty state that offers shortcuts to common sections, and the status line is then spoken only. Results come from one registry beside the section list, with one entry per setting; a test keeps every entry pointing at a real section.
- **Restore, replace and disconnect:** restoring a workspace backup always goes through a review on DialogShell lg titled "Replace this workspace?": first an attention notice that it replaces everything including follows, reminders and inbox state, then this workspace beside the backup at 14/20 (differing values at 500), the chosen file, and attachment details behind one disclosure. The footer note says a safety backup comes first; the only destructive control is "Replace workspace" ("Replacing…" while it runs). A file that cannot be restored shows why at the top, hides the destructive button and makes "Choose another file…" the primary. Google Drive's download replaces the workspace too and uses the same grammar with a destructive primary. Replacing an agent skill, disconnecting Google Drive, switching its account and turning Chat off ask first in a dialog that names what changes. Never use a browser confirmation.

Agent skills and Command line check when their page opens and when Check again is
chosen; skill installation also reads the resulting state. These checks refresh
the nav's setup dot, whose update never starts another page check.

## 11. Design system and shared components

ticketd's interface is assembled from one design system: the tokens in `apps/desktop/src/styles.css`, the bundled Geist fonts, and the shared React components in `apps/desktop/src/components/ui`, which are shadcn/ui copies restyled with the tokens. A web client can reuse them by building the same source; a separate package earns its place only once a second app imports the components.

### Levels

Build from the bottom up. A piece may use anything from a lower level, never from a higher one.

| Level                    | What lives there                                               | Where                            | Examples                                                                                                                                                                                                            |
| ------------------------ | -------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 · Tokens               | Named decisions; the only place raw values live                | `apps/desktop/src/styles.css`    | `surface`, `muted-foreground`, `radius-panel`, `shadow-menu`, `text-ui`                                                                                                                                             |
| 1 · Base components      | One job each, no ticketd words, tokens only                    | `apps/desktop/src/components/ui` | Button, IconButton, Input, Select, Switch, SegmentedControl, StatusDot, StatusLabel, ChoiceTiles, CommandBlock, Steps, Badge, Reference, Count, Progress, Kbd, Tooltip, Skeleton                                    |
| 2 · Composite components | Content-agnostic compositions with slots                       | `apps/desktop/src/components/ui` | Field, Picker, ChoiceList, TagPicker, Menu, Popover, Dialog, DialogShell, Sheet, Command, ListHeader, PaneHeader, PageHeader, EmptyState, Alert, StatusLine, SectionHeader, Card, Item, Timeline, EventRow, Sidebar |
| 3 · Product components   | ticketd recipes that know tickets, statuses, sources and Plans | `apps/desktop/src/features`      | StatusIcon, TicketRow, TicketPicker, RecordPicker, property bar, Activity, source card, Filters and Display, bulk bar                                                                                               |
| 4 · Layouts              | Page structures that place components                          | `apps/desktop/src`               | App shell, split view, ticket page, management page, Settings                                                                                                                                                       |
| 5 · Screens              | Real screens with real content                                 | `apps/desktop/src`               | All tickets, a ticket, Inbox, a Plan                                                                                                                                                                                |

Levels 0–2 live in `components/ui` and `styles.css`; levels 3–5 live with their features. Interactive components wrap a Radix primitive (Select, Popover, Dialog, DropdownMenu, Switch, Tooltip) that supplies keyboard, focus, and ARIA behavior; features use the wrapping component and never style a Radix part directly. Recurring combinations of components are patterns, written in this document rather than coded: empty, loading, and failure states (section 12) and the choice between menu, popover, and dialog (below).

### Catalogue notes

What the shared pieces do and which variants exist; each has a JSDoc summary in its file.

- **Badge** labels a tag (`tag`), an external source reference such as #98 (`source`) or a Document chip (`doc`, 28px). `size="sm"` fits ticket rows and `tone="raised"` sits on a recessed control. **Reference** is a ticket or Plan reference in the mono face, **Count** a caption-size tabular number beside its label, and **Progress** a 64px bar that is named with `aria-label` and has its words beside it; it keeps an edge and a system fill under forced colours.
- **SectionHeader** is the heading row of every section: a heading (`level` 1 to 3) that holds the optional count, so the name reads “Evidence 2”, then controls (`children`) and `actions` pushed to the end. `caption` is a muted note on its own line under the row. `bar` makes the 44px header that opens a panel.
- **Card** has a header band, body and recessed footer for a source description card or a management card, not for comments, updates or evidence; `asChild` lends it to a `section` or `article`. **Item** is one 36px row for a small list inside a section, with a leading icon, a Reference, a truncating title and trailing meta; `asChild` lends it to an `li`.
- **ChoiceTiles** is a radio group of tiles (`ChoiceTile`) wrapping Radix RadioGroup, for an exclusive choice that deserves a title, a sentence and often a `preview`. Two or three `columns`; the default chosen tile wears a 2px interactive ring; `preview` uses a neutral 2px foreground ring and `rows` groups 64px radio rows with hairlines and 12px × 16px padding. A disabled tile goes recessed, and `children` add detail that must not be interactive. It replaces the separate choice-card styles; name the group with `aria-label` or `aria-labelledby`.
- **StatusLabel** is a StatusDot and the word that says what it means, the one way to show a status. `size` is `ui` (14/20) or `caption` (12/16).
- **CommandBlock** shows a command to run in a recessed mono block with a muted `$` prompt that is not selectable or copied, ALL_CAPS words (PATH, TICKET) as placeholders in `--syntax-keyword`, a copy icon button and a transient “Copied” status. Say near the block that colored words are placeholders.
- **Steps** is a numbered list joined by a thin line; each `Step` has a title, a description and an `action`, and may be `done` (`--status-ready`) or `current` (primary), with words beside the state where it matters. Its `settings` variant uses a radius-12 group with one boundary, 64px minimum rows, 12px × 16px insets and hairlines, without the joining timeline.
- **Timeline** joins comments, updates and recorded changes with one 2px line, in Activity and the source conversation alike. A **CommentRow** is a comment or update with no card: a 28px badge on the line, a caption header with actions at the end, and the body beneath. An **EventRow** is one recorded change, a 28px badge with the change’s icon, the sentence and caption-size meta. A status change shows its new status icon, so Canceled and Duplicate never look completed.
- **Alert** is the one inline notice: a short title (`level` makes it a heading where the notice replaced one), one sentence and real buttons. Tones are `neutral`, `attention` (a status dot in the title) and `error`; size `compact` is the single-row form for transient confirmations such as “In Trash”. It defaults to `role="alert"`; pass `status` for a calm update.
- **EmptyState** comes in `block` (an empty view: a 40px IconTile, title 14/20/500, one sentence at most 360px wide, sm actions; top-anchored 48px below the region's last fixed row, never boxed; `anchor="center"` inside a canvas), `inline` (a row inside a card or section, the action at its end) and `hint` (a quiet pane with one line and an optional footnote; it carries no icon, description or action). Its words come from the one registry in `lib/empty-copy.ts`.
- **Tooltip** labels the control it wraps (section 4): `content`, an optional `shortcut` drawn as inverted **Kbd** chips, a `side` that defaults to the region's (**TooltipSide**: right in the sidebar), and `overflowOnly` for a truncated name. **IconButton** names its button and shows the same label.
- **DialogShell** is the one dialog (below). **DialogContent** is used directly only for the `viewer` size of the attachment and diagram previews.
- **ChoiceList** is the one searchable list, for a popover (`PopoverContent variant="list"`) or a dialog body. **Picker** is its closed, single-choice Select form; its options take an icon and a `clear` flag. **TagPicker** is a field of tag badges that opens a multi-choice ChoiceList offering "Create “x”". **TicketPicker** and **RecordPicker** (level 3) are ChoiceLists over a search: tickets, or tickets, Documents and Projects in groups.
- **OverlayBoundary** marks the region overlays opened inside it stay within: the content panel, or a pane body for a picker inside a pane. Dialogs reset it.
- **IconTile** is the 40px recessed tile with a 20px muted icon, one recipe for page headers, settings rows and empty states; in a list every row has one or none does.
- **StatusLine** (`StatusLineRegion` and `useStatusLine`) is the pane's one transient line; section 12 gives its rules.
- **PaneHeader** is the 48px header of every pane (lists, detail, graph, Chats, Inbox). It never wraps: the title truncates, its Count sits 8px after it, the right cluster holds 32px controls in a fixed order (Refresh, Search, Filters, Display) and `PaneHeaderButton`s collapse to icons with tooltips below a 420px pane. Search expands in place over the title; `caption` adds one 28px line for single-status views; `icon` puts a 16px muted mark before the title and `titleEditor` renames in place at the title's height. **Input** `inline` edits text in place in its own type (a Plan name, a purpose). **ReturnCrumb** fills its leading slot with `← {Origin} /`, the origin truncated at 18ch. **PageHeader** and **ManagementPage** are the management page shell: a 960px column on the page gutter, title 24/32 with its Count, a one-sentence lede, one sm primary and a toolbar row.
- **CopyButton** is an IconButton whose icon becomes a check for 2s with the tooltip "Copied"; its optional registered shortcut supplies both the resting tooltip and `aria-keyshortcuts` (Copy reference uses the reference key only); menu items that copy say so in the status line. **Disclosure** (a 16px chevron, the label and an optional count; one level) replaces every raw `<details>`; **Clamp** keeps long text to about eight lines and decides by rendered lines, not pixels. **PathText** puts a file's name on line 1 and its folder on line 2, shortened in the middle, never broken mid-word, the full path in a tooltip (`inline` and `folder` layouts for prose and captions). **SearchInput** has the icon inside, a clear button (never the native ⊗) and a width that does not change with results. **Pager** is the one paging control, "Show 50 more", centred under the content. **Time** is a focusable `<time>` with the exact local time in its tooltip; `lib/format.ts` is the one module for counts, plurals, "N of M" and times. **Skeleton** is still and appears only after 300ms.
- **RecordLink** is a reference or record in running text: foreground text with a 1px `--interactive` underline at 3px, the link colour on hover, the mono Reference face; a reference that cannot be opened is plain. `[[T-KQ8]]` renders as the reference without brackets. Action links in captions are `Button variant="link" size="inline"` in `--link-foreground`.
- **Badge** also has the 28px `record` chip and the `filter` chip; **FilterChip** reads "Status In review" (dimension muted) with a 16px × in a 24px hit area. **SegmentedControl** segments are an equal-width grid that never wraps; labels truncate inside them. In **ChoiceTiles** the radio leads the title row on every tile and a disabled tile drops its ring.
- **Kbd** has an `inverted` tone for tooltips; **KeyChords** writes keys with the platform's glyphs (⌘ ⇧ ⌥ on macOS, Ctrl Shift Alt elsewhere). Every shortcut is listed once in `lib/shortcuts.ts`, which feeds Settings › Keyboard shortcuts, tooltips and `aria-keyshortcuts`; add a key there in the same change as its handler.

### Tokens

Primitive values, such as hex colors and pixel sizes, belong only in the token blocks of `apps/desktop/src/styles.css`. Components use the semantic tokens of sections 2–4, such as `background`, `surface`, `recessed`, `foreground`, `muted-foreground`, `accent`, `border`, `link-foreground`, `error-surface`, `status-ready`, `text-ui`, `radius-panel`, `shadow-menu`, and `focus-ring`. Component tokens exist only where a part needs its own role (`sidebar-*`). Light values sit on `:root` and dark values on `:root[data-theme="dark"]`. `[data-theme-preview="light"|"dark"]` on any element applies that theme's tokens, derived ones included, to its subtree, so a preview, such as Appearance showing both themes, uses tokens and no raw colors; inside it use tokens, not `dark:` utilities. Tailwind's theme maps the color tokens to utilities such as `bg-accent`; spacing and control sizes use Tailwind's 4px steps with the values in section 4.

### Rules that keep the system small

- Check the catalog first. Extend an existing component before adding a near-duplicate, and never give two components one name.
- Build a new piece inside the screen that needs it. Promote it to level 3 on its second real use with the same meaning, and into `components/ui` only when it carries no ticketd words.
- A variant keeps the component's anatomy and behavior and differs in function; otherwise make a separate component or a recipe.
- Put content in children or named slots. Use typed props only for design-decided options such as `variant`, `size`, or a leading icon, and start them narrow: opening an API later is easier than closing it.
- Reference semantic tokens only: no hex values, no magic numbers, and no `!important` overrides of a shared control from a feature stylesheet.
- Stay on Radix. When adopting a shadcn/ui component, copy its Radix variant and restyle it with the tokens.

### Checks

`./scripts/check` enforces the tokens and components mechanically, and every count it keeps may only fall:

- ESLint runs `@shadcn/lint` on app components. It reports raw palette colors, arbitrary values, restyling a shared component beyond layout classes, and classes it cannot read, and its messages name the variant, size, or token to use instead. Findings that predate these rules are recorded in `apps/desktop/eslint-suppressions.json`; after fixing one, run `npx eslint --prune-suppressions` in `apps/desktop`.
- `src/test/design-tokens.test.ts` counts raw colors, literal radii, and `!important` in each stylesheet; `src/test/type-scale.test.ts` keeps font sizes on the type scale.

### Recorded lint findings

`apps/desktop/eslint-suppressions.json` holds the findings that remain; each group below says why it stays. Fix them by the route given, and prune the entry in the same change.

- **Feature class on a shared component** (the `no-restyle` entries in `src/features` and `WorkspaceSidebar.tsx`, such as `board-card`, `filters-content`, `linked-work-title`, `plan-actions-menu`). The feature stylesheet gives the component its own height, padding, font size, background or width, and many of the components render in a portal, so no parent element exists to carry the class. Each needs a variant or size on the shared component that the design names; moving the class to a wrapper would only hide the restyle. Do them one component at a time, with the screen open in both themes.
- **Overrides inside `components/ui`** (`command`, `empty-state`, `field`, `picker`, `resizable`, `sidebar`). The composite passes spacing, type or color classes to the primitive it wraps (`Label font-normal`, `CommandItem` padding). Each becomes a variant on the primitive (`dialog`, `label`, `separator`, `sheet`, `input`).
- **Arbitrary values with no scale equivalent** (`sidebar.tsx`, `switch.tsx`, `empty-state.tsx`): `calc()` widths and offsets, `transition-[...]` property lists, `0_0_0_1px` ring shadows, `tracking-[-0.6px]`, `stroke-[1.75]`. They need a new token or utility, which the design has not decided.
- **Toggled state color** (`Activity.tsx` `bg-accent` on a ghost Button): needs a pressed treatment for ghost buttons, which would change every ghost trigger that opens a menu.

### Control and state recipes

Compose a control before inventing another. Inputs, buttons, menus, fields, notices, and dialogs must have one visual contract across views.

| State          | Required treatment                                                                            |
| -------------- | --------------------------------------------------------------------------------------------- |
| Rest           | Clear label, semantic surface and foreground, stable dimensions                               |
| Hover          | Subtle neutral fill or border change; no translation or scaling                               |
| Keyboard focus | Visible outline ring independent of hover and selection (section 4)                           |
| Pressed/open   | `--accent` fill and semantic expanded/pressed state; never the primary fill                   |
| Disabled       | Native disabled semantics, no activation, readable label without opacity; explain why         |
| Pending        | Preserve width, show progress text/icon, block duplicate submission, retain the draft         |
| Invalid        | Field-level message and invalid semantics; never only a red outline                           |
| Failure        | Actionable local error with retry where possible; distinguish failed saves from saved content |
| Success        | Updated value and concise confirmation; avoid repeated success toasts for autosave            |

Primary buttons use the inverted neutral pair. Destructive buttons sit on `--error-surface` with the `--destructive` label, and hover adds a 1px `--destructive` ring; a destructive confirm places Cancel before it. Secondary actions use outline or quiet neutral fill. Tertiary actions use ghost styling with a visible focus state. Inline ticket references are links with consistent hover/focus behavior; they should not resemble a row of submit buttons embedded in prose.

Fields have persistent labels; placeholders are examples, not labels. Forms use aligned full-width inputs, shared field spacing, and a trailing action row. Put the destructive action away from ordinary submit controls. Do not place an unstyled native select beside a themed button and consider the form finished.

Menus are for short action choices. Popovers are for small, focused edits. Dialogs are for multi-field forms, consequential confirmation, and dependency review. Every dialog/sheet has a title, a close path, correct focus containment, and focus return. Escape closes only the foremost surface and must not silently discard a draft. One action must not open a stack of overlapping editors.

### Menus, selects and choice lists

- **Placement:** below the trigger, flipping above only on collision, 4px away with 16px clearance, at least as wide as the trigger, inside the nearest OverlayBoundary so nothing escapes over the sidebar or covers its own pane's header. A select list never opens over its own trigger.
- **Surface:** `--popover`, `--radius-panel`, 4px padding, `--shadow-menu` (`--shadow-large` for a popover holding a form). Menus are 220–280px wide by content, pickers 280–320px; lists stop at 320px and scroll inside.
- **Rows:** 32px (36px in ticket and record pickers): a 16px icon, the label, muted meta or a Kbd, and a trailing check for the current value. Every row of a list has an icon, or none does. The highlight is `--accent` for pointer and keyboard alike; section labels are 12/16 muted; separators are hairlines.
- **Values:** a single choice opens with its current value highlighted and checked, so Enter never clears it; the clearing choice ("No project") comes last after a separator. A multi choice (tags) stays open and toggles checks.
- **Disabled and destructive:** a disabled row keeps a readable `--disabled-foreground` label and says why on a 12/16 line under it, with no opacity. Destructive rows go last after a separator.
- **Rules:** a menu holds choices or actions; a popover holds a small form or a list and has a title when its trigger is icon-only; no popover is a column of buttons. Never a one-item menu: make that action a direct button. "…" only gathers several unrelated actions.
- **Search and empty:** an optional 32px search row at the top, a quiet "No matches" row, and "Create “x”" as the last row where creating is allowed. Pickers say "Search {things} by title or reference".
- **Pickers:** TicketPicker looks an exact reference up first, waits 150ms after typing, and shows a fixed list of six 36px rows (three in the compact Link a ticket dialog; StatusIcon, reference, title, a caption such as "Linked") with "No tickets match “x”"; its multi-pick form checks rows and its dialog puts the count in the note slot. RecordPicker groups tickets, Documents and Projects as "Linked to this …", "Recent" and results for `#` mentions, Link popovers, Plan context and the editor's Link.

### Dialogs

- **One component:** DialogShell, in three sizes: `sm` 480 for a confirm, `md` 640 for a form or picker, `lg` 920 for review and compare. A multi-step flow keeps one size. New ticket starts at 640px and expands to 760px, bounded by the viewport, while keeping the draft and the same top anchor. The attachment and diagram previews use the `viewer` size, min(1120px, 100vw − 64) by min(800px, the viewport below the dialog’s top anchor), with one header row (its actions, then Close) and no footer. A review with nothing to confirm (an empty Clean up) leaves the primary out and keeps one dismissing button. A view switch inside a dialog (Attach file's Upload, Existing files, Google Drive) sits under the header in the `tabs` slot and keeps the dialog's height.
- **Position:** anchored at max(48px, 12vh) and growing downward; the body scrolls inside while the header and footer stay put. A dialog never re-centres while someone types, searches or chooses.
- **Header:** a 24/32 title naming the action and its target, an optional one-sentence description, and the 32px close button on the title line, with 24px padding. A confirm's title is a question ("Change T-FV10 to In progress?").
- **Body:** a 24px inset; labels above 40px fields; pickers stacked; notices as Alerts.
- **Footer:** a 60px band on `--recessed` under a hairline. At the left, one persistent control (the Create more switch). At the right, the note slot (12/16 muted: the blocked reason such as "Add a title to create.", a count, or a transient result such as "Created T-FV16 · Open"), a ghost Cancel, and one 32px primary, default or destructive, with its key hint. The primary repeats the verb and keeps a constant label; counts go in the note slot. Never a close button plus "Done".
- **Failure:** the dialog stays open and a compact error Alert appears above the footer.
- **Focus and stacking:** focus starts in the first field, or on Cancel for a destructive confirm, and returns to the opener. Never open a dialog from a dialog: replace its content instead.

## 12. Feedback, motion, and accessibility

Use a small set of observable states rather than transient notifications everywhere. Empty, loading, unavailable, failed, saved, and externally changed data must be distinguishable. Build them from the shared EmptyState, Skeleton, Alert and StatusLine components.

Feedback has three tiers, and nothing is inserted into the flow to report an outcome:

- **Status line** (per pane; the one transient surface): outcomes of an action, such as moved, removed, copied from a menu, created, or a link that couldn't open. It floats at the bottom centre of its pane, 8px above the edge (above a docked bulk bar), 40px tall and at most 480px wide, on `--popover` with `--shadow-menu` and `--radius-panel`: an optional 16px icon, the message in the past tense with the reference ("Moved T-KQ16 to In progress"), one ghost action (Undo, Open, Retry, Copy link) and Dismiss. It lasts 4s, 10s when it carries Undo; a failure stays until dismissed or retried and is `role="alert"` with the attention dot, others `role="status"`. Hover or focus pauses it; one shows at a time and the newest replaces it; closing it keeps focus in the pane. It is never used for autosave, and is never stacked.
- **Alert** for lasting conditions where they apply (in Trash, outside the results, source unavailable, couldn't save).
- **Workspace band** for workspace-level state only (read-only, locked, disk full).

Reversible changes act at once and offer Undo in the status line ("Moved T-KQ1 to Trash · Undo", "Removed the link to T-KQ11 · Undo", "Unlinked Spec · Undo", archiving or trashing a Chat); a failed Undo becomes the failure with Retry. Irreversible changes are confirmed first.

Empty states follow one copy registry (`lib/empty-copy.ts`): "No {things} yet", "{Place} is empty", "No {things} match “…”", then one sentence on what appears here and how it gets here; never "scope", "eligible" or "snapshot". A primary action only when it is the only way to fill the view and no other primary is visible; otherwise outline sm, and none when the header already holds the action. Chrome that acts on nothing is hidden: no count, Search, Filters or Display over an empty workspace or Trash, and no Refresh there unless a source could bring tickets in, so a first run shows the title, one block empty state and its primary "New ticket C"; no pager, Clean up or count footer at zero. Placeholders appear only after 300ms and never pulse. Paging is one "Show 50 more" under the content; totals sit in headers. An empty state carries the action that fills it; two have none because the control sits directly beside them: the Activity timeline (its composer is the row above) and a Plan’s Dependencies view (Add tickets is in the Plan header above). An empty Board column says “No tickets” in one muted line (its header names the status and holds Add); with a search or filter on it says “No matches”. When nothing matches at all the board shows the view's one empty state instead of empty columns.

| Situation                       | Presentation                                                             |
| ------------------------------- | ------------------------------------------------------------------------ |
| Initial list load               | Row-shaped placeholders using the final row geometry                     |
| Background refresh              | Retain the current content and scroll; avoid blanking the pane           |
| No tickets                      | Short explanation and New ticket action                                  |
| No filter matches               | Current query context and Clear filters                                  |
| No selected ticket              | Quiet selection hint; no large illustration                              |
| Missing/trashed reference       | Readable reference plus unavailable/trashed explanation                  |
| Save failure                    | Draft stays editable; one plain failure with Retry and Details           |
| External change beneath a draft | Local notice with explicit reload/overwrite choices                      |
| Source refresh                  | Retain content; “Refreshing GitHub…”, then the new sync time             |
| Source unavailable              | Last synced content stays readable; notice with Retry and Take ownership |

Counts remain unknown until their own read succeeds. Initial failures retain an unknown count and expose the read's Retry; a known empty answer is distinct from pending or failed reads. Background failures retain observed content and counts. Plans reads are independent of ticket-list reads and use still card-shaped placeholders after 300ms. Document reader opens keep their target and failure independently of navigator reads, so a successful Recent/Pinned refresh cannot dismiss an open failure or redirect Retry.

### Failures and error language

One cause is reported once, at the place it concerns, in plain words. The core sends each failure with a kind (`workspace_read_only`, `workspace_unreadable`, `workspace_locked`, `disk_full`, `not_found`, `cycle`, `conflict`, `too_large`, `not_signed_in`, `offline`, or `failed`); the interface chooses its words and next step by kind and never parses the message. `describeFailure(error, action)` in `lib/api/describe-failure.ts` returns the title, sentence, next step, and raw text, and lint rejects raw `String(reason)` text in the interface. Unclassified bridge failures use a safe, action-specific title and say that the result could not be confirmed, with a retry or Details step. Arbitrary host text stays behind Details, and no unknown mutation failure claims that nothing changed.

- **Voice.** The title says what did not happen: “Couldn’t {verb} {object}”, sentence case, no period. One sentence follows with the plain cause and what is safe (“Nothing changed.”, “Your draft is kept on this device.”). The action is “Retry” only when retrying can succeed; otherwise it is the fix (“Change limit”, “Choose another ticket”). Core prefixes, “Error:”, CLI commands, backticks, byte counts, and absolute paths never appear outside Details.
- **Details.** The raw text sits behind a “Details” toggle, in 12px mono with “Copy details”. Status-line failures retain the same diagnostics in an anchored popover, keeping the line at 40px while Details is open.
- **By scope.** An invalid field shows a FieldError under it (`aria-invalid`, nothing is sent): an empty ticket title says “A ticket needs a title.” and keeps the last saved title. A failed action shows a compact error Alert under its control or above the dialog footer (FailureAlert). Dense rows and the ticket rail show one caption, “● Not saved · Retry”, with the cause under Details (FailureCaption). A region that cannot load shows “Couldn’t load {things}” with Retry in place of its content and never claims to be empty (FailureState). A failed background refresh keeps the content with “Can’t refresh. Showing the last list. Retry”. A dialog whose main task is blocked shows an error Alert at the top of its body.
- **Workspace band continuity.** A workspace failure blocks writes and announces its truthful message immediately. Each pane or page header keeps a reserved 28px notice-control slot from its first frame, before its existing right actions; healthy headers leave it empty, without a blank band above the document. When a failure arrives under pointer or focus, the slot shows a keyboard-reachable warning control with the full message as its accessible name and tooltip. It opens the real band content, Details and Retry in an anchored popover; “Review workspace notice” is also offered in the palette. The same mechanism covers the legacy-draft notice, with failure taking priority. The full 40px band commits on navigation or genuine departure from the content, including explicit pointer or focus departure outside the pane and its overlays. A disabled field falling to BODY is not departure. Successful recovery clears error wording immediately; an occupied 40px layout slot remains empty until departure so Retry never pulls the document upward. Pointer or focus still over the document, including focus moved to Retry, keeps that session's geometry. The shell never covers existing controls or body text to report the failure.
- **Workspace band.** Workspace-level state only (read-only, locked, unreadable, disk full, unsaved drafts not protected) is one 40px band inside the top edge of the content panel: `--workspace-band` (`--recessed` in light, approved `#1D1D1D` in dark) with a bottom hairline, an attention dot, one sentence (“This workspace is read-only. Changes can’t be saved.”), Details, and Retry. There is at most one; it stays until Retry succeeds. Details opens the shared anchored failure popover, preserving the band’s 40px height and the panes beneath it. At narrow widths the sentence truncates visually with its full text available to assistive technology and in its tooltip; Details and Retry stay on the same line. Successful reads never dismiss a workspace failure, including a lock. Retry keeps the band while queued draft protection settles and the existing sidebar query proves write access through its reminder transaction. Only the failure observed at the start of recovery can be cleared; newer failures remain. Startup recovery uses the same write proof before clearing a stale failure band. The one lasting workspace notice that is not a failure, the legacy-draft review, uses the same band with a neutral dot and its one action ("All desktop profiles reviewed"), and gives way while a failure band shows. Nothing else repeats the cause: editors add no notice of their own, and editing controls rest disabled with the reason.
- **Startup.** When the workspace cannot be opened, the window shows a recovery screen in the app’s theme (the native title bar included, with best-effort native theme and canvas requests from the blocking bootstrap even if application modules fail): one 520px column 120px from the top with the wordmark, an alert IconTile, “ticketd can’t open this workspace” at 24/32, the plain cause, the workspace file as PathText on `--surface` with Copy path and Show in Finder, Retry, and Details on its own line. Restore from a backup and Choose another workspace are not offered there: a restore needs a readable workspace for its safety copy, and the workspace location is fixed.

Buttons and links change color/background without scale, translation, or opacity animation. All CSS motion durations and delays use tokens. `--dur-1` is 80ms for press and colour feedback, `--dur-2` 140ms for reveals and status lines, `--dur-3` 180ms for menus and popovers, and `--dur-4` 240ms for dialogs and glyph sweeps. Entry uses `--ease-out` (`cubic-bezier(.16, 1, .3, 1)`), exit uses `--ease-in` (`cubic-bezier(.4, 0, 1, 1)`), and glyph sweeps use `--ease-in-out` (`cubic-bezier(.65, 0, .35, 1)`). The existing `--motion-swift` is reserved for the Done check.

The interaction timings retain distinct tokens: `--dur-exit` 100ms for exit, `--dur-lift` 120ms for lifting and short reveals, `--dur-settle` 160ms for card settle, `--dur-arrival` 1200ms for an arrival highlight, `--dur-loading-delay` 300ms for skeletons, `--dur-spin` 900ms for a spinner revolution, and `--dur-instant` 0ms. These follow the next-generation motion contract, including the spinner’s 0.9s linear rotation. Tailwind transition and spinner defaults use these tokens too. Reduced motion zeroes every duration and delay, including in theme previews, disables animations, and leaves spinners as static rings. Motion never conveys completion or selection by itself.

The global command palette uses the shared `Command` palette variant inside a
`DialogContent` of size `palette`: 640px wide (window minus 32px on narrow
windows), top 96px, popover surface, panel radius and modal shadow, with a soft
scrim (`--scrim-soft`: light `#17171714`, dark `#00000066`, from S07). Its input is 56px, rows are 38px with 8px corners, section labels 28px,
and footer 40px. It rises 8px and scales from .985 over `--dur-3`; reduced
motion is immediate. The empty query lists destinations immediately. A failed Ticket or Document lookup remains visible beside matching destinations or cached results, with the existing failure title, safe cause, Details and a Retry that refetches only that source. A partial failure never claims there are no results. Retry preserves the query, highlighted result and input focus; catalog reads do not repeat on each search keystroke. Search
uses the existing global core query, including literal partial references
without `T-`, with reference matches before content matches. Every TicketPicker
uses that same search. Escape restores the opener; navigation focuses the
destination content. Mod+K opens from views and plain fields; rich editor carets
keep Mod+K for links. G then I/A/R/C/D navigates outside typing and overlays,
with a one-second sequence timeout. Chat destinations are unavailable while
Chat is off. The single shortcut registry represents sequences separately from
simultaneous chords; Settings and palette hints render that registry. The
palette starts with the open or focused Ticket's actions. S/P/L/T/H drill into
Status, Project, Plan, tags and reminder on this same surface. The input's
recessed scope chip names the Ticket and property and announces “Status of
T-…”; 1–9 choose the visible options, Backspace on an empty input returns to
actions, and Tab or Right opens the selected action. Prefix > searches commands
only. Property changes use the same bridge operations as the property pickers
and post a status line with Undo; Duplicate opens the existing dependency review.
The same keys act on a focused list row or board card before the open Ticket;
Mod+Shift+C copies that reference, H means Remind me and R writes an update.
Typing and overlays keep their own keys; completing an action returns focus
to its opener.

Keyboard access must cover navigation, row selection/opening, resizing, property changes, editing, overlay dismissal, and return to the list. Preserve distinct focus and selection. Announce save errors and meaningful async results without repeatedly announcing background polling. Use landmark regions and a logical heading sequence. Do not assign a visual heading level solely to obtain a font size.

Support text selection and copying of references, paths, evidence, and errors. At 200% zoom, labels and actions remain reachable. Test long translations, filenames, and titles as layout stress cases even while English is the initial interface language.

## 13. Implementation boundaries

`apps/desktop/src/styles.css` is the shared token source. Map every semantic role used by Tailwind and shadcn, including popover background/foreground and focus roles. Components use those tokens instead of their own hex values. Theme changes apply at the root so portaled content follows the same palette.

Keep component-specific layout rules with their feature. Change shared control appearance through its variants, not repeated descendant overrides such as “all buttons inside ticket details.” Avoid appending a new stylesheet patch for every screen; reconcile the rule that owns the behavior. A control must not change its appearance merely because it moved into a portal.

Keep content state separate from presentation. A collapsed group, resized pane, open menu, or expanded document cannot destroy a draft or reset a pending write. Retain core validation and retry semantics; visual feedback describes the actual result rather than predicting success.

When implementing a new token or recipe, update its shared definition and all affected usages together. The design specification remains the target; code must not silently redefine the target through local exceptions.

## 14. Review criteria

Review a complete workflow with realistic content, not only an empty screenshot. Passing functional tests does not establish visual quality.

### Required visual set

- Light and dark views at 1440 × 900, 1280 × 800, 1024 × 768, and a 390 × 844 narrow-window stress case.
- Split, expanded, and single-pane detail modes, including navigation back to the same list position.
- Short and multiline titles, a long description, code, a table, a Mermaid diagram, updates, blockers, evidence, and empty optional content.
- Bulk selection, open pickers, reminder editing, duplicate dependency review, save errors, and external-change notices.
- Keyboard focus, selected and hovered rows, disabled/pending controls, and 200% zoom.
- Externally owned tickets that are open, closed, and unavailable; a local ticket ready to publish; the source filter; and a status change that moves a row between groups.

### Acceptance questions

1. Does the ticket title lead the detail view, with its status and description visible before optional forms?
2. Are text roles, control heights, gutters, and row columns consistent across screens?
3. Do existing relationships and evidence remain discoverable without a wall of empty forms or nested disclosures?
4. Is each meaningful action obvious without making all actions primary?
5. Are all overlays opaque, legible, correctly layered, and contained by the viewport in both themes?
6. Can someone distinguish open-ticket selection, bulk selection, hover, focus, unread, and blocked states?
7. Do long values wrap or scroll locally without forcing workspace-wide horizontal scrolling?
8. Do drafts, focus, and scroll survive refreshes, navigation, and layout changes?
9. Do errors explain what happened and the next available action without exposing internal event keys?
10. Does the screen remain useful with mouse, keyboard, larger text, and reduced motion?
11. For any ticket, can someone tell who owns each field and how fresh an external copy is?

A design change is ready for implementation review only when these questions can be answered from the rendered screens and interaction evidence. Record unresolved exceptions in the corresponding GitHub issue. Do not label a change visually complete solely because formatting, tests, or a build passed.

### Compact workspace density

Keep the 16px root so rem-based shared controls remain predictable. Working-pane text and ticket-row titles use 14px/20px; captions stay 12px/16px. Ticket and view titles use the ticketd-specific 24px/32px heading above. Navigation items are 32px high, the brand row and the list and detail pane headers are 48px high, and ticket ledger rows are 36px high (Detailed 56px), with no inter-row margin. Status group headers are 36px high. List headers use 16px top and 12px bottom padding. Use 40px desktop ticket document gutters and 16px narrow-window gutters. These application density choices take precedence over spacious display roles; preserve the reference palette, font families, shadows, and focus treatment.

### Workspace hierarchy

The ticket title is the strongest heading in the split workspace. The list heading is 14px/20px at weight 500, with a 12px count on the same line. Search and Filters use the 32px small-control role and transparent resting surfaces. Use the canvas color for navigation and the elevated surface color for the content panel. Preserve one subtle boundary between the list and detail panes; do not add nested cards around these regions. Properties in the rail use the shared ghost button and select variants beneath their labels. The full creation form keeps labeled, outlined controls.

## 15. Native Chat

The Chats list is 300px wide and groups active conversations into Needs you (pending approvals) and Recent, preserving recency inside each group. The transcript and tray share a centred column up to 760px with 40px gutters (16px in narrow panes). Split-pane messages and replies use the document role (15/24); expanded Chat uses reading (16/26). The composer control row is 44px tall. Harness tab names keep their full width; setup status gives way first. An approval shows its exact command in the dock before the reason, with the existing Command disclosure retaining Copy.

A Chat (product specification section 21) opens in the detail pane: a 48px header, the transcript, then the problem notice, activity dock and composer. It uses the shared components and existing tokens and adds none. A spaced middle dot separates items, a chevron marks disclosure, and at most two disclosure levels show at once.

### Identity and header

- **Harness mark:** the official mark in one color, 14px in a 16px box, once per surface: before the header title, leading a list row, and leading the composer's picker. An unknown harness uses `SquareTerminal`. Status never sits on a mark's corner.
- **Project icon:** derived from the Project's folder, probed when shown and never stored: a transparent favicon is its shape in the text color, an opaque one its picture in grays on the boundary ring, else a letter tile on `recessed`. Never the favicon's own colors.
- **Header:** one line: mark and title, then one muted 32px context button before the actions: the Project icon (else `folder`; `folder-x` in `foreground` when the folder is missing), the folder's name capped at 18ch with an ellipsis, and a chevron. Nothing else rides in it, so it never pushes into the title or the actions; below a 460px pane only the icon and the chevron stay. Its 280px popover ("Chat context", groups split by one `border` hairline) has four groups: the folder (name at 14/500 with Copy path, the path in 12px muted mono shortened in the middle, the branch on one 12px mono line shortened at the start, or "Detached at …"); the harness (mark and name, its status word on the right with a 6px dot, the version and executable in 12px mono when known, and "Check again" only when it isn't ready or couldn't be checked; "Checking…" holds the status word's place and gives way to "Couldn't check" after 8 seconds); the context window when the harness reported one; then 32px ghost rows: Open in the file manager, "2 other Chats here" opening their list, and the Project opening its tickets. Esc closes it and returns focus to what opened it.
- **Linked records:** 28px chips on one line, at most 280px each; remove shows on hover or focus over the chip's end, and what does not fit folds into "N more". The strip shows the header boundary under it only while the transcript is scrolled beneath it. With no links there is no row; the Chat actions menu links one, its picker opening under the header at its end, never over Expand or Close.
- **List header:** the title names the scope once and is its menu's trigger ("Chats ⌄", "Archived Chats ⌄", "Chats in Trash ⌄", radio items with the trailing check), the count after it, then the New Chat pencil.
- **List rows:** the mark leads; line two is the status, then at its end one context item, the first ticket's status icon, caption-size mono reference and "+N", else the Project. The status word is in `foreground` only beside its dot or spinner; an idle Chat's last line is muted. The row's ⋯ covers the time on hover, keyboard focus or while its menu is open, never after a click, so the open row keeps its time.
- **New Chat:** with no Chat open the detail pane is New Chat (one instance, so the pencil and the sidebar's New Chat only put the person in its message box and ask the harnesses again); resting there it has no Close and takes no focus, and closing a Chat returns focus to its row. In a narrow window the list stays first. The heading and composer are top-anchored (a fixed `clamp(32px, 16vh, 160px)` from the pane's top), so the composer grows only downward and nothing above the caret moves. No harness radios; the harness is chosen in the composer's picker. The notice under the composer holds the chosen harness's actions. New Chat starts on the last harness used while it can still be used, else the first that can, with that harness's last pick of model, effort and permissions while it still offers them. The picker holds its place from the first frame (a disabled skeleton trigger while harnesses are checked, which after 600ms reads "Checking harnesses…" beside the 12px spinner, with no chevron), so nothing moves when the check ends. The folder button reads "Folder: repo", or "Scratch folder" with no prefix (the full path in its tooltip, after the Project's name when it has one); its menu lists recent folders with where they are and a check on the current one, then "Scratch folder" (the empty folder ticketd keeps for the Chat), then "Choose a folder…". Linking a Project that has a folder chooses that folder unless one was already picked. The Link popover lists recent records before anything is typed.

### Transcript

Your message is right-aligned on `accent`, at most 82% wide, exactly as sent; past four lines it folds behind "Show more", and its time and Copy show on hover or focus. Its images are 96×72 tiles (the Attachment thumbnail's tile size), three then "+N", each opening the Attachment preview. A reply is full-width Markdown with no bubble. Expanded mode is a centered 760px column with gutters of at least 48px and messages at 16/26.

A **turn** runs from your message to its end; a steer starts a new segment. While it runs, step rows appear as tools start; "Working for 1m 32s" shows only between steps. When it ends, its steps, reasoning and record changes fold under one muted row: "Worked for 2m 13s", "Continued for 48s", "Stopped after 40s" or "Failed after 8s", plus problem counts only when present (" · 1 failed"). The time leaves out what the turn spent waiting on you for an approval or a question; past 5s it says so (" · waited 2m"). Opened, steps indent 16px. The harness's own warnings (an MCP server that did not start) are one quiet 12px line per turn, "2 Codex warnings", that opens to them and folds with the turn. The final response, question and expiry receipts, and ticketd notes such as sign-in problems are never folded. While a request waits in the dock, its card is the only place it is said: no "Waiting for you" line and no row for the step it asks about. A turn whose stop was not confirmed stays open.

A **step row** is one 28px line, `[icon] Verb target · suffix`:

- **Icon:** one neutral 16px Lucide icon per kind: read `eye`, search `search`, edit `pencil`, create `square-plus`, delete `trash-2`, run `terminal`, web `globe`, other `wrench`. A running step shows the 12px spinner in its place.
- **Words:** the verb in `muted-foreground`, the target in mono `foreground`. Only success takes the past tense: "Ran `npm test`", but "Run `npm test` · Failed".
- **Suffix:** at most one: a clock ("12s"), a diffstat ("+12 −4", 12px mono, muted), "No matches", or an outcome word at weight 500: Failed, Timed out, Declined, Not finished, Not confirmed. A step that finishes in view keeps its running verb's width, so a file name after it does not move. Rows are never grayed, and nothing is parsed from output.
- **Targets:** one or two are named ("`a` and `b`"), three or more counted ("Read 6 files"). Paths are relative to the Chat's folder, with `~` outside it; a search reads "for `pattern` in `scope`", a web search "for “query”", a page `host/path`, and a command its first line without shell wrappers.
- **ticketd calls:** a command that only calls the ticketd CLI (by its path, on PATH, or through a variable set to it) reads as what it does, in the step's tense: "Set `T-MP4` to In progress and posted an update on `T-MP4`", "Read Project Verify Project" (linked records by title). Its icon is its first verb's (read `eye`, search `search`, create `square-plus`, a change `pencil`, post `message-square-text`), not `terminal`. Any other ticketd call shows its command as `ticketd …`, without the path or the variable. Opened, the row shows exactly what ran. Claude Code's plan file reads "Wrote its plan".
- **Merging:** consecutive steps of one kind and outcome merge ("Read 6 files"); a different outcome word ("No matches", "Timed out") keeps its own row; commands never merge.
- **File names:** in a row that does not open, a read, edited or created file's mono name is itself the button: no ring or icon, `accent` on hover, opening the file in the computer's default app. It shows its last part (with its folder when another file in the row shares the name) and, short of room, truncates in the middle so the extension stays. A file that is gone is plain text; a failure is a caption under the row ("Couldn't open limiter.ts. No app on this computer opens .ts files.").
- **Detail:** a row opens one thing; a command opens one `code-block` box with its output and Copy, then a muted "Exit 1 · in {folder}". The box is at most 12 lines tall, scrolls inside, mounts only when opened and opens at the output's last line; the `$` is never copied.

An answered approval folds into its step row, with a tooltip such as "You allowed this for this session"; only questions ("Answered · …") and expiries ("Expired · `command`", the command or path in mono) leave receipt rows. The host records which step an approval was asked for and folds it there ("You declined this"); an approval it cannot tie to a step leaves no row. When a turn ends, a step still running reads "Not finished", or "Not confirmed" after an unconfirmed stop. A turn someone is reading in, or that holds focus, folds once it leaves the view; the person's own toggles win for the session.

**Below the response** come 28px step-style rows, in order and only when needed: the stop marker, changed files ("3 files changed · +53 −12"), then records, verb first ("Moved T-KQ12 to In review · Posted an update on T-KQ12"). A reference or record that opens is a `RecordLink` (mono reference or sans title, the 1px `interactive` underline) in sent mentions, fold rows and these rows alike; one that opens nothing (gone, in Trash, a ticketd step's words) is the plain mono reference without an underline. A record row leads with the ticket's status icon; a created Document's title is its link, without quotes.

The Chats list shows neutral group and row skeletons on its first read; its count stays unknown until a successful result. Failed refreshes retain the last known rows and count with Retry. Short conversations begin at the transcript’s top padding, while long and live conversations keep the existing follow and reading-anchor behavior. The message area reserves 52px before the 44px control row, and grows with the draft. Picker, Send and Steer tooltips show their registered keys. A failed creation, send or queue keeps the draft and offers Retry in the tray; retry repeats the refused action, including Queue when the primary action is Steer. Unchanged creation payloads reuse their request identity; edited payloads get a new one. Queue-removal Retry targets the same queued identity.

### New Chat suggestions

While the message box is empty, New Chat lists up to three suggestions under a muted "Suggested": 36px rows with the ticket's status icon (the Inbox icon for triage), the verb, Reference, title and a trailing time ("2h"): "Continue T-KQ14 …", "Review T-KQ12 …", "Triage the Inbox (3)". Placeholders appear only after 300ms; a failure reads "Couldn't load suggestions." with Try again; none shows nothing. Choosing one writes its prompt, links its records, says "Linked T-KQ14." in a status and puts the caret at the end; Cmd/Ctrl+Z right after takes both back. It never sends.

### Reasoning, plan, files and context

What a harness did not report is not drawn: no row, pill, card, files row or context count, and never "0 files" or an empty bar.

- **Reasoning:** a 28px step row with `brain`: "Thinking…" or "Thinking · {heading}" while live, then "Thought for 12s" ("Thought" without a time, never "0s"; " · Not finished" when cut off). It opens its text once, muted and indented 24px; one with no text leaves when it ends.
- **Plan:** while its turn runs, only the dock pill (`list-todo`, "3 of 7 done · {current step}") opening a popover of steps. A finished plan is a row in the turn, "Plan · 7 of 7 done"; one left unfinished is a card ("Plan · 3 of 7 done", `circle-check` or `circle` steps, open ones " · Not finished" or " · Not confirmed") whose Save as Document shows on hover or focus.
- **Changed files:** `file-diff` and "3 files changed · +53 −7", counting only confirmed edits (" · 1 not confirmed"). It opens 32px file rows: mono path shortened in the middle, "new", "deleted" or "renamed", counts or "—", and Copy path. A row opens the file in the system's default app for it, with the reason under the row when it cannot; deleted files are not buttons.
- **Context:** a quiet 12px mono count before Stop in a 32px ghost button, "144k" in `muted-foreground`; from 80% it reads "84% context" in `foreground` after the attention dot. It opens the Chat context popover at its Context group, and closing it returns to the message box. That group reads "Context" and "144k / 200k", one 4px bar (`muted-foreground` on `control-boundary`, `foreground` from 80%) with a 1px tick where the harness compacts, then one 12px line: "72% used · Compacts near 180k", "Compacted at 10:13 PM" once it has, and "As of 2:41 PM" only when the report predates the turn. The harness's categories wait behind "Details", largest first, with one decimal below 100k.

### Scroll and the New marker

The transcript follows only while you are at the bottom. Only your own scrolling up (wheel, touch, keys or the scrollbar) stops following; content that shrinks, a dock card leaving or a turn folding, never does. Reaching the bottom, sending, or "Jump to latest" resumes it. "Jump to latest" is an outline button in its own 40px strip between the transcript and the dock, so it never covers text; it fades in and out in 120ms. Otherwise the first visible item keeps its place. A divider with the unread dot and "New" marks the first item that arrived while you were away; your own messages never count. A Chat opens at the bottom when everything new fits, otherwise with the marker a quarter down; the marker stays until you send or leave. With nothing new it reopens where you left it this session. Opening or closing a row keeps that row in place, and a turn folding keeps the answer you are reading where it is.

### Activity dock and composer

The bottom of a Chat is one composed **tray**: one `--shadow-border-base` ring, one `--radius-panel`, the surface fill and one 16px inner edge. Top to bottom it holds the problem notice, the activity dock (the pending request, the plan pill "3 of 7 done · {current step}", then the queue), the message box and the control row; each section above the box ends in a group hairline, and none has a ring, fill or radius of its own. The part above the box is hidden when empty and its height glides in 150ms ease-out as one block when a section arrives or leaves, while the transcript keeps the end in view. The tray's focus edge is the 1px `--input-focus` ring while the message box has focus. A pending request appears only here, never takes focus from the message box, and is answered only by its own buttons. Shell approvals show the exact command and when it was asked; ticketd requests retain executable paths behind Command. Its title carries what would run inline in mono; what runs exactly is a "Command" Disclosure opening the output box with Copy. Approval sections use 12px vertical and 14px horizontal padding, with the command, caption reason and choices aligned to the section edge. Question bodies retain their indented reading layout. Approval choices are 28px outline buttons in one row, with the Command disclosure at its trailing edge and full-width command details below when opened. The row wraps when narrow; question options are plain 40px rows with the `accent` hover and selected fill, a muted description and a spinner while sending, no border. Inside a request ↑/↓ move and 1–9 pick, with no key badges; opening an approval from Inbox or a notification focuses its title for announcement, where 1–9 also pick and an arrow reaches the first option. ↑ from an empty message box reaches the first option, and Esc inside a request goes back to the box. Digits in the message box or another open control never answer a request. While the dock shows a request, the transcript shows no "Waiting for you" line. A draft typed before a question arrived keeps its meaning; only an empty box answers it. The plan section is 44px high with 8px × 12px padding around an intrinsic-width, 28px recessed pill, which truncates its current-step text in narrow panes. Its leading mark becomes the expand/collapse chevron on hover or focus without changing its width. The queue reads "Queued 3 · After this turn", or "Queued 3 · Paused" with Resume, in 12px muted; each card is one 32px line whose Send now, Edit and Remove are hidden at rest and show at full strength on hover or focus (always on touch), never dimmed. New Chat's composer keeps its own ring, with its notice below it.

The composer's 44px control row holds two 28px triggers, then Stop and Send, on one line at every width: the triggers truncate first, and below a 460px composer Permissions keeps only its shield and the effort only its bars. The first is one picker for harness, model and effort (`[mark] Opus 5.5 ▂▄▆ Medium ▾`, "Default model" when the harness reported none). Its 320px popover (8px padding) never scrolls itself: it opens above the composer inside the pane body, never over the pane header, and only the model list scrolls, with the current model scrolled into view on open. In New Chat, where tabs switch, it keeps one 272px body for every tab and while models load (skeleton rows), so the tabs never move; in a Chat it is as tall as its content. Top to bottom: harness tabs as one equal-width segmented strip that never wraps (mark and name, Left and Right move between them; one that isn't ready is dimmed with "· {word}", which truncates before the name, and choosing it shows its notice flat, without a card of its own, and its actions), the model's efforts as one segmented row (with "Default" first when the harness names no default effort), then the models, the only scroller (name, the harness's description unless it repeats the name, a muted "Default" tag, a check on the current one; an alias row is named by the model it runs). Past six models only the default, the current one and the first others in the harness's order show, then "More models (N)". It lists only what the harness reported, in New Chat from the host's check before any session; a harness that reported nothing offers "Default" and says so. What the picker shows is what the first turn runs on: New Chat sends the shown model, effort and permission mode by id, never "unset". In a Chat the harness is fixed and only its tab shows; until the session reports, a Chat made in New Chat shows what it was started with, so the triggers do not change as it starts. A change that waits for the turn to end shows the new value with a small clock in the trigger, "{value} from your next message" in its tooltip and "Applies from your next message." at the popover's foot; no words are added beside the triggers. The second is permissions (shield and the mode's name, never a bare "Default"; full access is never offered). Send shows an icon and a word set by the turn: Send, Steer or Queue. Enter does what it says, and Cmd/Ctrl+Enter queues while a turn runs. Beside Steer only, a caret menu holds Steer now (with the harness's steering effect) and Queue. The placeholder says the same: "Message {harness}", "Steer {harness}", "Queue for {harness}" or "Answer, or pick above". Send is the only solid button; Steer, Queue and their caret are secondary. On Send the composer and the working line go to "Starting {harness}…" at once, the one status row (the message's own "Sending…" is not said too), and Stop waits disabled until the host knows of the turn. Stop is a small filled square in a ghost icon button while a turn runs, disabled while stopping and enabled again as the retry when the stop is not confirmed; Esc stops only from an empty message box or the transcript, when no menu, picker or dialog is open and none closed in the last second, never from a request in the dock and never during IME composition. After Stop, focus is in the message box.

Typing `#` at the start of a word, `@` likewise, or `/` at the start of the message opens a menu above the composer (the Command list without its input, 32px rows, at most 420px wide): tickets, Documents and Projects ("Linked to this Chat" before anything is typed, footer "Links when you send"); "Files in {folder}"; or "{Harness} commands", only when the harness lists them. Enter or Tab inserts and never sends; Esc closes the menu and keeps the text. A record mention is underlined link text and links when the message is sent or queued; Backspace removes a mention whole. A quote from Add to chat waits above the text as a 12px muted source line over two clamped lines beside a 2px rule, with no card. Add to chat appears above the first line of selected rendered text (a Document being read, a description not being edited, an update), starting where that line starts, as one ghost button on `--popover`; only without room above does it flip below the last line, so it never covers the line being read. It and ⌘L open a flat menu of up to four Chats, linked ones first, then New Chat; the menu opens in the bar's place and grows away from the selection, never as a second layer under the bar. A Chat opened from a ticket, and New Chat about one, start their header with a crumb back to it ("← T-KQ12 /").

### Status and attention

| Rank | Word            | Signal                       |
| ---- | --------------- | ---------------------------- |
| 1    | Approval needed | Orange dot                   |
| 2    | Question        | Orange dot                   |
| 3    | Working         | Spinner                      |
| 4    | Failed          | Orange dot, until seen       |
| 5    | Done            | Blue dot, until seen         |
| 6    | Idle            | None; the last line in words |

Interrupted, Not confirmed and Stop not confirmed keep their own words and never read Done. The problem notice ranks by tone: a problem that needs the person (not signed in, not installed or too old, a usage limit, an unconfirmed delivery or stop, a missing folder, lost history, a session in use elsewhere) uses **attention**, the orange dot in its title; a failure (the turn failed, the sandbox didn't start) uses **error**, only its title in `error-foreground`; a check that could not tell stays neutral. Its body is the fact, then what is safe or what to do, in at most two sentences, with host text passed through `sentence()`. Status sits on a row's second line: the dot or spinner, the word in regular weight, then muted detail. It drives the sidebar entry, the app-icon count and system notifications for Chats not in view; there is no in-app toast or window-title count. The pane's status line (section 12) is the one transient surface: it says when a Chat was archived or moved to Trash, with Undo, and when a response was saved to Documents, with Open.

### Color, motion and narrow panes

Color is only the existing small status dot beside a word. The one live signal is the 12px spinner beside words, at most one per turn and never on replayed history. Under reduced motion it is static and jumps are instant. In a narrow pane rows wrap with the suffix beside its target, outcome words never truncate, approval buttons stack, and the model trigger drops its effort bars.

### Accessibility

Every state is a word; icons, spinners and clocks are `aria-hidden`. Rows that open are buttons with `aria-expanded`. One polite status announces a turn starting, waiting and ending, and a request arriving, never each step. Command output is a focusable named region, and the New marker is a separator named "New since you left".

## 16. First run

A confirmed empty Workspace opens under the All tickets pane header with a
centred column, at most 560px of content, 96px below the header. The shared 40px
IconTile introduces “Your workspace is ready” in display type (32/40), followed
by the 15/24 local-storage explanation. Three numbered setting rows inside one
bordered radius-12 group use 12px × 16px padding and 28px compact actions. They
lead to the existing New ticket dialog, Settings › Agent skills and
Settings › Google Drive; the last step is optional. A completed step shows a check and muted text from
existing installed-skill and sync state. The actions keep their positions as
completion changes. The footer names the command-palette shortcut.

The guide requires workspace-wide ticket totals including Trash and no existing
projects, Plans or Documents. Empty filtered lists retain their ordinary empty
states. The first Ticket immediately replaces the guide with the normal ticket
workspace. Sidebar creation, C and palette creation keep the same dialog and
save path. Narrow windows reflow the actions below their row copy and scroll the
page; the fixed pane header remains reachable. Native light/dark and zoom review
remains part of visual acceptance.
