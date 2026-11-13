# Building Note Relay

For anyone changing the plugin. Nothing here is needed to install or use it — see
[README.md](README.md) for that.

Node 22+ and pnpm.

```bash
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit
pnpm lint        # eslint-plugin-obsidianmd: the rule set the community directory scores
pnpm test        # node --test, no network
pnpm build       # writes main.js, compiled against https://api.noterelay.io
node scripts/check-release-build.mjs
```

`pnpm build` compiles the Worker origin into the bundle and defaults to the production origin, so a clean
checkout builds with no environment at all — which is what the community directory's build verifier runs. Set
`NR_WORKER_ORIGIN` to build against a development Worker; `scripts/check-release-build.mjs` then refuses that
bundle, which is the point.

`pnpm test` runs the protocol, framing, adapter-boundary, preview, search and reconnect suites against fakes.
It does not replace testing in a real vault.

## Releasing

1. Bump `version` in `manifest.json`, add the same version to `versions.json` with the `minAppVersion`, and keep
   `package.json` in step.
2. Commit, `git tag <version>`, push the tag. The release workflow typechecks, lints, tests, builds with the
   production Worker, refuses a development origin, attaches `main.js`, `manifest.json` and `styles.css`, and
   attests their provenance.
3. Submit the new version on the plugin's entry at community.obsidian.md; every version is reviewed again.

Never commit `main.js` — it is generated. Working agreements for this repository (identity, gates, the
deliberate lint warnings, what must never appear here) are in [AGENTS.md](AGENTS.md).
