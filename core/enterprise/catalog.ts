import {
  CATALOG_ITEM_KINDS,
  CATALOG_ITEM_STATES,
  CUSTOMER_STATES,
  ENTERPRISE_LIMITS,
  FORBIDDEN_CUSTOMER_DIGIT_RUN,
  FORBIDDEN_CUSTOMER_VALUE_WORDS,
  isCatalogItemKind,
  type CatalogItemKind,
  type CatalogItemState,
  type CustomerState,
  type EnterpriseRefusalCode,
} from './types'

/**
 * Projects, products and services; and customers.
 *
 * Two small aggregates that answer "what is this environment actually operating, and
 * for whom". Both are deliberately minimal, and the minimality is the design:
 *
 * **Catalog items** are what an environment holds. A project, a product and a service
 * share one lifecycle and one set of ceilings, and they share them because the
 * difference between them is a label rather than a different authority. Nothing here
 * can turn a project into something that spends, signs or ships, because there is no
 * field on a catalog item that means any of those things.
 *
 * **Customers** are third parties, and that changes the rules rather than the shape.
 * A customer record here holds a bounded display name and a state. That is all, and
 * the reason is written into {@link FORBIDDEN_CUSTOMER_VALUE_WORDS}: the moment this
 * subsystem holds someone's bank details, it has become a system that can lose them,
 * that has to be protected from a breach, and whose compromise is a harm to somebody
 * who never consented to being in the system at all. So it does not hold them.
 *
 * The value-word check is a content filter rather than a field-name allowlist, and
 * that choice is the point: "no field is called `cardNumber`" was never the property
 * anybody wanted, and it is defeated by putting a card number in a field called
 * `note`.
 *
 * Pure. No clock, no journal, no network, no payment route.
 */

export interface CatalogItem {
  readonly itemId: string
  readonly environmentId: string
  readonly kind: CatalogItemKind
  readonly name: string
  readonly state: CatalogItemState
  readonly createdAt: string
  readonly updatedAt: string
  readonly completedAt: string | null
}

export interface CustomerRecord {
  readonly customerId: string
  readonly environmentId: string
  /** A bounded label the owner chose. Not an email, not a handle, not an address. */
  readonly displayName: string
  readonly state: CustomerState
  readonly createdAt: string
  readonly updatedAt: string
  readonly withdrawnAt: string | null
}

/* ---------------------------------------------------------------- catalog */

export interface Reading<T> {
  readonly ok: boolean
  readonly value: T | null
  readonly code: EnterpriseRefusalCode | null
  readonly reason: string
}

const BAD = <T>(code: EnterpriseRefusalCode, reason: string): Reading<T> => ({
  ok: false,
  value: null,
  code,
  reason,
})

const GOOD = <T>(value: T, reason: string): Reading<T> => ({
  ok: true,
  value,
  code: null,
  reason,
})

export interface CatalogItemDraft {
  readonly itemId: string
  readonly environmentId: string
  readonly kind: unknown
  readonly name: unknown
  readonly at: string
}

/**
 * Validate one catalog item before it enters the journal.
 *
 * `itemKind` arrives as `unknown` on purpose. A caller is untrusted input, and typing
 * it as `CatalogItemKind` would let the compiler reject `kind: 'treasury'` before this
 * function ever saw it — which is exactly the case worth testing.
 */
export function readCatalogItem(input: unknown): Reading<CatalogItem> {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>

  if (!isCatalogItemKind(raw.kind)) {
    return BAD(
      'item-count-exceeded',
      `An item kind must be one of ${CATALOG_ITEM_KINDS.join(', ')}. An unknown kind is refused rather than defaulted.`,
    )
  }
  if (typeof raw.itemId !== 'string' || raw.itemId.length === 0) {
    return BAD('item-count-exceeded', 'A catalog item must have an id.')
  }
  if (typeof raw.environmentId !== 'string' || raw.environmentId.length === 0) {
    return BAD('environment-unknown', 'A catalog item must name the environment it belongs to.')
  }
  if (typeof raw.name !== 'string' || raw.name.trim().length === 0) {
    return BAD('item-count-exceeded', 'A catalog item must have a name the owner will recognise.')
  }
  if (raw.name.length > ENTERPRISE_LIMITS.maxTitleLength) {
    return BAD('item-count-exceeded', 'That item name is longer than the bounded length.')
  }
  if (raw.name.length > ENTERPRISE_LIMITS.maxPayloadTextLength) {
    return BAD(
      'item-count-exceeded',
      'An item name also appears in journal payloads, so it is held to the shorter journal bound.',
    )
  }
  if (!Number.isFinite(Date.parse(raw.at as string))) {
    return BAD('item-count-exceeded', 'A catalog item needs a trustworthy creation instant.')
  }

  const at = raw.at as string
  return GOOD<CatalogItem>(
    Object.freeze({
      itemId: raw.itemId,
      environmentId: raw.environmentId,
      kind: raw.kind,
      name: raw.name,
      state: 'draft',
      createdAt: at,
      updatedAt: at,
      completedAt: null,
    }),
    'The item is a bounded project, product or service with a name the owner chose.',
  )
}

/** May one more item be added to an environment that already holds `current`? */
export function mayAddCatalogItem(current: number): Reading<number> {
  if (current >= ENTERPRISE_LIMITS.maxCatalogItemsPerEnvironment) {
    return BAD(
      'item-count-exceeded',
      `This environment already holds its ceiling of ${String(ENTERPRISE_LIMITS.maxCatalogItemsPerEnvironment)} catalog items.`,
    )
  }
  return GOOD(current + 1, `${String(current + 1)} of ${String(ENTERPRISE_LIMITS.maxCatalogItemsPerEnvironment)} catalog items are in use.`)
}

/**
 * Which catalog kinds an environment kind may hold.
 *
 * A constraint rather than a fact: a `content` environment holding a `service` is not
 * obviously wrong, but a `webzone` environment holding nothing but services is a
 * website that sells nothing, and refusing the combination is cheaper than letting a
 * business be configured into a shape that cannot work.
 */
export const CATALOG_KINDS_BY_ENVIRONMENT: Readonly<Record<string, readonly CatalogItemKind[]>> =
  Object.freeze({
    webzone: Object.freeze<CatalogItemKind[]>(['project', 'product', 'service']),
    marketplace: Object.freeze<CatalogItemKind[]>(['project', 'product', 'service']),
    service: Object.freeze<CatalogItemKind[]>(['project', 'product', 'service']),
    // A content environment publishes; it does not deliver a service. Allowing one
    // would let a business be configured into a shape that cannot work.
    content: Object.freeze<CatalogItemKind[]>(['project', 'product']),
  })

/* -------------------------------------------------------------- customers */

/**
 * Collapse a string to the form the content filter matches on.
 *
 * Lower-cased with separators removed, so `Card Number`, `card_number` and `CARD-NUMBER`
 * are all the same word. A filter that matched only the exact token would be defeated
 * by adding a space, which is not an adversary anyone should have to be.
 */
function normaliseForContentCheck(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Does this customer field contain something it must not?
 *
 * Checks the normalised whole string against each forbidden word as a substring, so
 * `my card number is` and `acct-4481` both trip it. Substring matching in this
 * direction is the safe direction to be wrong in: a false positive costs the owner a
 * renamed field, and a false negative costs somebody their bank details.
 */
/**
 * Does this value contain a long digit run?
 *
 * Split out because it is the one check that catches a payment detail with no word in
 * it at all: `4111 1111 1111 1111` is mostly digits and matches nothing a word list
 * could match. The digit count ignores spaces and hyphens, since grouping is purely a
 * rendering choice, and the bound is 12–19 because that is the range real card numbers
 * occupy — a shorter customer reference is legitimate and refusing it would be a false
 * positive that teaches people to route around the filter.
 */
export function hasLongDigitRun(value: string): boolean {
  let digits = 0
  let longest = 0
  for (const character of value) {
    if (character >= '0' && character <= '9') {
      digits += 1
      if (digits > longest) longest = digits
    } else if (character !== ' ' && character !== '-') {
      digits = 0
    }
  }
  return longest >= FORBIDDEN_CUSTOMER_DIGIT_RUN.minDigits && longest <= FORBIDDEN_CUSTOMER_DIGIT_RUN.maxDigits
}

export function customerValueIsClean(value: string): boolean {
  const normalised = normaliseForContentCheck(value)
  if (normalised.length === 0) return true
  for (const word of FORBIDDEN_CUSTOMER_VALUE_WORDS) {
    if (normalised.includes(normaliseForContentCheck(word))) return false
  }
  return !hasLongDigitRun(value)
}

export interface CustomerDraft {
  readonly customerId: string
  readonly environmentId: string
  readonly displayName: unknown
  readonly at: string
}

/**
 * Validate one customer record before it enters the journal.
 *
 * There is no optional contact field, no notes field and no history. That is not
 * missing functionality, it is the boundary: the moment a customer record can hold a
 * message history it is a mailbox, and a mailbox needs retention, deletion and export
 * semantics that this phase does not have and should not improvise.
 */
export function readCustomer(input: unknown): Reading<CustomerRecord> {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>

  if (typeof raw.customerId !== 'string' || raw.customerId.length === 0) {
    return BAD('customer-count-exceeded', 'A customer record must have an id.')
  }
  if (typeof raw.environmentId !== 'string' || raw.environmentId.length === 0) {
    return BAD('environment-unknown', 'A customer record must name the environment it belongs to.')
  }
  if (typeof raw.displayName !== 'string' || raw.displayName.trim().length === 0) {
    return BAD('customer-count-exceeded', 'A customer record must have a display name.')
  }
  if (raw.displayName.length > ENTERPRISE_LIMITS.maxCustomerNameLength) {
    return BAD(
      'customer-count-exceeded',
      `A customer display name is held to ${String(ENTERPRISE_LIMITS.maxCustomerNameLength)} characters. This is not a place for an address.`,
    )
  }
  if (!customerValueIsClean(raw.displayName)) {
    return BAD(
      'customer-count-exceeded',
      'That display name contains something that looks like a payment, bank or credential detail. Customer records do not hold those.',
    )
  }
  if (!Number.isFinite(Date.parse(raw.at as string))) {
    return BAD('customer-count-exceeded', 'A customer record needs a trustworthy creation instant.')
  }

  const at = raw.at as string
  return GOOD<CustomerRecord>(
    Object.freeze({
      customerId: raw.customerId,
      environmentId: raw.environmentId,
      displayName: raw.displayName,
      state: 'active',
      createdAt: at,
      updatedAt: at,
      withdrawnAt: null,
    }),
    'The customer is a bounded label and a state. No payment, credential or contact detail is held.',
  )
}

/** May one more customer be added to an environment that already holds `current`? */
export function mayAddCustomer(current: number): Reading<number> {
  if (current >= ENTERPRISE_LIMITS.maxCustomersPerEnvironment) {
    return BAD(
      'customer-count-exceeded',
      `This environment already holds its ceiling of ${String(ENTERPRISE_LIMITS.maxCustomersPerEnvironment)} customer records.`,
    )
  }
  return GOOD(
    current + 1,
    `${String(current + 1)} of ${String(ENTERPRISE_LIMITS.maxCustomersPerEnvironment)} customer records are in use.`,
  )
}

/**
 * May this customer record be written to at all?
 *
 * A withdrawn customer is refused, permanently. Withdrawal has to mean something: a
 * third party who asked to be forgotten and then reappears in a record the owner did
 * not notice is worse than a record that was never there, because the owner cannot
 * reason about what they are looking at.
 */
export function mayTouchCustomer(
  customer: CustomerRecord,
): Reading<CustomerRecord> {
  if (customer.state === 'withdrawn') {
    return BAD(
      'customer-withdrawn',
      'This customer record was withdrawn. A withdrawn record is not written to again.',
    )
  }
  return GOOD(customer, 'This customer record is still active.')
}

/** The closed states, exposed for exhaustive tests. */
export function catalogItemStates(): readonly CatalogItemState[] {
  return CATALOG_ITEM_STATES
}

export function customerStates(): readonly CustomerState[] {
  return CUSTOMER_STATES
}