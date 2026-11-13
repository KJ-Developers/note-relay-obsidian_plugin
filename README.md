# Note Relay

Read and edit an Obsidian vault from a browser, without uploading the vault anywhere.

Note Relay is an Obsidian desktop plugin paired with a browser viewer at [noterelay.io](https://noterelay.io).
The browser talks to the live vault over an authenticated WebRTC data channel; Cloudflare TURN is used only
when a direct connection cannot be established. Markdown, rendered Dataview results and images travel over
that channel — the Note Relay service stores account, host, pairing and authorization records, not note
bodies.

## Disclosures

These are stated up front because the plugin needs all three to be useful.

- **An account is required for full access.** Note Relay is an Obsidian plugin plus a hosted service. You
  sign in at [noterelay.io](https://noterelay.io), pair this vault with your account, and approve the pairing
  in the browser with the host key fingerprint shown in the plugin.
- **Payment is required for editing.** Reading your own vault from a browser is free. Saving, creating,
  renaming, moving and deleting notes requires a paid Note Relay subscription. Current plans and prices are on
  [noterelay.io](https://noterelay.io); this repository does not state prices. During the beta, accounts are
  invite-only — request access on the site.
- **Network use.** See [Network use](#network-use) below for every endpoint the plugin contacts and why.

## What it does

- Lists your vault, opens notes, and renders them with headings, links, embeds, maths and Mermaid diagrams.
- Renders Dataview tables, lists and task queries **in Obsidian itself**, then sends the result — the browser
  never runs Dataview and never receives your Dataview JavaScript.
- Shows tags, backlinks and a one-hop local graph for the open note.
- Applies your vault's theme as a set of validated colour and font tokens, so the browser view follows your
  theme without loading your CSS.
- Searches note text on your machine and returns titles, match counts and short excerpts; the note body is
  fetched only when you open a result.
- With a paid subscription: saves notes, creates, renames, moves and deletes them. Every save and delete
  carries the content hash it was based on, so an edit made in Obsidian in the meantime is reported as a
  conflict instead of being overwritten.

## Requirements

- Obsidian 1.10.0 or later, **desktop only** (Windows, macOS, Linux). The plugin uses WebRTC and Node APIs that
  Obsidian does not expose on mobile.
- A Note Relay account.

## Install

Note Relay is not yet listed in the Obsidian community directory. Until it is, install it by hand:

1. Download the latest plugin archive from [noterelay.io](https://noterelay.io) — or take `main.js` and
   `manifest.json` from this repository's latest release.
2. In Obsidian, open **Settings → Community plugins** and select **Open plugins folder**. That button opens
   the folder for the current vault, so you do not have to find `.obsidian` yourself.
3. Create a folder named `note-relay` inside it and put `main.js` and `manifest.json` in that folder.
4. Back in Obsidian, reload the plugin list and enable **Note Relay**.

If an older `note-relay` folder is already there, delete it first and then unzip; on macOS, Finder refuses to
replace a folder inside `.obsidian` with "can't be replaced because it is invisible".

The plugin starts with hosting off. Nothing is opened until you turn on **Host this vault** and pair it.

## Network use

Every request below is made by the plugin from your machine. There is no analytics or telemetry of any kind.

| Endpoint | Purpose | What it sees |
| --- | --- | --- |
| `api.noterelay.io` | Account pairing, host presence, WebRTC signalling, short-lived TURN credentials, grant state | Your account id, vault id, connection timing and your IP address |
| `noterelay.io` | Site pages, the plugin download, and one version check that raises an "update available" notice | An ordinary HTTPS request for a small JSON file |
| Cloudflare TURN | Encrypted relay used when a direct peer connection fails (symmetric NAT, restrictive firewalls) | Encrypted traffic and connection metadata — not note content |

Signalling sees connection metadata but not note content: notes travel peer-to-peer, and TURN relays
encrypted traffic without keys. Cloudflare's logging and retention for these services are outside Note Relay's
control; the privacy policy at [noterelay.io/privacy](https://noterelay.io/privacy) states what Note Relay
itself keeps.

## Limits worth knowing

- The browser view is not pixel-identical to Obsidian. Preview is rendered from a standalone Markdown parser,
  not Obsidian's own view.
- Inline images are limited to PNG, JPEG, GIF and WebP rasters, size-capped per image.
- Arbitrary vault CSS is not loaded; only validated theme tokens are sent.
- The local graph is a one-hop slice around the open note, not the full vault graph.
- Search covers note text on the host; attachments and PDFs are not searched.

## Report a problem

Open an issue on this repository, or email [support@noterelay.io](mailto:support@noterelay.io) if the report
involves vault content or credentials — please do not paste note text into a public issue.

## Development

Node 22+ and pnpm.

```bash
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit
pnpm test        # unit tests, no network
NR_WORKER_ORIGIN=https://api.noterelay.io pnpm build   # writes main.js
```

`pnpm build` compiles the Worker origin into the bundle and refuses to run without `NR_WORKER_ORIGIN`,
because a compiled-in default is what leaves an installed copy pointing at the wrong service. A release build
must also pass `node scripts/check-release-build.mjs`, which refuses a bundle that names a development
endpoint. `pnpm test` runs the pure protocol, framing, adapter-boundary, preview, search and reconnect suites
against fakes; it does not replace testing in a real vault.

## License

MIT — see [LICENSE](LICENSE).
