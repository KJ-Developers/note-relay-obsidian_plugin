# Working in this repository

The Note Relay Obsidian plugin. Public source for the plugin listed in the Obsidian community directory;
the cloud service, the browser viewer and the orchestration notes live in private repositories and are not
in scope here.

**This repository is the source of truth.** Do not develop against a copy and merge later — two trees were
developed in parallel on 2026-11-13 and each silently lacked the other's work. Clone this repo, work in it,
push branches here.

## Identity, fixed by policy

| | |
| --- | --- |
| plugin id | `note-relay` (the folder Obsidian loads; unique across the directory) |
| display name | `Note Relay` |
| domain / slugs | `noterelay.io`, `noterelay-plugin` (all lowercase) |
| never write | `NoteRelay`, `NoteRelay.io` — a different publisher already uses that spelling |

Changing the id renames every command id and every user's plugin folder. Do not.

## Gates: run all four before any push that could become a release

```bash
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit
pnpm lint        # eslint-plugin-obsidianmd — the directory's own scorecard rules
pnpm test        # node --test; 209 tests
NR_WORKER_ORIGIN=https://api.noterelay.io pnpm build && node scripts/check-release-build.mjs
```

`pnpm lint` must report **zero errors**. It currently reports five warnings, all deliberate:

- `prefer-setting-definitions` and `no-deprecated setWarning` need an Obsidian newer than the declared
  `minAppVersion` (1.10). Adopting them means raising the app floor and rewriting the settings pane — an
  owner decision, not a cleanup.
- `prefer-create-el` / `prefer-active-doc` in `preview.ts` cannot use Obsidian's DOM helpers: that module is
  loaded by the jsdom test suite.
- `no-restricted-globals fetch` is the TURN credential request.

Obsidian's own rules **cannot be inline-disabled** (`eslint-comments/no-restricted-disable` turns the disable
into a new error). Fix the finding; do not suppress it.

## Release procedure

1. Bump `version` in `manifest.json`, add the same version to `versions.json` mapped to `minAppVersion`, and
   keep `package.json` in step.
2. Commit, then `git tag <version>` and push the tag. The Release workflow typechecks, lints, tests, builds
   with the production Worker, refuses a development origin, and attaches `main.js`, `manifest.json` and
   `styles.css`.
3. Never hand-edit or commit `main.js`; it is generated and gitignored.

The directory downloads the release whose tag equals the manifest version, and it re-scans **every** version.

## Compatibility is a standing requirement

Installs are manual and old builds stay in the field, so the service may never assume the installed plugin is
current, and the plugin must tolerate replies it does not recognise. New protocol features ship additive and
dark; a removal needs an explicit compatibility gate. `pairing-flow.ts` shows the pattern: send the new field,
and retry without it when an older Worker answers 400.

## What must never appear here

- Note bodies, vault paths, personal vault names, or anything copied out of a real vault.
- Credentials, tokens, account ids, or live Worker/Neon URLs beyond the public `https://api.noterelay.io`.
- Client-side telemetry. The plugin sends nothing about usage; the directory forbids it and the README promises
  it does not happen.
- Pricing figures. `README.md` says a paid plan exists and points at the site; the number is not approved and
  would be baked into the listing forever.

## The README is a disclosure document

The directory requires that an account, payment for full access, and network use be stated there. It also
requires the payment label **Optional payment** (the plugin connects to a paid service, even though reading is
free). If you change what the plugin contacts or what it costs to use, change the README and the listing in the
same slice.
