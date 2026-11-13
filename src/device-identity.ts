import { hostname } from 'node:os';
import { hasControlCharacter } from './characters';

/**
 * A stable identity for *this machine*, separate from *this vault*.
 *
 * The vault id lives in the plugin's `data.json`, so removing the plugin deletes it. Reinstall the
 * same plugin version on the same vault and the Worker sees a brand-new installation: a second
 * `nr_hosts` row with a fresh key, listing the same vault twice on the site forever, and the old row
 * can never reconnect because its private key left with `data.json`. Measured 2026-11-13: two oil
 * listings for one vault after a reinstall.
 *
 * Obsidian's app-level local storage survives plugin removal, so a device id written there is the
 * one fact that spans an uninstall. Two machines synced to one vault keep two different device ids
 * and therefore two live rows — which is correct, and is what a reader wants when one machine is
 * down — while a reinstall on one machine can retire its own previous row.
 */

const DEVICE_KEY = 'note-relay:device-id';
const MACHINE_KEY = 'note-relay:machine-label';

/** Same shape the Worker accepts elsewhere: a v4-ish uuid, lowercase. */
export const deviceIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * The two calls the plugin needs from Obsidian's app-level storage.
 *
 * Narrowed to an interface so the module can be tested without Electron, and so a host that refuses
 * app-level storage degrades to "no device id" rather than failing pairing.
 */
export type DeviceStorage = {
  loadLocalStorage(key: string): unknown;
  saveLocalStorage(key: string, value: unknown): void;
};

export type DeviceIdentity = { deviceId: string; machineLabel: string | null };

/**
 * A machine label a person can recognise.
 *
 * `os.hostname()` is only reachable in the desktop app; Obsidian mobile has no equivalent and the
 * plugin must not pretend it does, so the label is optional and the Worker treats it as a display
 * convenience rather than an identity.
 */
export function machineLabel(): string | null {
  try {
    const name = hostname();
    if (typeof name !== 'string') return null;
    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed.length > 64) return null;
    if (hasControlCharacter(trimmed)) return null;
    return trimmed;
  } catch { return null; }
}

/**
 * The device id for this install, minted once and kept across plugin removals.
 *
 * Returns `null` when app-level storage is unavailable (a host that refuses it) rather than minting a
 * value that would change every launch and retire a live row on every pairing — a wrong identity is
 * worse than a missing one, because absence is exactly how an old plugin build behaves.
 */
export function getOrCreateDeviceId(storage: DeviceStorage): DeviceIdentity | null {
  let existing: unknown;
  try { existing = storage.loadLocalStorage(DEVICE_KEY); }
  catch { return null; }
  if (typeof existing === 'string' && deviceIdPattern.test(existing)) {
    return { deviceId: existing, machineLabel: storedMachineLabel(storage) };
  }
  const deviceId = crypto.randomUUID();
  try {
    storage.saveLocalStorage(DEVICE_KEY, deviceId);
    // Written beside the id so a rename of the computer is picked up on the next launch rather than
    // freezing the name the machine had when the plugin was installed.
    const label = machineLabel();
    if (label) storage.saveLocalStorage(MACHINE_KEY, label);
    return { deviceId, machineLabel: label ?? storedMachineLabel(storage) };
  } catch { return null; }
}

function storedMachineLabel(storage: DeviceStorage): string | null {
  const current = machineLabel();
  if (current) return current;
  try {
    const saved = storage.loadLocalStorage(MACHINE_KEY);
    return typeof saved === 'string' && saved.length >= 1 && saved.length <= 64 &&
      !hasControlCharacter(saved) ? saved : null;
  } catch { return null; }
}
