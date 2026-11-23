# ticketd website

The landing page, documentation, download guide and release notes are one prerendered React Router site. It builds to static files. The desktop demonstration and artwork work locally, including in both colour themes.

## Run and build

From the repository root, use the Node version in `.nvmrc` and the npm version in `package.json`.

```sh
npx -y npm@10.9.2 ci
npm run docs -- --host 127.0.0.1 --port 5481
```

Open <http://127.0.0.1:5481>. To review the prerendered site on port 5482, run the production build and preview server.

```sh
npm run build:docs
npm run preview --workspace @ticketd/docs -- --host 127.0.0.1 --port 5482
```

## GitHub Pages

The public site uses the repository’s free [GitHub Pages address](https://vantoan19.github.io/ticketd/). To reproduce the hosted layout, build and preview with the same repository prefix.

```sh
export DOCS_PROJECT_PAGES=1
npm run build:docs
node apps/docs/check-pages.mjs
npm run preview --workspace @ticketd/docs -- --host 127.0.0.1 --port 5483
```

Open <http://127.0.0.1:5483/ticketd/>. The upload directory is `apps/docs/build/client`. It contains the page indexes, router data, search index, Markdown resources and a native `404.html`. Unset `DOCS_PROJECT_PAGES` to build at the domain root.

The Quality workflow checks the Pages layout on Linux and Windows. When Quality passes on `main`, the Website workflow requests a fresh build of that commit. Publishing, editing or withdrawing a GitHub Release also requests a refresh, as does the nightly Quality run. A maintainer can run Website manually on `main`.

Deployments wait in the `github-pages` queue. The newest refresh number for the current commit owns publication, so a slow build cannot replace newer release information. After withdrawing a release, check the Website run and the published Changelog. If the refresh failed, fix the cause and dispatch Website on current `main` to read the release feed again.

If Quality fails on `main`, the last successful deployment stays live. Fix or revert the failing change through review. To take the live site offline immediately, disable the Website workflow and cancel every queued or in-progress Website run, including refresh requests, builds and deployments. Wait until all runs have finished, then choose **Unpublish site** in the repository’s Pages settings. After the reviewed fix passes Quality on `main`, re-enable Website and run it on `main` to publish again. [GitHub’s unpublishing guide](https://docs.github.com/en/pages/getting-started-with-github-pages/unpublishing-a-github-pages-site)

## Drawing and demonstration

`src/art` holds the isometric projection, solid faces and line work, modelled objects and the three responsive floor plans. A Vite plugin renders the static models into a shared, fingerprinted SVG. The hero, four station models and destination are already present in the HTML. The moving cart, ticket and labels share the same projected coordinates. Theme colours, face tones and line weights come from `src/app.css`.

`src/demo` holds the six sample tickets, the four demonstration steps and the live workspace views. They reuse desktop components, the Plan Flow model and the desktop palette. The website keeps the example in memory. It can render the initial Plan during prerendering, before browser code runs. On narrow displays the workspace title lets visitors switch between the Plan, Inbox, Ready view and Document. Each Flow lane starts with the linked ticket and scrolls to show its other members. The Plan remembers its view and board column while a visitor inspects a ticket or its spec, including across changes in orientation. Reading an Inbox entry persists as the guided work moves forward.

`src/journey` connects the four wayside stations, their full-resolution app screenshots and the numbered callouts. One ticket leaves its current position on the hero, pauses at the measured docks, then unloads onto the Done stack. The static illustrations and normal document order also tell the story with motion turned off.

The initial HTML includes station links, expandable callouts, a documentation directory and a platform picker. They work even if the browser cannot load the application scripts. Screenshot links open the full native window for the reader’s screen size and theme. When the scripts arrive, a reader can finish using an open disclosure or focused link. Download keeps any platform the visitor has already selected.

## Refresh the desktop screenshots

From the repository root, install the workspace dependencies, build the app prerequisites and the debug CLI, then install a browser for Playwright.

```sh
npm run build:bridge
cargo build -p ticketd-cli --locked
npx --no-install playwright install chromium
npm run capture --workspace @ticketd/docs
```

The reference images use Chromium from the locked Playwright package. Setting `CAPTURE_BROWSER_CHANNEL=chrome` uses the installed Chrome and its own text and icon rendering. The CLI must be the debug binary in this checkout’s `target/debug`. Build with `CARGO_TARGET_DIR` set to this checkout’s `target` when your shell uses a shared target directory.

The capture script creates an empty temporary directory under `target`, selects its database through the debug CLI’s workspace override and verifies that selection before seeding. It sets a fresh device identity and uses the CLI to create the Plan, spec, tickets, dependencies, followed ticket, agent update and evidence. At all four steps it checks the live demonstration’s ticket statuses, readiness and Plan counts against the core. The cart, demonstration and desktop screenshots all use the same device-qualified reference, T-LG12.

Playwright opens the current desktop React app at 2× in both themes. It takes each screenshot in a 1280 × 740 window and again at a narrow native width. The narrow window is 480 pixels wide, or 640 for Plan Flow so two lanes stay visible. A capture-only adapter supplies the CLI snapshots to the desktop bridge and enables experimental Chat for the Automation examples. No external account is involved.

After every window and theme succeeds, the script replaces the WebPs in `screens` and records the actual controls’ bounds in `screens/regions.json`. Each size includes a lossless 2× master. The Vite image plugin crops the relevant part of each screen for the numbered callouts and serves the matching native layout on phones. After a capture, the development server refreshes the open page with the new images and pin positions. Opening a screenshot shows the complete window, with an option to inspect it at its original size. When a desktop control changes, update its locator in `capture/regions.mjs` and regenerate the images.

## Documentation and releases

The Fumadocs pages and navigation live in `content/docs`. The glossary includes the canonical repository glossary. All resource paths are relative to the site’s base URL. Search loads its local engine and `api/search` when a reader types a query. Agents can read `llms.txt`, `llms-full.txt` or `llms.mdx/docs/<page>/content.md`. The introduction’s Markdown is at `llms.mdx/docs/content.md`. On GitHub Pages the Markdown index is `/ticketd/llms.txt`. Each article also links to its Markdown representation in the HTML head.

At build time the site reads the repository’s public, unauthenticated GitHub Releases feed. Published release notes supply Changelog. Download buttons point to uploaded assets on those releases. With an empty feed the primary action opens the source repository. A feed error displays an availability message.

Run `npm test --workspace @ticketd/docs` to check the geometry, screenshot framing and retries, demonstration, and release selection. Run `./scripts/check` from the root for the repository’s full checks.
