import { requestUrl } from 'obsidian';
import { WORKER_ORIGIN } from './endpoints';

// The origin is fixed at build time and never supplied by a caller, so a vault cannot be
// talked into presenting its pairing proof to somebody else's server. See `endpoints.ts`.
const ORIGIN = WORKER_ORIGIN;

async function post(path: string, body: object): Promise<{ status: number; value: unknown }> {
  const response = await requestUrl({
    url: `${ORIGIN}${path}`, method: 'POST', contentType: 'application/json',
    body: JSON.stringify(body), throw: false,
  });
  if (response.text.length > 4096) throw new Error('Pairing service response too large');
  let value: unknown;
  try { value = JSON.parse(response.text); }
  catch { throw new Error('Pairing service unavailable'); }
  return { status: response.status, value };
}

export const pairingApi = {
  async lookup(code: string): Promise<unknown> {
    const result = await post('/v1/pairing/lookup', { code });
    if (result.status !== 200) throw new Error('Pairing code unavailable');
    return result.value;
  },
  async present(input: {
    code: string; vaultId: string; hostPublicJwk: object;
    signature: string; displayLabel: string;
  }): Promise<boolean> {
    const result = await post('/v1/pairing/present', input);
    return result.status === 200 && !!result.value &&
      typeof result.value === 'object' &&
      (result.value as { presented?: unknown }).presented === true;
  },
  async confirm(input: { pairingId: string; signature: string }): Promise<boolean> {
    const result = await post('/v1/pairing/confirm', input);
    if (result.status === 409) return false;
    return result.status === 200 && !!result.value &&
      typeof result.value === 'object' &&
      (result.value as { confirmed?: unknown }).confirmed === true;
  },
};
