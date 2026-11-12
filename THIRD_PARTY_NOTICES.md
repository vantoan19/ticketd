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
