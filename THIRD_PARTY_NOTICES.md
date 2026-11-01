# Third-party notices for adapted text

`THIRD_PARTY_NOTICES` (no extension) is generated from npm production
dependencies by `scripts/generate-notices.mjs`. This file covers something
different: text copied or adapted into this repository from other projects.
Each adapted file names its source in a header comment.

## pstack (cursor/plugins)

- Source: https://github.com/cursor/plugins/tree/11713c683fe4add4fd403ea880580abbc9e0875f/pstack
  (`skills/create-verification-skill/`, `skills/maintain-verification-skill/`)
- Used in: `.claude/skills/create-verification-skill/SKILL.md`,
  `.claude/skills/maintain-verification-skill/SKILL.md`,
  `.claude/skills/verify-wmux/SKILL.md`,
  `.claude/skills/verify-wmux/references/features/README.md`
- License text, verbatim from `pstack/LICENSE`:

```
MIT License

Copyright (c) 2026 Lauren Tan

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
```

## pstack-claude (anishekkamal/pstack-claude)

- Source: https://github.com/anishekkamal/pstack-claude/tree/d15d23958f1b9a5fb4cc4f5c5a0aa08869033a34
  (`plugins/pstack/skills/create-verification-skill/`,
  `plugins/pstack/skills/maintain-verification-skill/`,
  `plugins/pstack/skills/verify-web/references/proof-standards.md`)
- Used in: the same files as above (Claude Code port wording, proof standards
  and verdict format)
- License text, verbatim from `LICENSE`:

```
MIT License

Copyright (c) 2026 Lauren Tan
Copyright (c) 2026 Michael Denyer

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
```

## Open-Hermes-Bot (AZERDSQ131/Open-Hermes-Bot)

- Source: https://github.com/AZERDSQ131/Open-Hermes-Bot/tree/4966058c50e75fd221cd3dc6536b99e89bcc2f07
  (`src/group.ts`, `src/reactions.ts`)
- Used in: `src/shared/botGroupProtocol.ts` (the silent member's
  acknowledgement, the `[[react:…]]` marker and its palette, and the group
  round caps). Its avatars and other assets are not taken.
- License text, verbatim from `LICENSE`:

```
MIT License

Copyright (c) 2026 Jules Yzerd

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
```

## Cua Driver (trycua/cua)

- Source: https://github.com/trycua/cua/tree/a9902d272655b65180fa713a8b1f2f1c1935e70b/libs/cua-driver
  (`rust/crates/platform-macos/src/input/skylight.rs`,
  `rust/crates/platform-macos/src/input/mouse.rs`,
  `rust/crates/platform-macos/src/input/keyboard.rs`)
- Used in: `native/computer-use-macos/Sources/wmux-computer-use/SkyLight.swift`,
  `native/computer-use-macos/Sources/wmux-computer-use/Background.swift`,
  `native/computer-use-macos/Sources/ComputerUseCore/Background.swift`
- License text, verbatim from `LICENSE.md` at the repository root (the Driver
  crate declares `license = "MIT"`):

```
MIT License

Copyright (c) 2025 Cua AI, Inc.

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
```
