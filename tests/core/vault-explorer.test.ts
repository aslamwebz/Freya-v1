// @vitest-environment node
import { expect, it } from 'vitest'
import { validateVaultRequest } from '../../core/vault/explorer'
it('refuses authority, SQL, forged verification, invalid versions and unbounded content', () => {
  expect(() => validateVaultRequest({ operation: 'create', title: 'A', content: 'B', category: 'knowledge' })).not.toThrow()
  for (const extra of ['sql', 'authority', 'verified', 'source', 'path']) expect(() => validateVaultRequest({ operation: 'create', title: 'A', content: 'B', category: 'knowledge', [extra]: 'owner' })).toThrow()
  expect(() => validateVaultRequest({ operation: 'update', id: 'a', expectedVersion: -1 })).toThrow()
  expect(() => validateVaultRequest({ operation: 'create', title: 'A', content: 'x'.repeat(16001), category: 'knowledge' })).toThrow()
  expect(() => validateVaultRequest({ operation: 'read', id: '../vault.db' })).toThrow()
})
