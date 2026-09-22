# pi-prewalk

A [pi](https://github.com/earendil-works/pi) extension that lets a strong model do the planning, then hands the mechanical implementation off to a fast/cheap model.

Ported from [oh-my-pi](https://github.com/can1357/oh-my-pi) ("prewalk" behaviour).

## How it works

Prewalk is a one-way switch, armed either at startup or mid-session. Once armed:

1. **Plan nudge** — a hidden deep-plan prompt is steered in so the strong model commits to a complete plan and seeds a todo list before touching code.
2. **Continue safety net** — one extra turn is re-armed after a text-only reply, so a plan-only turn never ends the run with no code written.
3. **The switch** — once the todo list exists AND the model makes its first `edit`/`write` (the "todo gate"), the session switches to the fast target model and a verification checklist is steered in. The plan nudge is scrubbed from the LLM context at the switch: the fast model inherits the plan, not the nudge.

`bash` is deliberately **not** a trigger tool (it doubles as exploration), and the `todo` call itself is deliberately **not** a trigger (firing there would hand the fast model the whole implementation cold).

## Install

From git:

```bash
pi install git:github.com/jpagh/pi-prewalk
```

## Usage

```bash
pi --prewalk                     # arm at startup, first scoped model (xhigh thinking)
pi --prewalk-into anthropic/...  # arm at startup, explicit target
```

Or inside a session:

```
/prewalk                         # arm now, first scoped model (xhigh thinking)
/prewalk <model-id>              # arm or retarget (bare ID works; provider/model also works)
/prewalk off                     # disarm
/prewalk status                  # show current state
```

Without an explicit target, prewalk switches to the first model in Pi's scoped models list (the order shown by `/scoped-models`). If no scoped models are configured, it uses `openai-codex/gpt-5.6-luna`, falling back to the cheapest available model with a warning if that default is unavailable. While armed, run `/prewalk <model-id>` to change the target; a bare model ID is enough when it identifies a model.

## Development

```bash
npm install
npm run verify
```

`verify` runs the typecheck (`tsc --noEmit`) plus headless functional checks (`scripts/verify.mjs`): the extension is loaded with [jiti](https://github.com/unjs/jiti) — the same loader pi uses — and driven through a mock `ExtensionAPI` to assert the full arm → todo-gate → model-switch → context-scrub flow, with no pi binary, models, or API keys needed. The same command runs in CI (`.github/workflows/verify.yml`) and gates every publish (`.github/workflows/publish.yml`).

The extension is plain TypeScript loaded by pi via [jiti](https://github.com/unjs/jiti) — no build step. Pi's core packages (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`) are `peerDependencies`; they are provided by pi at runtime and installed locally only for typechecking.

## Releasing

Publishing is done from GitHub Actions via [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) — no npm tokens stored anywhere. Pushing a version tag publishes to npm with a provenance attestation:

```bash
npm version patch        # or minor / major — bumps, commits, tags vX.Y.Z
git push --follow-tags   # the v* tag triggers .github/workflows/publish.yml
```

## License

MIT
