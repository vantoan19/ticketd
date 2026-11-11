# ticketd docs

The ticketd website: the factory landing page and the documentation, built with
[Fumadocs](https://www.fumadocs.dev) on React Router and Vite, and written out as a
static site.

From the repository root:

```sh
npm ci
npm run docs          # dev server
npm run build:docs    # static site in apps/docs/build/client
npm test --workspace @ticketd/docs
npm run preview --workspace @ticketd/docs
```

Serve `apps/docs/build/client` with any static web server. Documentation pages are
prerendered, the search index is a static file, and searching runs in the browser.
Fonts use Google Fonts, with local system-font fallbacks. No credentials or
environment variables are required.

## Layout

```text
content/docs/        Documentation pages (MDX) and their order (meta.json)
src/root.tsx         Document shell, fonts, theme and search providers
src/routes.ts        Routes: landing, docs, search index, llms.txt
src/routes/          home (landing), docs, search, not-found
src/app.css          Tokens and theme for the documentation
src/Landing.jsx      The landing page
src/landing.css      The landing page's own tokens, layout and motion
src/LineScene.jsx    The five-machine line
src/screens/         Captured desktop app screens
```

## Landing page

The landing page runs a deterministic recorded demonstration; it never opens a
workspace, runs a CLI command, contacts an agent, or connects to Tauri.

The drawings and scoped stylesheet implement the approved November 10, 2026 design
(canvas version 27) for [issue 238](https://github.com/vantoan19/ticketd/issues/238).
`Landing.jsx` ports the design's interactions to React. `landing.css` owns the
page's paper, ink, accent and motion tokens, independently of the desktop app.

`Landing.markup.json` contains static SVG artwork. `LineScene.jsx` displays the
five-machine horizontal conveyor from `LineScene.markup.json`, including its
station positions. The ticket carrier follows the selected station; reduced
motion skips its travel. Narrow screens scroll the drawing to the selected machine.
The files under `src/screens` contain captured app markup and the app stylesheet,
from desktop/CLI revision
`5c1a242`. These are trusted, checked-in fixtures, never user-supplied HTML. The app
captures are inert; page controls and the monitor/dock's pointer overlays navigate
the recorded states. Equivalent labeled controls support keyboard navigation.
Only clock times, ticket ages and home-relative paths were adjusted. GitHub uses
the offline `acme/web-app` fixture, not a live account.

To refresh the recordings, build the desktop and CLI from the same revision.
Replay the spec → Plan → create → wire → update → context story in a disposable
workspace, then the four monitor moments and the dock views. Capture each app
view's markup at 1280 × 772 with the matching stylesheet scoped beneath `.app`.
Replace the corresponding screen fixture, update its highlight rectangles if
layout changed, and update the commands/outputs in `Landing.jsx` from that run.
Keep credentials, personal paths and raw session logs out of the fixtures. Update
every drawing's revision plate together, then compare desktop and phone captures
in both themes and rerun the interaction tests and repository checks.

### Rhythm

Sections are allowed to run longer than one screen. Each opens with generous room
above its heading and between the heading and its drawing; the per-section grids
in `landing.css` arrange a demo's parts without squeezing them to fit a viewport.

The numbered callouts on a drawing belong to its "Drawing notes": they appear when
the notes are opened, beside the legend that explains them, and stay off the
drawing otherwise.

### Drawing conventions

The drawings are static SVG markup with no generator, so these conventions are
kept by hand when a drawing is edited:

- **Line weight.** A box carries one heavier contour round its outside (class
  `x-edge`: 2.6 for a machine body, 2.2 for a mid-sized part or a long beam or
  belt, 1.8 and 1.4 for small parts) and keeps its three inner edges at 1. Other
  primary outlines (the sphere, hoppers, drums, gauges) are 2 to 2.2. Detail
  stays at 1 to 1.2.
- **Labels.** Nothing on a drawing is set below 8, and each drawing is shown near
  its natural size, so a label is about as large on screen as it is in the
  markup. Decorative serial plates were removed rather than enlarged.
- **Dither.** Dark on the side turned from the light, light on top. A face that
  carries a label keeps only the lightest texture (`d1`).

### How the landing page sits in the site

`src/routes/home.tsx` hosts the landing page. The page reads the window as it
renders (theme, motion, layout), so the route draws it in the browser only; the
prerendered home page is its paper ground.

The site has one theme. The home route passes the documentation's theme to the
landing page, and the landing page reports a change made with its own toggle
(`onTheme`), so the choice carries over to `/docs` and back.

`src/links.ts` owns the destinations. "Get started", the install guide and the
glossary lead to the documentation; the header has a "Docs" link. The repository
currently requires access; verify anonymous reachability before a public launch.
This app does not select hosting or publish a deployment.

## Documentation

Pages live in `content/docs` as MDX. Each folder's `meta.json` sets the order in
the sidebar. Fumadocs supplies the sidebar, table of contents, search and the
Markdown copy of each page. `src/app.css` gives the documentation the same paper
and ink as the landing page.

The documentation states only what the CLI and the repository's guides state.
Check a command against `ticketd COMMAND --help` before documenting it. The
glossary page includes the repository's `GLOSSARY.md` rather than copying it, so
the terms have one source.

Agents can read the documentation as plain text at `/llms.txt` (an index),
`/llms-full.txt` (everything), and `/llms.mdx/docs/<page>/content.md`.
