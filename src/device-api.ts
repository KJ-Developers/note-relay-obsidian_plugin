import { requestUrl } from 'obsidian';
import { WORKER_ORIGIN } from './endpoints';

// The device-grant half of the Worker API. The origin is fixed at build time and never supplied by a
// caller, exactly like pairing: a vault cannot be talked into presenting its proof elsewhere.
const ORIGIN = WORKER_ORIGIN;

/**
 * A refusal the person can act on.
 *
 * Measured 2026-11-06: the owner pressed Connect, the Worker answered 429, and the modal said
 * "Could not start connecting this vault" — the one fact that mattered (he had used up the network's
 * grant budget and it resets in minutes) was in the response and thrown away here.
 */
export class DeviceApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string,
    readonly retryAfterSeconds?: number) {
    super(message);
    this.name = 'DeviceApiError';
  }
}

type ApiBody = { error?: unknown; retryAfterSeconds?: unknown } | null;

async function post(path: string, body: object): Promise<{ status: number; value: unknown }> {
  const response = await requestUrl({
    url: `${ORIGIN}${path}`, method: 'POST', contentType: 'application/json',
    body: JSON.stringify(body), throw: false,
  });
  if (response.text.length > 4096) {
    throw new DeviceApiError('The connection service sent an unusable reply.', response.status, 'TOO_LARGE');
  }
  let value: unknown;
  try { value = JSON.parse(response.text); }
  catch {
    throw new DeviceApiError('The connection service is unreachable. Check this machine is online.',
      response.status, 'UNREADABLE');
  }
  return { status: response.status, value };
}

/** Turns a status and body into the sentence the person needs, after the mapping. */
function refusal(status: number, value: unknown): DeviceApiError {
  const body: ApiBody | null = value ?? null;
  const code = typeof body?.error === 'string' ? body.error : 'UNKNOWN';
  const wait = typeof body?.retryAfterSeconds === 'number' ? body.retryAfterSeconds : undefined;

  if (status === 429) {
    const minutes = wait ? Math.max(1, Math.ceil(wait / 60)) : 10;
    return new DeviceApiError(
      `Too many connection attempts from this network. Try again in about ${minutes} `
        + `${minutes === 1 ? 'minute' : 'minutes'}.`, status, code, wait);
  }
  if (status === 409 || code === 'ALREADY_LINKED') {
    return new DeviceApiError('This vault is already linked to an account on a different key. Open '
      + 'the site to manage it, or replace the pairing key here if this machine should own it.',
      status, 'ALREADY_LINKED');
  }
  if (status === 404) {
    // The Worker answers 404 for both "no such grant" and "this vault is already linked", on purpose.
    return new DeviceApiError('This vault could not be linked. If it is already connected, disconnect '
      + 'it here first; otherwise press Connect again for a fresh code.', status, code);
  }
  if (status === 503) {
    return new DeviceApiError('The connection service is temporarily unavailable. Try again shortly.',
      status, code);
  }
  return new DeviceApiError(`Connecting failed (${status} ${code}).`, status, code);
}

export const deviceApi = {
  async authorize(input: {
    vaultId: string; hostPublicJwk: object; displayLabel: string;
  }): Promise<unknown> {
    const result = await post('/v1/device/authorize', input);
    if (result.status !== 201) throw refusal(result.status, result.value);
    return result.value;
  },

  async present(input: { deviceCode: string; signature: string }): Promise<unknown> {
    const result = await post('/v1/device/present', input);
    // 403 is a rejected proof, not a transient fault: retrying the same signature cannot help.
    if (result.status === 403) return { status: 'rejected' };
    if (result.status !== 200) throw refusal(result.status, result.value);
    return result.value;
  },

  async token(input: { deviceCode: string }): Promise<unknown> {
    const result = await post('/v1/device/token', input);
    if (result.status === 428) return { status: 'pending' };
    if (result.status === 410) {
      const body = result.value as { status?: unknown } | null;
      return { status: body?.status === 'spent' ? 'spent' : 'expired' };
    }
    if (result.status !== 200) throw refusal(result.status, result.value);
    const body = result.value as { status?: unknown } | null;
    return body && body.status === 'approved' ? body : { status: 'pending' };
  },
};
