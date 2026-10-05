# CLAUDE.md

`local-lmcanvas` — fully-local, canvas-based branching AI conversation tool (Electron + React + TypeScript).

See [AGENTS.md](./AGENTS.md) for build commands, layout, and conventions.

Always run `bun run typecheck` before reporting work complete.

Unit tests are `*.test.mjs` files run with Bun. Run each file in its own `bun test <file>` process; never pass several files to one `bun test` invocation. `settings.test.mjs` redirects `HOME` and refuses to run once another file has loaded the storage modules. There's no lint script.
