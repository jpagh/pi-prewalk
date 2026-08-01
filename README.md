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

```bash
pi install npm:pi-prewalk
```

Or try it for a single run without installing:

```bash
pi -e npm:pi-prewalk
```

From git instead of npm:

```bash
pi install git:github.com/lukeramsden/pi-prewalk
```

## Usage

```bash
pi --prewalk                     # arm at startup, default target (GLM-5.2 on baseten)
pi --prewalk-into anthropic/...  # arm at startup, explicit target
```

Or inside a session:

```
/prewalk                         # arm now, default target (GLM-5.2 on baseten)
/prewalk <provider/model|model>  # arm now, explicit target
/prewalk off                     # disarm
/prewalk status                  # show current state
```

If the default target (`baseten/zai-org/GLM-5.2`) has no configured API key, prewalk falls back to the cheapest available model with a warning.

## Development

```bash
npm install
npm run typecheck
```

The extension is plain TypeScript loaded by pi via [jiti](https://github.com/unjs/jiti) — no build step. Pi's core packages (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`) are `peerDependencies`; they are provided by pi at runtime and installed locally only for typechecking.

## Releasing

Publishing is done from GitHub Actions via [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) — no npm tokens stored anywhere. Pushing a version tag publishes to npm with a provenance attestation:

```bash
npm version patch        # or minor / major — bumps, commits, tags vX.Y.Z
git push --follow-tags   # the v* tag triggers .github/workflows/publish.yml
```

## License

MIT
