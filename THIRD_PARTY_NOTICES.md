# Third-party notices

Third-party components retain their own licenses. This file identifies bundled
source and assets whose notices need to stay with them; it is not a complete
license manifest for a built desktop installer or CLI executable.

## Geist and Geist Mono

The font files in `apps/desktop/src/assets/fonts/` are from the
[Geist font project](https://github.com/vercel/geist-font).

Copyright 2024 The Geist Project Authors.

The fonts are licensed under the SIL Open Font License 1.1. The complete license
is retained alongside the fonts in [OFL.txt](apps/desktop/src/assets/fonts/OFL.txt).
Include that text when distributing the fonts.

## shadcn/ui

The desktop's UI primitives include adapted shadcn/ui components, as documented
in [interface guidance](docs/agents/ui.md). The upstream project is
[shadcn/ui](https://github.com/shadcn-ui/ui); its
[MIT license](https://github.com/shadcn-ui/ui/blob/main/LICENSE.md) follows.

Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Tauri application scaffold

The application scaffold comes from
[create-tauri-app](https://github.com/tauri-apps/create-tauri-app).
Its MIT license notice is reproduced below. The default Tauri icons have been
replaced with the maintainer-provided ticketd artwork in
`apps/desktop/src-tauri/app-icon.svg`, covered by the project's MIT license.

MIT License

Copyright (c) 2019 - 2022 Tauri Programme within The Commons Conservancy

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Claude Agent SDK

The Claude Chat bridge executable shipped beside the desktop
(`apps/chat-bridge-claude`) contains the
[Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
for TypeScript, pinned in that package's `package.json`, and the
[Bun](https://github.com/oven-sh/bun) runtime that runs it.

The SDK is not open-source software. Its `LICENSE.md` reads:

> © Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements
> outlined here: <https://code.claude.com/docs/en/legal-and-compliance>.

Re-read the license file of the exact SDK release shipped before distributing a
build. The bridge contains no Claude Code; it starts the Claude Code the user
installed, which stays under the terms the user accepted for it.

## Harness marks

`apps/desktop/src/features/chats/HarnessMark.tsx` draws the Claude mark
(Anthropic) for Claude Code and the OpenAI mark for Codex, one color each, to
say which harness a Chat runs. The path data was copied verbatim from
[T3 Code](https://github.com/pingdotgg/t3code)
(`apps/web/src/components/Icons.tsx`, `ClaudeAI` and `OpenAI`), which is MIT
licensed (Copyright (c) 2026 T3 Tools Inc.). The marks themselves are trademarks
of Anthropic PBC and OpenAI and are not covered by that license.

Still to confirm before distributing a build: that this use (a monochrome mark
naming the tool beside its name, never altered or recolored) is within each
publisher's brand guidelines.

## Agent Client Protocol schema

`ticketd-chat-host` uses the official
[Agent Client Protocol schema crate](https://crates.io/crates/agent-client-protocol-schema),
licensed under Apache-2.0. Its exact version is pinned in `Cargo.lock`. The
desktop starts the Antigravity CLI installed by the person.

## Package dependencies and distribution

Rust dependencies are recorded in `Cargo.lock`; JavaScript dependencies are
recorded in `package-lock.json`. Their package sources contain their license texts.
The desktop and CLI include different dependency sets, and platform-specific native
libraries can carry additional notices.

Before distributing binaries, collect the applicable license and notice texts
from the exact packages and assets shipped, including transitive dependencies.
Verify application-icon provenance and any newly copied code separately from package
metadata. Retain existing attribution when adapting third-party material.
See [the release guide](docs/releasing.md) for the distribution verification step.
