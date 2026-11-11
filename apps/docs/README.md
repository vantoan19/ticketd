# ticketd docs

Standalone landing page for ticketd: ticket and context management alongside AI
agents, with native assistance, automations, integrations and sync. All interactions
are deterministic local examples. They never open a workspace, run a CLI command,
contact an agent or connect to Tauri.

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

## Page and examples

`Landing.tsx` owns the page, system theme and reduced-motion preference. A centered
headline introduces one main factory illustration. Three product examples then
explain shared tickets and context, agent visibility, and grounded AI assistance.
The product is readable before any interaction. Small document connectors,
stippled edges and the cat supervisor carry the illustration style into these
examples without adding separate machinery to each section.

`FactoryHero.tsx` owns the factory exchange: organize a brief, pass context to an
agent, receive a report, and review the result. One “See it work” action runs the
exchange and stops for human review. Playback can be paused or reset; reduced
motion goes straight to the report. The HTML product view stays readable inside
the SVG housing. On narrow screens the drawing can be panned; the surrounding
page fits the viewport.

`ProductExamples.tsx` owns the three independent examples:

- Select tickets in the Login hardening Plan to see their linked context.
- Inspect an agent's evidence and mark the example reviewed.
- Choose an assistant question, inspect its sources, and confirm or discard a
  proposed ticket. Adding the ticket requires an explicit action.

`factoryRecords.ts` supplies the shared sources. Examples reset on reload and do
not share state with each other. These are launch-vision fixtures, not recordings
of shipped AI or sync functionality. Publication is deferred until the promised
capabilities are hardened.

`landing.css` owns paper, ink, accent and layout tokens independently of the
desktop app; `factory-hero.css` owns the main drawing's layout and finite motion.
The artwork uses oblique projection, stippling and a hard-hat pixel cat, continuing
the approved design for [issue 238](https://github.com/vantoan19/ticketd/issues/238).

## Artwork and retained studies

Edit `artwork/hero.mjs` and the shared primitives in `artwork/draw.mjs`, then run
`npm run artwork --workspace @ticketd/docs` to regenerate the static plates in
`FactoryPlates.markup.json`. No runtime drawing library is required. The page also
uses the SVG pattern definitions from `Landing.markup.json`.

Earlier design studies remain in `concepts`, `FactoryScenes.tsx`, `FactoryPlates.tsx`
and `LineScene.jsx`, with their associated artwork and styles. The captured app
fixtures under `src/screens` come from desktop/CLI revision `5c1a242`. These studies
and app captures are not rendered by the current landing page. Keep their fixture
sources separate from the simplified product examples.

`src/links.ts` owns the installation, repository and glossary destinations. The
repository currently requires access; verify anonymous reachability before a
public launch. This app does not select hosting or publish a deployment.
