// Where the plugin talks to.
//
// One module, one value, because the endpoint was previously pasted into four files. That made the
// plugin impossible to release: a public build would have pointed at the development Worker, and
// retiring that Worker would have broken every installed copy with no configuration to change.
//
// The value is a **build-time** constant rather than a user setting on purpose. A setting would let
// someone redirect an installed plugin's pairing, presence and TURN requests to a host of their
// choosing, which is a credential-capture path we would then have to defend. `__NR_WORKER_ORIGIN__`
// is replaced by esbuild at bundle time; see `build.mjs` and the `NR_WORKER_ORIGIN` environment
// variable it reads.

declare const __NR_WORKER_ORIGIN__: string | undefined;

/**
 * The Worker origin, without a trailing slash.
 *
 * Always supplied by the build: `build.mjs` defaults to the development Worker and takes
 * `NR_WORKER_ORIGIN` for any other build.
 */
export const WORKER_ORIGIN: string = (() => {
  // The default lives in `build.mjs`, not here, so a release bundle contains exactly one origin and
  // no development hostname at all — which is what `scripts/check-release-build.mjs` asserts.
  const raw = (typeof __NR_WORKER_ORIGIN__ === 'string' ? __NR_WORKER_ORIGIN__ : '').trim();
  const trimmed = raw.replace(/\/+$/, '');
  if (!trimmed) throw new Error('Note Relay was built without a Worker origin');
  // Only https, so a mistyped build flag cannot downgrade the connection silently.
  if (!/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(?::\d{2,5})?$/i.test(trimmed)) {
    throw new Error('Note Relay was built with an invalid Worker origin');
  }
  return trimmed;
})();

/** The same origin as a WebSocket base, for the signalling channel. */
export const WORKER_SOCKET: string = WORKER_ORIGIN.replace(/^https:/, 'wss:');

/** Whether this build points at a development endpoint rather than a release one. */
export const IS_DEVELOPMENT_ENDPOINT: boolean = /(^https:\/\/)localhost|127\.0\.0\.1|-dev\./i.test(WORKER_ORIGIN);

/**
 * The public site, which is where the plugin download and its version file live.
 *
 * Fixed rather than configurable for the same reason as the Worker origin: a redirectable update check
 * would let someone point an installed plugin at their own "newer version".
 */
export const SITE_ORIGIN = 'https://noterelay.io';
