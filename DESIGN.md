# ticketd interface design

## Purpose and authority

This document defines the target visual and interaction design for ticketd's desktop application. It is a specification for design work and review; the current interface is not evidence that these rules have been implemented. Dimensions are logical CSS pixels at 100% zoom. Minimum heights must grow for wrapped text and accessibility settings.

Use [GLOSSARY.md](GLOSSARY.md) for domain language, [the product specification](docs/mvp-spec.md) for behavior, and [the architecture](docs/architecture.md) for technical boundaries. This guide defines how those behaviors are presented. It does not add accounts, collaboration, a board, or a chat panel. For tickets owned by an external source, starting with GitHub Issues ([#98](https://github.com/vantoan19/ticketd/issues/98)), it defines how ownership, freshness, and source content are presented; that issue defines the synchronization behavior. Track implementation and deviations in GitHub Issues, not in this document.

### Reference and adaptation

The visual reference is the third-party [Vercel design language analysis by design-bites](https://github.com/educlopez/design-bites/blob/main/design-mds/vercel.com/DESIGN.md). Use its published numeric values for the light palette, type scale, control sizes, spacing scale, radii, focus treatment, and elevation. It is a third-party observation rather than an official Vercel specification. The tables below distinguish those source values from ticketd-specific layout assignments and dark-theme extensions.

Use a Linear-style issue workspace with the Vercel palette and components. Ticketd needs its own application composition: a persistent workspace, a scan-friendly ticket list, a readable document, and reliable editing feedback. Map the reference roles onto these application surfaces without inventing replacement token values. Ticketd uses an explicit compact application heading of 24px/32px with weight 600 and -0.6px tracking. This is a ticketd density adaptation, not a value copied from the reference. The 48px display role remains available for genuine display content and is not applied to every ticket. Workspace pane widths and responsive transitions are ticketd layout decisions. Vercel branding does not belong in this workspace. Use the reference’s shadow boundaries and spacing-led grouping.

The workspace structure also borrows interaction patterns that Linear, GitHub Issues, and Orca share: a ticket list grouped by status, a labeled property rail beside the document, and an external issue’s description and comments shown as read-only source cards with compact event rows. Borrow these structures, not those products’ styling or branding.

## 1. Visual character and hierarchy

The interface should feel composed, legible, and predictable. A person should identify the current view, selected ticket, status, and next action without inspecting a collection of equally prominent controls.

Use three levels of emphasis:

1. **Work content:** ticket titles, descriptions, notes, and meaningful results. These have the strongest text contrast and the largest share of the screen.
2. **Context:** status, project, Effort, relationships, and evidence. These stay readable and close to the content they describe.
3. **Operations:** follow, reminder configuration, filters, editing controls, and administrative actions. These have compact triggers and reveal their forms when requested.

Visual simplicity must not erase useful information. Existing prerequisites, duplicate links, evidence, and scheduled reminders need visible summaries. Hiding everything behind accordions is not an acceptable substitute for hierarchy.

### Composition rules

- Establish grouping with alignment and spacing first. Use a shadow boundary where navigation or independently scrolling planes meet. Separate document sections with spacing.
- Use flat document sections. Do not wrap each property, note, empty state, or relationship type in its own card. The one exception is content owned by an external source, which sits in read-only source cards (see Documents and activity).
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
| Recessed / `--muted`, `--secondary`           | `#F2F2F2`             | Quiet control surfaces and placeholders     |
| Primary text / `--foreground`                 | `#171717`             | Titles, authored content, active values     |
| Secondary text / `--secondary-foreground`     | `#4D4D4D`             | Navigation, labels, readable captions       |
| Decorative/disabled / `--disabled-foreground` | `#8F8F8F`             | Inactive decoration and disabled states     |
| Hover / `--accent`                            | `#EBEBEB`             | Navigation and row hover/selection          |
| Interactive / `--interactive`, `--ring`       | `#0072F5`             | Focus, link decoration, interactive accents |
| Input focus / `--input-focus`                 | `#005FCC`             | Input focus outline                         |
| Boundary / `--ds-shadow-border-base`          | `0 0 0 1px #00000014` | Shadow-based surface boundary               |
| Header boundary                               | `0 1px 0 0 #0000001A` | Pane header separator                       |

Use `#4D4D4D` for necessary small text, including timestamps. The reference’s `#8F8F8F` is not a readable-body-text substitute. If shared components use `muted-foreground` for captions, map it to the secondary text role and keep the decorative/disabled role separate.

Primary actions invert the existing primary/elevated pair: `#171717` fill and `#FFFFFF` text. Ghost actions begin transparent with secondary text and promote to primary text on `#EBEBEB` hover. Standard prose links may retain primary text with an underline, as in the reference’s standard-link treatment; use the blue token for focus and link decoration. Never reduce contrast merely to make all links blue.

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

| Meaning            | Icon treatment                                          | Visible label      |
| ------------------ | ------------------------------------------------------- | ------------------ |
| Todo               | Empty circle                                            | Todo               |
| In progress        | Circle with center mark                                 | In progress        |
| In review          | Dashed circle                                           | In review          |
| Done               | Circle with check                                       | Done               |
| Canceled           | Circle with slash                                       | Canceled           |
| Ready              | Status dot beside the word, on Todo tickets             | Ready              |
| Blocked            | Status dot beside the word, with the reason             | Blocked by T-18    |
| Duplicate          | Circle with equals sign, beside a canonical-ticket link | Duplicate of T-10  |
| Source unavailable | Status dot beside the words                             | Source unavailable |
| Unread             | Status dot plus accessible unread state                 | Unread             |

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

Do not shrink the entire workspace to a 13px root or scale down type to fit an extra pane. Choose the appropriate existing role instead: captions are 12px, navigation, ticket rows, descriptions, and notes are 14px/20px in the working panes. Semibold is reserved for display/section-title emphasis; small section headings use the real medium weight.

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

| Element                | Value  | Application                                           |
| ---------------------- | ------ | ----------------------------------------------------- |
| Small control          | 32px   | Header actions, property pickers, compact menus       |
| Default control        | 40px   | Search, form inputs, primary form actions             |
| Large control          | 48px   | Deliberately prominent actions / coarse-pointer forms |
| Default radius         | 6px    | Inputs, buttons, small controls                       |
| Marketing radius       | 8px    | Reserved; not a replacement control radius            |
| Elevated panel radius  | 12px   | Content panel, Settings cards, menus, dialogs, sheets |
| Pill radius            | 9999px | Tags or compact badges only                           |
| Header height          | 48px   | List pane header and detail pane header               |
| Sub-navigation height  | 46px   | Compact pane/header row                               |
| Page gutter            | 24px   | Workspace and management content gutters              |
| Standard content width | 1200px | Management content maximum                            |
| Wide content width     | 1400px | Wide content views where useful                       |

Pane widths and row columns are ticketd geometry, defined below. The application shell fills the window; the reference’s page-width limits apply to content views, not to the combined navigation/content-panel shell. Use the supplied 48px size for coarse-pointer targets rather than inventing a new control size.

Lucide icons remain 16px inside ordinary controls, with consistent stroke weight. Icon-only actions have accessible names and hover/focus tooltips. A 16px icon sits inside a 32px or larger hit area.

### Boundaries, shadows, and focus

Use shadow-based boundaries on surfaces. Keep layout dimensions stable with `box-sizing: border-box`; do not draw both a CSS border and a matching shadow ring. Native checkboxes, semantic table grids, and graph edges may retain their necessary line treatment. Do not use horizontal rules to divide every document section.

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
│              │ │ All tickets      ⟳ ⌕ ≡  │ T-42 ⧉ repo #98 ↗  2 of 11 ˄ ˅ … ⤢ ✕    │ │
│ Inbox     3  │ │ All 11 GitHub 7 Local 4 ├───────────────────────────┬─────────────┤ │
│ All tickets  │ ├─────────────────────────┤ Ticket title              │ Status      │ │
│ Ready     4  │ │ ◐ In progress  2     +  │ ● Open on GitHub · #98    │ Source      │ │
│ In progress  │ │ ◐ T-42 Selected     #98 │ ┌ GitHub · Read-only ──┐  │ Project     │ │
│              │ │ ◐ T-43 Ticket title     │ │ Description          │  │ Effort      │ │
│ Projects  ⚙  │ │ ◌ In review    1     +  │ └──────────────────────┘  │ Tags        │ │
│ Efforts   ⚙  │ │ ◌ T-44 Ticket title  #91│ Subtickets   ▬▬ 1 of 2    │ Relations   │ │
│ Archived …   │ │ ○ Todo         3     +  │ GitHub conversation       │ Attention   │ │
│              │ │ ○ T-45 Ticket title     │ Notes and history         │             │ │
│ ● GitHub     │ └─────────────────────────┴───────────────────────────┴─────────────┘ │
│ Trash        │                                                                       │
│ Settings     │                                                                       │
└──────────────┴───────────────────────────────────────────────────────────────────────┘
```

The drawing describes hierarchy, not additional duplicate search fields. Search belongs in the list pane header. Unread attention lives in the sidebar Inbox count, not in a top bar. The sidebar footer shows each configured source’s sync state and opens its settings.

| Region          | Geometry and behavior                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------- |
| Navigation      | 208px default width on the canvas; 12px outer inset; independently scrollable groups            |
| Content panel   | One elevated panel, 12px radius, small shadow ring, 8px from the window edges                   |
| List header     | 48px: view title, Refresh, then search and Filters (32px small controls)                        |
| Source filter   | Below the list header once a source is configured: All, GitHub, and Local with counts           |
| Detail header   | 48px: ticket reference, source link, list position, and actions (see Ticket detail)             |
| List pane       | At least 360px in split mode; remaining width allocated with the detail pane                    |
| Detail pane     | At least 480px in split mode; start near 55% of content panel width                             |
| Document column | 32px desktop gutters, 16px on narrow windows; at least 420px, at most 800px including gutters   |
| Property rail   | At least 232px beside the document column, on the canvas surface, with 20px padding             |
| Resize handle   | 1px visual separator with an 8px hit area; visible focus and keyboard resizing                  |
| Expanded detail | Centered column of at most 800px with 16px description text; keep navigation and return context |

List and detail scroll independently. Sticky chrome has an opaque surface and must not cover focused fields or anchor targets. The first detail viewport should show the title, properties, and the beginning of the description. Reminders, evidence forms, and an empty note editor must not push the title down.

### Responsive rules

Measure the available content panel width after navigation, not just the screen width. Preserve readable minimums rather than squeezing three panes together.

| Available space              | Behavior                                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| Content width at least 840px | List and detail may share the workspace; enforce both pane minimums                                   |
| Content width below 840px    | Selecting a ticket replaces the list in the content area; explicit Back returns to its prior position |
| Window below 768px           | Navigation moves into a sheet; retain a labeled navigation trigger                                    |
| Window near 390px            | One content column, 16px gutters, wrapping property values, full-width action forms where needed      |
| Detail pane below 652px      | The property rail moves below the document column and keeps its section order                         |

A navigation sheet is at most 280px or viewport width minus 32px. Popovers retain 16px viewport clearance and collide away from edges. Forms that cannot fit a popover use a sheet/dialog with a scrollable body. At short heights, keep form actions reachable without clipping the body.

Switching pane modes, resizing, or opening navigation must not remount drafts, reset selection, or lose list scroll position. Horizontal scrolling belongs only inside code, wide tables, or the graph canvas. At 200% zoom, reflow the shell rather than shrinking the type.

## 6. Navigation and ticket list

### Navigation

The sidebar sits on the canvas surface, top to bottom:

- **Brand:** the product name in plain type beside a 32px New ticket icon button with an accessible name and tooltip. Do not use a full-width primary creation button in persistent navigation.
- **Work views:** Inbox, All tickets, Ready, and In progress, each with a distinct icon (Ready does not reuse the Done icon) and a trailing count.
- **Projects and Efforts:** two groups, each with manage actions in its heading, plus an Archived Efforts entry under Efforts.
- **Pinned bottom:** Trash and Settings stay at the bottom without forcing other items off-screen.

Use 20px between groups and 8px between a group heading and its rows. Active navigation uses a neutral fill and primary text, plus semantic current-state markup. Inactive rows use secondary text. Hover does not change row size. Counts align at the trailing edge and remain secondary. Unread attention appears as the Inbox count or a status dot beside its label; there is no top-bar indicator and no permanent high-contrast banner.

### List anatomy

Use stable columns: selection, status, reference, title, then the source pill of an externally owned ticket. Titles receive flexible width. Reference and status columns do not move when a checkbox becomes checked.

- Group rows by status in workflow order: In progress, In review, Todo, Done, Canceled, Duplicate. Each group has a 32px header on the canvas surface with the status icon, the status name in the subsection role, a 12px count, and an Add ticket action for that status. Omit empty groups. A status change moves the ticket to its new group without animating the reorder.
- Once an external source is configured, a source filter below the list header offers All, GitHub, and Local with counts. It narrows the groups; it does not regroup the list by source.
- Checkbox hit areas occupy a reserved 32px column. With a mouse, reveal unchecked controls on row hover or keyboard focus; show all controls during bulk selection. On touch devices keep them visible. Selection never shifts the row or creates an extra row of controls inside it.
- Rows have two lines. Line one: 16px status icon (with an accessible name), monospace ticket reference, the title, then, for an externally owned ticket, a trailing pill with the source mark and its external number (#98). Line two: for Todo tickets a small status dot with Ready or "Blocked by T-n", "Source unavailable" when the source cannot be reached, or "Duplicate of T-n"; then one context item (parent, project, or Effort relevant to the current view), tag pills, and the 12px updated time. Group headers carry the status, so line two omits the status word; views that are not grouped by status, such as search results, begin line two with it. Do not repeat the current project on every row.
- Status color appears only as the small dot beside a word, never as an icon tint or fill.
- Metadata that does not fit moves to details; the title keeps its useful width. Long titles must not overlap trailing actions.
- An open ticket uses a neutral selected fill without a decorative leading stripe. Bulk selection is communicated separately by checkboxes. Keyboard focus uses the focus ring.
- Row hover uses a quieter fill than selection. Hover actions also appear on focus; essential actions cannot be hover-only.

There is no permanent “0 selected” bar. When tickets are selected, show a compact action bar with the count, Change status, Organize, and Clear selection. Organize exposes project, Effort, and explicit tag addition/removal choices. Do not display four inline forms and their submit buttons at once. Keep the count visible after validation errors; show which ticket prevents the batch and state that nothing changed.

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
8. **Notes and history:** authored notes, distinguishable recorded changes, and explicit note submission. On an externally owned ticket, a caption states that notes stay in ticketd and are never sent to the source.

The **property rail** sits beside the document column on the canvas surface, in this order: Status, Source, Project, Effort, Tags, Relationships, and Attention (Follow and the reminder). Each section has a 12px secondary label above its value; values are 32px ghost controls with identifying icons and no outlined boxes, aligned to the label’s left edge. Hover and keyboard focus reveal interactivity. Separate sections with 20px spacing, not dividers or cards. Outlined, labeled fields remain the creation form’s treatment. A picker opened from the rail aligns to the rail’s right edge so it stays inside the content panel.

In split view, description text is 14px. In the full-width (expanded) view, the document column is centered at no more than 800px, the property rail stays beside it, and description text is 16px.

Use 8px from title to state line and 24px from state line to the description. Use 24px between major reading sections and 32px before the source conversation and the notes. Use section spacing instead of divider lines; shadow boundaries belong to pane edges, floating surfaces, and source cards.

A save state belongs next to the edited content, in 12px supporting text. Stable Saved feedback must not take an entire standalone section. Pending save, Saving, and failures remain visible and accessible. Never hide a failure to achieve a cleaner screenshot.

### Visibility and action placement

| Information/action         | Default presentation                                               | Editing surface                                      |
| -------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------- |
| Follow                     | Labeled toggle in the rail’s Attention section                     | Immediate action with pending/error feedback         |
| Reminder                   | Remind me trigger, or a short scheduled-time summary, in Attention | Focused popover; expand to sheet when space requires |
| Status/project/Effort/tags | Labeled values in the property rail                                | Anchored picker; explicit clear/add/remove choices   |
| Source                     | Rail Source section: identity link, freshness, ownership, actions  | Explicit Refresh, Publish, Retry, or Take ownership  |
| Description                | Rendered document, or an unobtrusive Add description action        | In-place rich editor for local tickets only          |
| Parent/subtickets          | Subtickets with progress under the description; parent in the rail | Search/select action near the group heading          |
| Blocking dependencies      | Rail Relationships with each blocker’s status; reason in the row   | Focused add/remove workflow and graph access         |
| Related/discovered work    | Rail Relationships grouped by relationship meaning                 | Add relationship action with explicit direction      |
| Duplicate                  | Duplicate status, with the canonical ticket in Relationships       | Mark as duplicate workflow in the actions menu       |
| Evidence                   | Named records with type, value/link, and date                      | Add evidence or Edit opens a focused form            |
| Backlinks                  | Count and source excerpts; expandable when lengthy                 | Navigate to the source passage                       |
| Source conversation        | External comments and events in source order, read-only            | Comment at the source                                |
| Activity                   | Notes and history readable in one chronological area               | Add note; edit/delete beside the relevant note       |

Relationships are one flat rail section, grouped by meaning: parent, blocked by, blocks, related, discovered while, and duplicate of. Use at most one disclosure level for supporting content. Do not nest Relationships → category → form disclosures. Existing blockers and duplicate identity must not be buried behind a collapsed group. Empty optional groups collapse into a single Add relationship action; do not stack “No parent,” “No subtickets,” “No prerequisites,” and “No related tickets.”

Destructive actions belong in a labeled menu or focused review surface. Describe the result precisely: Trash ticket, Remove relationship, or Delete note. Duplicate handling is not a generic delete operation.

### Externally owned tickets

A ticket is either Local or owned by an external source. Retained provenance is not ownership: after Take ownership the ticket reads Local, and the rail adds “was owner/repo#n.”

- **Ownership cues:** show the owner in three places: the list row’s source pill, the detail header’s source link, and the rail’s Source section. A local ticket has no source pill.
- **Read-only content:** the title, description, and source comments of an externally owned ticket are read-only. Do not show editing affordances on them. The description card’s header says Read-only and links to edit at the source.
- **Local progress:** while the issue is open, the Status picker offers Todo, In progress, and In review, with a caption that closing states follow the source. Once it is closed, the picker’s choices are disabled and its caption explains that reopening at the source returns the ticket to Todo. The rail’s Status note says that progress is kept in ticketd.
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
- A note is a content entry, not a chat bubble. Show timestamp and supplied editing-agent attribution without inventing human identity.
- Content owned by an external source is read-only and sits in a source card: 12px radius, the boundary ring, and a 40px header bar on the canvas surface naming the author and action (“vantoan19 opened this issue on GitHub · Oct 31”), Read-only, and a link to edit or view it at the source. The card is the provenance signal; locally authored notes stay unboxed.
- The source conversation shows the source’s comments as source cards and its events, such as closed as completed, closed as a duplicate, reopened, or an assignment change, as compact rows: a 28px circular icon, the actor, the event, and the time.
- Automatic history is visually quieter than authored notes. Group its label, changed values, and time into a compact row.
- The empty note composer begins as a compact Add a note affordance. Once opened, keep the draft and tools available until submission or explicit discard; blur is not submission.

Description autosave and explicit Add note submission remain different interactions. External CLI updates refresh saved values while preserving drafts. A conflict notice offers Reload saved content and Save my draft, with enough text to explain the overwrite. Do not move the notice out of view when a refresh occurs.

## 9. Attention, reminders, evidence, and duplicate review

### Attention inbox

Use rows with a consistent grid: unread indicator, ticket reference/title, event summary, then time and read-state action. Title and summary are separate lines. Show human language such as “Status changed to In review”; never expose event keys such as `relationship:discovered-while`.

Unread rows have stronger title emphasis and an explicit state. Read rows remain legible. Keep Mark shown as read near the view heading; per-row controls appear on focus as well as hover. Navigation to a note reveals and focuses the relevant content without silently changing ticket status. Follow and reminder settings remain personal to the local person.

### Reminders

A reminder editor contains a heading, date/time input, short local-time hint, and one primary schedule/reschedule action. Show the current scheduled time when one exists, with Snooze and Dismiss as secondary actions. Ambiguous daylight-saving times require an explicit choice; invalid times show an inline error.

Use the locale's date/time presentation. Show exact time and zone where choosing a time needs precision. Do not put storage timestamps, request IDs, or UTC serialization explanations in ordinary helper copy. Due attention appears in the inbox; the interface must not promise delivery while the app is closed.

### Implementation evidence

Show the record's name first, type second, and a readable URL, short commit reference, branch, worktree path, or verification result below it. Long values wrap or have a local overflow affordance with Copy. Dates use readable formatting and can reveal an exact timestamp.

Provide an appropriate explicit open action where supported; always retain Copy for addresses and paths. Do not imply that a pasted pull request URL is connected to live platform status. Keep Edit and Delete subordinate to the evidence itself. An empty evidence section needs one short explanation and Add evidence, not an open form.

### Duplicate dependency review

Use a dialog or expanded review pane, not a small popover. Show the duplicate and canonical ticket by reference and title, the resulting Duplicate status, and each affected dependency with its current and proposed endpoints.

Each edge has an explicit retain, remove, or replace choice where valid. The final action states what will be applied. A stale preview or cycle error keeps the review visible and requests a fresh preview; no partial success presentation is allowed. Removing a duplicate designation must explain that dependency replacements are reviewed separately. Preserve access to the duplicate's description and history.

## 10. Projects, Efforts, graph, and settings

Project and Effort views reuse list typography, filters, row density, and selection behavior. Use the compact 24px/32px application title and a short context line. Effort status counts are simple labeled counts, not large dashboard cards or a productivity score. Archive/reactivate actions remain distinct from completing tickets.

The dependency graph uses a neutral canvas, readable reference/title nodes, and explicit edge direction with a legend explaining which ticket blocks which. Selection and keyboard focus remain visible without relying on colored edges. Keep zoom, fit, and return controls in one compact toolbar. Node selection opens ticket context; graph navigation must retain a way back to the prior ticket. Large graphs need bounded loading and a clear explanation when the displayed scope is limited.

Settings are described in the next section.

### Settings

Settings is a dedicated page. It replaces the sidebar with its own section list and a Back to tickets action; the content panel keeps the same inset and shadow ring.

| Group       | Sections                                  |
| ----------- | ----------------------------------------- |
| Preferences | Appearance, Attention                     |
| Workspace   | Location, Backups, Export, Command line   |
| Sources     | One section per available source (GitHub) |
| Help        | Keyboard shortcuts, About                 |

- **Page:** one centered column of cards. Each card has a 12px radius and the shadow ring (no separate border), with 32px between cards.
- **Card footer:** a card may end with a recessed footer (recessed surface) for explanations and secondary actions. Keep export and backup explanations in the footer beside their actions.
- **Controls:** use a segmented control for an exclusive choice among two to four options and a switch for an on/off preference.
- **Applying changes:** changes apply immediately. There is no Save button for preferences; show a failure beside the control if one cannot be applied.
- **Sources:** one section per available source, added only when its connector exists. Its card is the exception to immediate application: it shows Saved configuration or Unsaved changes, and Save stays unavailable until Preview matches has run for the current rules. Saving turns discovery on and says that matching issues are imported on the next refresh. A saved source also shows its refresh schedule and its last refresh.
- **Theme:** Appearance offers System, Light, and Dark as a segmented control. System is the default and follows the operating system live; the choice applies without reloading.
- **Restore:** restoring a workspace backup always goes through a review dialog that states what will be replaced. Never use a browser confirmation.

## 11. Shared control and state recipes

Use the existing shadcn/Radix components and shared variants. Compose a control before inventing another. Inputs, buttons, menus, fields, alerts, and dialogs must have one visual contract across views.

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

Use a small set of observable states rather than transient notifications everywhere. Empty, loading, unavailable, failed, saved, and externally changed data must be distinguishable.

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
- Short and multiline titles, a long description, code, a table, a Mermaid diagram, notes, blockers, evidence, and empty optional content.
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
