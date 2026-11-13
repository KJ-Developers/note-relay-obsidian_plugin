/**
 * What the vault remembers about its account.
 *
 * Deliberately tiny: an id, an address, a key fingerprint and a date. No session, no bearer token,
 * no refresh token — the plugin never holds a credential, which is why losing this file costs a
 * reconnect and nothing else.
 */
export type AccountBinding = {
  accountId: string;
  email: string;
  hostKeyId: string;
  pairedAt: string;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fingerprint = /^[A-Za-z0-9_-]{43}$/;

export function parseBinding(value: unknown): AccountBinding | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.accountId !== 'string' || !uuid.test(row.accountId)) return null;
  if (typeof row.email !== 'string' || row.email.length < 3 || row.email.length > 254 ||
      !row.email.includes('@') || /[\u0000-\u001f\u007f]/.test(row.email)) return null;
  if (typeof row.hostKeyId !== 'string' || !fingerprint.test(row.hostKeyId)) return null;
  if (typeof row.pairedAt !== 'string' || !Number.isFinite(Date.parse(row.pairedAt))) return null;
  return {
    accountId: row.accountId, email: row.email,
    hostKeyId: row.hostKeyId, pairedAt: row.pairedAt,
  };
}

/** The pane's one line of account status. Kept as a function so it can be tested without Obsidian. */
export function accountStatusLine(binding: AccountBinding | null): string {
  if (!binding) return 'Not connected — this vault is not linked to an account yet.';
  const when = new Date(binding.pairedAt).toLocaleDateString();
  return `Connected as ${binding.email} (linked ${when}).`;
}

/** A label Obsidian shows in the dashboard and in pairing reviews. Never the path. */
export function vaultLabel(vaultName: string): string {
  const trimmed = vaultName.trim().replace(/[\u0000-\u001f\u007f]/g, '');
  return (trimmed || 'This vault').slice(0, 120);
}
