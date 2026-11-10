# ticketd docs

Standalone landing page for ticketd. It runs a deterministic recorded demonstration;
it never opens a workspace, runs a CLI command, contacts an agent, or connects to Tauri.

From the repository root:

```sh
npm ci
npm run docs
npm run build:docs
npm test --workspace @ticketd/docs
```

The production output is `apps/docs/dist`. Serve it with a static web server or
`npm run preview --workspace @ticketd/docs`. Fonts use Google Fonts, with local
system-font fallbacks. No credentials or environment variables are required.

## Design and recordings

The drawings and scoped stylesheet implement the approved November 10, 2026 design
(canvas version 27) for [issue 238](https://github.com/vantoan19/ticketd/issues/238).
`Landing.jsx` ports the design's interactions to React. `landing.css` owns the
page's paper, ink, accent and motion tokens, independently of the desktop app.

`Landing.markup.json` contains static SVG artwork. The files under `src/screens`
contain captured app markup and the app stylesheet, from desktop/CLI revision
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

`src/links.ts` owns the installation, repository and glossary destinations. The
repository currently requires access; verify anonymous reachability before a
public launch. This app does not select hosting or publish a deployment.
