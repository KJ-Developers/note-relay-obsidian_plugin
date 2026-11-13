import assert from 'node:assert/strict';
import test from 'node:test';
import { isNewerVersion } from '../src/update-check';

// The update notice must never fire on an equal or older version: a wrong notice teaches the owner to
// ignore the one that matters.
test('a newer version is recognised and an equal or older one is not', () => {
  assert.equal(isNewerVersion('0.2.0', '0.1.10'), true);
  assert.equal(isNewerVersion('1.0.0', '0.9.9'), true);
  assert.equal(isNewerVersion('0.2.0', '0.2.0'), false);
  assert.equal(isNewerVersion('0.1.9', '0.1.10'), false);
  assert.equal(isNewerVersion('', '0.1.10'), false);
  assert.equal(isNewerVersion('not-a-version', '0.1.10'), false);
});
