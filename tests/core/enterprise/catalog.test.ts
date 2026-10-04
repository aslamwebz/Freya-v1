import { describe, expect, it } from 'vitest'
import {
  ENTERPRISE_LIMITS,
  customerValueIsClean,
  mayAddCatalogItem,
  mayAddCustomer,
  mayTouchCustomer,
  readCatalogItem,
  readCustomer,
  type CustomerRecord,
} from '../../../core/enterprise'
import { T0 } from './harness'

/**
 * The catalog (projects, products, services) and customers.
 *
 * The customer half of this file is the one that matters most, because a customer is a
 * third party. A record about somebody who did not consent to being in the system has a
 * different burden on it than a record about the owner's own business, and the tests
 * below are mostly about what such a record must *not* be able to contain.
 */

describe('a catalog item is a bounded project, product or service', () => {
  const base = { itemId: 'item-1', environmentId: 'env-1', kind: 'project', name: 'Launch site', at: T0 }

  it('accepts the three kinds the phase commits to', () => {
    for (const kind of ['project', 'product', 'service'] as const) {
      const reading = readCatalogItem({ ...base, kind })
      expect(reading.ok, kind).toBe(true)
      expect(reading.value?.kind).toBe(kind)
    }
  })

  it('refuses an unknown kind rather than defaulting to one', () => {
    // Defaulting would mean a mis-typed kind silently became a project, which is how a
    // service ends up governed by project ceilings.
    for (const kind of ['treasury', 'Project', '', null, 42]) {
      const reading = readCatalogItem({ ...base, kind })
      expect(reading.ok, String(kind)).toBe(false)
      expect(reading.reason).toContain('project, product, service')
    }
  })

  it('starts in draft, because nothing is operated before it is activated', () => {
    expect(readCatalogItem(base).value?.state).toBe('draft')
  })

  it('refuses a nameless item', () => {
    for (const name of ['', '   ', null, undefined, 42]) {
      expect(readCatalogItem({ ...base, name }).ok, String(name)).toBe(false)
    }
  })

  it('refuses an over-long name, and holds it to the shorter journal bound too', () => {
    const reading = readCatalogItem({ ...base, name: 'x'.repeat(ENTERPRISE_LIMITS.maxTitleLength + 1) })
    expect(reading.ok).toBe(false)
    expect(reading.reason).toContain('bounded length')
  })

  it('refuses a nameless item with no id or no environment', () => {
    expect(readCatalogItem({ ...base, itemId: '' }).ok).toBe(false)
    expect(readCatalogItem({ ...base, environmentId: '' }).ok).toBe(false)
  })

  it('refuses an unparseable creation instant', () => {
    expect(readCatalogItem({ ...base, at: 'whenever' }).ok).toBe(false)
  })

  it('bounds how many items one environment may hold', () => {
    expect(mayAddCatalogItem(0).ok).toBe(true)
    expect(mayAddCatalogItem(ENTERPRISE_LIMITS.maxCatalogItemsPerEnvironment - 1).ok).toBe(true)
    const over = mayAddCatalogItem(ENTERPRISE_LIMITS.maxCatalogItemsPerEnvironment)
    expect(over.ok).toBe(false)
    expect(over.code).toBe('item-count-exceeded')
  })
})

describe('a customer record holds a label and a state, and nothing else', () => {
  const base = { customerId: 'cus-1', environmentId: 'env-1', displayName: 'Acme Ltd', at: T0 }

  it('accepts a plain display name', () => {
    const reading = readCustomer(base)
    expect(reading.ok).toBe(true)
    expect(reading.value).toMatchObject({ displayName: 'Acme Ltd', state: 'active' })
  })

  it('refuses a nameless record', () => {
    for (const displayName of ['', '  ', null, undefined]) {
      expect(readCustomer({ ...base, displayName }).ok, String(displayName)).toBe(false)
    }
  })

  it('holds the display name to a short bound, because it is not an address book', () => {
    const reading = readCustomer({ ...base, displayName: 'x'.repeat(ENTERPRISE_LIMITS.maxCustomerNameLength + 1) })
    expect(reading.ok).toBe(false)
    expect(reading.reason).toContain('not a place for an address')
  })
})

describe('a customer record cannot hold money, a credential, or an impersonation', () => {
  const base = { customerId: 'cus-1', environmentId: 'env-1', at: T0 }

  /**
   * Each of these is a value a caller might innocently paste in. The point is not that
   * the field names would catch them — an allowlist of field names is defeated by
   * putting a card number in a field called `note` — but that the *content* is refused
   * wherever it appears.
   */
  const hostileValues = [
    'IBAN GB29 NWBK 6016 1331 9268 19',
    'iban: GB29NWBK60161331926819',
    'card number 4111111111111111',
    '4111 1111 1111 1111',
    'cvv 123',
    'password: hunter2',
    'api-key sk-live-abcdef',
    'token abc123',
    'secret: letmein',
    'wallet 0xdeadbeef',
    'sort code 20-00-00',
    'routing number 021000021',
    'account number 12345678',
    'SWIFT code DEUTDEFF',
  ]

  for (const value of hostileValues) {
    it(`refuses a display name containing "${value.slice(0, 24)}…"`, () => {
      const reading = readCustomer({ ...base, displayName: value })
      expect(reading.ok).toBe(false)
      expect(reading.reason).toContain('payment, bank or credential')
    })
  }

  it('refuses a bare card number, which contains no word to match at all', () => {
    // `4111 1111 1111 1111` matches nothing a word list could match, which is why the
    // digit-run check exists alongside the word check rather than inside it.
    for (const value of [
      '4111111111111111',
      '4111 1111 1111 1111',
      '4111-1111-1111-1111',
      '378282246310005',
      '6011111111111117',
    ]) {
      expect(customerValueIsClean(value), value).toBe(false)
    }
  })

  it('catches a wallet address by its leading word rather than its shape', () => {
    expect(customerValueIsClean('wallet 0xdeadbeef')).toBe(false)
  })

  it('does not refuse a short customer reference, which is legitimate', () => {
    // The bound is 12 digits precisely so that this stays true. A filter with false
    // positives on ordinary data gets worked around, and a worked-around filter
    // protects nothing.
    for (const value of ['Acme Ltd', 'customer 4471', 'ref 12345', 'acct 99-1234']) {
      expect(customerValueIsClean(value), value).toBe(true)
    }
  })

  it('sees through separators and case', () => {
    // A filter matching only the exact token is defeated by adding a space, which is
    // not an adversary anybody should have to be.
    expect(customerValueIsClean('Card Number')).toBe(false)
    expect(customerValueIsClean('CARD_NUMBER')).toBe(false)
    expect(customerValueIsClean('card-number')).toBe(false)
    expect(customerValueIsClean('my cardnumber is')).toBe(false)
  })

  it('allows ordinary business names that merely resemble nothing dangerous', () => {
    for (const name of ['Acme Ltd', 'Northwind Trading', 'The Very Best Co', 'Jan Kowalski']) {
      expect(customerValueIsClean(name), name).toBe(true)
    }
  })

  it('treats an empty value as clean rather than as an attack', () => {
    expect(customerValueIsClean('')).toBe(true)
  })
})

describe('withdrawal is permanent and visible', () => {
  const withdrawn: CustomerRecord = {
    customerId: 'cus-1',
    environmentId: 'env-1',
    displayName: 'Acme Ltd',
    state: 'withdrawn',
    createdAt: T0,
    updatedAt: T0,
    withdrawnAt: T0,
  }

  it('refuses to write to a withdrawn record', () => {
    // A third party who asked to be forgotten and then reappears is worse than a
    // record that was never there, because the owner cannot reason about it.
    const verdict = mayTouchCustomer(withdrawn)
    expect(verdict.ok).toBe(false)
    expect(verdict.code).toBe('customer-withdrawn')
    expect(verdict.reason).toContain('not written to again')
  })

  it('permits writing to an active record', () => {
    const active: CustomerRecord = { ...withdrawn, state: 'active', withdrawnAt: null }
    expect(mayTouchCustomer(active).ok).toBe(true)
  })

  it('permits a paused record, which is not withdrawn', () => {
    expect(mayTouchCustomer({ ...withdrawn, state: 'paused', withdrawnAt: null }).ok).toBe(true)
  })
})

describe('customers are bounded too', () => {
  it('allows records up to the ceiling and refuses beyond it', () => {
    expect(mayAddCustomer(0).ok).toBe(true)
    expect(mayAddCustomer(ENTERPRISE_LIMITS.maxCustomersPerEnvironment - 1).ok).toBe(true)
    const over = mayAddCustomer(ENTERPRISE_LIMITS.maxCustomersPerEnvironment)
    expect(over.ok).toBe(false)
    expect(over.code).toBe('customer-count-exceeded')
  })
})

describe('a customer record has no contact, payment or history field at all', () => {
  it('exposes exactly the fields the type declares, and none of them is a detail', () => {
    const reading = readCustomer({
      customerId: 'cus-1',
      environmentId: 'env-1',
      displayName: 'Acme Ltd',
      at: T0,
    })
    expect(Object.keys(reading.value ?? {}).sort()).toEqual([
      'createdAt',
      'customerId',
      'displayName',
      'environmentId',
      'state',
      'updatedAt',
      'withdrawnAt',
    ])
  })

  it('drops any extra field a caller supplies rather than storing it', () => {
    // The moment this stored an email it would be a contact database, and the moment
    // it stored a note it would be a mailbox. Neither has retention or export
    // semantics in this phase, so neither exists.
    const reading = readCustomer({
      customerId: 'cus-1',
      environmentId: 'env-1',
      displayName: 'Acme Ltd',
      email: 'billing@acme.test',
      notes: 'prefers invoices',
      cardNumber: '4111111111111111',
      at: T0,
    })
    expect(reading.ok).toBe(true)
    expect(reading.value).not.toHaveProperty('email')
    expect(reading.value).not.toHaveProperty('notes')
    expect(reading.value).not.toHaveProperty('cardNumber')
  })
})