# Contributing to local-lmcanvas

Thanks for your interest. This is a small project — keep PRs small and focused and they'll move fast.

## Dev setup

Prerequisites:

- [Bun](https://bun.sh) 1.1+
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (the `claude` binary on `$PATH`)
- macOS, Linux, or Windows

```bash
git clone https://github.com/max-lee-dev/local-lmcanvas
cd local-lmcanvas
bun install
bun run dev
```

This copy is the [xack20/local-lmcanvas](https://github.com/xack20/local-lmcanvas) fork. To work on it, clone the fork (its default branch is `local/model-labels`). The test, channel-scope and browser-adapter steps below apply to the fork only; upstream has none of those files.

The Electron window opens automatically. DevTools opens with it in dev mode.

## Project layout

See the **Architecture** section in the [README](./README.md) for the high-level map. If you're an AI coding agent working in this repo (Claude Code, Cursor, etc.), read [AGENTS.md](./AGENTS.md) first — it has the build/typecheck commands and hot-path file pointers you need.

There's also a [`plan.md`](./plan.md) at the root that captures the original design notes and build phases. It's not actively maintained but it's useful background.

## Before you push

Run the typechecker:

```bash
bun run typecheck
```

Then run the unit tests (`*.test.mjs`, run with Bun), each file in its own `bun test` process; never pass several files to one `bun test` invocation. `settings.test.mjs` redirects `HOME` and refuses to run once another file has loaded the storage modules. This loop also picks up new, uncommitted test files:

```bash
for f in $(git ls-files --cached --others --exclude-standard '*.test.mjs'); do bun test "$f" >/dev/null 2>&1 && echo "PASS $f" || echo "FAIL $f"; done
```

Add tests next to the code you change, and keep them away from the real `~/.local-lmcanvas`. There's no lint script.

Sanity-check your change in the app:

```bash
bun run dev
```

If you touched canvas/storage/IPC code, create a canvas, branch a node, restart the app, and confirm everything still loads from `~/.local-lmcanvas/`.

## Commit style

We use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

```
feat: add export to markdown
fix(canvas): preserve scroll position on reload
docs: clarify telemetry stance in README
```

Keep subject lines under 72 characters. Multi-paragraph bodies are fine when the why isn't obvious from the diff.

## Pull requests

- One concern per PR. Two small PRs are better than one large one.
- Link the issue you're fixing in the PR description.
- Describe what you tested. "Ran the app and clicked through X" is fine.
- AI/vibe-coded PRs are welcome — just make sure the change actually works end-to-end before you open it. Run `bun run dev` and try the feature.

## Code conventions

- TypeScript strict mode. No `any` unless a third-party type genuinely forces it.
- No `@ts-ignore` / `@ts-expect-error` — if a type fight is unwinnable, raise it in the PR.
- Minimal comments. Names should carry the meaning. Comments are for non-obvious *why*, not *what*.
- Don't add error handling, fallbacks, or validation for cases that can't happen.
- New channels need four pieces, so don't add ad-hoc ones:
  - a type in `src/shared/ipc.ts`;
  - a handler registered with `api.handle(channel, handler, scope)` in `src/main/index.ts`;
  - the surface in `src/preload/index.ts`;
  - a matching entry in the browser adapter `src/renderer/src/lib/webBridge.ts`.
- Channels are desktop-only by default. Mark one `"shared"` only if a paired browser may call it.
- Exceptions:
  - Browser-only helper channels (`chat:isActive`, `client:bye`) live only in `src/main/index.ts` and `webBridge.ts`.
  - Main → renderer events (`chat:event`, `askUser:request`, `canvas:lockLost`) go out with `client.send(channel, payload)`. They need an `ipcRenderer.on` listener in the preload and a `subscribe()` in `webBridge.ts`.

## Reporting bugs and proposing features

Use the issue templates at [github.com/max-lee-dev/local-lmcanvas/issues/new/choose](https://github.com/max-lee-dev/local-lmcanvas/issues/new/choose).

## Security

Do **not** open public issues for vulnerabilities. See [SECURITY.md](./SECURITY.md).

## License

By submitting a contribution, you agree your work is licensed under the [MIT License](./LICENSE) of this repository.
