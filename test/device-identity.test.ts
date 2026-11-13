import assert from 'node:assert/strict';
import test from 'node:test';
import { deviceIdPattern, getOrCreateDeviceId } from '../src/device-identity';

/** App-level storage, as a Map. Obsidian's own lives outside the plugin folder and survives removal. */
function storage() {
  const values = new Map<string, unknown>();
  return {
    values,
    loadLocalStorage(key: string) { return values.has(key) ? values.get(key) : null; },
    saveLocalStorage(key: string, value: unknown) { values.set(key, value); },
  };
}

test('mints one device id and keeps it across installs', () => {
  const store = storage();
  const first = getOrCreateDeviceId(store);
  assert.ok(first);
  assert.match(first.deviceId, deviceIdPattern);
  const second = getOrCreateDeviceId(store);
  assert.equal(second?.deviceId, first.deviceId);
});

test('replaces a stored value that is not a device id', () => {
  const store = storage();
  store.saveLocalStorage('note-relay:device-id', 'not-a-uuid');
  const identity = getOrCreateDeviceId(store);
  assert.ok(identity);
  assert.match(identity.deviceId, deviceIdPattern);
  assert.equal(store.loadLocalStorage('note-relay:device-id'), identity.deviceId);
});

test('sends nothing when the host refuses app-level storage', () => {
  // Absence is the same thing an older plugin build sends, so the Worker treats both identically.
  const refusing = {
    loadLocalStorage() { throw new Error('refused'); },
    saveLocalStorage() { throw new Error('refused'); },
  };
  assert.equal(getOrCreateDeviceId(refusing), null);
});

test('does not invent an id it cannot persist', () => {
  // A value that cannot be stored would change on every launch, retiring a live row each time —
  // worse than no device id at all.
  const readOnly = {
    loadLocalStorage() { return null; },
    saveLocalStorage() { throw new Error('refused'); },
  };
  assert.equal(getOrCreateDeviceId(readOnly), null);
});

test('keeps the machine label within what the Worker accepts', () => {
  const store = storage();
  const identity = getOrCreateDeviceId(store);
  assert.ok(identity);
  if (identity.machineLabel !== null) {
    assert.ok(identity.machineLabel.length >= 1 && identity.machineLabel.length <= 64);
    assert.equal([...identity.machineLabel].some(char => {
      const code = char.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    }), false);
  }
});
