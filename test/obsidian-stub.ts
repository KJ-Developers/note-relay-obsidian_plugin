// A node-test stand-in for the `obsidian` module.
//
// The published `obsidian` npm package is type declarations only — its `main` is an empty string —
// so esbuild cannot bundle a module that imports it at runtime. `test/build-and-test.mjs` aliases
// 'obsidian' to this file so the real signal client can be exercised with a fake transport instead
// of being untestable. Only the members the plugin actually touches are here; add one when a test
// needs it rather than growing this into a stub of the Obsidian API.

/** Every Notice a test-visible code path created, in order. */
export const notices: string[] = [];

export class Notice {
  constructor(readonly message: string, readonly duration?: number) {
    notices.push(message);
  }
}

/**
 * `requestUrl` as the device API uses it.
 *
 * The plugin reaches the Worker through Obsidian's requestUrl because the renderer origin is blocked
 * by CORS, so the transport has to exist here for those paths to be testable at all. A test sets
 * `requestUrlState.response` to decide what comes back.
 */
export const requestUrlState: { response: { status: number; text: string }; calls: string[] } = {
  response: { status: 200, text: '{}' },
  calls: [],
};

export async function requestUrl(request: { url: string }) {
  requestUrlState.calls.push(request.url);
  return { status: requestUrlState.response.status, text: requestUrlState.response.text };
}

/**
 * `TFile`/`TFolder` as the adapter uses them: `instanceof` checks and path/extension reads. The
 * adapter is exercised in jsdom for its appearance probe, and it imports both at module load.
 */
export class TAbstractFile {
  path = '';
}
export class TFile extends TAbstractFile {
  extension = 'md';
  basename = '';
}
export class TFolder extends TAbstractFile {
  children: unknown[] = [];
}
