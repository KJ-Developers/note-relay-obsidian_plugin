import assert from 'node:assert/strict';
import test from 'node:test';
import {
  accountStatusLine, parseBinding, vaultLabel, type AccountBinding,
} from '../src/account-binding';

const fingerprint = 'A'.repeat(43);

function binding(overrides: Partial<AccountBinding> = {}): AccountBinding {
  return {
    accountId: crypto.randomUUID(), email: 'owner@example.com',
    hostKeyId: fingerprint, pairedAt: new Date('2026-11-06T12:00:00Z').toISOString(),
    ...overrides,
  };
}

test('a stored binding round-trips', () => {
  const stored = binding();
  assert.deepEqual(parseBinding(stored), stored);
});

test('a binding is refused when any part of it is not usable', () => {
  for (const broken of [
    null, undefined, 'string', [], {},
    binding({ accountId: 'not-a-uuid' }),
    binding({ email: '' }),
    binding({ email: 'no-at-sign' }),
    binding({ hostKeyId: 'short' }),
    binding({ pairedAt: 'never' }),
  ]) {
    assert.equal(parseBinding(broken), null, JSON.stringify(broken));
  }
});

test('control characters cannot ride in through the account address', () => {
  assert.equal(parseBinding(binding({ email: 'a@b\u0000.c' })), null);
  assert.equal(parseBinding(binding({ email: 'a@b\nc' })), null);
});

test('the pane states the account, or says plainly that there is none', () => {
  assert.match(accountStatusLine(null), /^Not connected/);
  const line = accountStatusLine(binding());
  assert.match(line, /owner@example\.com/);
  assert.match(line, /linked/);
});

test('the vault label is a label, never a path', () => {
  assert.equal(vaultLabel('Work vault'), 'Work vault');
  assert.equal(vaultLabel('   '), 'This vault');
  assert.equal(vaultLabel('bad\u0000name'), 'badname');
  assert.ok(vaultLabel('x'.repeat(400)).length <= 120);
});
