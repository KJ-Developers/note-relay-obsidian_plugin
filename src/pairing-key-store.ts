import { generateHostPairingKey, hostPairingKeyId, type HostPublicJwk } from './pairing-key';

const DB_NAME = 'noterelay-host-keys';
const STORE = 'keys';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const coordinate = /^[A-Za-z0-9_-]{43}$/;

export type StoredHostKey = {
  vaultId: string;
  privateKey: CryptoKey;
  publicJwk: HostPublicJwk;
};

function open(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { keyPath: 'vaultId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Host key store unavailable'));
    request.onblocked = () => reject(new Error('Host key store blocked'));
  });
}

function read(db: IDBDatabase, vaultId: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(vaultId);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Host key read failed'));
  });
}

function insert(db: IDBDatabase, value: StoredHostKey): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    transaction.objectStore(STORE).add(value);
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('Host key write failed'));
  });
}

function replaceIfCurrent(db: IDBDatabase, old: StoredHostKey, next: StoredHostKey): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    const request = store.get(old.vaultId);
    request.onsuccess = () => {
      const current = request.result as Partial<StoredHostKey> | undefined;
      if (!current || current.publicJwk?.x !== old.publicJwk.x ||
          current.publicJwk?.y !== old.publicJwk.y) {
        transaction.abort();
        return;
      }
      store.put(next);
    };
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(new Error('Host key changed during replacement'));
  });
}

async function validate(value: unknown, vaultId: string): Promise<StoredHostKey> {
  if (!value || typeof value !== 'object') throw new Error('Invalid stored host key');
  const row = value as Partial<StoredHostKey>;
  const key = row.publicJwk;
  if (row.vaultId !== vaultId || !row.privateKey ||
      row.privateKey.type !== 'private' || row.privateKey.extractable !== false ||
      !row.privateKey.usages.includes('sign') ||
      row.privateKey.algorithm.name !== 'ECDSA' ||
      (row.privateKey.algorithm as EcKeyAlgorithm).namedCurve !== 'P-256' ||
      !key || Object.keys(key).sort().join(',') !== 'crv,kty,x,y' ||
      key.kty !== 'EC' || key.crv !== 'P-256' ||
      !coordinate.test(key.x) || !coordinate.test(key.y)) {
    throw new Error('Invalid stored host key');
  }
  try {
    const publicKey = await crypto.subtle.importKey('jwk', key,
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const check = crypto.getRandomValues(new Uint8Array(32));
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' }, row.privateKey, check);
    if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' },
      publicKey, signature, check)) throw new Error('Mismatched stored host key');
  } catch { throw new Error('Invalid stored host key'); }
  return row as StoredHostKey;
}

// A missing key may be created for a new vault. A malformed or inaccessible
// existing record fails closed; it must never be silently replaced.
export async function getOrCreateHostKey(
  vaultId: string, factory: IDBFactory = indexedDB,
): Promise<StoredHostKey> {
  if (!uuid.test(vaultId)) throw new Error('Invalid vault ID');
  const db = await open(factory);
  try {
    const existing = await read(db, vaultId);
    if (existing !== undefined) return validate(existing, vaultId);
    const generated = await generateHostPairingKey();
    const value = { vaultId, ...generated };
    try { await insert(db, value); return validate(value, vaultId); }
    catch (error) {
      // Only an insert race may fall back to the winner. Storage failures do
      // not mint a new identity or allow pairing to continue.
      if (!(error instanceof DOMException) || error.name !== 'ConstraintError') throw error;
      const winner = await read(db, vaultId);
      return validate(winner, vaultId);
    }
  } finally { db.close(); }
}

export async function getExistingHostKey(
  vaultId: string, factory: IDBFactory = indexedDB,
): Promise<StoredHostKey | null> {
  if (!uuid.test(vaultId)) throw new Error('Invalid vault ID');
  const db = await open(factory);
  try {
    const value = await read(db, vaultId);
    return value === undefined ? null : validate(value, vaultId);
  } finally { db.close(); }
}

// The owner must revoke the host in the browser first. This function only
// changes the local key and never claims to revoke an already paired host.
export async function replaceHostKey(
  vaultId: string, expectedHostKeyId: string, factory: IDBFactory = indexedDB,
): Promise<StoredHostKey> {
  if (!uuid.test(vaultId) || !coordinate.test(expectedHostKeyId)) {
    throw new Error('Invalid key replacement');
  }
  const db = await open(factory);
  try {
    const value = await read(db, vaultId);
    if (value === undefined) throw new Error('No host key to replace');
    const old = await validate(value, vaultId);
    if (await hostPairingKeyId(old.publicJwk) !== expectedHostKeyId) {
      throw new Error('Host key changed');
    }
    const next = { vaultId, ...await generateHostPairingKey() };
    await replaceIfCurrent(db, old, next);
    return validate(next, vaultId);
  } finally { db.close(); }
}
