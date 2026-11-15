# ticketd interface design

## Purpose and authority

This document defines the target visual and interaction design for ticketd's desktop application and the design system it is built from (section 11). It is a specification for design work and review; the current interface is not evidence that these rules have been implemented. Dimensions are logical CSS pixels at 100% zoom. Minimum heights must grow for wrapped text and accessibility settings.

Use [GLOSSARY.md](GLOSSARY.md) for domain language, [the product specification](docs/mvp-spec.md) for behavior, and [the architecture](docs/architecture.md) for technical boundaries. This guide defines how those behaviors are presented. It does not add accounts, collaboration, or a board. The experimental native Chat screens (product specification section 21) are off by default and follow this guide’s tokens and components; their layout is specified in section 15. For tickets owned by an external source, starting with GitHub Issues ([#98](https://github.com/vantoan19/ticketd/issues/98)), it defines how ownership, freshness, and source content are presented; that issue defines the synchronization behavior. Track implementation and deviations in GitHub Issues, not in this document.

### Reference and adaptation

The visual reference is the third-party [Vercel design language analysis by design-bites](https://github.com/educlopez/design-bites/blob/main/design-mds/vercel.com/DESIGN.md). Use its published numeric values for the light palette, type scale, control sizes, spacing scale, radii, focus treatment, and elevation. It is a third-party observation rather than an official Vercel specification. The tables below distinguish those source values from ticketd-specific layout assignments and dark-theme extensions.

Use a Linear-style issue workspace with the Vercel palette and components. Ticketd needs its own application composition: a persistent workspace, a scan-friendly ticket list, a readable document, and reliable editing feedback. Map the reference roles onto these application surfaces without inventing replacement token values. Ticketd uses an explicit compact application heading of 24px/32px with weight 600 and -0.6px tracking. This is a ticketd density adaptation, not a value copied from the reference. The 48px display role remains available for genuine display content and is not applied to every ticket. Workspace pane widths and responsive transitions are ticketd layout decisions. Vercel branding does not belong in this workspace. Use the reference’s shadow boundaries and spacing-led grouping.

The workspace structure also borrows interaction patterns that Linear, GitHub Issues, and Orca share: a ticket list grouped by status, a labeled property rail beside the document, an external issue’s description shown as a read-only source card, and its comments and events on one connected timeline. Borrow these structures, not those products’ styling or branding.

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

| Role / token                                  | Reference value       | Ticketd use                                 |
| --------------------------------------------- | --------------------- | ------------------------------------------- |
| Canvas / `--background`                       | `#FAFAFA`             | Workspace canvas and navigation             |
| Elevated / `--surface`, `--popover`           | `#FFFFFF`             | Content panel, menus, dialogs               |
| Recessed / `--recessed`                       | `#F2F2F2`             | Quiet control surfaces and placeholders     |
| Primary text / `--foreground`                 | `#171717`             | Titles, authored content, active values     |
| Secondary text / `--muted-foreground`         | `#4D4D4D`             | Navigation, labels, readable captions       |
| Decorative/disabled / `--disabled-foreground` | `#8F8F8F`             | Inactive decoration and disabled states     |
| Hover / `--accent`                            | `#EBEBEB`             | Navigation and row hover/selection          |
| Interactive / `--interactive`, `--ring`       | `#0072F5`             | Focus, link decoration, interactive accents |
| Input focus / `--input-focus`                 | `#005FCC`             | Input focus outline                         |
| Boundary / `--shadow-border-base`             | `0 0 0 1px #00000014` | Shadow-based surface boundary               |
| Header boundary / `--header-boundary`         | `0 1px 0 0 #0000001A` | Pane header separator                       |

`--muted` and `--secondary` are shadcn aliases of `--recessed`, `--secondary-foreground` of `--muted-foreground`, and `--popover` of `--surface`; new code uses the semantic names. Use `#4D4D4D` for necessary small text, including timestamps. The reference’s `#8F8F8F` is not a readable-body-text substitute. If shared components use `muted-foreground` for captions, map it to the secondary text role and keep the decorative/disabled role separate.

Primary actions invert the existing primary/elevated pair: `#171717` fill and `#FFFFFF` text. Ghost actions begin transparent with secondary text and promote to primary text on `#EBEBEB` hover. Standard prose links may retain primary text with an underline, as in the reference’s standard-link treatment; use the blue token for focus and link decoration. Never reduce contrast merely to make all links blue. Source links use the accessible text-link role `--link-foreground`: `#005FCC` in light and `#52AEFF` in dark; focus and decorative interactive accents keep their existing tokens. Recessed notices and footer bands retain a shadow boundary when their fill alone is too close to the surrounding surface.

The reference also supplies indicator colors: blue `#0062D1`, cyan `#52AEFF`, teal `#45DEC5` / `#067A6E`, green `#398E4A` / `#45A557` / `#6CDA75`, orange `#FF990A`, red `#E5484D`, pink `#EA3E83`, and purple `#7820BC` / `#BF89EC`. Reserve these for small indicators, approximately 10px, when the meaning requires color. Do not introduce colored status panels. Ticketd keeps status icons neutral; status color appears only as a small dot beside a word (see Status and state vocabulary), never as a fill, panel, or icon tint.

### Dark theme and error extensions

The linked reference does not specify a dark palette or complete error callouts. The following are explicit ticketd extensions, not claimed source values. Keep the reference’s sizes, spacing, typography, and elevation structure in both themes.

| Role                  | Dark extension        |
| --------------------- | --------------------- |
| Canvas                | `#0A0A0A`             |
| Elevated / popover    | `#171717`             |
| Recessed              | `#1A1A1A`             |
| Primary text          | `#EDEDED`             |
| Secondary text        | `#A1A1A1`             |
| Disabled decoration   | `#737373`             |
| Hover / selection     | `#262626`             |
| Shadow boundary       | `0 0 0 1px #FFFFFF24` |
| Focus and interactive | `#0072F5`             |
| Input focus           | `#005FCC`             |

Errors use local `error-surface` / `error-foreground` pairs: `#FEF2F2` / `#991B1B` in light and `#2B1414` / `#FECACA` in dark. Destructive labels use the corresponding error foreground. These roles exist for readable failure explanations, not status decoration.

The theme preference is System, Light, or Dark, chosen in Settings. System is the default and follows the operating system preference live; Light and Dark override it. Theme changes apply immediately without reloading. Sidebar and portaled surfaces use the same semantic roles. Every overlay has an opaque surface; never depend on a parent pane’s background.

Normal text must meet 4.5:1 contrast against its actual surface; large text and essential non-text indicators need 3:1. Decorative shadow boundaries need not act as a control’s sole identifier. Verify composed states rather than treating this palette as proof of accessibility. Use labels, shapes, and focus outlines to keep the reference’s subtle surfaces usable. Never apply opacity to an entire panel of readable content.

### Status and state vocabulary

Use a 16px Lucide status icon plus text. Keep icons neutral; shape and label provide the distinction. Where color adds meaning (Ready, Blocked, unread, checked), use a small status dot (about 10px or less) placed beside a word. A dot never appears alone, and it is the only place status color is used.

| Meaning            | Icon treatment                                          | Visible label       |
| ------------------ | ------------------------------------------------------- | ------------------- |
| Todo               | Empty circle                                            | Todo                |
| In progress        | Circle with center mark                                 | In progress         |
| In review          | Dashed circle                                           | In review           |
| Done               | Circle with check                                       | Done                |
| Canceled           | Circle with slash                                       | Canceled            |
| Ready              | Status dot beside the word, on Todo tickets             | Ready               |
| Blocked            | Status dot beside the word, with the reason             | Blocked by T-KQ18   |
| Duplicate          | Circle with equals sign, beside a canonical-ticket link | Duplicate of T-KQ10 |
| Source unavailable | Status dot beside the words                             | Source unavailable  |
| Unread             | Status dot plus accessible unread state                 | Unread              |

Ready and Blocked are availability indicators, not extra statuses. Canceled and Duplicate must never look completed. Duplicate is a status of its own: it never looks Canceled or Done, and it always names its canonical ticket, or the source’s reference when that ticket is not in the workspace. Trashed tickets remain readable and show a restoration action; avoid a full-page faded treatment.

Each dot color keeps one meaning across every view:

| Dot    | Value     | Meaning                                                                                                                      |
| ------ | --------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Green  | `#45A557` | Ready, and other positive states such as an external source that is open and synced                                          |
| Orange | `#FF990A` | Blocked, and other states that need attention: Source unavailable, an unrecognized closure reason, an unresolved publication |
| Blue   | `#0062D1` | Unread                                                                                                                       |

Transient and settled states, such as Refreshing GitHub… or Closed on GitHub, use words without a dot.

## 3. Typography

Bundle Geist Sans and Geist Mono locally. Use the reference’s actual 400, 500, and 600 weights; include a real medium face before using 500. Do not synthesize 550, 650, or 700. Sans handles the interface and prose; Mono handles code, references, paths, and identifiers. Enable standard ligatures for prose, and preserve exact identifier legibility.

### Reference scale and ticketd assignments

| Reference role      | Size | Weight | Line height | Tracking  | Ticketd assignment                                       |
| ------------------- | ---- | ------ | ----------- | --------- | -------------------------------------------------------- |
| Display heading     | 48px | 600    | 48px        | `-2.28px` | Reserved for display content; not ordinary ticket chrome |
| Section title       | 32px | 600    | 40px        | `-1.28px` | Reserved for spacious standalone views                   |
| Subsection heading  | 14px | 500    | 20px        | `-0.28px` | Activity, evidence, relationships, list heading          |
| Tertiary heading    | 14px | 400    | 20px        | Normal    | Supporting section labels                                |
| Body / inline link  | 16px | 400    | Normal      | Normal    | Long-form standalone reading                             |
| Button              | 14px | 400    | 14px        | Normal    | Button and compact action labels                         |
| Label               | 14px | 400    | 20px        | Normal    | Field and property labels, navigation                    |
| Caption             | 12px | 400    | 16px        | Normal    | Dates, hints, counts, supporting metadata                |
| Code / preformatted | 13px | 500    | 20px        | Normal    | Code, references, paths, commit identifiers              |

Use the source’s form tokens for shared inputs: 14px/20px default and 16px/24px large. Its observed native input size is 13.3px; ticketd’s themed form controls use the explicit 14px form token rather than relying on browser-native metrics. Root text size is 16px, so the reference’s `.875rem` form size resolves to 14px.

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
| Small control                          | 32px   | Header actions, property pickers, compact menus       |
| Default control                        | 40px   | Search, form inputs, primary form actions             |
| Large control                          | 48px   | Deliberately prominent actions / coarse-pointer forms |
| Default radius `--radius`              | 6px    | Inputs, buttons, small controls                       |
| Segment radius `--radius-segment`      | 4px    | Segments, keys and other small inner shapes           |
| Marketing radius                       | 8px    | Reserved; not a replacement control radius            |
| Elevated panel radius `--radius-panel` | 12px   | Content panel, cards, menus, dialogs, sheets          |
| Pill radius `--radius-pill`            | 9999px | Tags or compact badges only                           |
| Header height                          | 48px   | List pane header and detail pane header               |
| Sub-navigation height                  | 46px   | Compact pane/header row                               |
| Page gutter                            | 24px   | Workspace and management content gutters              |
| Standard content width                 | 1200px | Management content maximum                            |
| Wide content width                     | 1400px | Wide content views where useful                       |

Stylesheets hold no literal radii or raw colors; they map to tokens as follows. Literal 6px is `--radius`, 12px is `--radius-panel`, and 999px and 9999px are `--radius-pill`. Literal 2px, 3px and 4px are `--radius-segment`. The reserved 8px maps to `--radius` and 10px to `--radius-panel`, whichever is nearer. Control outlines drawn at `#00000024` use `--shadow-border-base` (8% in light, 14% in dark), which is a lighter outline in light than the literal was. A dialog keeps its ring from `--shadow-modal` and has no border of its own. A placeholder is text and uses `--disabled-foreground`; `--control-boundary` is for outlines and empty tracks. Hairlines at `#0000000f` use `--group-hairline`, and the dialog shadow `0 8px 32px #0003` uses `--shadow-modal`, and the board drag preview shadow uses `--shadow-menu`. The only `!important` left beats inline styles from the panel library on the ticket workspace, or implements reduced motion; each has a comment.

Pane widths and row columns are ticketd geometry, defined below. The application shell fills the window; the reference’s page-width limits apply to content views, not to the combined navigation/content-panel shell. Use the supplied 48px size for coarse-pointer targets rather than inventing a new control size.

Lucide icons remain 16px inside ordinary controls, with consistent stroke weight. Icon-only actions have accessible names and hover/focus tooltips. A 16px icon sits inside a 32px or larger hit area.

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
| Focus            | `0 0 0 2px var(--ds-background-100), 0 0 0 4px #0072F5`                                  |
| Input focus      | `1px` outline in `#005FCC`                                                               |
| Modal backdrop   | `var(--ds-background-200)` at `0.8` opacity                                              |

For light theme, map `--ds-background-100` to elevated white and `--ds-background-200` to canvas `#FAFAFA`. Dark equivalents use the explicit dark surfaces above. Dark elevation preserves these dimensions and uses the dark boundary role; tune visibility through the documented theme mapping rather than changing the light reference values.

The document plane, ticket rows, and inline sections remain flat. Floating menus and dialogs use their corresponding elevation. Focus is independent of hover and selection, and uses system-visible outlines under forced colors. Overlays always have an explicit opaque background and foreground, including when rendered through a portal.

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

The drawing describes hierarchy, not additional duplicate search fields. Search belongs in the list pane header. Unread attention lives in the sidebar Inbox count, not in a top bar. The sidebar footer shows each configured source’s sync state and opens its settings.

| Region          | Geometry and behavior                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Navigation      | 208px navigation allocation plus 16px shell inset/gap before the panel; independently scrollable groups; collapsible to a 52px icon rail that does not scroll |
| Content panel   | One elevated panel, 12px radius, small shadow ring, 8px from the window edges                                                                                 |
| List header     | 48px: view title, Refresh, then Search, Filters, and Display (32px small controls)                                                                            |
| Source filter   | Below the list header once a source is configured: All, GitHub, and Local with counts                                                                         |
| Detail header   | 48px: ticket reference, source link, list position, and actions (see Ticket detail)                                                                           |
| List pane       | At least 360px in split mode; remaining width allocated with the detail pane                                                                                  |
| Detail pane     | At least 480px in split mode; start near 55% of content panel width                                                                                           |
| Document column | 32px desktop gutters, 16px on narrow windows; at least 420px, at most 800px including gutters                                                                 |
| Property rail   | At least 232px beside the document column, on the canvas surface, with 20px padding                                                                           |
| Resize handle   | 1px visual separator with an 8px hit area; visible focus and keyboard resizing                                                                                |
| Expanded detail | Centered column of at most 800px with 16px description text; keep navigation and return context                                                               |

List and detail scroll independently, and the window itself never scrolls. In the list pane only the rows (and paging) scroll: the title, toolbar, source tabs and filter chips stay fixed above them. Sticky chrome has an opaque surface and must not cover focused fields or anchor targets. The first detail viewport should show the title, properties, and the beginning of the description. Reminders, evidence forms, and an empty update editor must not push the title down.

### Responsive rules

Measure the available content panel width after navigation, not just the screen width. Preserve readable minimums rather than squeezing three panes together.

| Available space              | Behavior                                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| Content width at least 840px | List and detail may share the workspace; enforce both pane minimums                                   |
| Content width below 840px    | Selecting a ticket replaces the list in the content area; explicit Back returns to its prior position |
| Window below 768px           | Navigation moves into a sheet; retain a labeled navigation trigger                                    |
| Window near 390px            | One content column, 16px gutters, wrapping property values, full-width action forms where needed      |
| Detail pane below 652px      | The property rail folds into a chip bar under the title (see Ticket detail)                           |

A navigation sheet is at most 280px or viewport width minus 32px. Popovers retain 16px viewport clearance and collide away from edges. Forms that cannot fit a popover use a sheet/dialog with a scrollable body. At short heights, keep form actions reachable without clipping the body.

Switching pane modes, resizing, or opening navigation must not remount drafts, reset selection, or lose list scroll position. Horizontal scrolling belongs only inside code, wide tables, or the graph canvas. At 200% zoom, reflow the shell rather than shrinking the type.

## 6. Navigation and ticket list

### Navigation

The sidebar sits on the canvas surface, top to bottom:

- **Brand:** the product name in plain type beside a 32px New ticket icon button with an accessible name and tooltip. Do not use a full-width primary creation button in persistent navigation.
- **Work views:** Inbox, All tickets, Ready, and In progress, each with a distinct icon (Ready does not reuse the Done icon) and a trailing count. While the experimental Chat setting is on, a Chats entry follows them; it shows an attention dot and the count of Chats waiting for the person, or, when none waits, an unread dot and the count of Chats with an unseen outcome (see Native Chat). Working Chats never count.
- **Projects and Plans:** two groups, each with manage actions in its heading, plus an Archived Plans entry under Plans.
- **Pinned bottom:** Trash and Settings stay at the bottom without forcing other items off-screen.
- **Title bar:** on Windows the app draws its own 32px title bar on the canvas in place of the native one. It is the window's drag handle, and double-clicking it maximizes; Minimize, Maximize or Restore, and Close sit at its end, and Close turns the system red on hover. The window keeps its native resize edges and shadow. macOS keeps its transparent native bar.
- **Collapse:** a button beside New ticket collapses the sidebar to a 52px rail of icons. Like a navigation rail, it holds a few fixed destinations and never scrolls. Inbox, the three ticket views, Documents and Workspace graph keep their icons. Projects and Plans each fold into one icon that opens a menu of the group's entries and its manage action. Each label becomes its icon's tooltip, counts hide, and an unread dot moves to the icon's corner. The window's minimum size, 480 by 600, keeps the rail whole.

Group headings (Projects, Context, Plans) are 12px secondary-text labels in both themes, not primary-weight headings. Use 20px between groups and 8px between a group heading and its rows. Active navigation uses a neutral fill and primary text, plus semantic current-state markup. Inactive rows use secondary text. Hover does not change row size. Counts align at the trailing edge and remain secondary. Unread attention appears as the Inbox count or a status dot beside its label; there is no top-bar indicator and no permanent high-contrast banner.

### Approved deviations from the base design

- Status group headers use the recessed surface with hairlines above and below in both themes; the canvas surface read as a hole inside the elevated dark panel.
- Tag pills use the shadow-boundary ring (`0 0 0 1px #FFFFFF24` in dark) so they keep their shape on dark surfaces; pane edges and inputs use the same boundary, and links use `--link-foreground` (`#52AEFF` in dark).
- Sidebar section labels are 12px secondary labels in both themes.
- Single-status views (a list narrowed to one status, such as Ready or an applied status filter) render no group header (the list title already names the status) and show a one-line view description under the title, rather than the full workflow-ordered set of groups.
- Option cards use a 2px selected edge instead of the 1px boundary used elsewhere, so the selection stays legible without a fill change.
- The unlinked project choice is labeled "No project" (not "None" or "Unassigned") in project pickers, the sidebar, and ticket properties.

### List anatomy

Use stable columns: selection, status, reference, title, then the source pill of an externally owned ticket. Titles receive flexible width. Reference and status columns do not move when a checkbox becomes checked.

- Group rows by status in workflow order: In progress, In review, Todo, Done, Canceled, Duplicate. Each group has a 32px header on the recessed surface (`#F2F2F2` light, `#1A1A1A` dark) with a hairline above and below (`#0000000D` light, `#FFFFFF14` dark) with the status icon, the status name in the subsection role, a 12px count, and an Add ticket action for that status. Omit empty groups. A status change moves the ticket to its new group without animating the reorder.
- Once an external source is configured, a source filter below the list header offers All, GitHub, and Local with counts. It narrows the groups; it does not regroup the list by source.
- Checkbox hit areas occupy a reserved 32px column. With a mouse, reveal unchecked controls on row hover or keyboard focus; show all controls during bulk selection. On touch devices keep them visible. Selection never shifts the row or creates an extra row of controls inside it.
- The list header's Display button opens a menu that holds the layout choices: Layout (List or Board) and Rows (Detailed or Simple). Layout choices never sit in the header as a row of toggles.
- Detailed rows, the default, have two lines. Simple rows keep only line one, ending with the Ready or Blocked dot and the updated time. Line one: 16px status icon (with an accessible name), monospace ticket reference in a 64px column (wide enough for a device reference such as T-KQ1043), the title, then, for an externally owned ticket, a trailing pill with the source mark and its external number (#98). Line two: for Todo tickets a small status dot with Ready or "Blocked by T-KQ18", "Source unavailable" when the source cannot be reached, or "Duplicate of T-KQ10"; then one context item (parent, project, or Plan relevant to the current view), tag pills, and the 12px updated time. In a single-status view the Todo row keeps its Ready or Blocked word and dot; only the Ready view, where every row is Ready, omits the per-row Ready dot. Group headers carry the status, so line two omits the status word; views that are not grouped by status, such as search results, begin line two with it. Do not repeat the current project on every row.
- Status color appears only as the small dot beside a word, never as an icon tint or fill.
- Metadata that does not fit moves to details; the title keeps its useful width. Long titles must not overlap trailing actions.
- An open ticket uses a neutral selected fill without a decorative leading stripe. Bulk selection is communicated separately by checkboxes. Keyboard focus uses the focus ring.
- Row hover uses a quieter fill than selection. Hover actions also appear on focus; essential actions cannot be hover-only.

There is no permanent “0 selected” bar. When tickets are selected, show a compact action bar with the count, Change status, Organize, and Clear selection. Organize exposes project, Plan, and explicit tag addition/removal choices. Do not display four inline forms and their submit buttons at once. Keep the count visible after validation errors; show which ticket prevents the batch and state that nothing changed.

Search retains its query while opening details. Filter controls show active constraints and an obvious clear action. A zero-result search displays the query context and a way to clear filters; an empty workspace offers New ticket.

## 7. Ticket detail

### Required reading order

1. **Detail header:** the ticket reference with Copy; for an externally owned ticket, its source location (`owner / repo #98`) as a link that opens the source; then the ticket’s position in the current list (“2 of 11”) with Previous and Next, the actions menu, expand, and close. Avoid repeating “Ticket details” above the reference and title.
2. **Title:** wraps to its content height. Reading must not look like an empty resizable form. Editing retains a clear focus treatment.
3. **State line:** one 14px line under the title. An externally owned ticket shows its source state as a dot and words (Open on GitHub, Source unavailable), then its external number, author, and opening date; a closed one reads “Closed on GitHub as completed” without a dot. A local ticket reads “Local ticket · created Oct 31”.
4. **Description:** primary reading surface, with editing on demand. An externally owned description is a read-only source card (see Documents and activity).
5. **Subtickets:** directly under the description, a heading with a compact neutral progress bar and “1 of 2 done”, rows with status icon, reference, title, and status word, and Add subticket. On an externally owned ticket, a caption states that subtickets stay local.
6. **Evidence and backlinks:** flat sections with concise existing information and contextual add/edit actions.
7. **Source conversation:** tickets that have an external source. The source’s comments and events, read-only, with a link to comment at the source. After ownership is taken the retrieved conversation stays, as the history of the source; it is no longer refreshed.
8. **Activity:** authored updates, distinguishable recorded changes, and explicit update submission, with an All | Updates toggle. Activity follows the description; empty relationship sections are folded away. On an externally owned ticket, a caption states that updates stay in ticketd and are never sent to the source.

For In progress and In review tickets, a Latest update section follows Status in the rail. It uses the core’s latest authored update, with its relative reporting time and supplied editing agent, and opens that update; with none it says “No update reported”. Editing an older update does not make it the latest report. In the chip bar it fills its own line under the chips.

While Chat is on, a **Chats** section follows Status and Latest update in the rail: one ghost line, "3 Chats · ● Approval needed ›", naming the count and the top-ranked status of the ticket's Chats (only the count when none is live). It opens a menu of those Chats (title, then their status line) ending in Chat about this ticket; under the line, the same action is a ghost button with a plus. With no Chats only the action shows; Chats in Trash never show, and a ticket in Trash keeps the line but not the action. In the chip bar the line is a chip, in rail order. Chat about this ticket is also in the ticket actions menu, after Copy context command.

The **property rail** sits beside the document column on the canvas surface, in this order: Status, Source, Project, Plan, Tags, Relationships, and Attention (Follow and the reminder). Each section has a 12px secondary label above its value; values are 32px ghost controls with identifying icons and no outlined boxes, aligned to the label’s left edge. Hover and keyboard focus reveal interactivity. Separate sections with 20px spacing, not dividers or cards. Outlined, labeled fields remain the creation form’s treatment. A picker opened from the rail aligns to the rail’s right edge so it stays inside the content panel. When the detail pane is too narrow for the rail beside the document column, the rail folds into a wrapping chip bar under the title, in rail order; each chip shows its value and opens the same editor, and Relationships follow the description as a section.

In split view, description text is 14px. In the full-width (expanded) view, the document column is centered at no more than 800px, the property rail stays beside it, and description text is 16px.

Use 8px from title to state line and 24px from state line to the description. Use 40px between major sections. The ticket stays one scrolling page, without tabs or an outline. Each major section (Subtickets, Evidence, Backlinks, Source conversation, Activity) opens with a section header: one row holding the section's title, count, and actions. Space sets sections apart, not divider lines or cards; shadow boundaries belong to pane edges, floating surfaces, and the source description card. An empty section is one muted line with its action in the header, not a filled box.

A save state belongs next to the edited content, in 12px supporting text. Stable Saved feedback must not take an entire standalone section. Pending save, Saving, and failures remain visible and accessible. Never hide a failure to achieve a cleaner screenshot.

### Visibility and action placement

| Information/action       | Default presentation                                               | Editing surface                                         |
| ------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------- |
| Follow                   | Labeled toggle in the rail’s Attention section                     | Immediate action with pending/error feedback            |
| Reminder                 | Remind me trigger, or a short scheduled-time summary, in Attention | Focused popover; expand to sheet when space requires    |
| Status/project/Plan/tags | Labeled values in the property rail                                | Anchored picker; explicit clear/add/remove choices      |
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
- **Unavailable source:** a recessed notice at the top of the document column states what failed and since when, says that nothing was deleted or completed, and offers Retry and Take ownership…. The list row and the rail carry the orange Source unavailable dot.
- **Publishing:** an eligible local ticket (Todo, In progress, or In review) offers Publish to GitHub… in the rail’s Source section; an ineligible one states why. Publication goes through a dialog that previews the issue exactly as it will be sent.

## 8. Documents and activity

Follow the [canonical Markdown editing decision](docs/adr/0005-plate-editor-with-canonical-markdown.md). Reading and focusing a document never rewrite it. Unsupported rich content retains a source-editing path.

- Description editing is in place. Show formatting tools in the editing context; avoid a permanent multi-row toolbar above every rendered document.
- Selection formatting, slash commands, and block movement have keyboard alternatives. Controls must not steal editor selection unexpectedly.
- Paragraphs use the document type scale and 12px separation. Lists use 20px indentation with 4px between items. Checklist controls align with the first text line.
- Code uses a recessed surface, 12px padding, language label, and Copy action. Scroll code horizontally inside its boundary. Long prose and URLs wrap.
- Tables stay within a labeled horizontal scroll region. Preserve cell readability instead of shrinking the whole table.
- Mermaid diagrams fit the reading column and provide source and expand actions. Rendering errors stay beside the diagram; source remains editable and savable.
- An update is a content entry, not a chat bubble. Show timestamp and supplied editing-agent attribution without inventing human identity.
- An external source’s description is read-only and sits in a source card: 12px radius, the boundary ring, and a 40px header bar on the canvas surface naming the author and action (“vantoan19 opened this issue on GitHub · Oct 31”), Read-only, and a link to edit or view it at the source. The header’s source name and Read-only mark are the provenance signal.
- The source conversation is one connected timeline, like Activity. A comment is a comment row with no card: a 28px badge on the line, a caption header naming the author, “commented on GitHub”, the time, Read-only, and a View link, then the comment body. Its events, such as closed as completed, closed as a duplicate, reopened, or an assignment change, are compact rows: a 28px circular icon, the actor, the event, and the time.
- Activity is one timeline under its composer, joined by a single 2px line as on a GitHub issue. Updates are comment rows on the line, with no card, whose header names the supplied agent and the time. Recorded changes are compact event rows, visually quieter than updates, with their 28px icon on the line; changes made together share one row. All | Updates hides the event rows.
- The empty update composer begins as a one-line “Write an update…” affordance. Once opened, keep the draft available until submission or explicit discard, with “Add details” and “Attach Document” in one row and “Draft kept on this device” beside Post; blur is not submission. Whitespace-only text cannot be posted. Details are the Document that explains an update; attaching a Document uses a title-search picker, never a raw ID.

Description autosave and explicit Post update submission remain different interactions. External CLI updates refresh saved values while preserving drafts. A conflict notice offers Reload saved content and Save my draft, with enough text to explain the overwrite. Do not move the notice out of view when a refresh occurs.

## 9. Attention, reminders, evidence, and duplicate review

### Attention inbox

Use rows with a consistent grid: unread indicator, ticket reference/title, event summary, then time and read-state action. Title and summary are separate lines. Show human language such as “Status changed to In review”; never expose event keys such as `relationship:discovered-while`.

Your own updates never notify you. Opening an entry marks it read; an entry for a deleted update says “Update deleted”. Unread rows have stronger title emphasis and an explicit state. Read rows remain legible. Keep Mark shown as read near the view heading; per-row controls appear on focus as well as hover. Navigation to an update reveals and focuses the relevant content without silently changing ticket status. Follow and reminder settings remain personal to the local person.

### Reminders

A reminder editor contains a heading, date/time input, short local-time hint, and one primary schedule/reschedule action. Show the current scheduled time when one exists, with Snooze and Dismiss as secondary actions. Ambiguous daylight-saving times require an explicit choice; invalid times show an inline error.

Use the locale's date/time presentation. Show exact time and zone where choosing a time needs precision. Do not put storage timestamps, request IDs, or UTC serialization explanations in ordinary helper copy. Due attention appears in the inbox; the interface must not promise delivery while the app is closed.

### Implementation evidence

Show the record's name first, type second, and a readable URL, short commit reference, branch, worktree path, or verification result below it. Long values wrap or have a local overflow affordance with Copy. Dates use readable formatting and can reveal an exact timestamp.

Provide an appropriate explicit open action where supported; always retain Copy for addresses and paths. Do not imply that a pasted pull request URL is connected to live platform status. Keep Edit and Delete subordinate to the evidence itself. An empty evidence section needs one short explanation and Add evidence, not an open form.

### Duplicate dependency review

Use a dialog or expanded review pane, not a small popover. Show the duplicate and canonical ticket by reference and title, the resulting Duplicate status, and each affected dependency with its current and proposed endpoints.

Each edge has an explicit retain, remove, or replace choice where valid. The final action states what will be applied. A stale preview or cycle error keeps the review visible and requests a fresh preview; no partial success presentation is allowed. Removing a duplicate designation must explain that dependency replacements are reviewed separately. Preserve access to the duplicate's description and history.

## 10. Projects, Plans, graph, and settings

Project and Plan views reuse list typography, filters, row density, and selection behavior. Use the compact 24px/32px application title and a short context line. Plan status counts are simple labeled counts, not large dashboard cards or a productivity score. Archive/reactivate actions remain distinct from completing tickets.

The dependency graph uses a neutral canvas, readable reference/title nodes, and explicit edge direction with a legend explaining which ticket blocks which. Selection and keyboard focus remain visible without relying on colored edges. Keep zoom, fit, and return controls in one compact toolbar. Node selection opens ticket context; graph navigation must retain a way back to the prior ticket. Large graphs need bounded loading and a clear explanation when the displayed scope is limited.

Settings are described in the next section.

### Settings

Settings is a dedicated page made of pages: the section nav opens exactly one section at a time, and nothing scrolls to a card. It replaces the sidebar with its own nav, and the content panel keeps the same inset and shadow ring. Every page is composed from one shell and the shared components, using semantic tokens only.

**Nav.** The nav is 224px wide, matching the workspace sidebar. From the top: **Back to tickets**; a **Search settings** entry, which shows the current query and a ⌘F hint (Ctrl+F outside macOS) and opens the Search page, where that shortcut (⌘F on macOS, Ctrl+F elsewhere, never both) also leads while Settings is open; then the groups below. Each item has a 16px icon, the active item uses the accent fill with `aria-current="page"`, and every item opens its own page. Links from elsewhere, such as the Attachment Library's, open the page that holds the setting.

| Group       | Sections                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------ |
| Preferences | Appearance, Attention                                                                            |
| Workspace   | Location, Attachments, Backups, Export                                                           |
| Agents      | Command line, Agent skills, Chat (Experimental badge)                                            |
| Connections | Google Drive, then one entry per available source (GitHub), added only when its connector exists |
| Help        | Keyboard shortcuts, About                                                                        |

The list lives in `settings-sections.ts`; a section is added there with its page. Two indicators sit at the end of an item and carry a spoken label: an attention dot, "Needs setup", on Command line (the tool is not found or needs attention) and on Agent skills (a detected agent lacks the skill, or its copy needs attention); and a positive dot, "On", on a source with a saved configuration. Pages that change what an indicator reads ask for it again, so the dot follows without reopening Settings.

**Page shell.** A page is the panel bar and a centered column.

- **Panel bar:** sticky, 48px, with the breadcrumb `Group / Page` (group muted, page in the foreground color) and an end slot. The end slot reads "Changes apply right away" with a check icon on pages whose controls apply immediately (Appearance, Attention, Attachments, Chat), shows a source's save state on source pages, and is empty elsewhere.
- **Column:** at most 736px wide, 40px above, 32px at the sides and 80px below.
- **Page header:** a 40px icon tile (panel radius, recessed fill, border ring, 20px icon), the page title as the `h1` (24/32, 600) and a one-sentence lede (14/20, muted, at most 560px). The `h1` takes focus when a page opens; Search focuses its input instead. A badge may sit beside the title.
- **Sections:** 40px apart. A level 2 heading row holds the title, an optional caption (12/16, muted, at most 520px) and actions at the end, such as Check again, Refresh now or a status label; 12px separate it from the content.
- **Lists and rows:** a list is a surface with the panel radius and the shadow ring, its rows divided by the group hairline. A row has an optional leading tile, a title (14/500) with a description (12/16 muted) and a trailing control, at least 64px tall. The top-aligned variant serves switches and wrapping text; the stacked variant serves full-width controls.
- **List footer:** a list may end in a recessed footer (12/16, muted) for explanations, results and secondary actions. Keep export and backup explanations and their success and failure messages in the footer beside their actions.
- **Choices and controls:** use ChoiceTiles for an exclusive choice that deserves a title, a sentence or a preview, a segmented control for two to four short options, and a switch for an on/off preference. A status is always a StatusLabel. A command to run is a CommandBlock, and ordered instructions are Steps.

**Saving.** Each page uses one of three models and says which.

- **Immediate:** Appearance, Attention, Attachments' destination and Chat apply when changed. There is no Save button; the panel bar says "Changes apply right away". A failure appears beside the control.
- **Save on blur:** a text value, such as the upload limit, saves when the field loses focus and says "Saved" beside it for two seconds. Invalid input and failures are stated next to the field and the previous value stays in force; the next valid value clears the message, even when it is the value already saved.
- **Explicit Save:** a source is the exception. Its discovery rules are a draft with a save bar stuck to the bottom of the panel: a status (dot and sentence: Saved configuration, Unsaved changes, or the rules changed and need a new preview), **Discard changes**, **Preview matches** (hidden once the preview is current) and primary **Save**. Save stays unavailable until Preview matches has run for the current rules and something changed. Saving turns discovery on and says that matching issues are imported on the next refresh. A saved source also shows its refresh schedule and its last refresh, with Refresh now in the Sync header.

**Pages.**

- **Theme:** Appearance offers System, Light and Dark as ChoiceTiles with miniature windows, shown in both themes at once through the scoped theme tokens. System is the default, follows the operating system live and says which theme it is right now; the choice applies without reloading.
- **Agent skills:** one list for the ticketd skill: its overall status, a sentence on what it does, and one action that installs or updates it for every supported agent found on this computer ("Install for Claude Code and Codex"). A second list has a row per agent with its status and skill folder. A copy that was edited or not written by ticketd is left out of that action and offers Replace… on its row, which goes through a review dialog that says the current file is saved as a backup. Check again sits in the section header.
- **Command line:** the status of the ticketd executable, with not-found shown as Steps toward Check again, then the quick reference as CommandBlocks whose colored words are placeholders to replace.
- **Google Drive:** a track of four steps (Connect, Choose a workspace, First sync, In sync) above the content for the current stage. Choices are ChoiceTiles, and the Files are not encrypted notice stays visible before connecting.
- **Keyboard shortcuts:** a filter, then groups of keys in one right-aligned column, each with a spoken label; an empty filter offers Clear filter.
- **Search:** a labelled input, a status line, and results grouped by section as link rows with the match highlighted (semibold with an underline, not color alone). With no query it shows only the input and its status line; a query with no match shows an empty state that offers shortcuts to common sections. Results come from one registry beside the section list, with one entry per setting; a test keeps every entry pointing at a real section.
- **Restore, replace and disconnect:** restoring a workspace backup always goes through a review dialog that states what will be replaced: a comparison of the current workspace and the backup, a note that restoring replaces everything including follows, reminders and inbox state, a safety backup that comes first, and a footer with Cancel and the only destructive control, "Replace workspace with backup". Replacing an agent skill, disconnecting Google Drive, switching its account and turning Chat off ask first in a dialog that names what changes. Never use a browser confirmation.

## 11. Design system and shared components

ticketd's interface is assembled from one design system: the tokens in `apps/desktop/src/styles.css`, the bundled Geist fonts, and the shared React components in `apps/desktop/src/components/ui`, which are shadcn/ui copies restyled with the tokens. A web client can reuse them by building the same source; a separate package earns its place only once a second app imports the components.

### Levels

Build from the bottom up. A piece may use anything from a lower level, never from a higher one.

| Level                    | What lives there                                               | Where                            | Examples                                                                                                                                                                         |
| ------------------------ | -------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 · Tokens               | Named decisions; the only place raw values live                | `apps/desktop/src/styles.css`    | `surface`, `muted-foreground`, `radius-panel`, `shadow-menu`, `text-ui`                                                                                                          |
| 1 · Base components      | One job each, no ticketd words, tokens only                    | `apps/desktop/src/components/ui` | Button, IconButton, Input, Select, Switch, SegmentedControl, StatusDot, StatusLabel, ChoiceTiles, CommandBlock, Steps, Badge, Reference, Count, Progress, Kbd, Tooltip, Skeleton |
| 2 · Composite components | Content-agnostic compositions with slots                       | `apps/desktop/src/components/ui` | Field, Picker, TokenField, Menu, Popover, Dialog, Sheet, Command, ListHeader, EmptyState, Alert, SectionHeader, Card, Item, Timeline, EventRow, Sidebar                          |
| 3 · Product components   | ticketd recipes that know tickets, statuses, sources and Plans | `apps/desktop/src/features`      | StatusIcon, TicketRow, property rail, Activity, source card, Filters and Display, bulk bar                                                                                       |
| 4 · Layouts              | Page structures that place components                          | `apps/desktop/src`               | App shell, split view, ticket page, management page, Settings                                                                                                                    |
| 5 · Screens              | Real screens with real content                                 | `apps/desktop/src`               | All tickets, a ticket, Inbox, a Plan                                                                                                                                             |

Levels 0–2 live in `components/ui` and `styles.css`; levels 3–5 live with their features. Interactive components wrap a Radix primitive (Select, Popover, Dialog, DropdownMenu, Switch, Tooltip) that supplies keyboard, focus, and ARIA behavior; features use the wrapping component and never style a Radix part directly. Recurring combinations of components are patterns, written in this document rather than coded: empty, loading, and failure states (section 12) and the choice between menu, popover, and dialog (below).

### Catalogue notes

What the shared pieces do and which variants exist; each has a JSDoc summary in its file.

- **Badge** labels a tag (`tag`), an external source reference such as #98 (`source`) or a Document chip (`doc`, 28px). `size="sm"` fits ticket rows and `tone="raised"` sits on a recessed control. **Reference** is a ticket or Plan reference in the mono face, **Count** a caption-size tabular number beside its label, and **Progress** a 64px bar that is named with `aria-label` and has its words beside it; it keeps an edge and a system fill under forced colours.
- **SectionHeader** is the heading row of every section: a heading (`level` 1 to 3) that holds the optional count, so the name reads “Evidence 2”, then controls (`children`) and `actions` pushed to the end. `caption` is a muted note on its own line under the row. `bar` makes the 44px header that opens a panel.
- **Card** has a header band, body and recessed footer for a source description card or a management card, not for comments, updates or evidence; `asChild` lends it to a `section` or `article`. **Item** is one 36px row for a small list inside a section, with a leading icon, a Reference, a truncating title and trailing meta; `asChild` lends it to an `li`.
- **ChoiceTiles** is a radio group of tiles (`ChoiceTile`) wrapping Radix RadioGroup, for an exclusive choice that deserves a title, a sentence and often a `preview`. Two or three `columns`; the chosen tile wears a 2px interactive ring, a disabled tile goes recessed, and `children` add detail that must not be interactive. It replaces the separate choice-card styles; name the group with `aria-label` or `aria-labelledby`.
- **StatusLabel** is a StatusDot and the word that says what it means, the one way to show a status. `size` is `ui` (14/20) or `caption` (12/16).
- **CommandBlock** shows a command to run in a recessed mono block with a muted `$` prompt that is not selectable or copied, ALL_CAPS words (PATH, TICKET) as placeholders in `--syntax-keyword`, a copy icon button and a transient “Copied” status. Say near the block that colored words are placeholders.
- **Steps** is a numbered list joined by a thin line; each `Step` has a title, a description and an `action`, and may be `done` (`--status-ready`) or `current` (primary), with words beside the state where it matters.
- **Timeline** joins comments, updates and recorded changes with one 2px line, in Activity and the source conversation alike. A **CommentRow** is a comment or update with no card: a 28px badge on the line, a caption header with actions at the end, and the body beneath. An **EventRow** is one recorded change, a 28px badge with the change’s icon, the sentence and caption-size meta. A status change shows its new status icon, so Canceled and Duplicate never look completed.
- **Alert** is the one inline notice: a short title (`level` makes it a heading where the notice replaced one), one sentence and real buttons. Tones are `neutral`, `attention` (a status dot in the title) and `error`; size `compact` is the single-row form for transient confirmations such as “In Trash”. It defaults to `role="alert"`; pass `status` for a calm update.
- **EmptyState** comes in `block` (an empty view: icon, title, one sentence and the action that fills it), `inline` (a row inside a card or section, the action at its end) and `hint` (a quiet pane with one line and an optional footnote; it carries no icon, description or action).

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
- **Overrides inside `components/ui`** (`dialog-shell`, `command`, `empty-state`, `field`, `picker`, `resizable`, `sidebar`). The composite passes spacing, type or color classes to the primitive it wraps (`DialogContent p-0 gap-0`, `DialogTitle text-2xl`, `Label font-normal`). Each becomes a variant on the primitive (`dialog`, `label`, `separator`, `sheet`, `input`).
- **Arbitrary values with no scale equivalent** (`dialog.tsx`, `sidebar.tsx`, `switch.tsx`, `tooltip.tsx`, `dialog-shell.tsx`, `empty-state.tsx`, `DocumentEditor.tsx`): `calc()` widths and offsets, `transition-[...]` property lists, `0_0_0_1px` ring shadows, `tracking-[-0.6px]`, `stroke-[1.75]`. They need a new token or utility, which the design has not decided.
- **Toggled state color** (`Activity.tsx` `bg-accent` on a ghost Button): needs a pressed treatment for ghost buttons, which would change every ghost trigger that opens a menu.

### Control and state recipes

Compose a control before inventing another. Inputs, buttons, menus, fields, notices, and dialogs must have one visual contract across views.

| State          | Required treatment                                                                            |
| -------------- | --------------------------------------------------------------------------------------------- |
| Rest           | Clear label, semantic surface and foreground, stable dimensions                               |
| Hover          | Subtle neutral fill or border change; no translation or scaling                               |
| Keyboard focus | Visible ring independent of hover and selection                                               |
| Pressed/open   | Persistent selected treatment and semantic expanded/pressed state                             |
| Disabled       | Native disabled semantics, no activation, readable label; explain a non-obvious restriction   |
| Pending        | Preserve width, show progress text/icon, block duplicate submission, retain the draft         |
| Invalid        | Field-level message and invalid semantics; never only a red outline                           |
| Failure        | Actionable local error with retry where possible; distinguish failed saves from saved content |
| Success        | Updated value and concise confirmation; avoid repeated success toasts for autosave            |

Primary buttons use the inverted neutral pair. Secondary actions use outline or quiet neutral fill. Tertiary actions use ghost styling with a visible focus state. Inline ticket references are links with consistent hover/focus behavior; they should not resemble a row of submit buttons embedded in prose.

Fields have persistent labels; placeholders are examples, not labels. Forms use aligned full-width inputs, shared field spacing, and a trailing action row. Put the destructive action away from ordinary submit controls. Do not place an unstyled native select beside a themed button and consider the form finished.

Menus are for short action choices. Popovers are for small, focused edits. Dialogs are for multi-field forms, consequential confirmation, and dependency review. Every dialog/sheet has a title, a close path, correct focus containment, and focus return. Escape closes only the foremost surface and must not silently discard a draft. One action must not open a stack of overlapping editors.

## 12. Feedback, motion, and accessibility

Use a small set of observable states rather than transient notifications everywhere. Empty, loading, unavailable, failed, saved, and externally changed data must be distinguishable. Build them from the shared EmptyState, Skeleton, and Alert components. An empty state carries the action that fills it; two have none because the control sits directly beside them: the Activity timeline (its composer is the row above) and a Plan’s Dependencies view (Add tickets is in the Plan header above). An empty Board column says “No tickets” (its header names the status, so every column reads alike and the line never wraps) and offers Add ticket; with a search or filter on it says “No matches” and offers Clear filters.

| Situation                       | Presentation                                                             |
| ------------------------------- | ------------------------------------------------------------------------ |
| Initial list load               | Row-shaped placeholders using the final row geometry                     |
| Background refresh              | Retain the current content and scroll; avoid blanking the pane           |
| No tickets                      | Short explanation and New ticket action                                  |
| No filter matches               | Current query context and Clear filters                                  |
| No selected ticket              | Quiet selection hint; no large illustration                              |
| Missing/trashed reference       | Readable reference plus unavailable/trashed explanation                  |
| Save failure                    | Draft stays editable with Retry and a clear failure message              |
| External change beneath a draft | Local notice with explicit reload/overwrite choices                      |
| Source refresh                  | Retain content; “Refreshing GitHub…”, then the new sync time             |
| Source unavailable              | Last synced content stays readable; notice with Retry and Take ownership |

Buttons and links change color/background without scale, translation, or opacity animation. Overlay motion uses the reference’s 200ms popover / 300ms modal duration, scale from 0.96, and `cubic-bezier(.175, .885, .32, 1.1)` easing. Avoid animated row reordering and decorative loading loops. Honor reduced-motion preferences with immediate state changes. Motion is never required to understand completion or selection.

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

Keep the 16px root so rem-based shared controls remain predictable. Working-pane text and ticket-row titles use 14px/20px; captions stay 12px/16px. Ticket and view titles use the ticketd-specific 24px/32px heading above. Navigation items are 32px high, the brand row and the list and detail pane headers are 48px high, and ticket rows have a 48px minimum with 8px vertical padding and no inter-row margin. Status group headers are 32px high. List headers use 16px top and 12px bottom padding. Use 32px desktop document gutters and 16px narrow-window gutters. These application density choices take precedence over spacious display roles; preserve the reference palette, font families, shadows, and focus treatment.

### Workspace hierarchy

The ticket title is the strongest heading in the split workspace. The list heading is 14px/20px at weight 500, with a 12px count on the same line. Search and Filters use the 32px small-control role and transparent resting surfaces. Use the canvas color for navigation and the elevated surface color for the content panel. Preserve one subtle boundary between the list and detail panes; do not add nested cards around these regions. Properties in the rail use the shared ghost button and select variants beneath their labels. The full creation form keeps labeled, outlined controls.

## 15. Native Chat

A Chat (product specification section 21) opens in the detail pane: a 48px header, the transcript, then the problem notice, activity dock and composer. It uses the shared components and existing tokens and adds none. A spaced middle dot separates items, a chevron marks disclosure, and at most two disclosure levels show at once.

### Identity and header

- **Harness mark:** the official mark in one color, 14px in a 16px box, once per surface: before the header title, leading a list row, and leading the composer's picker. An unknown harness uses `SquareTerminal`. Status never sits on a mark's corner.
- **Project icon:** derived from the Project's folder, probed when shown and never stored: a transparent favicon is its shape in the text color, an opaque one its picture in grays on the boundary ring, else a letter tile on `recessed`. Never the favicon's own colors.
- **Header:** one line: mark and title, then one muted 32px context button before the actions: the Project icon (else `folder`; `folder-x` in `foreground` when the folder is missing), the folder's name capped at 18ch with an ellipsis, and a chevron. Nothing else rides in it, so it never pushes into the title or the actions; below a 460px pane only the icon and the chevron stay. Its 280px popover ("Chat context", groups split by one `border` hairline) has four groups: the folder (name at 14/500 with Copy path, the path in 12px muted mono shortened in the middle, the branch on one 12px mono line shortened at the start, or "Detached at …"); the harness (mark and name, its status word on the right with a 6px dot, the version and executable in 12px mono when known, and "Check again" only when it isn't ready or couldn't be checked; "Checking…" holds the status word's place and gives way to "Couldn't check" after 8 seconds); the context window when the harness reported one; then 32px ghost rows: Open in the file manager, "2 other Chats here" opening their list, and the Project opening its tickets. Esc closes it and returns focus to what opened it.
- **Linked records:** 28px chips on one line, at most 280px each; remove shows on hover or focus, and what does not fit folds into "N more". With no links there is no row; the Chat actions menu links one.
- **List rows:** the mark leads; line two is the status, then one context item, the first ticket's status icon, mono reference and "+N", else the Project.
- **New Chat:** no harness radios; the harness is chosen in the composer's picker. The notice under the composer holds the chosen harness's actions. New Chat starts on the last harness used while it can still be used, else the first that can, with that harness's last pick of model, effort and permissions while it still offers them. The picker holds its place from the first frame (a disabled skeleton trigger while harnesses are checked), so nothing moves when the check ends. The folder button reads "Folder: repo" (full path in its tooltip); its menu lists recent folders with where they are and a check on the current one, then "Scratch folder" (the empty folder ticketd keeps for the Chat), then "Choose a folder…". Linking a Project that has a folder chooses that folder unless one was already picked. The Link popover lists recent records before anything is typed.

### Transcript

Your message is right-aligned on `accent`, at most 82% wide, exactly as sent; past four lines it folds behind "Show more", and its time and Copy show on hover or focus. Its images are 96×72 tiles (the Attachment thumbnail's tile size), three then "+N", each opening the Attachment preview. A reply is full-width Markdown with no bubble. Expanded mode is a centered 720px column with gutters of at least 48px and messages at 16/24.

A **turn** runs from your message to its end; a steer starts a new segment. While it runs, step rows appear as tools start; "Working for 1m 32s" shows only between steps. When it ends, its steps, reasoning and record changes fold under one muted row: "Worked for 2m 13s", "Continued for 48s", "Stopped after 40s" or "Failed after 8s", plus problem counts only when present (" · 1 failed"). The time leaves out what the turn spent waiting on you for an approval or a question; past 5s it says so (" · waited 2m"). Opened, steps indent 16px. The harness's own warnings (an MCP server that did not start) are one quiet 12px line per turn, "2 Codex warnings", that opens to them and folds with the turn. The final response, question and expiry receipts, and ticketd notes such as sign-in problems are never folded. While a request waits in the dock, its card is the only place it is said: no "Waiting for you" line and no row for the step it asks about. A turn whose stop was not confirmed stays open.

A **step row** is one 28px line, `[icon] Verb target · suffix`:

- **Icon:** one neutral 16px Lucide icon per kind: read `eye`, search `search`, edit `pencil`, create `square-plus`, delete `trash-2`, run `terminal`, web `globe`, other `wrench`. A running step shows the 12px spinner in its place.
- **Words:** the verb in `muted-foreground`, the target in mono `foreground`. Only success takes the past tense: "Ran `npm test`", but "Run `npm test` · Failed".
- **Suffix:** at most one: a clock ("12s"), a diffstat ("+12 −4", 12px mono, muted), "No matches", or an outcome word at weight 500: Failed, Timed out, Declined, Not finished, Not confirmed. A step that finishes in view keeps its running verb's width, so a file name after it does not move. Rows are never grayed, and nothing is parsed from output.
- **Targets:** one or two are named ("`a` and `b`"), three or more counted ("Read 6 files"). Paths are relative to the Chat's folder, with `~` outside it; a search reads "for `pattern` in `scope`", a web search "for “query”", a page `host/path`, and a command its first line without shell wrappers.
- **ticketd calls:** a command that only calls the ticketd CLI (by its path, on PATH, or through a variable set to it) reads as what it does, in the step's tense: "Set `T-MP4` to In progress and posted an update on `T-MP4`", "Read Project Verify Project" (linked records by title). Any other ticketd call shows its command as `ticketd …`, without the path or the variable. Opened, the row shows exactly what ran. Claude Code's plan file reads "Wrote its plan".
- **Merging:** consecutive steps of one kind and outcome merge ("Read 6 files"); a different outcome word ("No matches", "Timed out") keeps its own row; commands never merge.
- **File names:** in a row that does not open, a read, edited or created file's mono name is itself the button: no ring or icon, `accent` on hover, opening the file in the computer's default app. It shows its last part (with its folder when another file in the row shares the name) and, short of room, truncates in the middle so the extension stays. A file that is gone is plain text; a failure is a caption under the row ("Couldn't open limiter.ts. No app on this computer opens .ts files.").
- **Detail:** a row opens one thing; a command opens one `code-block` box with its output and Copy, then a muted "Exit 1 · in {folder}". The box is at most 12 lines tall, scrolls inside, mounts only when opened and opens at the output's last line; the `$` is never copied.

An answered approval folds into its step row, with a tooltip such as "You allowed this for this session"; only questions ("Answered · …") and expiries ("Expired · …") leave receipt rows. The host records which step an approval was asked for and folds it there ("You declined this"); an approval it cannot tie to a step leaves no row. When a turn ends, a step still running reads "Not finished", or "Not confirmed" after an unconfirmed stop. A turn someone is reading in, or that holds focus, folds once it leaves the view; the person's own toggles win for the session.

**Below the response** come 28px step-style rows, in order and only when needed: the stop marker, changed files ("3 files changed · +53 −12"), then records, verb first ("Moved T-KQ12 to In review · Posted an update on T-KQ12"). References are mono and underlined everywhere. A record row leads with the ticket's status icon; a created Document's title is its link, without quotes.

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

The dock sits on the composer, tucked 12px under it, hidden when empty; its height glides in 150ms ease-out when a card arrives or leaves, and the transcript keeps the end in view through the glide. It holds only, in order, the pending request, the plan pill ("3 of 7 done · {current step}") and the queue. A pending request appears only here, never takes focus from the message box, and is answered only by its own buttons. Its title carries what would run inline in mono; approval choices are outline buttons in one row that wraps when narrow and question options plain 40px rows. Inside a request ↑/↓ move and 1–9 pick, with no key badges; ↑ from an empty message box reaches the first option. While the dock shows a request, the transcript shows no "Waiting for you" line. A draft typed before a question arrived keeps its meaning; only an empty box answers it. The queue reads "Queued 3 · After this turn", or "Paused" with Resume; each card is one 32px line whose Send now, Edit and Remove show on hover or focus.

The composer's control row holds two 32px triggers, then Stop and Send, on one line at every width: the triggers truncate first, and below a 460px composer Permissions keeps only its shield and the effort only its bars. The first is one picker for harness, model and effort (`[mark] Opus 5.5 ▂▄▆ Medium ▾`); its 320px popover keeps one height for every tab and while models load (skeleton rows), so the tabs never move. Top to bottom: harness tabs (mark and name, Left and Right move between them; one that isn't ready is dimmed with its word, and choosing it shows its notice and actions), the model's efforts as one segmented row (with "Default" first when the harness names no default effort), then the models, the only scroller (name, the harness's description unless it repeats the name, a muted "Default" tag, a check on the current one; an alias row is named by the model it runs). Past six models only the default, the current one and the first others in the harness's order show, then "More models (N)". It lists only what the harness reported, in New Chat from the host's check before any session; a harness that reported nothing offers "Default" and says so. What the picker shows is what the first turn runs on: New Chat sends the shown model, effort and permission mode by id, never "unset". In a Chat the harness is fixed and only its tab shows; until the session reports, a Chat made in New Chat shows what it was started with, so the triggers do not change as it starts. The second is permissions (shield and the mode's name, never a bare "Default"; full access is never offered). Send shows an icon and a word set by the turn: Send, Steer or Queue. Enter does what it says, and Cmd/Ctrl+Enter queues while a turn runs. Beside Steer only, a caret menu holds Steer now (with the harness's steering effect) and Queue. The placeholder says the same: "Message {harness}", "Steer {harness}", "Queue for {harness}" or "Answer, or pick above". Send is the only solid button; Steer, Queue and their caret are secondary. On Send the composer and the working line go to "Starting {harness}…" at once, the one status row (the message's own "Sending…" is not said too), and Stop waits disabled until the host knows of the turn. Stop is a small filled square in a ghost icon button while a turn runs, disabled while stopping and enabled again as the retry when the stop is not confirmed; Esc stops only from an empty message box or the transcript, when no menu, picker or dialog is open and none closed in the last second, never from a request in the dock and never during IME composition. After Stop, focus is in the message box.

Typing `#` at the start of a word, `@` likewise, or `/` at the start of the message opens a menu above the composer (the Command list without its input, 32px rows, at most 420px wide): tickets, Documents and Projects ("Linked to this Chat" before anything is typed, footer "Links when you send"); "Files in {folder}"; or "{Harness} commands", only when the harness lists them. Enter or Tab inserts and never sends; Esc closes the menu and keeps the text. A record mention is underlined link text and links when the message is sent or queued; Backspace removes a mention whole. A quote from Add to chat waits above the text as a 12px muted source line over two clamped lines beside a 2px rule, with no card. Add to chat appears at the end of selected rendered text (a Document being read, a description not being edited, an update) as one ghost button; it and ⌘L open a flat menu of up to four Chats, linked ones first, then New Chat. A Chat opened from a ticket, and New Chat about one, start their header with a crumb back to it ("← T-KQ12 /").

### Status and attention

| Rank | Word            | Signal                       |
| ---- | --------------- | ---------------------------- |
| 1    | Approval needed | Orange dot                   |
| 2    | Question        | Orange dot                   |
| 3    | Working         | Spinner                      |
| 4    | Failed          | Orange dot, until seen       |
| 5    | Done            | Blue dot, until seen         |
| 6    | Idle            | None; the last line in words |

Interrupted, Not confirmed and Stop not confirmed keep their own words and never read Done. Status sits on a row's second line: the dot or spinner, the word in regular weight, then muted detail. It drives the sidebar entry, the app-icon count and system notifications for Chats not in view; there is no in-app toast or window-title count.

### Color, motion and narrow panes

Color is only the existing small status dot beside a word. The one live signal is the 12px spinner beside words, at most one per turn and never on replayed history. Under reduced motion it is static and jumps are instant. In a narrow pane rows wrap with the suffix beside its target, outcome words never truncate, approval buttons stack, and the model trigger drops its effort bars.

### Accessibility

Every state is a word; icons, spinners and clocks are `aria-hidden`. Rows that open are buttons with `aria-expanded`. One polite status announces a turn starting, waiting and ending, and a request arriving, never each step. Command output is a focusable named region, and the New marker is a separator named "New since you left".
