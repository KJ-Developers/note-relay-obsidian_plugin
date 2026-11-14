import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  dispatchReadOnly, dispatchVaultRequest, sha256Hex, MAX_NOTE_BYTES,
  MAX_REQUEST_BYTES, MAX_WRITE_NOTE_BYTES, MAX_WRITE_REQUEST_BYTES,
  type VaultAdapter, type WriteCommand, type WriteOutcome, type WritableVaultAdapter,
} from '../src/protocol';

const source = '# Fixture\n';
let reads = 0;
let previews = 0;
const adapter: VaultAdapter = {
  listMarkdown: () => [
    { path: 'Welcome.md', extension: 'md' },
    { path: '.obsidian/Secret.md', extension: 'md' },
  ],
  listFolders: () => ['Projects', 'Projects/Empty', '.obsidian/Hidden'],
  tags: file => file.path === 'Welcome.md' ? ['#project/notes'] : [],
  backlinks: () => [], outgoing: () => [],
  getFile: path => path === 'Welcome.md' ? { path, extension: 'md' }
    : path === 'photo.png' ? { path, extension: 'png' } : null,
  read: async () => { reads++; return source; },
  readBinary: async () => new ArrayBuffer(0),
  preview: async () => { previews++; return { html: '<h1>Fixture</h1>', state: 'complete', renderer: 'test' }; },
  searchNotes: async () => ({ matches: [], scanned: 0, total: 0, truncated: false }),
  properties: () => [],
  appearance: () => ({ mode: 'dark', tokens: {} }),
};

const req = (cmd: string, path?: string) => ({ version: 1, id: 'test-1', cmd, ...(path ? { path } : {}) });

test('hosting defaults to an offline command boundary', async () => {
  assert.deepEqual(await dispatchReadOnly(adapter, false, req('READ_MARKDOWN', 'Welcome.md')), { ok: false, id: '', error: 'OFFLINE' });
});

test('read-only registry rejects every mutation command and extra fields', async () => {
  for (const cmd of ['SAVE', 'SAVE_MARKDOWN', 'CREATE_FILE', 'CREATE_MARKDOWN', 'RENAME', 'DELETE_MARKDOWN']) {
    const reply = await dispatchReadOnly(adapter, true, req(cmd, 'Welcome.md'));
    assert.equal(reply.ok, false, cmd);
  }
  assert.equal((await dispatchReadOnly(adapter, true, { ...req('READ_MARKDOWN', 'Welcome.md'), data: 'overwrite' })).ok, false);
});

test('rejects traversal, encoded separators, hidden internals, and malformed requests', async () => {
  for (const path of ['../Welcome.md', 'folder/../Welcome.md', '/Welcome.md', 'a\\Welcome.md', 'a%2fWelcome.md', '.obsidian/Secret.md', 'a//b.md', 'note.txt', 'a\u0000.md']) {
    const reply = await dispatchReadOnly(adapter, true, req('READ_MARKDOWN', path));
    assert.equal(reply.ok, false, path);
  }
  // 1 and 2 are both spoken (2 adds compressed replies); anything else is refused.
  assert.equal((await dispatchReadOnly(adapter, true, { version: 3, id: 'x', cmd: 'LIST_MARKDOWN' })).ok, false);
  assert.equal((await dispatchReadOnly(adapter, true, { version: 1, id: 'x', cmd: 'LIST_MARKDOWN' })).ok, true);
  assert.equal((await dispatchReadOnly(adapter, true, { version: 2, id: 'x', cmd: 'LIST_MARKDOWN' })).ok, true);
  assert.equal((await dispatchReadOnly(adapter, true, { version: 1, id: 'x', cmd: 'READ_MARKDOWN', path: 'a'.repeat(20_000) })).ok, false);
});

test('listing filters hidden files and missing read has no side effect', async () => {
  const list = await dispatchReadOnly(adapter, true, req('LIST_MARKDOWN'));
  assert.deepEqual(list, { ok: true, id: 'test-1', data: { paths: ['Welcome.md'] } });
  const before = reads;
  assert.deepEqual(await dispatchReadOnly(adapter, true, req('READ_MARKDOWN', 'Missing.md')), { ok: false, id: 'test-1', error: 'NOT_FOUND' });
  assert.equal(reads, before);
});

test('folder tree includes empty visible folders and filters internals', async () => {
  assert.deepEqual(await dispatchReadOnly(adapter, true, req('LIST_VAULT_TREE')), {
    ok: true, id: 'test-1', data: { files: ['Welcome.md'], folders: ['Projects', 'Projects/Empty'] },
  });
});

test('tree pages include empty folders and reject a changed inventory', async () => {
  let files = Array.from({ length: 205 }, (_, n) => ({ path: `Notes/${String(n).padStart(3, '0')}.md`, extension: 'md' }));
  const paged: VaultAdapter = { ...adapter, listMarkdown: () => files, listFolders: () => ['Notes', 'Empty'] };
  const first = await dispatchReadOnly(paged, true, req('LIST_VAULT_TREE_PAGE'));
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const data = first.data as { entries: { kind: string; path: string }[]; nextCursor: string };
  assert.equal(data.entries.length, 200);
  assert.deepEqual(data.entries[0], { kind: 'folder', path: 'Empty' });
  const second = await dispatchReadOnly(paged, true, { ...req('LIST_VAULT_TREE_PAGE'), cursor: data.nextCursor });
  assert.equal(second.ok, true);
  if (second.ok) {
    const rest = second.data as { entries: { kind: string; path: string }[]; nextCursor: string | null };
    assert.equal(rest.entries.length, 7);
    assert.equal(rest.nextCursor, null);
  }
  files = files.slice(1);
  assert.deepEqual(await dispatchReadOnly(paged, true, { ...req('LIST_VAULT_TREE_PAGE'), cursor: data.nextCursor }),
    { ok: false, id: 'test-1', error: 'STALE_CURSOR' });
  assert.deepEqual(await dispatchReadOnly(paged, true, { ...req('LIST_VAULT_TREE_PAGE'), cursor: 'wrong' }),
    { ok: false, id: 'test-1', error: 'BAD_REQUEST' });
});

test('a folder page answers with that folder\'s own children, and nothing else', async () => {
  // Expanding one folder must cost one request. Without this the browser walks a flat listing
  // (~93 pages on an 18,490-note vault) to reach a folder that sorts late.
  const tree: VaultAdapter = { ...adapter,
    listMarkdown: () => [
      { path: 'Root.md', extension: 'md' },
      { path: 'Projects/Plan.md', extension: 'md' },
      { path: 'Projects/Deep/Note.md', extension: 'md' },
      { path: 'Journal/2026.md', extension: 'md' },
    ],
    listFolders: () => ['Projects', 'Projects/Deep', 'Journal', 'Empty'] };

  const root = await dispatchReadOnly(tree, true, { ...req('LIST_VAULT_TREE_PAGE'), path: '' });
  assert.equal(root.ok, true);
  if (root.ok) assert.deepEqual((root.data as { entries: unknown[] }).entries, [
    { kind: 'folder', path: 'Empty' }, { kind: 'folder', path: 'Journal' },
    { kind: 'folder', path: 'Projects' }, { kind: 'file', path: 'Root.md' }]);

  const projects = await dispatchReadOnly(tree, true, { ...req('LIST_VAULT_TREE_PAGE'), path: 'Projects' });
  assert.equal(projects.ok, true);
  if (projects.ok) assert.deepEqual(projects.data, {
    entries: [{ kind: 'folder', path: 'Projects/Deep' }, { kind: 'file', path: 'Projects/Plan.md' }],
    nextCursor: null });

  // A folder nobody has is an empty page, not an error: the vault may have changed under the reader.
  const missing = await dispatchReadOnly(tree, true, { ...req('LIST_VAULT_TREE_PAGE'), path: 'Gone' });
  if (missing.ok) assert.deepEqual(missing.data, { entries: [], nextCursor: null });
  // Path traversal and absolute paths are refused before any vault work.
  assert.deepEqual(await dispatchReadOnly(tree, true, { ...req('LIST_VAULT_TREE_PAGE'), path: '../etc' }),
    { ok: false, id: 'test-1', error: 'FORBIDDEN' });
  assert.deepEqual(await dispatchReadOnly(tree, true, { ...req('LIST_VAULT_TREE_PAGE'), path: '/etc' }),
    { ok: false, id: 'test-1', error: 'FORBIDDEN' });
});

test('empty tree returns one empty page', async () => {
  const empty: VaultAdapter = { ...adapter, listMarkdown: () => [], listFolders: () => [] };
  assert.deepEqual(await dispatchReadOnly(empty, true, req('LIST_VAULT_TREE_PAGE')),
    { ok: true, id: 'test-1', data: { entries: [], nextCursor: null } });
});

test('tag metadata is bounded, paginated, read-only, hides internals, and rejects stale cursors', async () => {
  let files = Array.from({ length: 205 }, (_, n) => ({ path: `Notes/${String(n).padStart(3, '0')}.md`, extension: 'md' }));
  const tagged: VaultAdapter = { ...adapter, listMarkdown: () => [...files, { path: '.hidden.md', extension: 'md' }], tags: file => file.path === 'Notes/000.md' ? ['#area/work', 'area/work', '#nested/tag'] : ['#other'] };
  assert.deepEqual(await dispatchReadOnly(tagged, false, req('LIST_TAG_METADATA_PAGE')), { ok: false, id: '', error: 'OFFLINE' });
  const first = await dispatchReadOnly(tagged, true, req('LIST_TAG_METADATA_PAGE'));
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const data = first.data as { entries: { path: string; tags: string[] }[]; nextCursor: string };
  assert.equal(data.entries.length, 200);
  assert.deepEqual(data.entries[0], { path: 'Notes/000.md', tags: ['area/work', 'nested/tag'] });
  const second = await dispatchReadOnly(tagged, true, { ...req('LIST_TAG_METADATA_PAGE'), cursor: data.nextCursor });
  assert.equal(second.ok, true);
  if (second.ok) assert.equal((second.data as { entries: unknown[]; nextCursor: string | null }).entries.length, 5);
  files = files.slice(1);
  assert.deepEqual(await dispatchReadOnly(tagged, true, { ...req('LIST_TAG_METADATA_PAGE'), cursor: data.nextCursor }), { ok: false, id: 'test-1', error: 'STALE_CURSOR' });
  assert.equal((await dispatchReadOnly(tagged, true, { ...req('LIST_TAG_METADATA_PAGE'), path: 'Notes/000.md' })).ok, false);
});

test('one heavily tagged note does not remove tag browsing for the whole vault', async () => {
  // 2026-11-06: a 15,000-note vault reported "too many tags for the current limit" because a single
  // note carried more than 32. The vault's other tags are perfectly browsable, so the note is marked
  // and truncated rather than the snapshot refused.
  const excessive: VaultAdapter = { ...adapter,
    tags: file => file.path === 'Welcome.md'
      ? Array.from({ length: 70 }, (_, n) => `tag-${n}`) : ['shared'] };
  const reply = await dispatchReadOnly(excessive, true, req('LIST_TAG_METADATA_PAGE'));
  assert.equal(reply.ok, true);
  const page = (reply as { data: { entries: { path: string; tags: string[]; tagCount?: number }[] } }).data;
  const welcome = page.entries.find(entry => entry.path === 'Welcome.md')!;
  assert.equal(welcome.tags.length, 64);
  assert.equal(welcome.tagCount, 70);
  // The page is still served: the vault's tags remain browsable.
  assert.deepEqual(Object.keys(reply as object).sort(), ['data', 'id', 'ok']);
});

test('stopping the host during tag snapshot hashing suppresses the page', async () => {
  let enabled = true;
  const pending = dispatchReadOnly(adapter, () => enabled, req('LIST_TAG_METADATA_PAGE'));
  enabled = false;
  assert.deepEqual(await pending, { ok: false, id: 'test-1', error: 'OFFLINE' });
});

test('backlinks use only visible existing Markdown paths and reject oversized results', async () => {
  const linked: VaultAdapter = { ...adapter,
    getFile: path => ['Welcome.md', 'Links/Source.md'].includes(path) ? { path, extension: 'md' } : null,
    backlinks: () => ['Links/Source.md', 'Links/Source.md', '.obsidian/Hidden.md', '../escape.md', 'Missing.md'],
  };
  assert.deepEqual(await dispatchReadOnly(linked, true, req('GET_BACKLINKS', 'Welcome.md')),
    { ok: true, id: 'test-1', data: { path: 'Welcome.md', backlinks: ['Links/Source.md'] } });
  assert.deepEqual(await dispatchReadOnly(linked, true, req('GET_BACKLINKS', '../Welcome.md')),
    { ok: false, id: 'test-1', error: 'FORBIDDEN' });
  assert.deepEqual(await dispatchReadOnly(linked, true, { ...req('GET_BACKLINKS', 'Welcome.md'), data: 'write' }),
    { ok: false, id: 'test-1', error: 'BAD_REQUEST' });
  const excessive: VaultAdapter = { ...linked,
    backlinks: () => Array.from({ length: 501 }, (_, n) => `Links/${n}.md`),
    getFile: path => ({ path, extension: 'md' }),
  };
  assert.deepEqual(await dispatchReadOnly(excessive, true, req('GET_BACKLINKS', 'Welcome.md')),
    { ok: false, id: 'test-1', error: 'TOO_LARGE' });
});

test('host stop during backlink lookup suppresses the result', async () => {
  let enabled = true;
  const linked: VaultAdapter = { ...adapter, backlinks: () => { enabled = false; return ['Welcome.md']; } };
  assert.deepEqual(await dispatchReadOnly(linked, () => enabled, req('GET_BACKLINKS', 'Welcome.md')),
    { ok: false, id: 'test-1', error: 'OFFLINE' });
});

test('local graph includes only resolved visible direct neighbors within limits', async () => {
  const graph: VaultAdapter = { ...adapter,
    getFile: path => ['Welcome.md', 'Links/Incoming.md', 'Links/Outgoing.md'].includes(path) ?
      { path, extension: 'md' } : null,
    backlinks: () => ['Links/Incoming.md', '.hidden.md', 'Missing.md'],
    outgoing: () => ['Links/Outgoing.md', 'Links/Incoming.md', '../escape.md'],
  };
  const small = await dispatchReadOnly(graph, true, req('GET_LOCAL_GRAPH', 'Welcome.md'));
  assert.equal(small.ok, true);
  if (small.ok) {
    const data = small.data as { center: string; nodes: string[]; edges: unknown[]; omitted?: number };
    assert.equal(data.center, 'Welcome.md');
    assert.deepEqual([...data.nodes].sort(),
      ['Links/Incoming.md', 'Links/Outgoing.md', 'Welcome.md']);
    assert.deepEqual(data.edges, [
      { from: 'Links/Incoming.md', to: 'Welcome.md' },
      { from: 'Welcome.md', to: 'Links/Incoming.md' },
      { from: 'Welcome.md', to: 'Links/Outgoing.md' },
    ]);
    assert.equal(data.omitted, 0);
  }
  // A hub note with more connections than the panel can draw keeps the graph and reports the rest,
  // instead of refusing at exactly the note where a graph is most useful.
  const excessive: VaultAdapter = { ...graph,
    getFile: path => ({ path, extension: 'md' }),
    outgoing: () => Array.from({ length: 150 }, (_, n) => `Links/${n}.md`),
    linkCounts: paths => Object.fromEntries(paths.map((path, index) => [path, paths.length - index])),
  };
  const hub = await dispatchReadOnly(excessive, true, req('GET_LOCAL_GRAPH', 'Welcome.md'));
  assert.equal(hub.ok, true);
  if (hub.ok) {
    const data = hub.data as { nodes: string[]; omitted?: number; degree?: Record<string, number> };
    assert.equal(data.nodes.length, 101);
    // 150 outgoing plus two visible backlinks (Incoming and Missing both resolve) is 152; the panel
    // keeps the hundred most connected and says so.
    assert.equal(data.omitted, 52);
    // The fake counts every path it is given, so the centre's degree is the whole node set.
    assert.equal(data.degree?.['Welcome.md'], data.nodes.length + (data.omitted ?? 0));
  }
  assert.deepEqual(await dispatchReadOnly(graph, true, req('GET_LOCAL_GRAPH', '../Welcome.md')),
    { ok: false, id: 'test-1', error: 'FORBIDDEN' });
});

test('raster reads require canonical path, allowed type, signature, and byte cap', async () => {
  const png = Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1]);
  const asset: VaultAdapter = { ...adapter,
    getFile: path => path === 'images/chart.png' ? { path, extension: 'png' } : null,
    readBinary: async () => png.buffer,
  };
  const reply = await dispatchReadOnly(asset, true, req('READ_RASTER', 'images/chart.png'));
  assert.equal(reply.ok, true);
  if (reply.ok) assert.deepEqual(reply.data, { path: 'images/chart.png', mime: 'image/png', base64: Buffer.from(png).toString('base64') });
  for (const path of ['.obsidian/chart.png', '../chart.png', 'images/code.svg', 'images/chart.pdf']) {
    assert.equal((await dispatchReadOnly(asset, true, req('READ_RASTER', path))).ok, false, path);
  }
  asset.readBinary = async () => Uint8Array.from([60,115,118,103,62]).buffer;
  assert.deepEqual(await dispatchReadOnly(asset, true, req('READ_RASTER', 'images/chart.png')), { ok: false, id: 'test-1', error: 'FORBIDDEN' });
  asset.readBinary = async () => new ArrayBuffer(256 * 1024 + 1);
  assert.deepEqual(await dispatchReadOnly(asset, true, req('READ_RASTER', 'images/chart.png')), { ok: false, id: 'test-1', error: 'TOO_LARGE' });
});

test('host stop during a pending read prevents delivering its result', async () => {
  let finish!: (value: string) => void;
  const pending = new Promise<string>(resolve => { finish = resolve; });
  const slow: VaultAdapter = { ...adapter, read: () => pending };
  let enabled = true;
  const response = dispatchReadOnly(slow, () => enabled, req('READ_MARKDOWN', 'Welcome.md'));
  enabled = false;
  finish(source);
  assert.deepEqual(await response, { ok: false, id: 'test-1', error: 'OFFLINE' });
});

test('host stop during raster IO or preview suppresses the pending result', async () => {
  let finishBinary!: (value: ArrayBuffer) => void;
  const binary = new Promise<ArrayBuffer>(resolve => { finishBinary = resolve; });
  const asset: VaultAdapter = { ...adapter,
    getFile: path => ({ path, extension: path.endsWith('.png') ? 'png' : 'md' }),
    readBinary: () => binary,
  };
  let enabled = true;
  const raster = dispatchReadOnly(asset, () => enabled, req('READ_RASTER', 'chart.png'));
  enabled = false;
  finishBinary(Uint8Array.from([137,80,78,71,13,10,26,10]).buffer);
  assert.deepEqual(await raster, { ok: false, id: 'test-1', error: 'OFFLINE' });

  let finishPreview!: (value: { html: string; state: 'complete'; renderer: string }) => void;
  const pendingPreview = new Promise<{ html: string; state: 'complete'; renderer: string }>(resolve => { finishPreview = resolve; });
  const slow: VaultAdapter = { ...adapter, preview: () => pendingPreview };
  enabled = true;
  const preview = dispatchReadOnly(slow, () => enabled, req('RENDER_PREVIEW', 'Welcome.md'));
  await Promise.resolve();
  enabled = false;
  finishPreview({ html: '<p>late</p>', state: 'complete', renderer: 'test' });
  assert.deepEqual(await preview, { ok: false, id: 'test-1', error: 'OFFLINE' });
});

test('read and preview are separate bounded commands', async () => {
  const read = await dispatchReadOnly(adapter, true, req('READ_MARKDOWN', 'Welcome.md'));
  // The host now returns the hash of the bytes it read, so conflict detection has one
  // implementation rather than the browser hashing whatever it believes it received.
  assert.deepEqual(read, { ok: true, id: 'test-1',
    data: { path: 'Welcome.md', source, hash: await sha256Hex(source) } });
  const count = previews;
  const preview = await dispatchReadOnly(adapter, true, req('RENDER_PREVIEW', 'Welcome.md'));
  assert.equal(preview.ok, true);
  assert.equal(previews, count + 1);
});

test('preview reply rejects malformed adapter output without passing extra fields', async () => {
  const malformed: VaultAdapter = {
    ...adapter,
    preview: async () => ({ html: '<p>Safe</p>', state: 'complete', renderer: 'test', secret: 'do not forward' }) as never,
  };
  const reply = await dispatchReadOnly(malformed, true, req('RENDER_PREVIEW', 'Welcome.md'));
  assert.equal(reply.ok, true);
  if (reply.ok) assert.deepEqual(reply.data, { path: 'Welcome.md', html: '<p>Safe</p>', state: 'complete', renderer: 'test' });
  malformed.preview = async () => ({ html: '<p>Safe</p>', state: 'broken', renderer: 'test' }) as never;
  assert.deepEqual(await dispatchReadOnly(malformed, true, req('RENDER_PREVIEW', 'Welcome.md')), { ok: false, id: 'test-1', error: 'RENDER_FAILED' });
});

test('properties are display-only, validated, and bounded', async () => {
  const entries = [
    { key: 'created', kind: 'date' as const, values: ['2026-10-29'] },
    { key: 'tags', kind: 'list' as const, values: ['project/alpha', 'project/beta'] },
    { key: 'draft', kind: 'boolean' as const, values: ['false'] },
  ];
  const withProps: VaultAdapter = { ...adapter, properties: () => entries };
  assert.deepEqual(await dispatchReadOnly(withProps, true, req('GET_PROPERTIES', 'Welcome.md')),
    { ok: true, id: 'test-1', data: { path: 'Welcome.md', properties: entries } });

  // A write-looking field, a wrong path shape, and a non-Markdown target are refused.
  assert.deepEqual(await dispatchReadOnly(withProps, true, { ...req('GET_PROPERTIES', 'Welcome.md'), data: 'x' }),
    { ok: false, id: 'test-1', error: 'BAD_REQUEST' });
  assert.deepEqual(await dispatchReadOnly(withProps, true, req('GET_PROPERTIES', '../Welcome.md')),
    { ok: false, id: 'test-1', error: 'FORBIDDEN' });
  assert.deepEqual(await dispatchReadOnly(withProps, true, req('GET_PROPERTIES', 'Missing.md')),
    { ok: false, id: 'test-1', error: 'NOT_FOUND' });

  const tooMany: VaultAdapter = { ...adapter, properties: () =>
    Array.from({ length: 65 }, (_, n) => ({ key: `k${n}`, kind: 'text' as const, values: ['v'] })) };
  assert.deepEqual(await dispatchReadOnly(tooMany, true, req('GET_PROPERTIES', 'Welcome.md')),
    { ok: false, id: 'test-1', error: 'TOO_LARGE' });

  const tooManyValues: VaultAdapter = { ...adapter, properties: () => [
    { key: 'tags', kind: 'list' as const, values: Array.from({ length: 33 }, (_, n) => `t${n}`) }] };
  assert.deepEqual(await dispatchReadOnly(tooManyValues, true, req('GET_PROPERTIES', 'Welcome.md')),
    { ok: false, id: 'test-1', error: 'TOO_LARGE' });

  const longValue: VaultAdapter = { ...adapter, properties: () => [
    { key: 'body', kind: 'text' as const, values: ['x'.repeat(513)] }] };
  assert.deepEqual(await dispatchReadOnly(longValue, true, req('GET_PROPERTIES', 'Welcome.md')),
    { ok: false, id: 'test-1', error: 'TOO_LARGE' });

  // Control characters in a value are refused rather than delivered to the browser.
  const control: VaultAdapter = { ...adapter, properties: () => [
    { key: 'bad', kind: 'text' as const, values: ['a\u0000b'] }] };
  assert.deepEqual(await dispatchReadOnly(control, true, req('GET_PROPERTIES', 'Welcome.md')),
    { ok: false, id: 'test-1', error: 'FORBIDDEN' });

  const badKind: VaultAdapter = { ...adapter, properties: () => [
    { key: 'x', kind: 'html' as never, values: ['<b>x</b>'] }] };
  assert.deepEqual(await dispatchReadOnly(badKind, true, req('GET_PROPERTIES', 'Welcome.md')),
    { ok: false, id: 'test-1', error: 'RENDER_FAILED' });

  // Host stop during the lookup suppresses the reply.
  let enabled = true;
  const stopDuring = { ...withProps, properties: () => { enabled = false; return entries; } };
  assert.deepEqual(await dispatchReadOnly(stopDuring, () => enabled, req('GET_PROPERTIES', 'Welcome.md')),
    { ok: false, id: 'test-1', error: 'OFFLINE' });
});

// ---------------------------------------------------------------------------
// Owner-write surface: SAVE_NOTE / CREATE_NOTE / RENAME_NOTE / MOVE_NOTE / DELETE_NOTE.
// Every case below is a refusal first and an effect second: a command that is not
// allowed must be decided *before* the adapter is touched, so each refusal also
// asserts that the recording adapter saw zero write calls.
// ---------------------------------------------------------------------------

const NOTE = 'Notes/A.md';
const OLD = 'old body';

type WriteMethod = 'writeNote' | 'createNote' | 'renameNote' | 'trashNote';
type WriteCall = { method: WriteMethod; args: unknown[] };

/** A writable fake that records every write call and keeps its own content map. */
function writableVault(initial: Record<string, string>, outcomes: Partial<Record<WriteMethod, WriteOutcome>> = {}) {
  const files = new Map(Object.entries(initial));
  const calls: WriteCall[] = [];
  const settle = (method: WriteMethod, args: unknown[]): WriteOutcome => {
    calls.push({ method, args });
    const outcome = outcomes[method] ?? 'ok';
    if (outcome !== 'ok') return outcome;
    if (method === 'writeNote') files.set((args[0] as { path: string }).path, args[1] as string);
    if (method === 'createNote') files.set(args[0] as string, args[1] as string);
    if (method === 'renameNote') {
      const from = (args[0] as { path: string }).path;
      const value = files.get(from) ?? '';
      files.delete(from);
      files.set(args[1] as string, value);
    }
    if (method === 'trashNote') files.delete((args[0] as { path: string }).path);
    return 'ok';
  };
  const adapter: WritableVaultAdapter = {
    listMarkdown: () => [...files.keys()].map(path => ({ path, extension: 'md' })),
    listFolders: () => [],
    tags: () => [],
    backlinks: () => [],
    outgoing: () => [],
    getFile: path => files.has(path) ? { path, extension: 'md' } : null,
    read: async file => {
      const value = files.get(file.path);
      if (value === undefined) throw new Error(`missing ${file.path}`);
      return value;
    },
    readBinary: async () => new ArrayBuffer(0),
    preview: async () => ({ html: '', state: 'complete', renderer: 'test' }),
    searchNotes: async () => ({ matches: [], scanned: 0, total: 0, truncated: false }),
    properties: () => [],
    appearance: () => ({ mode: 'dark', tokens: {} }),
    writeNote: async (file, source, expected) => settle('writeNote', [file, source, expected]),
    createNote: async (path, source) => settle('createNote', [path, source]),
    renameNote: async (file, to) => settle('renameNote', [file, to]),
    trashNote: async (file, expected) => settle('trashNote', [file, expected]),
  };
  return { adapter, calls, files };
}

const ownerWrite = { enabled: true, scope: 'owner_write' as const };
const readGrant = { enabled: true, scope: 'read' as const };
const vaultReq = (cmd: string, fields: Record<string, unknown>) => ({ version: 1, id: 'test-1', cmd, ...fields });

/** Well-formed payloads for the five write commands, against an existing note. */
async function writePayloads(hash: string): Promise<Record<WriteCommand, Record<string, unknown>>> {
  return {
    SAVE_NOTE: { path: NOTE, source: 'next body', hash },
    CREATE_NOTE: { path: 'Notes/New.md', source: 'new body' },
    RENAME_NOTE: { path: NOTE, to: 'Notes/Other.md' },
    MOVE_NOTE: { path: NOTE, to: 'Archive/A.md' },
    DELETE_NOTE: { path: NOTE, hash },
  };
}

test('a read grant cannot reach any write command and the adapter is never touched', async () => {
  const payloads = await writePayloads(await sha256Hex(OLD));
  for (const cmd of Object.keys(payloads) as WriteCommand[]) {
    const { adapter: vault, calls } = writableVault({ [NOTE]: OLD });
    assert.deepEqual(await dispatchVaultRequest(vault, readGrant, vaultReq(cmd, payloads[cmd])),
      { ok: false, id: 'test-1', error: 'FORBIDDEN' }, cmd);
    assert.equal(calls.length, 0, cmd);
  }
});

test('a stopped host answers OFFLINE to every write command without touching the adapter', async () => {
  const payloads = await writePayloads(await sha256Hex(OLD));
  for (const cmd of Object.keys(payloads) as WriteCommand[]) {
    const { adapter: vault, calls } = writableVault({ [NOTE]: OLD });
    assert.deepEqual(await dispatchVaultRequest(vault, { enabled: false, scope: 'owner_write' }, vaultReq(cmd, payloads[cmd])),
      { ok: false, id: '', error: 'OFFLINE' }, cmd);
    assert.equal(calls.length, 0, cmd);
  }
});

test('a grant cannot widen an adapter that has no write methods', async () => {
  const hash = await sha256Hex(source);
  const payloads: Record<WriteCommand, Record<string, unknown>> = {
    SAVE_NOTE: { path: 'Welcome.md', source: 'next body', hash },
    CREATE_NOTE: { path: 'Welcome.md', source: 'new body' },
    RENAME_NOTE: { path: 'Welcome.md', to: 'Links/Other.md' },
    MOVE_NOTE: { path: 'Welcome.md', to: 'Links/Other.md' },
    DELETE_NOTE: { path: 'Welcome.md', hash },
  };
  for (const cmd of Object.keys(payloads) as WriteCommand[]) {
    assert.deepEqual(await dispatchVaultRequest(adapter, ownerWrite, vaultReq(cmd, payloads[cmd])),
      { ok: false, id: 'test-1', error: 'FORBIDDEN' }, cmd);
  }
});

test('non-canonical or non-Markdown write paths are refused before any adapter call', async () => {
  const hash = await sha256Hex(OLD);
  const badPaths = [
    '../escape.md', '/abs.md', 'C\\win.md', '.obsidian/x.md', 'notes/../../evil.md',
    'note.txt', 'Note.MD', 'a//b.md', 'a/./b.md', 'bad\u0000.md', `${'a'.repeat(600)}.md`,
  ];
  for (const path of badPaths) {
    for (const cmd of ['SAVE_NOTE', 'CREATE_NOTE'] as const) {
      const { adapter: vault, calls } = writableVault({ [NOTE]: OLD });
      const fields = cmd === 'SAVE_NOTE' ? { path, source: 'next', hash } : { path, source: 'next' };
      assert.deepEqual(await dispatchVaultRequest(vault, ownerWrite, vaultReq(cmd, fields)),
        { ok: false, id: 'test-1', error: 'FORBIDDEN' }, `${cmd} ${path}`);
      assert.equal(calls.length, 0, `${cmd} ${path}`);
    }
  }
});

test('non-canonical rename and move targets are refused before any adapter call', async () => {
  const badPaths = [
    '../escape.md', '/abs.md', 'C\\win.md', '.obsidian/x.md', 'notes/../../evil.md',
    'note.txt', 'Note.MD', 'a//b.md', 'a/./b.md', 'Notes/bad\u0000.md',
    `Notes/${'a'.repeat(600)}.md`,
  ];
  for (const to of badPaths) {
    for (const cmd of ['RENAME_NOTE', 'MOVE_NOTE'] as const) {
      const { adapter: vault, calls } = writableVault({ [NOTE]: OLD });
      assert.deepEqual(await dispatchVaultRequest(vault, ownerWrite, vaultReq(cmd, { path: NOTE, to })),
        { ok: false, id: 'test-1', error: 'FORBIDDEN' }, `${cmd} ${to.slice(0, 20)}`);
      assert.equal(calls.length, 0, cmd);
    }
  }
});

test('write commands refuse unknown fields instead of ignoring them', async () => {
  const hash = await sha256Hex(OLD);
  const cases: [WriteCommand, Record<string, unknown>][] = [
    ['SAVE_NOTE', { path: NOTE, source: 'next', hash, mode: 'append' }],
    ['RENAME_NOTE', { path: NOTE, to: 'Notes/Other.md', source: 'next' }],
    ['CREATE_NOTE', { path: 'Notes/New.md', source: 'next', hash }],
  ];
  for (const [cmd, fields] of cases) {
    const { adapter: vault, calls } = writableVault({ [NOTE]: OLD });
    assert.deepEqual(await dispatchVaultRequest(vault, ownerWrite, vaultReq(cmd, fields)),
      { ok: false, id: 'test-1', error: 'BAD_REQUEST' }, cmd);
    assert.equal(calls.length, 0, cmd);
  }
});

test('save and delete require a 64-character lowercase hex content hash', async () => {
  const good = await sha256Hex(OLD);
  const badHashes: unknown[] = ['abc', 'A'.repeat(64), 'DEADBEEF', 123, null, good.slice(0, 63), `${good}a`];
  for (const cmd of ['SAVE_NOTE', 'DELETE_NOTE'] as const) {
    for (const hash of badHashes) {
      const { adapter: vault, calls } = writableVault({ [NOTE]: OLD });
      assert.deepEqual(await dispatchVaultRequest(vault, ownerWrite, vaultReq(cmd, { path: NOTE, source: 'next', hash })),
        { ok: false, id: 'test-1', error: 'BAD_REQUEST' }, `${cmd} ${String(hash)}`);
      assert.equal(calls.length, 0, `${cmd} ${String(hash)}`);
    }
    const { adapter: vault, calls } = writableVault({ [NOTE]: OLD });
    assert.deepEqual(await dispatchVaultRequest(vault, ownerWrite, vaultReq(cmd, { path: NOTE, source: 'next' })),
      { ok: false, id: 'test-1', error: 'BAD_REQUEST' }, `${cmd} missing hash`);
    assert.equal(calls.length, 0, `${cmd} missing hash`);
  }
});

test('a note larger than the read request budget can still be saved', async () => {
  // Regression guard: MAX_REQUEST_BYTES (16 KiB) is a read-request budget, and applying it to
  // writes made any note above ~16 KiB readable but unsaveable. A 20 KiB body must round-trip.
  const big = '# Big\n\n' + 'y'.repeat(20 * 1024);
  assert.ok(big.length > MAX_REQUEST_BYTES, 'fixture must exceed the read request budget');
  assert.ok(big.length < MAX_WRITE_NOTE_BYTES, 'fixture must fit the write note budget');

  const save = writableVault({ [NOTE]: OLD });
  const hash = await sha256Hex(OLD);
  const saved = await dispatchVaultRequest(save.adapter, ownerWrite, vaultReq('SAVE_NOTE', { path: NOTE, source: big, hash }));
  assert.deepEqual(saved, { ok: true, id: 'test-1', data: { path: NOTE, hash: await sha256Hex(big) } });

  const create = writableVault({});
  const created = await dispatchVaultRequest(create.adapter, ownerWrite, vaultReq('CREATE_NOTE', { path: 'Notes/Big.md', source: big }));
  assert.deepEqual(created, { ok: true, id: 'test-1', data: { path: 'Notes/Big.md', hash: await sha256Hex(big) } });
});

test('a body over the write note budget is TOO_LARGE even though the request fits', async () => {
  // Proves applyWrite's own cap runs: this body fits MAX_WRITE_REQUEST_BYTES but not
  // MAX_WRITE_NOTE_BYTES, so the refusal must come from the note cap (and keep its id).
  const oversized = 'z'.repeat(MAX_WRITE_NOTE_BYTES + 1);
  assert.ok(oversized.length < MAX_WRITE_REQUEST_BYTES, 'fixture must fit the request envelope');
  const hash = await sha256Hex(OLD);
  for (const [cmd, fields] of [
    ['SAVE_NOTE', { path: NOTE, source: oversized, hash }],
    ['CREATE_NOTE', { path: 'Notes/Huge.md', source: oversized }],
  ] as [WriteCommand, Record<string, unknown>][]) {
    const { adapter: vault, calls } = writableVault({ [NOTE]: OLD });
    assert.deepEqual(await dispatchVaultRequest(vault, ownerWrite, vaultReq(cmd, fields)),
      { ok: false, id: 'test-1', error: 'TOO_LARGE' }, cmd);
    assert.equal(calls.length, 0, cmd);
  }
});

test('a write refused because the host stopped mutates nothing', async () => {
  // The pre-mutation check: a stopped host must not reach the adapter at all. Without it the
  // client would see OFFLINE after the vault had already changed.
  const { adapter: vault, calls } = writableVault({ [NOTE]: OLD });
  const hash = await sha256Hex(OLD);
  for (const [cmd, fields] of Object.entries(await writePayloads(hash)) as [WriteCommand, Record<string, unknown>][]) {
    const reply = await dispatchVaultRequest(vault, { enabled: false, scope: 'owner_write' }, vaultReq(cmd, fields));
    assert.deepEqual(reply, { ok: false, id: '', error: 'OFFLINE' }, cmd);
  }
  assert.equal(calls.length, 0);
});

test('a source over every request budget is refused before the id is parsed', async () => {
  // MAX_NOTE_BYTES (1 MiB) exceeds MAX_WRITE_REQUEST_BYTES (64 KiB), so the outer request
  // budget refuses this first and the reply carries no id — the gate fires before parsing.
  const oversized = 'x'.repeat(MAX_NOTE_BYTES + 1);
  const hash = await sha256Hex(OLD);
  const cases: [WriteCommand, Record<string, unknown>][] = [
    ['SAVE_NOTE', { path: NOTE, source: oversized, hash }],
    ['CREATE_NOTE', { path: 'Notes/New.md', source: oversized }],
  ];
  for (const [cmd, fields] of cases) {
    const { adapter: vault, calls } = writableVault({ [NOTE]: OLD });
    assert.deepEqual(await dispatchVaultRequest(vault, ownerWrite, vaultReq(cmd, fields)),
      { ok: false, id: '', error: 'TOO_LARGE' }, cmd);
    assert.equal(calls.length, 0, cmd);
  }
});

test('control characters in a note body are refused while tab and newline are allowed', async () => {
  const hash = await sha256Hex(OLD);
  const refused = writableVault({ [NOTE]: OLD });
  assert.deepEqual(await dispatchVaultRequest(refused.adapter, ownerWrite, vaultReq('SAVE_NOTE', { path: NOTE, source: 'a\u0000b', hash })),
    { ok: false, id: 'test-1', error: 'FORBIDDEN' });
  assert.equal(refused.calls.length, 0);

  const allowed = writableVault({ [NOTE]: OLD });
  const whitespace = '# Title\n\n\tindented line\r\n';
  assert.deepEqual(await dispatchVaultRequest(allowed.adapter, ownerWrite, vaultReq('SAVE_NOTE', { path: NOTE, source: whitespace, hash })),
    { ok: true, id: 'test-1', data: { path: NOTE, hash: await sha256Hex(whitespace) } });
  assert.deepEqual(allowed.calls, [{ method: 'writeNote', args: [{ path: NOTE, extension: 'md' }, whitespace, OLD] }]);
});

test('an adapter-side conflict is reported as CONFLICT for save and delete', async () => {
  const hash = await sha256Hex(OLD);
  const save = writableVault({ [NOTE]: OLD }, { writeNote: 'conflict' });
  assert.deepEqual(await dispatchVaultRequest(save.adapter, ownerWrite, vaultReq('SAVE_NOTE', { path: NOTE, source: 'next', hash })),
    { ok: false, id: 'test-1', error: 'CONFLICT' });
  assert.equal(save.calls.length, 1);

  const remove = writableVault({ [NOTE]: OLD }, { trashNote: 'conflict' });
  assert.deepEqual(await dispatchVaultRequest(remove.adapter, ownerWrite, vaultReq('DELETE_NOTE', { path: NOTE, hash })),
    { ok: false, id: 'test-1', error: 'CONFLICT' });
  assert.equal(remove.calls.length, 1);
});

test('an occupied destination is reported as EXISTS for create and rename', async () => {
  const create = writableVault({ [NOTE]: OLD }, { createNote: 'exists' });
  assert.deepEqual(await dispatchVaultRequest(create.adapter, ownerWrite, vaultReq('CREATE_NOTE', { path: 'Notes/New.md', source: 'new' })),
    { ok: false, id: 'test-1', error: 'EXISTS' });
  assert.equal(create.calls.length, 1);

  const rename = writableVault({ [NOTE]: OLD }, { renameNote: 'exists' });
  assert.deepEqual(await dispatchVaultRequest(rename.adapter, ownerWrite, vaultReq('RENAME_NOTE', { path: NOTE, to: 'Notes/Other.md' })),
    { ok: false, id: 'test-1', error: 'EXISTS' });
  assert.equal(rename.calls.length, 1);
});

test('write commands against an unresolvable path are NOT_FOUND before any adapter call', async () => {
  const hash = await sha256Hex(OLD);
  const cases: [WriteCommand, Record<string, unknown>][] = [
    ['SAVE_NOTE', { path: 'Notes/Gone.md', source: 'next', hash }],
    ['RENAME_NOTE', { path: 'Notes/Gone.md', to: 'Notes/Other.md' }],
    ['MOVE_NOTE', { path: 'Notes/Gone.md', to: 'Archive/Gone.md' }],
    ['DELETE_NOTE', { path: 'Notes/Gone.md', hash }],
  ];
  for (const [cmd, fields] of cases) {
    const { adapter: vault, calls } = writableVault({ [NOTE]: OLD });
    assert.deepEqual(await dispatchVaultRequest(vault, ownerWrite, vaultReq(cmd, fields)),
      { ok: false, id: 'test-1', error: 'NOT_FOUND' }, cmd);
    assert.equal(calls.length, 0, cmd);
  }
});

test('rename may not change folder and move must change it', async () => {
  const across = writableVault({ [NOTE]: OLD });
  assert.deepEqual(await dispatchVaultRequest(across.adapter, ownerWrite, vaultReq('RENAME_NOTE', { path: NOTE, to: 'Archive/A.md' })),
    { ok: false, id: 'test-1', error: 'FORBIDDEN' });
  assert.equal(across.calls.length, 0);

  const within = writableVault({ [NOTE]: OLD });
  assert.deepEqual(await dispatchVaultRequest(within.adapter, ownerWrite, vaultReq('MOVE_NOTE', { path: NOTE, to: 'Notes/B.md' })),
    { ok: false, id: 'test-1', error: 'FORBIDDEN' });
  assert.equal(within.calls.length, 0);

  const rename = writableVault({ [NOTE]: OLD });
  assert.deepEqual(await dispatchVaultRequest(rename.adapter, ownerWrite, vaultReq('RENAME_NOTE', { path: NOTE, to: 'Notes/B.md' })),
    { ok: true, id: 'test-1', data: { path: 'Notes/B.md' } });
  assert.deepEqual(rename.calls, [{ method: 'renameNote', args: [{ path: NOTE, extension: 'md' }, 'Notes/B.md'] }]);

  const move = writableVault({ [NOTE]: OLD });
  assert.deepEqual(await dispatchVaultRequest(move.adapter, ownerWrite, vaultReq('MOVE_NOTE', { path: NOTE, to: 'Archive/A.md' })),
    { ok: true, id: 'test-1', data: { path: 'Archive/A.md' } });
  assert.deepEqual(move.calls, [{ method: 'renameNote', args: [{ path: NOTE, extension: 'md' }, 'Archive/A.md'] }]);
});

test('rename and move to the same path are refused', async () => {
  for (const cmd of ['RENAME_NOTE', 'MOVE_NOTE'] as const) {
    const { adapter: vault, calls } = writableVault({ [NOTE]: OLD });
    assert.deepEqual(await dispatchVaultRequest(vault, ownerWrite, vaultReq(cmd, { path: NOTE, to: NOTE })),
      { ok: false, id: 'test-1', error: 'FORBIDDEN' }, cmd);
    assert.equal(calls.length, 0, cmd);
  }
});

test('save and create return the hash of the bytes they wrote', async () => {
  const hash = await sha256Hex(OLD);
  const body = '# Saved\n';
  const save = writableVault({ [NOTE]: OLD });
  assert.deepEqual(await dispatchVaultRequest(save.adapter, ownerWrite, vaultReq('SAVE_NOTE', { path: NOTE, source: body, hash })),
    { ok: true, id: 'test-1', data: { path: NOTE, hash: await sha256Hex(body) } });
  assert.deepEqual(save.calls, [{ method: 'writeNote', args: [{ path: NOTE, extension: 'md' }, body, OLD] }]);
  assert.equal(save.files.get(NOTE), body);

  const created = writableVault({});
  assert.deepEqual(await dispatchVaultRequest(created.adapter, ownerWrite, vaultReq('CREATE_NOTE', { path: 'Notes/New.md', source: body })),
    { ok: true, id: 'test-1', data: { path: 'Notes/New.md', hash: await sha256Hex(body) } });
  assert.deepEqual(created.calls, [{ method: 'createNote', args: ['Notes/New.md', body] }]);
});

test('delete returns the path and no content hash', async () => {
  const hash = await sha256Hex(OLD);
  const { adapter: vault, calls } = writableVault({ [NOTE]: OLD });
  assert.deepEqual(await dispatchVaultRequest(vault, ownerWrite, vaultReq('DELETE_NOTE', { path: NOTE, hash })),
    { ok: true, id: 'test-1', data: { path: NOTE } });
  assert.deepEqual(calls, [{ method: 'trashNote', args: [{ path: NOTE, extension: 'md' }, OLD] }]);
});

test('a stale hash never reaches writeNote but a matching hash still defers to the adapter', async () => {
  const body = 'next body';

  // Protocol layer: the hash the caller saw is not what the vault holds.
  const stale = writableVault({ [NOTE]: OLD });
  assert.deepEqual(await dispatchVaultRequest(stale.adapter, ownerWrite,
    vaultReq('SAVE_NOTE', { path: NOTE, source: body, hash: await sha256Hex('some other body') })),
    { ok: false, id: 'test-1', error: 'CONFLICT' });
  assert.equal(stale.calls.length, 0);

  // Adapter layer: the hash matched on read, then the write window saw a change.
  const racing = writableVault({ [NOTE]: OLD }, { writeNote: 'conflict' });
  assert.deepEqual(await dispatchVaultRequest(racing.adapter, ownerWrite,
    vaultReq('SAVE_NOTE', { path: NOTE, source: body, hash: await sha256Hex(OLD) })),
    { ok: false, id: 'test-1', error: 'CONFLICT' });
  assert.deepEqual(racing.calls, [{ method: 'writeNote', args: [{ path: NOTE, extension: 'md' }, body, OLD] }]);
  assert.equal(racing.files.get(NOTE), OLD);
});

test('dispatchReadOnly cannot reach the write surface even with a writable adapter', async () => {
  const hash = await sha256Hex(OLD);
  const payloads = await writePayloads(hash);
  for (const cmd of Object.keys(payloads) as WriteCommand[]) {
    const { adapter: vault, calls } = writableVault({ [NOTE]: OLD });
    assert.deepEqual(await dispatchReadOnly(vault, true, vaultReq(cmd, payloads[cmd])),
      { ok: false, id: 'test-1', error: 'FORBIDDEN' }, cmd);
    assert.equal(calls.length, 0, cmd);
  }

  // A read-shaped payload mutated into a write after it was built is still refused.
  const mutated = { ...req('READ_MARKDOWN', NOTE), cmd: 'SAVE_NOTE', source: 'next body', hash } as Record<string, unknown>;
  const { adapter: vault, calls } = writableVault({ [NOTE]: OLD });
  assert.deepEqual(await dispatchReadOnly(vault, true, mutated), { ok: false, id: 'test-1', error: 'FORBIDDEN' });
  assert.equal(calls.length, 0);
});

test('SEARCH_NOTES returns titles and bounded excerpts, never a note body', async () => {
  const searching: VaultAdapter = {
    ...adapter,
    searchNotes: async (query, limit) => ({
      matches: [
        { path: 'Welcome.md', hits: 3, snippet: 'a needle here…' },
        { path: 'deep/Other.md', hits: 1, snippet: '…needle again…' },
      ].slice(0, limit),
      scanned: 42, total: 100, truncated: true,
    }),
  };
  const reply = await dispatchVaultRequest(searching, { enabled: true, scope: 'read' },
    { version: 1, id: 'search-1', cmd: 'SEARCH_NOTES', query: 'needle' });
  assert.equal(reply.ok, true);
  const data = reply.data as { matches: Array<{ path: string; hits: number; snippet: string }>;
    scanned: number; total: number; truncated: boolean };
  assert.equal(data.matches.length, 2);
  assert.equal(data.matches[0].path, 'Welcome.md');
  assert.equal(data.matches[0].hits, 3);
  // The partial-read fact is carried, so the browser can say so instead of implying completeness.
  assert.equal(data.scanned, 42);
  assert.equal(data.total, 100);
  assert.equal(data.truncated, true);
});

test('a search result naming an unpublished path is dropped rather than returned', async () => {
  const leaky: VaultAdapter = {
    ...adapter,
    searchNotes: async () => ({
      matches: [
        { path: '.obsidian/Private.md', hits: 1, snippet: 'secret' },
        { path: 'Welcome.md', hits: 1, snippet: 'fine' },
      ],
      scanned: 2, total: 2, truncated: false,
    }),
  };
  const reply = await dispatchVaultRequest(leaky, { enabled: true, scope: 'read' },
    { version: 1, id: 'search-2', cmd: 'SEARCH_NOTES', query: 'needle' });
  assert.equal(reply.ok, true);
  if (!reply.ok) return;
  const data = reply.data as { matches: Array<{ path: string }> };
  assert.deepEqual(data.matches.map(match => match.path), ['Welcome.md']);
});

test('a search cannot carry fields it does not own, or smuggle a path', async () => {
  const base = { version: 1, id: 'search-3', cmd: 'SEARCH_NOTES' };
  const cases = [
    { ...base, query: 'needle', path: 'Welcome.md' },
    { ...base, query: 'needle', cursor: 'a'.repeat(32) + ':1' },
    { ...base, query: 'needle', source: 'contents' },
  ];
  for (const request of cases) {
    const reply = await dispatchVaultRequest(adapter, { enabled: true, scope: 'read' }, request);
    assert.equal(reply.ok, false);
    assert.equal(reply.error, 'BAD_REQUEST');
  }
});

test('a search query is validated before the adapter is asked', async () => {
  let asked = 0;
  const counting: VaultAdapter = { ...adapter, searchNotes: async () => {
    asked += 1; return { matches: [], scanned: 0, total: 0, truncated: false };
  } };
  for (const query of ['', '   ', '\u0000x', 'x'.repeat(201), '-']) {
    const reply = await dispatchVaultRequest(counting, { enabled: true, scope: 'read' },
      { version: 1, id: 'search-4', cmd: 'SEARCH_NOTES', query });
    assert.equal(reply.ok, false, `expected ${JSON.stringify(query)} to be refused`);
    assert.equal(reply.error, 'FORBIDDEN');
  }
  assert.equal(asked, 0, 'the adapter must never see an invalid query');
});

test('a search limit is bounded, and a malformed one is refused', async () => {
  let seen = 0;
  const counting: VaultAdapter = { ...adapter, searchNotes: async (_query, limit) => {
    seen = limit; return { matches: [], scanned: 0, total: 0, truncated: false };
  } };
  const ok = await dispatchVaultRequest(counting, { enabled: true, scope: 'read' },
    { version: 1, id: 'search-5', cmd: 'SEARCH_NOTES', query: 'x', limit: 10 });
  assert.equal(ok.ok, true);
  assert.equal(seen, 10);

  for (const limit of [0, -1, 10_000, 1.5, 'lots']) {
    const reply = await dispatchVaultRequest(counting, { enabled: true, scope: 'read' },
      { version: 1, id: 'search-6', cmd: 'SEARCH_NOTES', query: 'x', limit });
    assert.equal(reply.ok, false);
  }
});

test('SEARCH_NOTES is refused while hosting is off, like every other read', async () => {
  const reply = await dispatchVaultRequest(adapter, { enabled: false, scope: 'read' },
    { version: 1, id: 'search-7', cmd: 'SEARCH_NOTES', query: 'needle' });
  assert.equal(reply.ok, false);
  assert.equal(reply.error, 'OFFLINE');
});

test('a read-scoped grant can search but still cannot write', async () => {
  const reply = await dispatchVaultRequest(adapter, { enabled: true, scope: 'read' },
    { version: 1, id: 'search-8', cmd: 'SEARCH_NOTES', query: 'needle' });
  assert.equal(reply.ok, true);
  const write = await dispatchVaultRequest(adapter, { enabled: true, scope: 'read' },
    { version: 1, id: 'search-9', cmd: 'DELETE_NOTE', path: 'Welcome.md', hash: 'a'.repeat(64) });
  assert.equal(write.ok, false);
  assert.equal(write.ok ? '' : write.error, 'FORBIDDEN');
});

test('a guest write grant may edit, and a read grant still may not', async () => {
  // The guest tier will grant `write` rather than the owner's `owner_write`. Accepting it now means the
  // day sharing ships the plugin does not need another manual install.
  const hash = await sha256Hex(OLD);
  const { adapter: vault } = writableVault({ [NOTE]: OLD });
  const save = { ...req('SAVE_NOTE', NOTE), source: 'next body', hash };
  assert.equal((await dispatchVaultRequest(vault, { enabled: true, scope: 'write' }, save)).ok, true);
  assert.deepEqual(await dispatchVaultRequest(vault, { enabled: true, scope: 'read' }, save),
    { ok: false, id: 'test-1', error: 'FORBIDDEN' });
});

test('the tag index comes from the vault in one reply, not a walk over every note', async () => {
  // Obsidian maintains this index itself; the per-note walk answers the same question after ninety
  // round trips on an 18,000-note vault, which is what the reader saw as "1 note loaded".
  const host: VaultAdapter = {
    ...adapter,
    tagIndex: () => [{ tag: '#area/work', count: 412 }, { tag: 'project/notes', count: 7 }],
    notesWithTag: tag => tag === 'area/work' ? ['Welcome.md'] : [],
  };
  const index = await dispatchReadOnly(host, true, req('GET_TAG_INDEX'));
  assert.equal(index.ok, true);
  if (index.ok) {
    assert.deepEqual((index.data as { tags: unknown[]; total: number }).tags,
      [{ tag: 'area/work', count: 412 }, { tag: 'project/notes', count: 7 }]);
    assert.equal((index.data as { total: number }).total, 2);
  }
  const notes = await dispatchReadOnly(host, true, req('GET_NOTES_WITH_TAG', '#area/work'));
  assert.equal(notes.ok, true);
  if (notes.ok) {
    assert.deepEqual(notes.data, { tag: 'area/work', paths: ['Welcome.md'], total: 1 });
  }
  // A tag is not a path: the request must not be read as one.
  assert.deepEqual(await dispatchReadOnly(host, true, req('GET_NOTES_WITH_TAG', '.obsidian/Secret.md')),
    { ok: true, id: 'test-1', data: { tag: '.obsidian/Secret.md', paths: [], total: 0 } });
});

test('a host without the index says BAD_REQUEST so the browser can fall back', async () => {
  assert.deepEqual(await dispatchReadOnly(adapter, true, req('GET_TAG_INDEX')),
    { ok: false, id: 'test-1', error: 'BAD_REQUEST' });
  assert.deepEqual(await dispatchReadOnly(adapter, true, req('GET_NOTES_WITH_TAG', 'area/work')),
    { ok: false, id: 'test-1', error: 'BAD_REQUEST' });
});

test('a folder page carries each note\'s tags, so membership arrives with the tree', async () => {
  const host: VaultAdapter = {
    ...adapter,
    tagIndex: () => [{ tag: 'area/work', count: 1 }],
    listMarkdown: () => [{ path: 'Notes/000.md', extension: 'md' }],
    tags: file => file.path === 'Notes/000.md' ? ['#area/work', 'area/work', '#nested/tag'] : [],
  };
  const page = await dispatchReadOnly(host, true, req('LIST_VAULT_TREE_PAGE', ''));
  assert.equal(page.ok, true);
  if (page.ok) {
    const entries = (page.data as { entries: Array<{ kind: string }> }).entries;
    assert.deepEqual(entries.filter(entry => entry.kind === 'file'),
      [{ kind: 'file', path: 'Notes/000.md', tags: ['area/work', 'nested/tag'] }]);
  }
});


test('READ_RASTER returns the display copy, and the original only when asked', async () => {
  // A host that can resize: the display reply is small and marked capped, `full` is the file itself.
  // A real PNG header: the signature check needs the magic and 24 bytes of file, not a stand-in.
  const bytes = new Uint8Array(32);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const seen: boolean[] = [];
  const resizing = { ...adapter,
    rasterForDisplay: async (_path: string, full: boolean) => {
      seen.push(full);
      return { bytes, mime: 'image/png', capped: !full };
    } };
  const display = await dispatchReadOnly(resizing, true, req('READ_RASTER', 'photo.png'));
  assert.equal(display.ok, true);
  assert.equal((display.data as { capped?: boolean }).capped, true);
  const original = await dispatchReadOnly(resizing, true,
    { version: 2, id: 'test-1', cmd: 'READ_RASTER', path: 'photo.png', full: true });
  assert.equal(original.ok, true);
  assert.equal((original.data as { capped?: boolean }).capped, false);
  assert.deepEqual(seen, [false, true]);
});

test('an unknown field on READ_RASTER is still refused', async () => {
  const reply = await dispatchReadOnly(adapter, true,
    { version: 2, id: 'x', cmd: 'READ_RASTER', path: 'photo.png', fullish: true });
  assert.equal(reply.ok, false);
});


test('READ_RASTER pages a large image and reports its size and hash', async () => {
  // 40 bytes in 16-byte pages: the client asks for offsets 0, 16 and 32 and gets the whole file back.
  const whole = new Uint8Array(96);
  whole.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let index = 8; index < whole.length; index++) whole[index] = index;
  const asks: number[] = [];
  const paging = { ...adapter, rasterPage: async (_path: string, options: { offset: number }) => {
    asks.push(options.offset);
    // The first page carries a whole PNG header: the signature check needs 24 bytes of file.
    const end = Math.min(whole.length, options.offset + 32);
    return { bytes: whole.subarray(options.offset, end), mime: 'image/png', capped: false,
      size: whole.length, hash: 'f'.repeat(64), offset: options.offset };
  } };
  const first = await dispatchReadOnly(paging, true, req('READ_RASTER', 'photo.png'));
  assert.equal(first.ok, true);
  assert.equal((first.data as { size?: number }).size, 96);
  assert.equal((first.data as { hash?: string }).hash, 'f'.repeat(64));
  // A page that does not start at the file header must still be served: it is the middle of an image.
  const later = await dispatchReadOnly(paging, true,
    { version: 2, id: 'p2', cmd: 'READ_RASTER', path: 'photo.png', offset: 32 });
  assert.equal(later.ok, true);
  assert.deepEqual(asks, [0, 32]);
});
