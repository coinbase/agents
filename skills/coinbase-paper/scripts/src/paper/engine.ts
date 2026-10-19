// Pure paper-trading accounting. The simulator is an intentional local feature:
// it validates public market data itself because no remote operation owns
// these simulated fills. No filesystem, network or storage access here; the
// caller passes `now` (epoch milliseconds) explicitly.
import { createHash } from 'node:crypto';
import {
  UNIT,
  divRound,
  formatAmount,
  formatRatio,
  formatUnits,
  isMultiple,
  parseInputDecimal,
  parseStoredDecimal,
  toIncrement,
} from './decimal.ts';
import {
  EXTERNAL_QUOTE_MODEL_VERSION,
  EXTERNAL_QUOTE_NOTICE,
  ORDER_MODEL_VERSION,
  PAPER_MODEL_VERSION,
  PAPER_NOTICE,
  PaperError,
  type Account,
  type CancelMutation,
  type CancelResult,
  type ClosePositionInput,
  type EditOrderInput,
  type EquityMetadata,
  type FillResult,
  type InitialAccount,
  type Intent,
  type LedgerSnapshot,
  type LiquidityIndicator,
  type OrderEvent,
  type OrderEventType,
  type OrderInput,
  type OrderIntent,
  type LedgerMutation,
  type OrderMutation,
  type OrderReceipt,
  type OrderState,
  type OrderStatus,
  type PaperFill,
  type PlacementMarket,
  type Position,
  type ProductRules,
  type Receipt,
  type StopDirection,
  type StoredOrderType,
  type TimeInForce,
} from './types.ts';

export const MAX_BOOK_AGE_SECONDS = 60;
export const MAX_FUTURE_SKEW_SECONDS = 5;
export const MAX_FEE_BPS = '1000';
export const MAX_BOOK_LEVELS = 1000;
export const MAX_QUOTE_AGE_SECONDS = 86_400;
export const MAX_QUOTE_FUTURE_SKEW_SECONDS = 300;
export const EXTERNAL_SLIPPAGE_BPS = 10n;
/** Used when no listing is consulted; disclosed on every receipt that relies on them. */
export const ASSUMED_EQUITY_METADATA: EquityMetadata = Object.freeze({
  source: 'assumed',
  base_increment: '0.00001',
  quote_increment: '0.01',
  whole_shares: false,
});

const CURRENCY = /^[A-Z0-9]{2,10}$/;
const PRODUCT = /^[A-Z0-9]{1,15}-[A-Z0-9]{1,10}$/;
/** Equity tickers may contain dots (BRK.B); crypto product ids never do. */
export const EQUITY_PRODUCT = /^([A-Z][A-Z0-9.]{0,9})-(USD|USDC)$/;
const MAX_SOURCE_LENGTH = 300;
const SOURCE_URL = /^https:\/\/[\x21-\x7e]+$/;
const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const QUOTE_FIELDS = ['reference_price', 'price_source', 'price_as_of'] as const;
const UUID = /^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/;
const ACCOUNT_ID = /^(paper-)?([0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12})$/;
const TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;
const TRADE_KEYS = new Set(['request_id', 'account_id', 'product_id', 'side', 'base_size', 'quote_size', ...QUOTE_FIELDS]);
// Product flags the public product schema always returns; any true flag blocks a
// market fill. view_only is optional upstream.
const REQUIRED_FLAGS = ['is_disabled', 'trading_disabled', 'cancel_only', 'limit_only', 'post_only', 'auction_mode'] as const;
const OPTIONAL_FLAGS = ['view_only'] as const;
const FEE_DENOMINATOR = 10_000n;
const ROUNDING_NOTE =
  'buy notional and all fees round up to quote_increment; sell notional rounds down; partial-sell basis is pro rata (half-even)';
const MARK_SOURCE = 'best_bid_indicative_excluding_exit_fees';
const STALE_HINT = 'Retry the same command with the same client_order_id to use a fresh order book.';
const STATE_HINT = 'Stop and run coinbase-paper doctor; do not reinitialize or edit the account.';
const QUOTE_STALE_HINT = 'Nothing was placed and no order is kept. Get a current quote from a reputable source, show it to the user, and submit it as a new order with a new client_order_id. Never reuse an old quote or estimate a price.';
const EXTERNAL_ROUNDING_NOTE =
  'fill price = reference_price x (1 + slippage) rounded up to quote_increment for BUY, x (1 - slippage) rounded down for SELL; buy notional and all fees round up; sell notional rounds down; partial-sell basis is pro rata (half-even)';
const ASSUMED_METADATA_NOTE = 'Instrument details are ASSUMED (base_increment 0.00001, quote_increment 0.01): Coinbase\'s public listing is not searchable by ticker, so trading halts, fractionability and real increments were not checked.';
const LISTED_METADATA_NOTE = 'Instrument details came from the Coinbase public equity listing; the listing does not verify the supplied price.';
const EQUITY_UNPRICED = 'no keyless equity price; balance --refresh does not price equities (they are priced only at order time, from a supplied quote)';

interface Level {
  price: bigint;
  size: bigint;
}

interface Book {
  product_id: string;
  time: string;
  timeMs: number;
  bids: Level[];
  asks: Level[];
}

interface Product {
  base_increment: bigint;
  quote_increment: bigint;
  base_min_size: bigint;
  base_max_size: bigint;
  quote_min_size: bigint;
  quote_max_size: bigint;
}

interface ParsedAccount {
  account_id: string;
  currency: string;
  cash: bigint;
  realized_pnl: bigint;
  initial_cash: bigint;
  fee_bps: bigint;
  maker_fee_bps: bigint;
  taker_fee_bps: bigint;
  quote_increment: bigint | null;
}

/** Amounts already reserved by open orders; a new market order cannot spend them. */
interface Reserved {
  cash: bigint;
  base: bigint;
}

const NO_HOLDS: Reserved = Object.freeze({ cash: 0n, base: 0n });

interface ParsedPosition {
  product_id: string;
  quantity: bigint;
  cost_basis: bigint;
  base_increment: bigint;
  quote_increment: bigint;
  equity: boolean;
}

export interface MarkedPosition {
  product_id: string;
  quantity: string;
  cost_basis: string;
  average_cost: string;
  mark: string | null;
  market_value: string | null;
  unrealized_pnl: string | null;
  mark_status: 'FRESH' | 'STALE' | 'FUTURE' | 'MISSING' | 'INVALID';
  mark_time: string | null;
  mark_source: string;
  asset_class?: 'EQUITY';
  unpriced_reason?: string;
}

export interface PortfolioMark {
  mode: 'PAPER';
  ok: true;
  account_id: string;
  currency: string;
  initial_cash: string;
  cash: string;
  fee_bps: string;
  realized_pnl: string;
  unrealized_pnl: string | null;
  total_pnl: string | null;
  equity: string | null;
  priced: boolean;
  positions: MarkedPosition[];
  /** Present only when a refresh found equity positions, which are never marked. */
  priced_market_value?: string;
  priced_unrealized_pnl?: string;
  unpriced_positions?: Array<{ product_id: string; quantity: string; unpriced_reason: string }>;
  notice: string;
}

/** Plain JSON-like object with only own, enumerable data properties. */
function plainObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  if (Object.getOwnPropertySymbols(value).length > 0) return null;
  for (const name of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return null;
  }
  return value as Record<string, unknown>;
}

function field(object: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

function requestError(message: string): PaperError {
  return new PaperError('INVALID_REQUEST', message);
}

function stateError(message: string): PaperError {
  return new PaperError('STATE_INVALID', `paper state ${message}`, STATE_HINT);
}

function checkNow(now: number): void {
  if (typeof now !== 'number' || !Number.isSafeInteger(now) || now < 0) {
    throw new PaperError('INVALID_ARGUMENT', 'now must be epoch milliseconds');
  }
}

function parseFeeBps(value: unknown, field: string): bigint {
  const fee = parseInputDecimal(value, field, true);
  if (fee > parseInputDecimal(MAX_FEE_BPS, 'max fee') || fee % (UNIT / 10_000n) !== 0n) {
    throw new PaperError('INVALID_ARGUMENT', `${field} must be 0-1000 with at most 4 decimals`);
  }
  return fee;
}

// ------------------------------------------------------------------ inputs

export function normalizeIntent(input: unknown): Intent {
  const request = plainObject(input);
  if (!request) throw requestError('trade request must be a plain object');
  if (Object.keys(request).some((key) => !TRADE_KEYS.has(key))) {
    throw requestError('unknown trade fields; use only request_id, account_id, product_id, side and one size');
  }
  const trade = normalizeTrade(request, { allowSellQuote: false, sizeOptional: false });
  return trade as Intent;
}

interface TradeTerms {
  request_id: string;
  account_id: string;
  product_id: string;
  side: 'BUY' | 'SELL';
  size_type: 'base_size' | 'quote_size' | null;
  size: string | null;
  reference_price?: string;
  price_source?: string;
  price_as_of?: string;
}

function normalizeTrade(request: Record<string, unknown>, options: { allowSellQuote: boolean; sizeOptional: boolean }): TradeTerms {
  const requestId = request.request_id;
  if (typeof requestId !== 'string' || !UUID.test(requestId)) {
    throw requestError('client_order_id must be a UUID string');
  }
  const accountId = request.account_id;
  const accountMatch = typeof accountId === 'string' ? ACCOUNT_ID.exec(accountId) : null;
  if (!accountMatch) throw requestError('account_id must be the paper account UUID');
  const productId = request.product_id;
  if (typeof productId !== 'string' || !(PRODUCT.test(productId) || EQUITY_PRODUCT.test(productId))) {
    throw requestError('product_id must look like BTC-USD (crypto) or AAPL-USD (equity)');
  }
  const side = request.side;
  if (side !== 'BUY' && side !== 'SELL') throw requestError('side must be BUY or SELL');
  // An undefined size is an omitted optional field, not a second size.
  const sizes = (['base_size', 'quote_size'] as const).filter((key) => request[key] !== undefined);
  if (sizes.length > 1 || (sizes.length === 0 && !options.sizeOptional)) throw requestError('use exactly one of base_size or quote_size');
  const sizeType = sizes.length === 1 ? sizes[0] : null;
  if (side === 'SELL' && sizeType === 'quote_size' && !options.allowSellQuote) throw requestError('SELL requires base_size');
  const trade: TradeTerms = {
    request_id: requestId.toLowerCase(),
    account_id: `${accountMatch[1] ?? ''}${accountMatch[2].toLowerCase()}`,
    product_id: productId,
    side,
    size_type: sizeType,
    size: sizeType === null ? null : formatUnits(parseInputDecimal(request[sizeType], sizeType)),
  };
  const quoted = QUOTE_FIELDS.filter((key) => request[key] !== undefined);
  if (quoted.length === 0) return trade;
  if (quoted.length !== QUOTE_FIELDS.length) {
    throw new PaperError(
      'EXTERNAL_QUOTE_REQUIRED',
      'reference_price, price_source and price_as_of must be passed together',
      'Pass all three from one current quote (price, its https source URL and the quote time in UTC), or none for a crypto order.',
    );
  }
  // Syntax only: freshness is checked against the clock at fill time, never at reservation.
  return { ...trade, ...parseExternalQuote(request.reference_price, request.price_source, request.price_as_of) };
}

function parseExternalQuote(price: unknown, source: unknown, asOf: unknown): Pick<Intent, 'reference_price' | 'price_source' | 'price_as_of'> {
  const reference = parseInputDecimal(price, 'reference_price');
  if (typeof source !== 'string' || source.length > MAX_SOURCE_LENGTH || !SOURCE_URL.test(source)) {
    throw requestError(`price_source must be the https URL of the quote (at most ${MAX_SOURCE_LENGTH} characters)`);
  }
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw requestError('price_source is not a valid https URL');
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hostname === '') {
    throw requestError('price_source must be an https URL without credentials');
  }
  if (typeof asOf !== 'string' || !UTC_TIME.test(asOf)) {
    throw requestError('price_as_of must be the quote time as an ISO-8601 UTC timestamp such as 2026-01-15T15:30:00Z');
  }
  try {
    parseTime(asOf, 'price_as_of');
  } catch {
    throw requestError('price_as_of is not a valid UTC date and time');
  }
  return { reference_price: formatUnits(reference), price_source: source, price_as_of: asOf };
}

function hasQuote(intent: Intent): boolean {
  return intent.reference_price !== undefined;
}

/**
 * Checks an external quote's time against `now`; returns its age in whole seconds
 * (negative within the allowed future skew).
 */
export function checkExternalFresh(asOf: string, now: number): number {
  checkNow(now);
  const ms = parseTime(asOf, 'price_as_of');
  const age = now - ms;
  if (age > MAX_QUOTE_AGE_SECONDS * 1000) {
    throw new PaperError('EXTERNAL_QUOTE_STALE', `quote is ${Math.floor(age / 1000)}s old; maximum is ${MAX_QUOTE_AGE_SECONDS}s (24 h)`, QUOTE_STALE_HINT);
  }
  if (age < -MAX_QUOTE_FUTURE_SKEW_SECONDS * 1000) {
    throw new PaperError('EXTERNAL_QUOTE_STALE', `quote time is ${Math.floor(-age / 1000)}s in the future; maximum skew is ${MAX_QUOTE_FUTURE_SKEW_SECONDS}s`, `Check that price_as_of is the quote's own time in UTC and check the local clock. ${QUOTE_STALE_HINT}`);
  }
  return Math.trunc(age / 1000);
}

/**
 * Instrument details for an equity from a public equity listing response
 * ({products:[...]}), matched by ticker and quote currency. Pass null when no
 * listing was consulted: the result is the labeled assumption. A matched entry
 * that is malformed, halted or disabled fails; it never falls back to assumptions.
 */
export function resolveEquityMetadata(listing: unknown, productId: string): EquityMetadata {
  const match = EQUITY_PRODUCT.exec(productId);
  if (!match) throw requestError('equity product_id must look like AAPL-USD (ticker, then USD or USDC)');
  if (listing === null) return { ...ASSUMED_EQUITY_METADATA };
  const response = plainObject(listing);
  const products = response ? field(response, 'products') : undefined;
  if (!Array.isArray(products)) throw new PaperError('INVALID_PRODUCT', 'equity listing must contain a products list');
  const [, ticker, quote] = match;
  const found = products.filter((raw) => {
    const item = plainObject(raw);
    const details = item ? plainObject(field(item, 'equity_product_details')) : null;
    return item !== null && details !== null && field(details, 'ticker') === ticker && field(item, 'quote_currency_id') === quote;
  }) as Array<Record<string, unknown>>;
  if (found.length === 0) return { ...ASSUMED_EQUITY_METADATA };
  if (found.length > 1) throw new PaperError('INVALID_PRODUCT', `equity listing has ${found.length} entries for ${productId}`);
  const item = found[0];
  const details = plainObject(field(item, 'equity_product_details')) as Record<string, unknown>;
  if (field(item, 'product_type') !== 'EQUITY') throw new PaperError('INVALID_PRODUCT', 'listed product is not an equity');
  const flag = (object: Record<string, unknown>, key: string) => {
    const value = field(object, key);
    if (typeof value !== 'boolean') throw new PaperError('INVALID_PRODUCT', `equity listing ${key} must be a boolean`);
    return value;
  };
  for (const key of ['is_disabled', 'trading_disabled', 'cancel_only', 'limit_only', 'post_only', 'auction_mode']) {
    if (flag(item, key)) throw new PaperError('PRODUCT_UNAVAILABLE', `listed equity is ${key}`, 'Do not place this order; tell the user the listing is not open for market orders.');
  }
  if (flag(details, 'trading_halted')) throw new PaperError('PRODUCT_UNAVAILABLE', 'listed equity trading is halted', 'Do not place this order; tell the user trading in this equity is halted.');
  const fractionable = flag(details, 'fractionable');
  const amount = (key: string) => {
    try {
      return parseInputDecimal(field(item, key), `listing ${key}`);
    } catch (error) {
      if (error instanceof PaperError) throw new PaperError('INVALID_PRODUCT', error.message);
      throw error;
    }
  };
  const baseInc = amount('base_increment');
  const quoteInc = amount('quote_increment');
  return {
    source: 'coinbase-public-listing',
    base_increment: formatUnits(fractionable ? baseInc : UNIT),
    quote_increment: formatUnits(quoteInc),
    whole_shares: !fractionable,
  };
}

function parseEquityMetadata(value: unknown): { source: EquityMetadata['source']; base: bigint; quote: bigint; whole: boolean } {
  const meta = plainObject(value);
  const source = meta ? field(meta, 'source') : undefined;
  const whole = meta ? field(meta, 'whole_shares') : undefined;
  if (!meta || (source !== 'assumed' && source !== 'coinbase-public-listing') || typeof whole !== 'boolean') {
    throw new PaperError('INVALID_ARGUMENT', 'equity metadata must come from resolveEquityMetadata');
  }
  const base = parseInputDecimal(field(meta, 'base_increment'), 'equity base_increment');
  const quote = parseInputDecimal(field(meta, 'quote_increment'), 'equity quote_increment');
  if (whole && base % UNIT !== 0n) throw new PaperError('INVALID_ARGUMENT', 'whole-share metadata needs a whole base_increment');
  return { source, base, quote, whole };
}

/**
 * Validates init settings. Without separate maker/taker rates both equal fee_bps;
 * fee_bps is returned as the deprecated alias of the taker rate.
 */
export function validateInitialAccount(cash: unknown, currency: unknown, feeBps: unknown, makerFeeBps?: unknown, takerFeeBps?: unknown): InitialAccount {
  const cashUnits = parseInputDecimal(cash, 'cash');
  if (typeof currency !== 'string' || !CURRENCY.test(currency)) {
    throw new PaperError('INVALID_ARGUMENT', 'currency must be an uppercase code such as USD');
  }
  const fee = parseFeeBps(feeBps, 'fee_bps');
  const maker = makerFeeBps === undefined ? fee : parseFeeBps(makerFeeBps, 'maker_fee_bps');
  const taker = takerFeeBps === undefined ? fee : parseFeeBps(takerFeeBps, 'taker_fee_bps');
  return { cash: formatUnits(cashUnits), currency, fee_bps: formatUnits(taker), maker_fee_bps: formatUnits(maker), taker_fee_bps: formatUnits(taker) };
}

function parseTime(value: unknown, what: string): number {
  const match = typeof value === 'string' ? TIME.exec(value) : null;
  if (!match) throw new PaperError('INVALID_BOOK', `${what} time must be an ISO-8601 timestamp with zone`);
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const millis = Number((match[7] ?? '').padEnd(3, '0').slice(0, 3));
  const base = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  const date = new Date(base);
  let offset = 0;
  if (match[8] !== 'Z') {
    const offsetHours = Number(match[8].slice(1, 3));
    const offsetMinutes = Number(match[8].slice(4, 6));
    if (offsetHours > 23 || offsetMinutes > 59) {
      throw new PaperError('INVALID_BOOK', `${what} time has an invalid zone offset`);
    }
    offset = (match[8][0] === '-' ? -1 : 1) * (offsetHours * 60 + offsetMinutes) * 60_000;
  }
  if (
    year < 1970 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new PaperError('INVALID_BOOK', `${what} time is not a valid date`);
  }
  return base - offset;
}

function freshness(snapshotMs: number, now: number): 'FRESH' | 'STALE' | 'FUTURE' {
  const age = now - snapshotMs;
  if (age > MAX_BOOK_AGE_SECONDS * 1000) return 'STALE';
  if (age < -MAX_FUTURE_SKEW_SECONDS * 1000) return 'FUTURE';
  return 'FRESH';
}

export function checkFresh(snapshotTime: string, now: number): void {
  checkNow(now);
  const snapshotMs = parseTime(snapshotTime, 'book');
  const state = freshness(snapshotMs, now);
  const seconds = (Math.abs(now - snapshotMs) / 1000).toFixed(1);
  if (state === 'STALE') {
    throw new PaperError('STALE_BOOK', `book is ${seconds}s old; maximum is ${MAX_BOOK_AGE_SECONDS}s`, STALE_HINT);
  }
  if (state === 'FUTURE') {
    throw new PaperError(
      'FUTURE_BOOK',
      `book time is ${seconds}s in the future; maximum skew is ${MAX_FUTURE_SKEW_SECONDS}s`,
      'Check the local clock, then retry the same command with the same client_order_id.',
    );
  }
}

function parseLevels(value: unknown, side: 'bids' | 'asks'): Level[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new PaperError('INVALID_BOOK', `book ${side} must be a non-empty list`);
  }
  if (value.length > MAX_BOOK_LEVELS) {
    throw new PaperError('INVALID_BOOK', `book ${side} exceeds ${MAX_BOOK_LEVELS} levels`);
  }
  const levels = value.map((raw) => {
    const level = plainObject(raw);
    if (!level) throw new PaperError('INVALID_BOOK', `book ${side} level must be an object`);
    return {
      price: parseInputDecimal(field(level, 'price'), `${side} price`),
      size: parseInputDecimal(field(level, 'size'), `${side} size`),
    };
  });
  for (let i = 1; i < levels.length; i++) {
    const ordered = side === 'bids' ? levels[i].price < levels[i - 1].price : levels[i].price > levels[i - 1].price;
    if (!ordered) throw new PaperError('INVALID_BOOK', `book ${side} are not strictly ordered`);
  }
  return levels;
}

function parseBook(raw: unknown, productId: string): Book {
  const response = plainObject(raw);
  const pricebook = response ? plainObject(field(response, 'pricebook')) : null;
  if (!pricebook) throw new PaperError('INVALID_BOOK', 'book must contain a pricebook object');
  const bookProduct = field(pricebook, 'product_id');
  if (typeof bookProduct !== 'string' || !PRODUCT.test(bookProduct)) {
    throw new PaperError('INVALID_BOOK', 'pricebook.product_id is missing or invalid');
  }
  if (bookProduct !== productId) throw new PaperError('PRODUCT_MISMATCH', 'book product_id does not match the request');
  const time = field(pricebook, 'time');
  const timeMs = parseTime(time, 'pricebook');
  const bids = parseLevels(field(pricebook, 'bids'), 'bids');
  const asks = parseLevels(field(pricebook, 'asks'), 'asks');
  if (bids[0].price >= asks[0].price) throw new PaperError('INVALID_BOOK', 'book is crossed or locked');
  return { product_id: bookProduct, time: time as string, timeMs, bids, asks };
}

/** Which order kind a product's trading flags must admit. */
type ProductUse = 'market' | 'limit' | 'post_only_limit' | 'conditional';

function parseProduct(raw: unknown, productId: string, currency: string, use: ProductUse = 'market'): Product {
  const product = plainObject(raw);
  if (!product) throw new PaperError('INVALID_PRODUCT', 'product metadata must be an object');
  if (field(product, 'product_id') !== productId) {
    throw new PaperError('PRODUCT_MISMATCH', 'product metadata does not match product_id');
  }
  if (field(product, 'product_type') !== 'SPOT') {
    throw new PaperError('UNSUPPORTED_PRODUCT', 'only crypto SPOT products are supported', 'Choose a crypto spot product such as BTC-USD.');
  }
  const base = field(product, 'base_currency_id');
  const quote = field(product, 'quote_currency_id');
  if (typeof base !== 'string' || typeof quote !== 'string' || `${base}-${quote}` !== productId) {
    throw new PaperError('PRODUCT_MISMATCH', 'product base/quote currencies do not match product_id');
  }
  if (quote !== currency) {
    throw new PaperError(
      'CURRENCY_MISMATCH',
      `product quote ${quote} is not account currency ${currency}`,
      `Choose a product quoted in ${currency}.`,
    );
  }
  for (const flag of [...REQUIRED_FLAGS, ...OPTIONAL_FLAGS]) {
    const value = field(product, flag);
    if (value === undefined && (OPTIONAL_FLAGS as readonly string[]).includes(flag)) continue;
    if (typeof value !== 'boolean') throw new PaperError('INVALID_PRODUCT', `product ${flag} must be a boolean`);
    if (!value) continue;
    if (flag === 'limit_only' && (use === 'limit' || use === 'post_only_limit')) continue;
    if (flag === 'post_only' && use === 'post_only_limit') continue;
    throw new PaperError('PRODUCT_UNAVAILABLE', `product is ${flag}`, flag === 'limit_only' || flag === 'post_only'
      ? `This product accepts only ${flag === 'post_only' ? 'type=limit post_only=true' : 'limit'} orders; place that order type with a new client_order_id, or choose another product.`
      : 'Choose a product that is open for market orders.');
  }
  const status = field(product, 'status');
  if (typeof status !== 'string') throw new PaperError('INVALID_PRODUCT', 'product status is missing');
  if (status.toLowerCase() !== 'online') {
    throw new PaperError('PRODUCT_UNAVAILABLE', 'product status is not online', 'Choose a product that is open for market orders.');
  }
  const amount = (key: string, allowZero: boolean) => {
    try {
      return parseInputDecimal(field(product, key), `product ${key}`, allowZero);
    } catch (error) {
      if (error instanceof PaperError) throw new PaperError('INVALID_PRODUCT', error.message);
      throw error;
    }
  };
  const parsed: Product = {
    base_increment: amount('base_increment', false),
    quote_increment: amount('quote_increment', false),
    base_min_size: amount('base_min_size', true),
    base_max_size: amount('base_max_size', false),
    quote_min_size: amount('quote_min_size', true),
    quote_max_size: amount('quote_max_size', false),
  };
  if (parsed.base_min_size > parsed.base_max_size || parsed.quote_min_size > parsed.quote_max_size) {
    throw new PaperError('INVALID_PRODUCT', 'product minimum size exceeds maximum size');
  }
  return parsed;
}

function parseAccount(account: Account): ParsedAccount {
  const value = plainObject(account);
  if (!value) throw stateError('account is not an object');
  const accountId = field(value, 'account_id');
  if (typeof accountId !== 'string' || !ACCOUNT_ID.test(accountId)) throw stateError('account_id is invalid');
  const currency = field(value, 'currency');
  if (typeof currency !== 'string' || !CURRENCY.test(currency)) throw stateError('currency is invalid');
  const fee = (key: string, fallback?: bigint) => {
    const raw = field(value, key);
    if (raw === undefined && fallback !== undefined) return fallback;
    try {
      return parseFeeBps(raw, key);
    } catch {
      throw stateError(`${key} is invalid`);
    }
  };
  const feeBps = fee('fee_bps');
  const increment = field(value, 'quote_increment');
  return {
    account_id: accountId,
    currency,
    cash: parseStoredDecimal(field(value, 'cash'), 'cash'),
    realized_pnl: parseStoredDecimal(field(value, 'realized_pnl'), 'realized_pnl', { allowNegative: true }),
    initial_cash: parseStoredDecimal(field(value, 'initial_cash'), 'initial_cash', { allowZero: false }),
    fee_bps: feeBps,
    maker_fee_bps: fee('maker_fee_bps', feeBps),
    taker_fee_bps: fee('taker_fee_bps', feeBps),
    quote_increment:
      increment === null ? null : parseStoredDecimal(increment, 'quote_increment', { allowZero: false }),
  };
}

function parsePosition(position: Position): ParsedPosition {
  const value = plainObject(position);
  if (!value) throw stateError('position is not an object');
  const productId = field(value, 'product_id');
  const assetClass = field(value, 'asset_class');
  if (assetClass !== undefined && assetClass !== 'EQUITY') throw stateError('position asset_class is invalid');
  const equity = assetClass === 'EQUITY';
  if (typeof productId !== 'string' || !(equity ? EQUITY_PRODUCT : PRODUCT).test(productId)) throw stateError('position product_id is invalid');
  return {
    product_id: productId,
    equity,
    quantity: parseStoredDecimal(field(value, 'quantity'), 'position quantity', { allowZero: false }),
    cost_basis: parseStoredDecimal(field(value, 'cost_basis'), 'position cost_basis'),
    base_increment: parseStoredDecimal(field(value, 'base_increment'), 'position base_increment', { allowZero: false }),
    quote_increment: parseStoredDecimal(field(value, 'quote_increment'), 'position quote_increment', { allowZero: false }),
  };
}

// ------------------------------------------------------------------- fills

interface Walk {
  /** Exact notional in units * UNIT (price units x size units). */
  raw: bigint;
  fills: Array<{ price: string; size: string }>;
}

function walk(levels: Level[], quantity: bigint): Walk {
  let remaining = quantity;
  let raw = 0n;
  const fills: Walk['fills'] = [];
  for (const level of levels) {
    if (remaining <= 0n) break;
    const take = level.size < remaining ? level.size : remaining;
    raw += level.price * take;
    remaining -= take;
    fills.push({ price: formatUnits(level.price), size: formatUnits(take) });
  }
  if (remaining > 0n) {
    throw new PaperError(
      'INSUFFICIENT_LIQUIDITY',
      'order book snapshot depth cannot fill the whole order',
      'Use a smaller size; the simulator does not partially fill.',
    );
  }
  return { raw, fills };
}

function feeFor(notional: bigint, feeBps: bigint, quoteIncrement: bigint): bigint {
  return toIncrement(notional * feeBps, UNIT * FEE_DENOMINATOR, quoteIncrement, 'ceil');
}

function buyCost(asks: Level[], quantity: bigint, feeBps: bigint, quoteIncrement: bigint) {
  const filled = walk(asks, quantity);
  const notional = toIncrement(filled.raw, UNIT, quoteIncrement, 'ceil');
  return { ...filled, notional, fee: feeFor(notional, feeBps, quoteIncrement) };
}

/** Largest base-increment quantity whose rounded notional plus fee fits the budget. */
function sizeQuoteBuy(asks: Level[], budget: bigint, feeBps: bigint, product: Product): bigint {
  const step = product.base_increment;
  const depth = asks.reduce((sum, level) => sum + level.size, 0n);
  const top = depth / step;
  const total = (steps: bigint) => {
    const cost = buyCost(asks, steps * step, feeBps, product.quote_increment);
    return cost.notional + cost.fee;
  };
  // A budget the visible depth cannot exhaust would buy less than requested.
  if (top < 1n || total(top) < budget) {
    throw new PaperError(
      'INSUFFICIENT_LIQUIDITY',
      'order book snapshot depth cannot cover quote_size',
      'Use a smaller quote_size; the simulator does not partially fill.',
    );
  }
  return largestSteps(top, budget, total) * step;
}

/** Largest step count in [1, top] whose monotonic total fits the budget. */
function largestSteps(top: bigint, budget: bigint, total: (steps: bigint) => bigint): bigint {
  let low = 0n;
  let high = top;
  while (low < high) {
    const middle = (low + high + 1n) / 2n;
    if (total(middle) <= budget) low = middle;
    else high = middle - 1n;
  }
  if (low < 1n) {
    throw new PaperError('BELOW_MINIMUM', 'quote_size cannot buy one base increment including fees', 'If the user wants a larger quote_size, place it as a new order with a new client_order_id.');
  }
  return low;
}

/** Error for an order that Coinbase lists no crypto product for and that carries no external quote. */
export function externalQuoteRequired(productId: string): PaperError {
  return new PaperError(
    'EXTERNAL_QUOTE_REQUIRED',
    `${productId} is not a Coinbase crypto product; an equity paper order needs reference_price, price_source and price_as_of`,
    'If you meant a crypto product, check the product_id: Coinbase lists no crypto product with this ID. Coinbase\'s public API does not publish equity prices. For a stock, look up a current quote from a reputable source (exchange, broker or major finance site), show the user the price, source URL and quote time, then place the order with reference_price, price_source (https URL) and price_as_of (the quote\'s own UTC time) and a new client_order_id. If no current quote is available, do not trade; never invent or estimate a price.',
  );
}

export function referenceOnCrypto(): PaperError {
  return new PaperError(
    'REFERENCE_PRICE_NOT_ALLOWED',
    'reference_price, price_source and price_as_of are only for equities; crypto orders always fill against a fresh Coinbase order book',
    'This product_id is a listed Coinbase crypto product. Remove the three quote fields and place the order with a new client_order_id; never price crypto from an external quote. If the user meant a stock whose ticker matches this crypto product, it cannot be paper-traded; tell the user.',
  );
}

export function classConflict(productId: string, held: string, requested: string): PaperError {
  return new PaperError(
    'PRODUCT_CLASS_CONFLICT',
    `${productId} is held as ${held} position; it cannot be traded as ${requested} product`,
    'Stop and run coinbase-paper balance; do not retry with different fields.',
  );
}

/** Basis removed when selling `base` of a position; the whole basis for a full exit. */
function removedBasis(heldBasis: bigint, heldQty: bigint, base: bigint, quoteInc: bigint): bigint {
  if (base === heldQty) return heldBasis;
  const removed = toIncrement(heldBasis * base, heldQty, quoteInc, 'half_even');
  return removed > heldBasis ? heldBasis : removed;
}

/** INSUFFICIENT_CASH with exact figures; `hold` is cash reserved by open orders. */
export function insufficientCash(cash: bigint, hold: bigint, required: bigint, currency: string, increment: bigint | null): PaperError {
  const available = cash - hold;
  const show = (units: bigint) => formatAmount(units, increment);
  const shortfall = required - available;
  return new PaperError(
    'INSUFFICIENT_CASH',
    `Insufficient paper cash: available ${show(available)} ${currency}; required ${show(required)} ${currency}; shortfall ${show(shortfall)} ${currency}.`,
    'Run coinbase-paper balance to see cash and holds. Paper cash is never reseeded. If the user wants it, place an explicitly smaller order with a new client_order_id, or cancel a named open order first; never resize automatically.',
    { currency, available: show(available), required: show(required), shortfall: show(shortfall), hold: show(hold) },
  );
}

/** INSUFFICIENT_HOLDINGS with exact figures; `hold` is base reserved by open sell orders. */
export function insufficientHoldings(productId: string, quantity: bigint, hold: bigint, required: bigint, increment: bigint | null): PaperError {
  const available = quantity - hold;
  const show = (units: bigint) => formatAmount(units, increment);
  return new PaperError(
    'INSUFFICIENT_HOLDINGS',
    `Insufficient ${productId} holdings: available ${show(available)}; required ${show(required)}; shortfall ${show(required - available)}; held by open orders ${show(hold)}.`,
    'Run coinbase-paper balance to see holdings and holds. Sell an explicitly smaller size with a new client_order_id, or cancel a named open order first.',
    { product_id: productId, available: show(available), required: show(required), shortfall: show(required - available), hold: show(hold) },
  );
}

function checkLimits(product: Product, base: bigint, notional: bigint): void {
  if (base < product.base_min_size) throw new PaperError('BELOW_MINIMUM', 'base size is below product base_min_size', 'If the user wants a larger size, place it as a new order with a new client_order_id.');
  if (base > product.base_max_size) throw new PaperError('ABOVE_MAXIMUM', 'base size exceeds product base_max_size', 'If the user wants a smaller size, place it as a new order with a new client_order_id.');
  if (notional < product.quote_min_size) throw new PaperError('BELOW_MINIMUM', 'notional is below product quote_min_size', 'If the user wants a larger size, place it as a new order with a new client_order_id.');
  if (notional > product.quote_max_size) throw new PaperError('ABOVE_MAXIMUM', 'notional exceeds product quote_max_size', 'If the user wants a smaller size, place it as a new order with a new client_order_id.');
}

function sameIntent(intent: Intent): Intent {
  const value = plainObject(intent);
  if (!value) throw requestError('intent must be a plain object');
  const sizeType = field(value, 'size_type');
  if (sizeType !== 'base_size' && sizeType !== 'quote_size') throw requestError('intent size_type is invalid');
  const input: Record<string, unknown> = {
    request_id: field(value, 'request_id'),
    account_id: field(value, 'account_id'),
    product_id: field(value, 'product_id'),
    side: field(value, 'side'),
    [sizeType]: field(value, 'size'),
  };
  for (const key of QUOTE_FIELDS) input[key] = field(value, key);
  const normalized = normalizeIntent(input);
  const keys = Object.keys(value);
  if (
    keys.length !== Object.keys(normalized).length ||
    (Object.keys(normalized) as Array<keyof Intent>).some((key) => normalized[key] !== value[key])
  ) {
    throw requestError('intent is not normalized; pass the output of normalizeIntent');
  }
  return normalized;
}

export function simulate(
  account: Account,
  position: Position | null,
  intent: Intent,
  product: unknown,
  book: unknown,
  now: number,
): FillResult {
  return simulateMarket(account, position, intent, product, book, now, NO_HOLDS);
}

function simulateMarket(
  account: Account,
  position: Position | null,
  intent: Intent,
  product: unknown,
  book: unknown,
  now: number,
  reserved: Reserved,
): FillResult {
  checkNow(now);
  const terms = sameIntent(intent);
  if (hasQuote(terms)) throw referenceOnCrypto();
  const acct = parseAccount(account);
  if (terms.account_id !== acct.account_id) {
    throw new PaperError('ACCOUNT_MISMATCH', 'intent account_id does not match the paper account', STATE_HINT);
  }
  const held = position === null ? null : parsePosition(position);
  if (held && held.product_id !== terms.product_id) throw stateError('position does not match the intent product');
  if (held?.equity) throw classConflict(terms.product_id, 'an equity', 'a crypto');
  const limits = parseProduct(product, terms.product_id, acct.currency);
  const snapshot = parseBook(book, terms.product_id);
  checkFresh(snapshot.time, now);

  const baseInc = limits.base_increment;
  const quoteInc = limits.quote_increment;
  const heldQty = held?.quantity ?? 0n;
  const heldBasis = held?.cost_basis ?? 0n;
  const size = parseInputDecimal(terms.size, terms.size_type);
  let base: bigint;
  let notional: bigint;
  let fee: bigint;
  let total: bigint;
  let filled: Walk;
  let realized: bigint | null = null;
  let cash: bigint;
  let quantity: bigint;
  let basis: bigint;

  if (terms.side === 'BUY') {
    if (terms.size_type === 'quote_size') {
      if (!isMultiple(size, quoteInc)) {
        throw new PaperError('INVALID_INCREMENT', 'quote_size is not a multiple of product quote_increment');
      }
      if (size > acct.cash - reserved.cash) throw insufficientCash(acct.cash, reserved.cash, size, acct.currency, quoteInc);
      base = sizeQuoteBuy(snapshot.asks, size, acct.taker_fee_bps, limits);
    } else {
      if (!isMultiple(size, baseInc)) {
        throw new PaperError('INVALID_INCREMENT', 'base_size is not a multiple of product base_increment');
      }
      base = size;
    }
    const cost = buyCost(snapshot.asks, base, acct.taker_fee_bps, quoteInc);
    ({ notional, fee } = cost);
    filled = cost;
    checkLimits(limits, base, notional);
    total = notional + fee;
    if (total > acct.cash - reserved.cash) throw insufficientCash(acct.cash, reserved.cash, total, acct.currency, quoteInc);
    cash = acct.cash - total;
    quantity = heldQty + base;
    basis = heldBasis + total;
  } else {
    base = size;
    if (base > heldQty - reserved.base) throw insufficientHoldings(terms.product_id, heldQty, reserved.base, base, baseInc);
    // Selling the whole position may include sub-increment dust.
    if (base !== heldQty && !isMultiple(base, baseInc)) {
      throw new PaperError('INVALID_INCREMENT', 'base_size is not a multiple of product base_increment');
    }
    filled = walk(snapshot.bids, base);
    notional = toIncrement(filled.raw, UNIT, quoteInc, 'floor');
    checkLimits(limits, base, notional);
    fee = feeFor(notional, acct.taker_fee_bps, quoteInc);
    total = notional - fee;
    const removed = removedBasis(heldBasis, heldQty, base, quoteInc);
    realized = total - removed;
    cash = acct.cash + total;
    quantity = heldQty - base;
    basis = heldBasis - removed;
  }

  const receipt: Receipt = {
    mode: 'PAPER',
    ok: true,
    status: 'FILLED',
    request_id: terms.request_id,
    account_id: acct.account_id,
    product_id: terms.product_id,
    side: terms.side,
    order_type: 'MARKET',
    requested: { [terms.size_type]: terms.size },
    base_size: formatAmount(base, baseInc),
    notional: formatAmount(notional, quoteInc),
    fee: formatAmount(fee, quoteInc),
    total: formatAmount(total, quoteInc),
    average_price: formatRatio(filled.raw, base),
    realized_pnl: realized === null ? null : formatAmount(realized, quoteInc),
    cash: formatAmount(cash, quoteInc),
    position: { quantity: formatAmount(quantity, baseInc), cost_basis: formatAmount(basis, quoteInc) },
    currency: acct.currency,
    snapshot_time: snapshot.time,
    filled_at: new Date(now).toISOString(),
    fills: filled.fills,
    source: {
      best_bid: formatUnits(snapshot.bids[0].price),
      best_ask: formatUnits(snapshot.asks[0].price),
      product: Object.fromEntries(Object.entries(limits).map(([key, value]) => [key, formatUnits(value)])),
    },
    assumptions: {
      model_version: PAPER_MODEL_VERSION,
      fee_bps: formatUnits(acct.taker_fee_bps),
      rounding: ROUNDING_NOTE,
      max_book_age_seconds: MAX_BOOK_AGE_SECONDS,
      max_future_skew_seconds: MAX_FUTURE_SKEW_SECONDS,
    },
    notice: PAPER_NOTICE,
  };
  return {
    receipt,
    cash: formatUnits(cash),
    realized_pnl: formatUnits(acct.realized_pnl + (realized ?? 0n)),
    position: {
      product_id: terms.product_id,
      quantity: formatUnits(quantity),
      cost_basis: formatUnits(basis),
      base_increment: formatUnits(baseInc),
      quote_increment: formatUnits(quoteInc),
    },
  };
}

/**
 * Fills an equity order at its caller-supplied reference price with an assumed
 * slippage. `metadata` comes from resolveEquityMetadata. Nothing here verifies the
 * price; the receipt labels it UNVERIFIED_EXTERNAL_QUOTE.
 */
export function simulateExternal(
  account: Account,
  position: Position | null,
  intent: Intent,
  metadata: EquityMetadata,
  now: number,
): FillResult {
  return simulateQuoted(account, position, intent, metadata, now, NO_HOLDS);
}

function simulateQuoted(
  account: Account,
  position: Position | null,
  intent: Intent,
  metadata: EquityMetadata,
  now: number,
  reserved: Reserved,
): FillResult {
  checkNow(now);
  const terms = sameIntent(intent);
  if (!hasQuote(terms)) {
    throw new PaperError('EXTERNAL_QUOTE_REQUIRED', 'equity orders need reference_price, price_source and price_as_of');
  }
  const acct = parseAccount(account);
  if (terms.account_id !== acct.account_id) {
    throw new PaperError('ACCOUNT_MISMATCH', 'intent account_id does not match the paper account', STATE_HINT);
  }
  const match = EQUITY_PRODUCT.exec(terms.product_id);
  if (!match) throw requestError('equity product_id must look like AAPL-USD (ticker, then USD or USDC)');
  if (match[2] !== acct.currency) {
    throw new PaperError('CURRENCY_MISMATCH', `product quote ${match[2]} is not account currency ${acct.currency}`, `Use ${match[1]}-${acct.currency} with a quote in ${acct.currency}.`);
  }
  const held = position === null ? null : parsePosition(position);
  if (held && held.product_id !== terms.product_id) throw stateError('position does not match the intent product');
  if (held && !held.equity) throw classConflict(terms.product_id, 'a crypto', 'an equity');
  const meta = parseEquityMetadata(metadata);
  const ageSeconds = checkExternalFresh(terms.price_as_of as string, now);
  const reference = parseInputDecimal(terms.reference_price, 'reference_price');
  const baseInc = meta.base;
  const quoteInc = meta.quote;
  const heldQty = held?.quantity ?? 0n;
  const heldBasis = held?.cost_basis ?? 0n;
  const size = parseInputDecimal(terms.size, terms.size_type);
  const buy = terms.side === 'BUY';
  const price = toIncrement(
    reference * (FEE_DENOMINATOR + (buy ? EXTERNAL_SLIPPAGE_BPS : -EXTERNAL_SLIPPAGE_BPS)),
    FEE_DENOMINATOR,
    quoteInc,
    buy ? 'ceil' : 'floor',
  );
  if (price <= 0n) throw new PaperError('BELOW_MINIMUM', 'modeled fill price rounds to zero', 'Check reference_price; it is too small for quote_increment.');
  const notionalOf = (base: bigint) => toIncrement(price * base, UNIT, quoteInc, buy ? 'ceil' : 'floor');
  const wholeHint = meta.whole ? ' This equity trades in whole shares only.' : '';
  let base: bigint;
  let notional: bigint;
  let fee: bigint;
  let total: bigint;
  let realized: bigint | null = null;
  let cash: bigint;
  let quantity: bigint;
  let basis: bigint;
  if (buy) {
    if (terms.size_type === 'quote_size') {
      if (!isMultiple(size, quoteInc)) throw new PaperError('INVALID_INCREMENT', 'quote_size is not a multiple of quote_increment');
      if (size > acct.cash - reserved.cash) throw insufficientCash(acct.cash, reserved.cash, size, acct.currency, quoteInc);
      const top = (size * UNIT) / (price * baseInc);
      if (top < 1n) throw new PaperError('BELOW_MINIMUM', `quote_size cannot buy one base increment including fees.${wholeHint}`, 'If the user wants a larger quote_size, place it as a new order with a new client_order_id.');
      base = largestSteps(top, size, (steps) => {
        const n = notionalOf(steps * baseInc);
        return n + feeFor(n, acct.taker_fee_bps, quoteInc);
      }) * baseInc;
    } else {
      if (!isMultiple(size, baseInc)) throw new PaperError('INVALID_INCREMENT', `base_size is not a multiple of base_increment ${formatUnits(baseInc)}.${wholeHint}`);
      base = size;
    }
    notional = notionalOf(base);
    fee = feeFor(notional, acct.taker_fee_bps, quoteInc);
    total = notional + fee;
    if (total > acct.cash - reserved.cash) throw insufficientCash(acct.cash, reserved.cash, total, acct.currency, quoteInc);
    cash = acct.cash - total;
    quantity = heldQty + base;
    basis = heldBasis + total;
  } else {
    base = size;
    if (base > heldQty - reserved.base) throw insufficientHoldings(terms.product_id, heldQty, reserved.base, base, baseInc);
    if (base !== heldQty && !isMultiple(base, baseInc)) {
      throw new PaperError('INVALID_INCREMENT', `base_size is not a multiple of base_increment ${formatUnits(baseInc)}.${wholeHint}`);
    }
    notional = notionalOf(base);
    if (notional <= 0n) throw new PaperError('BELOW_MINIMUM', 'sell notional rounds to zero', 'Sell a larger base_size as a new order with a new client_order_id.');
    fee = feeFor(notional, acct.taker_fee_bps, quoteInc);
    total = notional - fee;
    const removed = removedBasis(heldBasis, heldQty, base, quoteInc);
    realized = total - removed;
    cash = acct.cash + total;
    quantity = heldQty - base;
    basis = heldBasis - removed;
  }

  const receipt: Receipt = {
    mode: 'PAPER',
    ok: true,
    status: 'FILLED',
    request_id: terms.request_id,
    account_id: acct.account_id,
    product_id: terms.product_id,
    side: terms.side,
    order_type: 'MARKET',
    asset_class: 'EQUITY',
    price_verification: 'UNVERIFIED_EXTERNAL_QUOTE',
    requested: { [terms.size_type]: terms.size },
    base_size: formatAmount(base, baseInc),
    notional: formatAmount(notional, quoteInc),
    fee: formatAmount(fee, quoteInc),
    total: formatAmount(total, quoteInc),
    average_price: formatAmount(price, quoteInc),
    realized_pnl: realized === null ? null : formatAmount(realized, quoteInc),
    cash: formatAmount(cash, quoteInc),
    position: { quantity: formatAmount(quantity, baseInc), cost_basis: formatAmount(basis, quoteInc) },
    currency: acct.currency,
    snapshot_time: terms.price_as_of as string,
    price_age_seconds: ageSeconds,
    filled_at: new Date(now).toISOString(),
    fills: [{ price: formatUnits(price), size: formatUnits(base) }],
    source: {
      provider: 'external',
      url: terms.price_source,
      as_of: terms.price_as_of,
      reference_price: terms.reference_price,
      slippage_bps: formatUnits(EXTERNAL_SLIPPAGE_BPS * UNIT),
      metadata: meta.source,
    },
    assumptions: {
      model_version: EXTERNAL_QUOTE_MODEL_VERSION,
      fee_bps: formatUnits(acct.taker_fee_bps),
      slippage_bps: formatUnits(EXTERNAL_SLIPPAGE_BPS * UNIT),
      rounding: EXTERNAL_ROUNDING_NOTE,
      max_quote_age_seconds: MAX_QUOTE_AGE_SECONDS,
      max_quote_future_skew_seconds: MAX_QUOTE_FUTURE_SKEW_SECONDS,
      instrument: {
        base_increment: formatUnits(baseInc),
        quote_increment: formatUnits(quoteInc),
        whole_shares: meta.whole,
        source: meta.source,
      },
    },
    notice: `${EXTERNAL_QUOTE_NOTICE} ${meta.source === 'assumed' ? ASSUMED_METADATA_NOTE : LISTED_METADATA_NOTE}`,
  };
  return {
    receipt,
    cash: formatUnits(cash),
    realized_pnl: formatUnits(acct.realized_pnl + (realized ?? 0n)),
    position: {
      product_id: terms.product_id,
      quantity: formatUnits(quantity),
      cost_basis: formatUnits(basis),
      base_increment: formatUnits(baseInc),
      quote_increment: formatUnits(quoteInc),
      asset_class: 'EQUITY',
    },
  };
}

// ----------------------------------------------------------------- reports

/**
 * Marks positions at the best bid of a fresh book. `books` maps product_id to a
 * raw public order-book response; pass null for an offline report. A product
 * without a usable fresh book stays unpriced rather than using an old price.
 */
export function markPortfolio(
  account: Account,
  positions: Position[],
  books: Readonly<Record<string, unknown>> | null,
  now: number,
): PortfolioMark {
  checkNow(now);
  const acct = parseAccount(account);
  if (!Array.isArray(positions)) throw stateError('positions are not a list');
  const parsed = positions.map(parsePosition).sort((a, b) => (a.product_id < b.product_id ? -1 : a.product_id > b.product_id ? 1 : 0));
  for (let i = 1; i < parsed.length; i++) {
    if (parsed[i].product_id === parsed[i - 1].product_id) throw stateError('has duplicate positions');
  }
  const bookMap = books === null ? null : plainObject(books);
  if (books !== null && !bookMap) throw new PaperError('INVALID_ARGUMENT', 'books must map product_id to an order book');

  const money = acct.quote_increment;
  let unrealized = 0n;
  let marketTotal = 0n;
  let priced = true;
  const unpricedEquities: NonNullable<PortfolioMark['unpriced_positions']> = [];
  const rows = parsed.map((position): MarkedPosition => {
    const inc = position.quote_increment;
    const row: MarkedPosition = {
      product_id: position.product_id,
      quantity: formatAmount(position.quantity, position.base_increment),
      cost_basis: formatAmount(position.cost_basis, inc),
      average_cost: formatRatio(position.cost_basis * UNIT, position.quantity, inc),
      mark: null,
      market_value: null,
      unrealized_pnl: null,
      mark_status: 'MISSING',
      mark_time: null,
      mark_source: MARK_SOURCE,
    };
    if (position.equity) {
      row.asset_class = 'EQUITY';
      row.mark_source = 'none: no keyless equity price';
      row.unpriced_reason = EQUITY_UNPRICED;
      unpricedEquities.push({ product_id: row.product_id, quantity: row.quantity, unpriced_reason: EQUITY_UNPRICED });
      priced = false;
      return row;
    }
    const raw = bookMap ? field(bookMap, position.product_id) : undefined;
    if (raw !== undefined) {
      let book: Book | null = null;
      try {
        book = parseBook(raw, position.product_id);
      } catch (error) {
        if (!(error instanceof PaperError)) throw error;
        row.mark_status = 'INVALID';
      }
      if (book) {
        row.mark_time = book.time;
        row.mark_status = freshness(book.timeMs, now);
        if (row.mark_status === 'FRESH') {
          const bid = book.bids[0].price;
          const value = toIncrement(position.quantity * bid, UNIT, inc, 'floor');
          row.mark = formatUnits(bid);
          row.market_value = formatAmount(value, inc);
          row.unrealized_pnl = formatAmount(value - position.cost_basis, inc);
          marketTotal += value;
          unrealized += value - position.cost_basis;
        }
      }
    }
    if (row.mark_status !== 'FRESH') priced = false;
    return row;
  });

  const mark: PortfolioMark = {
    mode: 'PAPER',
    ok: true,
    account_id: acct.account_id,
    currency: acct.currency,
    initial_cash: formatAmount(acct.initial_cash, money),
    cash: formatAmount(acct.cash, money),
    fee_bps: formatUnits(acct.fee_bps),
    realized_pnl: formatAmount(acct.realized_pnl, money),
    unrealized_pnl: priced ? formatAmount(unrealized, money) : null,
    total_pnl: priced ? formatAmount(acct.realized_pnl + unrealized, money) : null,
    equity: priced ? formatAmount(acct.cash + marketTotal, money) : null,
    priced,
    positions: rows,
    notice: priced ? PAPER_NOTICE : `${PAPER_NOTICE} Open positions without fresh marks are unpriced.`,
  };
  // A refresh with equities reports what it could mark, never as whole-account equity.
  if (bookMap && unpricedEquities.length > 0) {
    mark.priced_market_value = formatAmount(marketTotal, money);
    mark.priced_unrealized_pnl = formatAmount(unrealized, money);
    mark.unpriced_positions = unpricedEquities;
    mark.notice = `${PAPER_NOTICE} Equity positions are unpriced: refresh does not price equities; they are priced only at order time, from a supplied quote. priced_* subtotals cover crypto positions only.`;
  }
  return mark;
}

// -------------------------------------------------------------- order model
// Resting, conditional and attached-exit orders (schema 4). Planners take a
// complete ledger snapshot and return the rows to write; they never do I/O.

/** Paper-model aggressive limit below a bracket stop; not a Coinbase parameter. */
export const STOP_LIMIT_BUFFER_BPS = '500';
export const MAX_CANCEL_IDS = 100;
const BUFFER = 500n;
const ORDER_TYPES = new Set(['market', 'limit', 'stoplimit', 'bracket']);
const TIFS = new Set(['GTC', 'GTD', 'IOC', 'FOK']);
const PRICE_FIELDS = ['limit_price', 'stop_price', 'attached_take_profit_price', 'attached_stop_loss_price'] as const;
const ORDER_KEYS = new Set([...TRADE_KEYS, 'type', 'stop_direction', 'time_in_force', 'end_time', 'post_only', ...PRICE_FIELDS]);
const CLOSE_KEYS = new Set(['request_id', 'account_id', 'product_id', 'size', ...QUOTE_FIELDS]);
const EDIT_KEYS = new Set(['base_size', 'limit_price', 'attached_take_profit_price', 'attached_stop_loss_price', 'cancel_attached_order']);
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const CREATE_HINT = 'Run coinbase-paper orders create --help. Nothing was placed.';
const EDIT_HINT = 'Read the order first with coinbase-paper orders get <order_id>. Edit only remaining eligible terms; activated exits must be managed by their own order IDs.';
const MODEL_ASSUMPTIONS = Object.freeze({
  model_version: ORDER_MODEL_VERSION,
  immediate: 'marketable limit and triggered stop terms walk the visible public book up to the limit as TAKER; no queue, latency or market impact',
  resting: 'resting limits fill only on strict trade-through of a completed public candle (BUY low < limit, SELL high > limit); a touch is not a fill; price min(limit, open) for BUY and max(limit, open) for SELL, rounded adversely to quote_increment; MAKER fee',
  volume: 'a candle fills an order completely or not at all, and only if the candle base volume not yet used by higher-priority paper orders covers it; candle volume is not evidence the order was executable or had queue priority',
  coverage: 'only completed candles that start at or after an order\'s creation, activation or edit time are used; the candle straddling that time, and any coarser bucket straddling the evaluation cursor, are excluded',
  stop_limit: 'a stop triggers on high >= stop (STOP_UP) or low <= stop (STOP_DOWN); its limit is evaluated from the next candle, except a candle that opens beyond the stop and marketable fills at the open as TAKER',
  bracket: 'if one candle reaches both the take-profit and the stop, the stop is assumed first (AMBIGUOUS_OCO); a triggered stop becomes an aggressive SELL limit at floor(stop x 0.95); no fill or loss cap is guaranteed',
  stop_limit_buffer_bps: STOP_LIMIT_BUFFER_BPS,
  expiry: 'GTD orders expire exactly at end_time after completed pre-expiry candles are evaluated; a candle containing end_time is excluded',
  fills_time: 'candle fills are timestamped at the candle end; the intrabar time is unknown',
  hold: 'BUY hold = ceil(limit x remaining) + ceil(fee at max(maker, taker)); SELL hold = remaining base; brackets reserve base once',
  rounding: ROUNDING_NOTE,
});

export interface OrderRules {
  product_type: 'SPOT' | 'EQUITY';
  base_increment: bigint;
  quote_increment: bigint;
  base_min_size: bigint | null;
  base_max_size: bigint | null;
  quote_min_size: bigint | null;
  quote_max_size: bigint | null;
}

interface WorkPosition {
  product_id: string;
  quantity: bigint;
  cost_basis: bigint;
  base_increment: bigint;
  quote_increment: bigint;
  equity: boolean;
}

export interface FillRow {
  trade_id: string;
  trade_time: string;
  price: string;
  size: string;
  notional: string;
  commission: string;
  liquidity_indicator: LiquidityIndicator;
  realized_pnl: string | null;
}

/** Mutable working copy of a ledger. Internal to the paper order model and its reconciler. */
export interface Work {
  accountId: string;
  currency: string;
  maker: bigint;
  taker: bigint;
  cash: bigint;
  realized: bigint;
  quoteIncrement: bigint | null;
  baseAccount: LedgerSnapshot['account'];
  positions: Map<string, WorkPosition>;
  touchedPositions: Set<string>;
  orders: Map<string, OrderState>;
  touchedOrders: Set<string>;
  fillsByOrder: Map<string, FillRow[]>;
  fills: LedgerMutationFill[];
  events: LedgerMutationEvent[];
  acceptances: Array<{ request_id: string; terms: string; receipt: string }>;
  ids: Set<string>;
  nextOrderSeq: number;
  /** Snapshot time of the latest execution per order this pass. */
  snapshots: Map<string, string>;
  /** Receipt source/assumptions for orders created this pass. */
  bases: Map<string, ReceiptBase>;
}

type LedgerMutationFill = Omit<PaperFill, 'fill_seq'>;
type LedgerMutationEvent = Omit<OrderEvent, 'event_seq'>;

interface ReceiptBase {
  source: Record<string, unknown>;
  assumptions: Record<string, unknown>;
  notice: string;
  extra?: Partial<OrderReceipt>;
}

function argError(message: string, hint = CREATE_HINT): PaperError {
  return new PaperError('INVALID_ARGUMENT', message, hint);
}

function equityUnsupported(type: string): PaperError {
  return new PaperError(
    'PAPER_UNSUPPORTED_ORDER_TYPE',
    `Equity paper orders support type=market with a supplied quote; ${type} is not simulated.`,
    'Place type=market with reference_price, price_source and price_as_of taken from one current quote. Resting, conditional and attached-exit equity orders are not simulated; never substitute crypto candles. Nothing was placed.',
  );
}

/** Deterministic UUID (v5 layout) from parts, so replays reuse the same IDs. */
export function uuidFrom(...parts: string[]): string {
  const hex = createHash('sha256').update(parts.join('\u001f')).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const h = hex.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Strict RFC 3339 with zone and at most millisecond precision, as a UTC ISO string. */
export function parseOrderTime(value: unknown, name: string): string {
  if (typeof value !== 'string' || !RFC3339.test(value)) {
    throw argError(`${name} must be an RFC 3339 time with zone and at most millisecond precision, such as 2026-10-15T00:00:00Z`);
  }
  try {
    return new Date(parseTime(value, name)).toISOString();
  } catch {
    throw argError(`${name} is not a valid date and time`);
  }
}

function units(value: string | null | undefined, name: string): bigint {
  return parseStoredDecimal(value, name, { allowNegative: false });
}

function maybe(value: string | null | undefined, name: string): bigint | null {
  return value === null || value === undefined ? null : units(value, name);
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

// ------------------------------------------------------------- normalization

export function normalizeOrderInput(input: OrderInput): OrderIntent {
  const request = plainObject(input);
  if (!request) throw requestError('order request must be a plain object');
  const unknown = Object.keys(request).filter((key) => !ORDER_KEYS.has(key) && request[key] !== undefined);
  if (unknown.length > 0) {
    throw new PaperError(
      'PAPER_UNSUPPORTED_FIELD',
      `paper orders do not support ${unknown.join(', ')}`,
      'Supported paper create fields: product_id, side, type, base_size, quote_size, client_order_id, limit_price, stop_price, stop_direction, time_in_force, end_time, post_only, attached_take_profit_price, attached_stop_loss_price, reference_price, price_source, price_as_of. Nothing was placed.',
    );
  }
  const type = request.type;
  if (typeof type !== 'string' || !ORDER_TYPES.has(type)) {
    throw new PaperError(
      'PAPER_UNSUPPORTED_ORDER_TYPE',
      `paper type=${String(type)} is not simulated`,
      'Paper supports type=market, limit, stoplimit and bracket. twap, scaled, stop-market and trailing stops are not simulated. Nothing was placed; do not fall back to live trading.',
    );
  }
  const has = (key: string) => request[key] !== undefined;
  if (QUOTE_FIELDS.some(has) && type !== 'market') throw equityUnsupported(type);
  const trade = normalizeTrade(request, { allowSellQuote: type === 'market' || type === 'limit', sizeOptional: false });
  const intent: OrderIntent = { operation: 'create', ...trade, type: type as OrderIntent['type'] };
  const price = (key: string) => formatUnits(parseInputDecimal(request[key], key));
  const forbid = (keys: string[], where: string) => {
    const present = keys.filter(has);
    if (present.length > 0) throw argError(`${present.join(', ')} ${present.length > 1 ? 'are' : 'is'} not allowed ${where}`);
  };
  const require = (keys: string[], where: string) => {
    const missing = keys.filter((key) => !has(key));
    if (missing.length > 0) throw argError(`${where} requires ${missing.join(', ')}`);
  };
  const tif = request.time_in_force;
  if (tif !== undefined && (typeof tif !== 'string' || !TIFS.has(tif))) throw argError('time_in_force must be GTC, GTD, IOC or FOK');
  const gtcOrGtd = (where: string) => {
    if (tif !== undefined && tif !== 'GTC' && tif !== 'GTD') throw argError(`${where} supports time_in_force GTC or GTD`);
    intent.time_in_force = (tif ?? 'GTC') as TimeInForce;
  };
  if (type === 'market') {
    forbid(['limit_price', 'stop_price', 'stop_direction', 'post_only', 'end_time'], 'on type=market');
    if (tif !== undefined && tif !== 'IOC' && tif !== 'FOK') throw argError('type=market supports time_in_force IOC or FOK, or omit it');
    if (tif !== undefined) intent.time_in_force = tif as TimeInForce;
  } else if (type === 'limit') {
    require(['limit_price'], 'type=limit');
    forbid(['stop_price', 'stop_direction'], 'on type=limit');
    intent.limit_price = price('limit_price');
    intent.time_in_force = (tif ?? 'GTC') as TimeInForce;
    const post = request.post_only;
    if (post !== undefined && typeof post !== 'boolean') throw argError('post_only must be true or false');
    intent.post_only = post === true;
    if (intent.post_only && intent.time_in_force !== 'GTC' && intent.time_in_force !== 'GTD') throw argError('post_only=true requires time_in_force GTC or GTD');
  } else if (type === 'stoplimit') {
    if (trade.size_type !== 'base_size') throw argError('type=stoplimit requires base_size');
    require(['limit_price', 'stop_price', 'stop_direction'], 'type=stoplimit');
    forbid(['post_only'], 'on type=stoplimit');
    intent.limit_price = price('limit_price');
    intent.stop_price = price('stop_price');
    const direction = request.stop_direction;
    if (direction === 'STOP_DIRECTION_STOP_UP' || direction === 'up') intent.stop_direction = 'STOP_DIRECTION_STOP_UP';
    else if (direction === 'STOP_DIRECTION_STOP_DOWN' || direction === 'down') intent.stop_direction = 'STOP_DIRECTION_STOP_DOWN';
    else throw argError('stop_direction must be STOP_DIRECTION_STOP_UP, STOP_DIRECTION_STOP_DOWN, up or down');
    gtcOrGtd('type=stoplimit');
  } else {
    if (trade.side !== 'SELL') throw argError('spot type=bracket requires side=SELL', 'For an entry with exits, place a market or limit BUY with attached_take_profit_price and/or attached_stop_loss_price. Nothing was placed.');
    if (trade.size_type !== 'base_size') throw argError('type=bracket requires base_size');
    require(['limit_price', 'stop_price'], 'type=bracket');
    forbid(['stop_direction', 'post_only'], 'on type=bracket (the stop direction is implied by side)');
    intent.limit_price = price('limit_price');
    intent.stop_price = price('stop_price');
    if (parseInputDecimal(intent.stop_price, 'stop_price') >= parseInputDecimal(intent.limit_price, 'limit_price')) {
      throw argError('a SELL bracket needs stop_price below the take-profit limit_price');
    }
    gtcOrGtd('type=bracket');
  }
  if (intent.time_in_force === 'GTD') {
    if (!has('end_time')) throw argError('time_in_force=GTD requires end_time');
    intent.end_time = parseOrderTime(request.end_time, 'end_time');
  } else {
    forbid(['end_time'], `with time_in_force ${intent.time_in_force ?? 'omitted'} (end_time is only for GTD)`);
  }
  const attached = (['attached_take_profit_price', 'attached_stop_loss_price'] as const).filter(has);
  if (attached.length > 0) {
    if ((type !== 'market' && type !== 'limit') || trade.side !== 'BUY') {
      throw argError('attached exits are only allowed on a crypto market or limit BUY');
    }
    for (const key of attached) intent[key] = price(key);
    if (intent.attached_take_profit_price !== undefined && intent.attached_stop_loss_price !== undefined
      && parseInputDecimal(intent.attached_stop_loss_price, 'attached_stop_loss_price') >= parseInputDecimal(intent.attached_take_profit_price, 'attached_take_profit_price')) {
      throw argError('attached_stop_loss_price must be below attached_take_profit_price');
    }
  }
  return intent;
}

export function normalizeClosePositionInput(input: ClosePositionInput): OrderIntent {
  const request = plainObject(input);
  if (!request) throw requestError('close-position request must be a plain object');
  const unknown = Object.keys(request).filter((key) => !CLOSE_KEYS.has(key) && request[key] !== undefined);
  if (unknown.length > 0) {
    throw new PaperError('PAPER_UNSUPPORTED_FIELD', `paper close-position does not support ${unknown.join(', ')}`, 'Supported fields: client_order_id, product_id, size, reference_price, price_source, price_as_of. Nothing was placed.');
  }
  const trade = normalizeTrade({ ...request, side: 'SELL', base_size: request.size, quote_size: undefined }, { allowSellQuote: false, sizeOptional: true });
  return { operation: 'close-position', ...trade, type: 'market' };
}

export function normalizeEditInput(input: EditOrderInput): EditOrderInput {
  const request = plainObject(input);
  if (!request) throw requestError('edit request must be a plain object');
  const keys = Object.keys(request).filter((key) => request[key] !== undefined);
  const unknown = keys.filter((key) => !EDIT_KEYS.has(key));
  if (unknown.length > 0) {
    throw new PaperError('PAPER_UNSUPPORTED_FIELD', `paper orders edit does not support ${unknown.join(', ')}`, 'Editable fields: base_size, limit_price, attached_take_profit_price, attached_stop_loss_price, cancel_attached_order. Nothing was changed.');
  }
  if (keys.length === 0) throw argError('edit needs at least one field', EDIT_HINT);
  const edit: EditOrderInput = {};
  for (const key of ['base_size', 'limit_price', 'attached_take_profit_price', 'attached_stop_loss_price'] as const) {
    if (request[key] !== undefined) edit[key] = formatUnits(parseInputDecimal(request[key], key));
  }
  if (request.cancel_attached_order !== undefined) {
    if (typeof request.cancel_attached_order !== 'boolean') throw argError('cancel_attached_order must be true or false', EDIT_HINT);
    if (request.cancel_attached_order && (edit.attached_take_profit_price !== undefined || edit.attached_stop_loss_price !== undefined)) {
      throw argError('cancel_attached_order=true cannot be combined with attached prices', EDIT_HINT);
    }
    edit.cancel_attached_order = request.cancel_attached_order;
  }
  if (edit.attached_take_profit_price !== undefined && edit.attached_stop_loss_price !== undefined
    && parseInputDecimal(edit.attached_stop_loss_price, 'attached_stop_loss_price') >= parseInputDecimal(edit.attached_take_profit_price, 'attached_take_profit_price')) {
    throw argError('attached_stop_loss_price must be below attached_take_profit_price', EDIT_HINT);
  }
  return edit;
}

/** Legacy market serialization; existing pending and filled orders keep matching their retries. */
export function legacyTerms(intent: Pick<Intent, 'account_id' | 'product_id' | 'request_id' | 'side' | 'size' | 'size_type' | 'reference_price' | 'price_source' | 'price_as_of'>): string {
  if (intent.reference_price === undefined && intent.price_source === undefined && intent.price_as_of === undefined) {
    return JSON.stringify({ account_id: intent.account_id, product_id: intent.product_id, request_id: intent.request_id, side: intent.side, size: intent.size, size_type: intent.size_type });
  }
  return JSON.stringify({
    account_id: intent.account_id,
    price_as_of: intent.price_as_of,
    price_source: intent.price_source,
    product_id: intent.product_id,
    reference_price: intent.reference_price,
    request_id: intent.request_id,
    side: intent.side,
    size: intent.size,
    size_type: intent.size_type,
  });
}

function isLegacyShape(intent: OrderIntent): boolean {
  return intent.operation === 'create' && intent.type === 'market' && intent.size_type !== null && intent.time_in_force === undefined
    && intent.attached_take_profit_price === undefined && intent.attached_stop_loss_price === undefined;
}

/** Immutable idempotency terms of a create/close request. */
export function orderTerms(intent: OrderIntent): string {
  if (isLegacyShape(intent)) {
    return legacyTerms({ ...intent, size_type: intent.size_type as Intent['size_type'], size: intent.size as string });
  }
  const entries = Object.entries(intent).filter(([, value]) => value !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(Object.fromEntries(entries));
}

/** Re-normalizes an intent so planners only ever act on validated terms. */
export function checkOrderIntent(intent: OrderIntent): OrderIntent {
  const value = plainObject(intent);
  if (!value) throw requestError('intent must be a plain object');
  const input: Record<string, unknown> = {};
  for (const key of ['request_id', 'account_id', 'product_id', ...QUOTE_FIELDS]) input[key] = field(value, key);
  let normalized: OrderIntent;
  if (field(value, 'operation') === 'close-position') {
    input.size = field(value, 'size') ?? undefined;
    normalized = normalizeClosePositionInput(input as unknown as ClosePositionInput);
  } else if (field(value, 'operation') === 'create') {
    const sizeType = field(value, 'size_type');
    if (sizeType !== 'base_size' && sizeType !== 'quote_size') throw requestError('intent size_type is invalid');
    input[sizeType] = field(value, 'size');
    for (const key of ['side', 'type', 'stop_direction', 'time_in_force', 'end_time', 'post_only', ...PRICE_FIELDS]) input[key] = field(value, key);
    if (input.type === 'limit' && input.post_only === false) input.post_only = undefined;
    normalized = normalizeOrderInput(input as unknown as OrderInput);
  } else {
    throw requestError('intent operation must be create or close-position');
  }
  if (orderTerms(normalized) !== orderTerms(value as unknown as OrderIntent) || Object.keys(value).some((key) => value[key] !== undefined && !(key in normalized))) {
    throw requestError('intent is not normalized; pass the output of normalizeOrderInput or normalizeClosePositionInput');
  }
  return normalized;
}

// --------------------------------------------------------------- holds

export function rulesOf(order: Pick<OrderState, 'product_rules'>, fallbackQuote: bigint | null = null): OrderRules {
  const rules = order.product_rules;
  if (rules === null) {
    return { product_type: 'SPOT', base_increment: 1n, quote_increment: fallbackQuote ?? 1n, base_min_size: null, base_max_size: null, quote_min_size: null, quote_max_size: null };
  }
  return {
    product_type: rules.product_type,
    base_increment: units(rules.base_increment, 'product_rules base_increment'),
    quote_increment: units(rules.quote_increment, 'product_rules quote_increment'),
    base_min_size: maybe(rules.base_min_size, 'product_rules base_min_size'),
    base_max_size: maybe(rules.base_max_size, 'product_rules base_max_size'),
    quote_min_size: maybe(rules.quote_min_size, 'product_rules quote_min_size'),
    quote_max_size: maybe(rules.quote_max_size, 'product_rules quote_max_size'),
  };
}

/** Hold an order's current terms require: BUY notional plus worst-case fee, or SELL remaining base. */
export function holdFor(order: OrderState, makerBps: bigint, takerBps: bigint): { cash: bigint; base: bigint } {
  // Market orders execute fully inside one transaction and never rest.
  if (order.status !== 'OPEN' || order.order_type === 'MARKET') return { cash: 0n, base: 0n };
  const remaining = units(order.remaining_size, 'order remaining_size');
  if (order.side === 'SELL') return { cash: 0n, base: remaining };
  const limit = units(order.limit_price, 'order limit_price');
  const quoteInc = rulesOf(order).quote_increment;
  const notional = toIncrement(limit * remaining, UNIT, quoteInc, 'ceil');
  return { cash: notional + feeFor(notional, max(makerBps, takerBps), quoteInc), base: 0n };
}

/** Totals of the stored holds of open orders. */
export function summarizeHolds(orders: readonly OrderState[]): { cash: string; positions: Record<string, string> } {
  let cash = 0n;
  const base = new Map<string, bigint>();
  for (const order of orders) {
    cash += units(order.cash_hold, 'order cash_hold');
    const held = units(order.base_hold, 'order base_hold');
    if (held > 0n) base.set(order.product_id, (base.get(order.product_id) ?? 0n) + held);
  }
  const positions: Record<string, string> = {};
  for (const [product, held] of [...base].sort(([a], [b]) => (a < b ? -1 : 1))) positions[product] = formatUnits(held);
  return { cash: formatUnits(cash), positions };
}

function reservedCash(work: Work, except?: string): bigint {
  let total = 0n;
  for (const order of work.orders.values()) if (order.order_id !== except) total += holdFor(order, work.maker, work.taker).cash;
  return total;
}

function reservedBase(work: Work, productId: string, except?: string): bigint {
  let total = 0n;
  for (const order of work.orders.values()) {
    if (order.product_id === productId && order.order_id !== except) total += holdFor(order, work.maker, work.taker).base;
  }
  return total;
}

// ----------------------------------------------------------------- work

export function openWork(ledger: LedgerSnapshot): Work {
  const acct = parseAccount(ledger.account);
  const positions = new Map<string, WorkPosition>();
  for (const raw of ledger.positions) {
    const p = parsePosition(raw);
    positions.set(p.product_id, { ...p });
  }
  const orders = new Map<string, OrderState>();
  let nextOrderSeq = 1;
  for (const order of ledger.orders) {
    orders.set(order.order_id, { ...order });
    if (order.order_seq >= nextOrderSeq) nextOrderSeq = order.order_seq + 1;
  }
  const fillsByOrder = new Map<string, FillRow[]>();
  const ids = new Set<string>();
  for (const fill of ledger.fills) {
    const list = fillsByOrder.get(fill.order_id) ?? [];
    list.push(fillRow(fill));
    fillsByOrder.set(fill.order_id, list);
    ids.add(fill.trade_id);
  }
  for (const event of ledger.events) ids.add(event.event_id);
  return {
    accountId: acct.account_id,
    currency: acct.currency,
    maker: acct.maker_fee_bps,
    taker: acct.taker_fee_bps,
    cash: acct.cash,
    realized: acct.realized_pnl,
    quoteIncrement: acct.quote_increment,
    baseAccount: ledger.account,
    positions,
    touchedPositions: new Set(),
    orders,
    touchedOrders: new Set(),
    fillsByOrder,
    fills: [],
    events: [],
    acceptances: [],
    ids,
    nextOrderSeq,
    snapshots: new Map(),
    bases: new Map(),
  };
}

function fillRow(fill: Pick<PaperFill, 'trade_id' | 'trade_time' | 'price' | 'size' | 'notional' | 'commission' | 'liquidity_indicator' | 'realized_pnl'>): FillRow {
  return {
    trade_id: fill.trade_id,
    trade_time: fill.trade_time,
    price: fill.price,
    size: fill.size,
    notional: fill.notional,
    commission: fill.commission,
    liquidity_indicator: fill.liquidity_indicator,
    realized_pnl: fill.realized_pnl,
  };
}

function claim(work: Work, id: string): string {
  if (work.ids.has(id)) throw stateError(`transition ${id} was already applied`);
  work.ids.add(id);
  return id;
}

export function touch(work: Work, order: OrderState, time: string): void {
  order.updated_at = time;
  const hold = holdFor(order, work.maker, work.taker);
  order.cash_hold = formatUnits(hold.cash);
  order.base_hold = formatUnits(hold.base);
  work.orders.set(order.order_id, order);
  work.touchedOrders.add(order.order_id);
}

export function addEvent(work: Work, order: OrderState, type: OrderEventType, time: string, details: Record<string, unknown>, key: string[] = []): void {
  work.events.push({
    event_id: claim(work, uuidFrom('event', order.order_id, type, ...key)),
    order_id: order.order_id,
    product_id: order.product_id,
    event_time: time,
    event_type: type,
    status: order.status,
    details,
  });
}

/** Moves an order to a terminal status, releasing its remaining hold. */
export function finish(work: Work, order: OrderState, status: 'FILLED' | 'CANCELLED' | 'EXPIRED', time: string, reason: string | null, key: string[] = []): void {
  if (order.status === 'FILLED' || order.status === 'EXPIRED') throw stateError('terminal order cannot change status');
  const unfilled = order.remaining_size;
  order.status = status;
  order.terminal_reason = reason;
  // Terminal rows keep no executable remainder; the event records what was released.
  order.remaining_size = '0';
  if (status !== 'FILLED') {
    if (order.take_profit_status === 'OPEN') order.take_profit_status = 'CANCELLED';
    if (order.stop_loss_status === 'OPEN' || order.stop_loss_status === 'TRIGGERED') order.stop_loss_status = 'CANCELLED';
  }
  touch(work, order, time);
  if (status !== 'FILLED') addEvent(work, order, status, time, { reason, unfilled_size: unfilled }, key);
}

/**
 * Applies one execution batch (one book walk or one candle) as a single fee and
 * accounting unit, split across rows by exact weights.
 */
export function applyBatch(
  work: Work,
  order: OrderState,
  rows: Array<{ price: bigint; size: bigint }>,
  liquidity: LiquidityIndicator,
  time: string,
  batchKey: string[],
  source: Record<string, unknown>,
): bigint {
  const rules = rulesOf(order, work.quoteIncrement);
  const quoteInc = rules.quote_increment;
  const raw = rows.reduce((sum, row) => sum + row.price * row.size, 0n);
  const size = rows.reduce((sum, row) => sum + row.size, 0n);
  if (rows.length === 0 || size <= 0n) throw stateError('execution batch is empty');
  const remaining = units(order.remaining_size, 'order remaining_size');
  if (size > remaining) throw stateError('execution exceeds the order remainder');
  const buy = order.side === 'BUY';
  const notional = toIncrement(raw, UNIT, quoteInc, buy ? 'ceil' : 'floor');
  const fee = feeFor(notional, liquidity === 'MAKER' ? work.maker : work.taker, quoteInc);
  const equity = order.product_type === 'EQUITY';
  const position = work.positions.get(order.product_id) ?? {
    product_id: order.product_id, quantity: 0n, cost_basis: 0n, base_increment: rules.base_increment, quote_increment: quoteInc, equity,
  };
  if (position.equity !== equity) throw classConflict(order.product_id, position.equity ? 'an equity' : 'a crypto', equity ? 'an equity' : 'a crypto');
  let removed = 0n;
  if (buy) {
    if (notional + fee > work.cash) throw insufficientCash(work.cash, 0n, notional + fee, work.currency, quoteInc);
    work.cash -= notional + fee;
    if (position.quantity === 0n) {
      position.base_increment = rules.base_increment;
      position.quote_increment = quoteInc;
    }
    position.quantity += size;
    position.cost_basis += notional + fee;
  } else {
    if (size > position.quantity) throw stateError('sell execution exceeds the position');
    removed = removedBasis(position.cost_basis, position.quantity, size, position.quote_increment);
    work.cash += notional - fee;
    work.realized += notional - fee - removed;
    position.quantity -= size;
    position.cost_basis -= removed;
  }
  work.positions.set(order.product_id, position);
  work.touchedPositions.add(order.product_id);
  if (work.quoteIncrement === null || quoteInc < work.quoteIncrement) work.quoteIncrement = quoteInc;

  const batchId = uuidFrom('batch', order.order_id, ...batchKey);
  const tradeIds: string[] = [];
  let usedNotional = 0n;
  let usedFee = 0n;
  let usedBasis = 0n;
  const list = work.fillsByOrder.get(order.order_id) ?? [];
  rows.forEach((row, index) => {
    const last = index === rows.length - 1;
    const weight = row.price * row.size;
    const share = (total: bigint, used: bigint) => (last ? total - used : toIncrement(total * weight, raw, quoteInc, 'floor'));
    const rowNotional = share(notional, usedNotional);
    const rowFee = share(fee, usedFee);
    const rowBasis = buy ? 0n : share(removed, usedBasis);
    usedNotional += rowNotional;
    usedFee += rowFee;
    usedBasis += rowBasis;
    const tradeId = claim(work, uuidFrom('trade', batchId, String(index)));
    tradeIds.push(tradeId);
    const fill: LedgerMutationFill = {
      trade_id: tradeId,
      order_id: order.order_id,
      batch_id: batchId,
      batch_index: index,
      product_id: order.product_id,
      product_type: order.product_type,
      side: order.side,
      trade_time: time,
      price: formatUnits(row.price),
      size: formatUnits(row.size),
      notional: formatUnits(rowNotional),
      commission: formatUnits(rowFee),
      liquidity_indicator: liquidity,
      cost_basis_removed: formatUnits(rowBasis),
      realized_pnl: buy ? null : formatSigned(rowNotional - rowFee - rowBasis),
      source,
    };
    work.fills.push(fill);
    list.push(fillRow(fill));
  });
  work.fillsByOrder.set(order.order_id, list);
  order.filled_size = formatUnits(units(order.filled_size, 'order filled_size') + size);
  order.remaining_size = formatUnits(remaining - size);
  work.snapshots.set(order.order_id, time);
  touch(work, order, time);
  // A batch that completes the order is recorded as FILLED, so activity and status history end on the real outcome.
  addEvent(work, remaining - size === 0n ? { ...order, status: 'FILLED' } : order, 'FILL', time, {
    batch_id: batchId,
    trade_ids: tradeIds,
    size: formatUnits(size),
    notional: formatUnits(notional),
    commission: formatUnits(fee),
    liquidity_indicator: liquidity,
    source,
  }, batchKey);
  return size;
}

function formatSigned(value: bigint): string {
  return formatUnits(value);
}

/** Creates the composite SELL exit for one parent execution batch. */
export function activateChild(work: Work, parent: OrderState, size: bigint, time: string, batchKey: string[]): OrderState | null {
  const tp = parent.attached_take_profit_price;
  const sl = parent.attached_stop_loss_price;
  if (tp === null && sl === null) return null;
  const rules = rulesOf(parent);
  const id = uuidFrom('attached', parent.order_id, ...batchKey);
  const floor = sl === null ? null : stopLimitFloor(units(sl, 'attached_stop_loss_price'), rules.quote_increment);
  const child: OrderState = {
    order_id: id,
    order_seq: work.nextOrderSeq++,
    product_id: parent.product_id,
    side: 'SELL',
    order_type: 'BRACKET',
    status: 'OPEN',
    product_type: parent.product_type,
    created_at: time,
    updated_at: time,
    priority_at: time,
    time_in_force: 'GTC',
    end_time: null,
    base_size: formatUnits(size),
    filled_size: '0',
    remaining_size: formatUnits(size),
    limit_price: tp,
    stop_price: sl,
    stop_direction: sl === null ? null : 'STOP_DIRECTION_STOP_DOWN',
    post_only: false,
    triggered_at: null,
    evaluate_after: time,
    cash_hold: '0',
    base_hold: '0',
    parent_order_id: parent.order_id,
    attached_take_profit_price: null,
    attached_stop_loss_price: null,
    take_profit_status: tp === null ? null : 'OPEN',
    stop_loss_status: sl === null ? null : 'OPEN',
    stop_limit_price: floor === null ? null : formatUnits(floor),
    product_rules: parent.product_rules,
    terminal_reason: null,
    current_receipt: null,
  };
  touch(work, child, time);
  work.bases.set(id, {
    source: { kind: 'attached_exit', parent_order_id: parent.order_id, activated_at: time },
    assumptions: { ...MODEL_ASSUMPTIONS },
    notice: PAPER_NOTICE,
  });
  addEvent(work, parent, 'ATTACHED_ACTIVATED', time, { attached_order_id: id, base_size: formatUnits(size) }, batchKey);
  addEvent(work, child, 'ACCEPTED', time, { parent_order_id: parent.order_id }, []);
  addEvent(work, child, 'OPENED', time, { base_hold: child.base_hold }, []);
  work.acceptances.push({
    request_id: id,
    terms: JSON.stringify({
      account_id: work.accountId,
      attached_stop_loss_price: sl,
      attached_take_profit_price: tp,
      base_size: formatUnits(size),
      batch_key: batchKey.join('/'),
      kind: 'attached_exit',
      parent_order_id: parent.order_id,
      product_id: parent.product_id,
      side: 'SELL',
    }),
    receipt: JSON.stringify(viewOf(work, child)),
  });
  return child;
}

export function stopLimitFloor(stop: bigint, quoteInc: bigint): bigint {
  const floor = toIncrement(stop * (FEE_DENOMINATOR - BUFFER), FEE_DENOMINATOR, quoteInc, 'floor');
  if (floor <= 0n) {
    throw new PaperError('INVALID_INCREMENT', 'the stop-loss aggressive limit floor(stop x 0.95) rounds to zero at this quote_increment', 'Use a larger stop price. Nothing was placed.');
  }
  return floor;
}

/** Current order view (receipt shape) from the working state. */
export function viewOf(work: Work, order: OrderState): OrderReceipt {
  const rules = rulesOf(order, work.quoteIncrement);
  const baseInc = order.product_rules === null ? null : rules.base_increment;
  const quoteInc = order.product_rules === null ? work.quoteIncrement : rules.quote_increment;
  const fills = work.fillsByOrder.get(order.order_id) ?? [];
  let raw = 0n;
  let size = 0n;
  let notional = 0n;
  let fee = 0n;
  let realized: bigint | null = null;
  for (const fill of fills) {
    const price = units(fill.price, 'fill price');
    const qty = units(fill.size, 'fill size');
    raw += price * qty;
    size += qty;
    notional += units(fill.notional, 'fill notional');
    fee += units(fill.commission, 'fill commission');
    if (fill.realized_pnl !== null) realized = (realized ?? 0n) + parseStoredDecimal(fill.realized_pnl, 'fill realized_pnl', { allowNegative: true });
  }
  const total = order.side === 'BUY' ? notional + fee : notional - fee;
  const position = work.positions.get(order.product_id);
  const prior = order.current_receipt;
  const base = work.bases.get(order.order_id) ?? {
    source: prior?.source ?? {},
    assumptions: prior?.assumptions ?? { ...MODEL_ASSUMPTIONS },
    notice: prior?.notice ?? PAPER_NOTICE,
  };
  const requested = (base.extra?.requested ?? prior?.requested ?? (order.base_size === null ? {} : { base_size: order.base_size })) as OrderReceipt['requested'];
  const baseSize = order.base_size === null ? null : units(order.base_size, 'order base_size');
  const children = [...work.orders.values()].filter((child) => child.parent_order_id === order.order_id).sort((a, b) => a.order_seq - b.order_seq).map((child) => child.order_id);
  const lastFill = fills.length === 0 ? null : fills[fills.length - 1].trade_time;
  const filledSize = units(order.filled_size, 'order filled_size');
  const type = order.order_type.toLowerCase() as OrderReceipt['order_configuration']['type'];
  const receipt: OrderReceipt = {
    mode: 'PAPER',
    ok: true,
    request_id: order.order_id,
    order_id: order.order_id,
    client_order_id: order.order_id,
    account_id: work.accountId,
    product_id: order.product_id,
    side: order.side,
    order_type: order.order_type,
    status: order.status,
    requested,
    base_size: formatAmount(filledSize, baseInc),
    notional: formatAmount(notional, quoteInc),
    fee: formatAmount(fee, quoteInc),
    total: formatAmount(total, quoteInc),
    average_price: size === 0n ? null : formatRatio(raw, size),
    realized_pnl: realized === null ? null : formatAmount(realized, quoteInc),
    cash: formatAmount(work.cash, quoteInc),
    position: {
      quantity: formatAmount(position?.quantity ?? 0n, baseInc),
      cost_basis: formatAmount(position?.cost_basis ?? 0n, quoteInc),
    },
    currency: work.currency,
    snapshot_time: work.snapshots.get(order.order_id) ?? prior?.snapshot_time ?? null,
    filled_at: order.status === 'FILLED' ? lastFill : null,
    fills: fills.map((fill) => ({
      price: fill.price,
      size: fill.size,
      trade_id: fill.trade_id,
      trade_time: fill.trade_time,
      commission: fill.commission,
      notional: fill.notional,
      liquidity_indicator: fill.liquidity_indicator,
    })),
    source: base.source,
    assumptions: base.assumptions,
    notice: base.notice,
    created_time: order.created_at,
    updated_time: order.updated_at,
    time_in_force: order.time_in_force,
    end_time: order.end_time,
    order_configuration: {
      type,
      base_size: order.base_size,
      limit_price: order.limit_price,
      stop_price: order.stop_price,
      stop_direction: order.stop_direction,
      time_in_force: order.time_in_force,
      end_time: order.end_time,
      post_only: order.post_only,
      stop_limit_price: order.stop_limit_price,
    },
    attached_order_configuration: order.attached_take_profit_price === null && order.attached_stop_loss_price === null ? null : {
      attached_take_profit_price: order.attached_take_profit_price,
      attached_stop_loss_price: order.attached_stop_loss_price,
    },
    attached_order_id: children[0] ?? null,
    attached_order_ids: children,
    parent_order_id: order.parent_order_id,
    filled_size: formatAmount(filledSize, baseInc),
    remaining_size: formatAmount(units(order.remaining_size, 'order remaining_size'), baseInc),
    average_filled_price: size === 0n ? null : formatRatio(raw, size),
    total_fees: formatAmount(fee, quoteInc),
    number_of_fills: fills.length,
    last_fill_time: lastFill,
    completion_percentage: baseSize === null || baseSize === 0n ? '0' : formatRatio(filledSize * 100n * UNIT, baseSize),
    hold: { currency: work.currency, cash: formatAmount(units(order.cash_hold, 'cash_hold'), quoteInc), base: formatAmount(units(order.base_hold, 'base_hold'), baseInc) },
    triggered_at: order.triggered_at,
    terminal_reason: order.terminal_reason,
  };
  if (order.product_type === 'EQUITY') {
    receipt.asset_class = 'EQUITY';
    const extra = base.extra ?? prior ?? {};
    if (extra.price_verification !== undefined) receipt.price_verification = extra.price_verification;
    if (extra.price_age_seconds !== undefined) receipt.price_age_seconds = extra.price_age_seconds;
  }
  if (base.extra?.success ?? prior?.success) receipt.success = true;
  return receipt;
}

/** Rows for the store: touched orders (with fresh views), positions, fills, events, acceptances. */
export function finishWork(work: Work): {
  account: { cash: string; realized_pnl: string; quote_increment: string | null };
  positions: Array<Position | { product_id: string; deleted: true }>;
  orders: OrderState[];
  fills: LedgerMutationFill[];
  events: LedgerMutationEvent[];
  acceptances: Array<{ request_id: string; terms: string; receipt: string }>;
} {
  if (work.cash < 0n) throw stateError('cash would become negative');
  if (work.cash < reservedCash(work)) throw stateError('holds would exceed cash');
  const orders = [...work.touchedOrders].map((id) => {
    const order = work.orders.get(id) as OrderState;
    order.current_receipt = viewOf(work, order);
    return order;
  });
  const positions = [...work.touchedPositions].sort().map((id): Position | { product_id: string; deleted: true } => {
    const p = work.positions.get(id) as WorkPosition;
    if (p.quantity < reservedBase(work, id)) throw stateError('holds would exceed holdings');
    if (p.quantity === 0n) return { product_id: id, deleted: true };
    const row: Position = {
      product_id: id,
      quantity: formatUnits(p.quantity),
      cost_basis: formatUnits(p.cost_basis),
      base_increment: formatUnits(p.base_increment),
      quote_increment: formatUnits(p.quote_increment),
    };
    if (p.equity) row.asset_class = 'EQUITY';
    return row;
  });
  return {
    account: { cash: formatUnits(work.cash), realized_pnl: formatUnits(work.realized), quote_increment: work.quoteIncrement === null ? null : formatUnits(work.quoteIncrement) },
    positions,
    orders,
    fills: work.fills,
    events: work.events,
    acceptances: work.acceptances,
  };
}

function accountFor(work: Work): Account {
  return {
    ...work.baseAccount,
    cash: formatUnits(work.cash),
    realized_pnl: formatUnits(work.realized),
    quote_increment: work.quoteIncrement === null ? null : formatUnits(work.quoteIncrement),
  };
}

function positionFor(work: Work, productId: string): Position | null {
  const p = work.positions.get(productId);
  if (!p || p.quantity === 0n) return null;
  const row: Position = {
    product_id: productId,
    quantity: formatUnits(p.quantity),
    cost_basis: formatUnits(p.cost_basis),
    base_increment: formatUnits(p.base_increment),
    quote_increment: formatUnits(p.quote_increment),
  };
  if (p.equity) row.asset_class = 'EQUITY';
  return row;
}

// --------------------------------------------------------- legacy receipts

/**
 * Records a legacy (schema 2/3) or legacy-API market fill: one MARKET/FILLED order,
 * one TAKER batch from the receipt's own rows and amounts, and its events. Basis
 * removal comes from the receipt's position snapshot, so the ledger reproduces the
 * stored account exactly.
 */
export function recordLegacyFill(work: Work, receipt: Receipt, orderSeq: number, createdAt: string): void {
  const equity = receipt.asset_class === 'EQUITY';
  const rules = legacyRules(receipt, work.positions.get(receipt.product_id));
  const quoteInc = rules?.quote_increment ?? 1n;
  const notional = parseStoredDecimal(receipt.notional, 'receipt notional');
  const fee = parseStoredDecimal(receipt.fee, 'receipt fee');
  const total = parseStoredDecimal(receipt.total, 'receipt total');
  const base = parseStoredDecimal(receipt.base_size, 'receipt base_size');
  const buy = receipt.side === 'BUY';
  if (total !== (buy ? notional + fee : notional - fee)) throw stateError('legacy receipt total does not match notional and fee');
  const position = work.positions.get(receipt.product_id) ?? {
    product_id: receipt.product_id, quantity: 0n, cost_basis: 0n,
    base_increment: rules?.base_increment ?? 1n, quote_increment: quoteInc, equity,
  };
  if (position.equity !== equity) throw stateError('legacy receipts mix asset classes for one product');
  const after = parseStoredDecimal(receipt.position.cost_basis, 'receipt position cost_basis');
  let removed = 0n;
  if (buy) {
    work.cash -= total;
    position.quantity += base;
    position.cost_basis += total;
    if (rules) {
      position.base_increment = rules.base_increment;
      position.quote_increment = rules.quote_increment;
    }
  } else {
    if (base > position.quantity) throw stateError('legacy sell exceeds the reconstructed position');
    removed = position.cost_basis - after;
    if (removed < 0n) throw stateError('legacy sell basis is inconsistent');
    work.cash += total;
    work.realized += total - removed;
    position.quantity -= base;
    position.cost_basis = after;
  }
  if (position.quantity !== parseStoredDecimal(receipt.position.quantity, 'receipt position quantity') || position.cost_basis !== after) {
    throw stateError('legacy receipt position does not match the reconstructed history');
  }
  work.positions.set(receipt.product_id, position);
  work.touchedPositions.add(receipt.product_id);
  if (rules && (work.quoteIncrement === null || quoteInc < work.quoteIncrement)) work.quoteIncrement = quoteInc;

  const productRules: ProductRules | null = rules === null ? null : {
    product_type: equity ? 'EQUITY' : 'SPOT',
    base_currency_id: receipt.product_id.split('-')[0],
    quote_currency_id: receipt.product_id.split('-')[1],
    base_increment: formatUnits(rules.base_increment),
    quote_increment: formatUnits(rules.quote_increment),
    base_min_size: rules.base_min_size === null ? null : formatUnits(rules.base_min_size),
    base_max_size: rules.base_max_size === null ? null : formatUnits(rules.base_max_size),
    quote_min_size: rules.quote_min_size === null ? null : formatUnits(rules.quote_min_size),
    quote_max_size: rules.quote_max_size === null ? null : formatUnits(rules.quote_max_size),
  };
  const order: OrderState = {
    order_id: receipt.request_id,
    order_seq: orderSeq,
    product_id: receipt.product_id,
    side: receipt.side,
    order_type: 'MARKET',
    status: 'FILLED',
    product_type: equity ? 'EQUITY' : 'SPOT',
    created_at: createdAt,
    updated_at: receipt.filled_at,
    priority_at: createdAt,
    time_in_force: null,
    end_time: null,
    base_size: formatUnits(base),
    filled_size: formatUnits(base),
    remaining_size: '0',
    limit_price: null,
    stop_price: null,
    stop_direction: null,
    post_only: false,
    triggered_at: null,
    evaluate_after: createdAt,
    cash_hold: '0',
    base_hold: '0',
    parent_order_id: null,
    attached_take_profit_price: null,
    attached_stop_loss_price: null,
    take_profit_status: null,
    stop_loss_status: null,
    stop_limit_price: null,
    product_rules: productRules,
    terminal_reason: null,
    current_receipt: null,
  };
  if (orderSeq >= work.nextOrderSeq) work.nextOrderSeq = orderSeq + 1;
  work.orders.set(order.order_id, order);
  work.touchedOrders.add(order.order_id);

  const rows = receipt.fills.map((fill) => ({ price: parseStoredDecimal(fill.price, 'receipt fill price'), size: parseStoredDecimal(fill.size, 'receipt fill size') }));
  if (rows.reduce((sum, row) => sum + row.size, 0n) !== base) throw stateError('legacy receipt fills do not sum to base_size');
  const raw = rows.reduce((sum, row) => sum + row.price * row.size, 0n);
  const batchId = uuidFrom('batch', order.order_id, 'legacy');
  const source = { kind: equity ? 'legacy_external_quote' : 'legacy_book_snapshot', snapshot_time: receipt.snapshot_time, model_version: receipt.assumptions.model_version ?? null };
  const tradeIds: string[] = [];
  let used = [0n, 0n, 0n];
  const list: FillRow[] = [];
  rows.forEach((row, index) => {
    const last = index === rows.length - 1;
    const share = (amount: bigint, slot: number) => {
      const value = last ? amount - used[slot] : toIncrement(amount * row.price * row.size, raw, quoteInc, 'floor');
      used[slot] += value;
      return value;
    };
    const rowNotional = share(notional, 0);
    const rowFee = share(fee, 1);
    const rowBasis = buy ? 0n : share(removed, 2);
    const tradeId = claim(work, uuidFrom('trade', batchId, String(index)));
    tradeIds.push(tradeId);
    const fill: LedgerMutationFill = {
      trade_id: tradeId,
      order_id: order.order_id,
      batch_id: batchId,
      batch_index: index,
      product_id: order.product_id,
      product_type: order.product_type,
      side: order.side,
      trade_time: receipt.filled_at,
      price: formatUnits(row.price),
      size: formatUnits(row.size),
      notional: formatUnits(rowNotional),
      commission: formatUnits(rowFee),
      liquidity_indicator: 'TAKER',
      cost_basis_removed: formatUnits(rowBasis),
      realized_pnl: buy ? null : formatUnits(rowNotional - rowFee - rowBasis),
      source,
    };
    work.fills.push(fill);
    list.push(fillRow(fill));
  });
  used = [0n, 0n, 0n];
  work.fillsByOrder.set(order.order_id, list);
  work.snapshots.set(order.order_id, receipt.snapshot_time);
  work.bases.set(order.order_id, {
    source: receipt.source,
    assumptions: receipt.assumptions,
    notice: receipt.notice,
    extra: { requested: receipt.requested, price_verification: receipt.price_verification, price_age_seconds: receipt.price_age_seconds },
  });
  addEvent(work, order, 'ACCEPTED', createdAt, { legacy: true });
  addEvent(work, { ...order, status: 'FILLED' }, 'FILL', receipt.filled_at, { batch_id: batchId, trade_ids: tradeIds, size: formatUnits(base), notional: formatUnits(notional), commission: formatUnits(fee), liquidity_indicator: 'TAKER', source }, ['legacy']);
}

function legacyRules(receipt: Receipt, held: WorkPosition | undefined): OrderRules | null {
  const read = (object: unknown, key: string, allowZero = false): bigint | null => {
    const record = plainObject(object);
    const value = record ? field(record, key) : undefined;
    if (value === undefined) return null;
    return parseStoredDecimal(value, `receipt ${key}`, { allowZero });
  };
  if (receipt.asset_class === 'EQUITY') {
    const instrument = plainObject(receipt.assumptions.instrument);
    const baseInc = read(instrument, 'base_increment');
    const quoteInc = read(instrument, 'quote_increment');
    if (baseInc !== null && quoteInc !== null) return { product_type: 'EQUITY', base_increment: baseInc, quote_increment: quoteInc, base_min_size: null, base_max_size: null, quote_min_size: null, quote_max_size: null };
  } else {
    const product = receipt.source.product;
    const baseInc = read(product, 'base_increment');
    const quoteInc = read(product, 'quote_increment');
    if (baseInc !== null && quoteInc !== null) {
      return {
        product_type: 'SPOT', base_increment: baseInc, quote_increment: quoteInc,
        base_min_size: read(product, 'base_min_size', true), base_max_size: read(product, 'base_max_size'),
        quote_min_size: read(product, 'quote_min_size', true), quote_max_size: read(product, 'quote_max_size'),
      };
    }
  }
  if (held) return { product_type: held.equity ? 'EQUITY' : 'SPOT', base_increment: held.base_increment, quote_increment: held.quote_increment, base_min_size: null, base_max_size: null, quote_min_size: null, quote_max_size: null };
  return null;
}

/** PENDING row for a reserved request that has not executed: no hold, no execution. */
export function pendingOrder(intent: OrderIntent, orderSeq: number, reservedAt: string): OrderState {
  return {
    order_id: intent.request_id,
    order_seq: orderSeq,
    product_id: intent.product_id,
    side: intent.side,
    order_type: intent.type.toUpperCase() as StoredOrderType,
    status: 'PENDING',
    product_type: intent.reference_price !== undefined ? 'EQUITY' : 'SPOT',
    created_at: reservedAt,
    updated_at: reservedAt,
    priority_at: reservedAt,
    time_in_force: intent.time_in_force ?? null,
    end_time: intent.end_time ?? null,
    base_size: intent.size_type === 'base_size' ? intent.size : null,
    filled_size: '0',
    remaining_size: '0',
    limit_price: intent.limit_price ?? null,
    stop_price: intent.stop_price ?? null,
    stop_direction: intent.stop_direction ?? null,
    post_only: intent.post_only === true,
    triggered_at: null,
    evaluate_after: reservedAt,
    cash_hold: '0',
    base_hold: '0',
    parent_order_id: null,
    attached_take_profit_price: intent.attached_take_profit_price ?? null,
    attached_stop_loss_price: intent.attached_stop_loss_price ?? null,
    take_profit_status: null,
    stop_loss_status: null,
    stop_limit_price: null,
    product_rules: null,
    terminal_reason: null,
    current_receipt: null,
  };
}

/** Reconstructs a PENDING row from stored legacy market terms (migration). */
export function intentFromLegacyTerms(text: string): OrderIntent {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw stateError('order terms are not JSON');
  }
  const terms = plainObject(value);
  if (!terms) throw stateError('order terms are not an object');
  if (field(terms, 'operation') !== undefined) {
    try {
      return checkOrderIntent(terms as unknown as OrderIntent);
    } catch {
      throw stateError('order terms are invalid');
    }
  }
  const sizeType = field(terms, 'size_type');
  try {
    const legacy = normalizeIntent({
      request_id: field(terms, 'request_id'),
      account_id: field(terms, 'account_id'),
      product_id: field(terms, 'product_id'),
      side: field(terms, 'side'),
      [sizeType === 'quote_size' ? 'quote_size' : 'base_size']: field(terms, 'size'),
      reference_price: field(terms, 'reference_price'),
      price_source: field(terms, 'price_source'),
      price_as_of: field(terms, 'price_as_of'),
    });
    if (legacyTerms(legacy) !== text) throw new Error('not canonical');
    return { operation: 'create', ...legacy, type: 'market' };
  } catch {
    throw stateError('legacy order terms are invalid');
  }
}

// ------------------------------------------------------------- placement

function rulesFromProduct(product: Product, productId: string): ProductRules {
  const [base, quote] = productId.split('-');
  return {
    product_type: 'SPOT',
    base_currency_id: base,
    quote_currency_id: quote,
    base_increment: formatUnits(product.base_increment),
    quote_increment: formatUnits(product.quote_increment),
    base_min_size: formatUnits(product.base_min_size),
    base_max_size: formatUnits(product.base_max_size),
    quote_min_size: formatUnits(product.quote_min_size),
    quote_max_size: formatUnits(product.quote_max_size),
  };
}

function productFromRules(rules: OrderRules): Product {
  return {
    base_increment: rules.base_increment,
    quote_increment: rules.quote_increment,
    base_min_size: rules.base_min_size ?? 0n,
    base_max_size: rules.base_max_size ?? (1n << 200n),
    quote_min_size: rules.quote_min_size ?? 0n,
    quote_max_size: rules.quote_max_size ?? (1n << 200n),
  };
}

function newOrder(work: Work, intent: OrderIntent, rules: ProductRules, time: string): OrderState {
  const existing = work.orders.get(intent.request_id);
  return {
    ...pendingOrder(intent, existing?.order_seq ?? work.nextOrderSeq++, existing?.created_at ?? time),
    status: 'OPEN',
    updated_at: time,
    priority_at: time,
    evaluate_after: time,
    product_type: rules.product_type,
    product_rules: rules,
  };
}

/** Walks crossing levels for up to `quantity`; returns the rows taken. */
function take(levels: Level[], quantity: bigint): Array<{ price: bigint; size: bigint }> {
  const rows: Array<{ price: bigint; size: bigint }> = [];
  let remaining = quantity;
  for (const level of levels) {
    if (remaining <= 0n) break;
    const size = min(level.size, remaining);
    rows.push({ price: level.price, size });
    remaining -= size;
  }
  return rows;
}

function rowsCost(rows: Array<{ price: bigint; size: bigint }>, feeBps: bigint, quoteInc: bigint): bigint {
  if (rows.length === 0) return 0n;
  const notional = toIncrement(rows.reduce((sum, row) => sum + row.price * row.size, 0n), UNIT, quoteInc, 'ceil');
  return notional + feeFor(notional, feeBps, quoteInc);
}

interface BookPlan {
  rows: Array<{ price: bigint; size: bigint }>;
  limit: bigint;
  triggered: boolean;
}

/** What one fresh book does to an open order's current terms (immediate execution only). */
function bookPlan(order: OrderState, book: Book, rules: OrderRules): BookPlan {
  const remaining = units(order.remaining_size, 'order remaining_size');
  const crossing = (limit: bigint) => (order.side === 'BUY' ? book.asks.filter((level) => level.price <= limit) : book.bids.filter((level) => level.price >= limit));
  let limit = order.limit_price === null ? 0n : units(order.limit_price, 'limit_price');
  let triggered = false;
  if (order.order_type === 'STOPLIMIT' && order.triggered_at === null) {
    const stop = units(order.stop_price, 'stop_price');
    const met = order.stop_direction === 'STOP_DIRECTION_STOP_UP' ? book.asks[0].price >= stop : book.bids[0].price <= stop;
    if (!met) return { rows: [], limit, triggered: false };
    triggered = true;
  }
  if (order.order_type === 'BRACKET') {
    const stopOpen = order.stop_loss_status === 'OPEN';
    if (order.stop_loss_status === 'TRIGGERED' || (stopOpen && book.bids[0].price <= units(order.stop_price, 'stop_price'))) {
      triggered = order.stop_loss_status === 'OPEN';
      limit = units(order.stop_limit_price, 'stop_limit_price');
    } else if (order.take_profit_status !== 'OPEN') {
      return { rows: [], limit, triggered: false };
    }
  }
  const levels = crossing(limit);
  const depth = levels.reduce((sum, level) => sum + level.size, 0n);
  let quantity = min(remaining, depth);
  if (order.time_in_force === 'FOK') quantity = depth >= remaining ? remaining : 0n;
  quantity -= quantity % rules.base_increment;
  return { rows: quantity > 0n ? take(levels, quantity) : [], limit, triggered };
}

function checkPriceIncrements(order: OrderState, rules: OrderRules): void {
  for (const key of ['limit_price', 'stop_price', 'attached_take_profit_price', 'attached_stop_loss_price'] as const) {
    const value = order[key];
    if (value !== null && !isMultiple(units(value, key), rules.quote_increment)) {
      throw new PaperError('INVALID_INCREMENT', `${key} is not a multiple of product quote_increment ${formatUnits(rules.quote_increment)}`, 'Pass a price on the product\'s quote_increment as a new order; paper never rounds user prices.');
    }
  }
}

/**
 * Validates an order's (new) terms and holds against the book, executes any
 * immediately marketable part as TAKER and leaves the rest open, cancelled or
 * filled. `except` names the order whose own old hold is being replaced.
 */
function placeAgainstBook(work: Work, order: OrderState, book: Book, rules: OrderRules, time: string, key: string, events: { accepted: boolean }): void {
  const product = productFromRules(rules);
  const baseSize = units(order.base_size, 'base_size');
  const filled = units(order.filled_size, 'filled_size');
  if (!isMultiple(baseSize, rules.base_increment)) throw new PaperError('INVALID_INCREMENT', `base_size is not a multiple of product base_increment ${formatUnits(rules.base_increment)}`);
  if (order.order_type === 'BRACKET' && order.stop_price !== null) {
    order.stop_limit_price = formatUnits(stopLimitFloor(units(order.stop_price, 'stop_price'), rules.quote_increment));
  }
  // A stop-loss-only exit has no take-profit price; its aggressive stop floor is the applicable limit.
  const limit = order.limit_price === null && order.order_type === 'BRACKET'
    ? units(order.stop_limit_price, 'stop_limit_price')
    : units(order.limit_price, 'limit_price');
  checkLimits(product, baseSize, toIncrement(limit * baseSize, UNIT, rules.quote_increment, order.side === 'BUY' ? 'ceil' : 'floor'));
  if (order.attached_stop_loss_price !== null) stopLimitFloor(units(order.attached_stop_loss_price, 'attached_stop_loss_price'), rules.quote_increment);
  const plan = bookPlan(order, book, rules);
  if (order.post_only && plan.rows.length > 0) {
    throw new PaperError('PAPER_POST_ONLY_WOULD_CROSS', 'Post-only limit price would take liquidity (INVALID_LIMIT_PRICE_POST_ONLY).', 'Choose a non-crossing limit_price, or explicitly submit a new order with post_only=false and a new client_order_id.');
  }
  if (order.post_only && (order.side === 'BUY' ? book.asks[0].price <= limit : book.bids[0].price >= limit)) {
    throw new PaperError('PAPER_POST_ONLY_WOULD_CROSS', 'Post-only limit price would take liquidity (INVALID_LIMIT_PRICE_POST_ONLY).', 'Choose a non-crossing limit_price, or explicitly submit a new order with post_only=false and a new client_order_id.');
  }
  const executed = plan.rows.reduce((sum, row) => sum + row.size, 0n);
  const remainder = baseSize - filled - executed;
  const rests = remainder > 0n && order.time_in_force !== 'IOC' && order.time_in_force !== 'FOK';
  if (order.side === 'BUY') {
    const cash = work.cash;
    const reserved = reservedCash(work, order.order_id);
    let required = rowsCost(plan.rows, work.taker, rules.quote_increment);
    if (rests) {
      const notional = toIncrement(limit * remainder, UNIT, rules.quote_increment, 'ceil');
      required += notional + feeFor(notional, max(work.maker, work.taker), rules.quote_increment);
    }
    if (required > cash - reserved) throw insufficientCash(cash, reserved, required, work.currency, rules.quote_increment);
  } else {
    const held = work.positions.get(order.product_id)?.quantity ?? 0n;
    const reserved = reservedBase(work, order.product_id, order.order_id);
    if (baseSize - filled > held - reserved) throw insufficientHoldings(order.product_id, held, reserved, baseSize - filled, rules.base_increment);
  }
  if (events.accepted) addEvent(work, order, 'ACCEPTED', time, { order_type: order.order_type, base_size: order.base_size });
  if (plan.triggered) {
    order.triggered_at = time;
    if (order.order_type === 'BRACKET') {
      order.stop_loss_status = 'TRIGGERED';
      if (order.take_profit_status === 'OPEN') order.take_profit_status = 'CANCELLED';
    }
    touch(work, order, time);
    addEvent(work, order, 'TRIGGERED', time, { source: 'book', best_bid: formatUnits(book.bids[0].price), best_ask: formatUnits(book.asks[0].price) }, [key]);
  }
  const source = { kind: 'book', snapshot_time: book.time, best_bid: formatUnits(book.bids[0].price), best_ask: formatUnits(book.asks[0].price) };
  if (plan.rows.length > 0) {
    applyBatch(work, order, plan.rows, 'TAKER', time, [key], source);
    work.snapshots.set(order.order_id, book.time);
  }
  touch(work, order, time);
  if (units(order.remaining_size, 'remaining_size') === 0n) {
    order.status = 'FILLED';
    if (order.take_profit_status === 'OPEN') {
      order.take_profit_status = 'FILLED';
      if (order.stop_loss_status === 'OPEN') order.stop_loss_status = 'CANCELLED';
    } else if (order.stop_loss_status === 'TRIGGERED') {
      order.stop_loss_status = 'FILLED';
    }
    touch(work, order, time);
  } else if (!rests) {
    finish(work, order, 'CANCELLED', time, order.time_in_force === 'FOK' ? 'FOK_NOT_FILLED' : 'IOC_REMAINDER_CANCELLED', [key]);
  } else if (events.accepted) {
    addEvent(work, order, 'OPENED', time, { remaining_size: order.remaining_size, cash_hold: order.cash_hold, base_hold: order.base_hold });
  }
  // Activate attached exits only after the parent's status is final for this pass, so the
  // ATTACHED_ACTIVATED event (the parent's last event) reports FILLED for a full fill, OPEN for a partial one.
  if (plan.rows.length > 0) activateChild(work, order, executed, time, [key]);
}

type Provenance = { reconciliation?: unknown; requests?: unknown; provider?: string };

function attachProvenance(receipt: OrderReceipt, provenance: Provenance | undefined): OrderReceipt {
  if (!provenance) return receipt;
  // An existing source provider (an external quote) is kept; otherwise the command's market-data provider is named.
  const provider = provenance.provider === undefined ? {} : { provider: provenance.provider };
  return {
    ...receipt,
    source: { ...provider, ...receipt.source, requests: provenance.requests },
    reconciliation: provenance.reconciliation as OrderReceipt['reconciliation'],
  };
}

/**
 * Plans a new create/close order against a fresh book (crypto) or a supplied
 * quote (equity market orders only).
 */
export function planOrder(ledger: LedgerSnapshot, intent: OrderIntent, market: PlacementMarket, now: number, provenance?: Provenance): OrderMutation {
  checkNow(now);
  const terms = checkOrderIntent(intent);
  const work = openWork(ledger);
  if (terms.account_id !== work.accountId) throw new PaperError('ACCOUNT_MISMATCH', 'intent account_id does not match the paper account', STATE_HINT);
  const existing = work.orders.get(terms.request_id);
  if (existing && existing.status !== 'PENDING') throw stateError('order was already accepted');
  const time = new Date(now).toISOString();
  const marketValue = plainObject(market);
  const kind = marketValue ? field(marketValue, 'kind') : undefined;
  if (kind !== 'crypto' && kind !== 'equity') throw requestError('market must be a crypto book or equity metadata');
  const held = work.positions.get(terms.product_id);
  let order: OrderState;
  if (kind === 'equity') {
    if (terms.type !== 'market' || terms.attached_take_profit_price !== undefined || terms.attached_stop_loss_price !== undefined) throw equityUnsupported(terms.type === 'market' ? 'attached exits' : terms.type);
    if (terms.time_in_force !== undefined && terms.time_in_force !== 'IOC') throw argError('equity market orders support time_in_force IOC or omit it');
    if (terms.reference_price === undefined) throw externalQuoteRequired(terms.product_id);
    if (terms.side === 'SELL' && terms.size_type === 'quote_size') throw requestError('SELL requires base_size');
    if (held && !held.equity) throw classConflict(terms.product_id, 'a crypto', 'an equity');
    const metadata = (market as { metadata: EquityMetadata }).metadata;
    const meta = parseEquityMetadata(metadata);
    const base = sellBase(work, terms, held, null, meta.base);
    const legacy = legacyIntent(terms, base);
    const reserved = { cash: reservedCash(work), base: reservedBase(work, terms.product_id) };
    const fill = simulateQuoted(accountFor(work), positionFor(work, terms.product_id), legacy, metadata, now, reserved);
    const rules: ProductRules = {
      product_type: 'EQUITY', base_currency_id: terms.product_id.split('-')[0], quote_currency_id: terms.product_id.split('-')[1],
      base_increment: formatUnits(meta.base), quote_increment: formatUnits(meta.quote), base_min_size: null, base_max_size: null, quote_min_size: null, quote_max_size: null,
    };
    order = executeMarket(work, terms, fill, rules, time);
  } else {
    if (terms.reference_price !== undefined) throw referenceOnCrypto();
    if (held?.equity) throw classConflict(terms.product_id, 'an equity', 'a crypto');
    const use: ProductUse = terms.type === 'market' ? 'market' : terms.type === 'limit' ? (terms.post_only ? 'post_only_limit' : 'limit') : 'conditional';
    const { product: rawProduct, book: rawBook } = market as { product: unknown; book: unknown };
    const product = parseProduct(rawProduct, terms.product_id, work.currency, use);
    const book = parseBook(rawBook, terms.product_id);
    checkFresh(book.time, now);
    const rules = rulesFromProduct(product, terms.product_id);
    if (terms.type === 'market') {
      // Attached exit prices are validated before the parent executes; paper never rounds user prices.
      for (const key of ['attached_take_profit_price', 'attached_stop_loss_price'] as const) {
        const value = terms[key];
        if (value !== undefined && !isMultiple(units(value, key), product.quote_increment)) {
          throw new PaperError('INVALID_INCREMENT', `${key} is not a multiple of product quote_increment ${formatUnits(product.quote_increment)}`, 'Pass a price on the product\'s quote_increment as a new order; paper never rounds user prices.');
        }
      }
      if (terms.attached_stop_loss_price !== undefined) stopLimitFloor(units(terms.attached_stop_loss_price, 'attached_stop_loss_price'), product.quote_increment);
      const base = sellBase(work, terms, held, book, product.base_increment);
      const legacy = legacyIntent(terms, base);
      const reserved = { cash: reservedCash(work), base: reservedBase(work, terms.product_id) };
      const fill = simulateMarket(accountFor(work), positionFor(work, terms.product_id), legacy, rawProduct, rawBook, now, reserved);
      order = executeMarket(work, terms, fill, rules, time);
      if (order.attached_take_profit_price !== null || order.attached_stop_loss_price !== null) {
        activateChild(work, order, units(order.filled_size, 'filled_size'), time, ['place']);
      }
    } else {
      order = newOrder(work, terms, rules, time);
      const parsedRules = rulesOf(order);
      checkPriceIncrements(order, parsedRules);
      if (terms.end_time !== undefined && Date.parse(terms.end_time) <= now) throw argError('end_time must be in the future');
      if (terms.size_type === 'quote_size') {
        const base = toIncrement(units(terms.size, 'quote_size') * UNIT, units(terms.limit_price, 'limit_price'), product.base_increment, 'floor');
        if (base === 0n) throw new PaperError('BELOW_MINIMUM', 'quote_size at limit_price buys less than one base increment', 'If the user wants a larger quote_size, place it as a new order with a new client_order_id.');
        order.base_size = formatUnits(base);
      }
      order.remaining_size = order.base_size as string;
      if (order.order_type === 'BRACKET') {
        order.take_profit_status = 'OPEN';
        order.stop_loss_status = 'OPEN';
      }
      work.bases.set(order.order_id, {
        source: { provider_snapshot: 'book', snapshot_time: book.time, best_bid: formatUnits(book.bids[0].price), best_ask: formatUnits(book.asks[0].price), product: rules },
        assumptions: { ...MODEL_ASSUMPTIONS, maker_fee_bps: formatUnits(work.maker), taker_fee_bps: formatUnits(work.taker), max_book_age_seconds: MAX_BOOK_AGE_SECONDS },
        notice: PAPER_NOTICE,
        extra: { requested: { [terms.size_type as string]: terms.size } },
      });
      placeAgainstBook(work, order, book, parsedRules, time, 'place', { accepted: true });
    }
  }
  if (terms.operation === 'close-position') {
    const base = work.bases.get(order.order_id) as ReceiptBase;
    base.extra = { ...base.extra, success: true, requested: terms.size === null ? {} : { size: terms.size } };
  }
  const rows: LedgerMutation = finishWork(work);
  // A successful pass this command ran (including NOT_NEEDED) is persisted with the placement, so a later
  // STALE report never shows an older last-reconciled time than one already reported.
  const report = plainObject(provenance?.reconciliation);
  const reconciledAt = report && report.status !== 'STALE' && typeof report.reconciled_at === 'string' ? report.reconciled_at : null;
  if (reconciledAt !== null && (ledger.account.last_reconciled_at === null || reconciledAt > ledger.account.last_reconciled_at)) {
    rows.account = { ...rows.account, last_reconciled_at: reconciledAt };
  }
  const receipt = attachProvenance((rows.orders.find((row) => row.order_id === order.order_id) as OrderState).current_receipt as OrderReceipt, provenance);
  rows.acceptances.unshift({ request_id: order.order_id, terms: orderTerms(terms), receipt: JSON.stringify(receipt) });
  return { ...rows, receipt };
}

/** Base quantity of a SELL: close-position size or full position, or a quote target at the best bid. */
function sellBase(work: Work, terms: OrderIntent, held: WorkPosition | undefined, book: Book | null, baseInc: bigint): string | null {
  if (terms.operation === 'close-position') {
    const quantity = held?.quantity ?? 0n;
    if (quantity === 0n) {
      throw new PaperError('PAPER_NO_POSITION', `No open paper position exists for ${terms.product_id}.`, 'Run coinbase-paper balance and check --data-dir and product_id.');
    }
    if (terms.size !== null) return terms.size;
    const reserved = reservedBase(work, terms.product_id);
    if (reserved > 0n) {
      const error = insufficientHoldings(terms.product_id, quantity, reserved, quantity, held?.base_increment ?? null);
      throw new PaperError(error.code, `${error.message} Closing the full position needs all of it; open orders hold part of it.`, 'Cancel the named open orders holding it (for example an attached exit), or pass size= for the available quantity with the same client_order_id only if the user chose that. Protection is never cancelled automatically.', error.details);
    }
    return formatUnits(quantity);
  }
  if (terms.side === 'SELL' && terms.size_type === 'quote_size' && book !== null) {
    const base = toIncrement(units(terms.size, 'quote_size') * UNIT, book.bids[0].price, baseInc, 'floor');
    if (base === 0n) throw new PaperError('BELOW_MINIMUM', 'quote_size at the best bid sells less than one base increment', 'If the user wants a larger quote_size, place it as a new order with a new client_order_id.');
    return formatUnits(base);
  }
  return null;
}

function legacyIntent(terms: OrderIntent, base: string | null): Intent {
  const intent: Intent = {
    request_id: terms.request_id,
    account_id: terms.account_id,
    product_id: terms.product_id,
    side: terms.side,
    size_type: base === null ? (terms.size_type as Intent['size_type']) : 'base_size',
    size: base ?? (terms.size as string),
  };
  if (terms.reference_price !== undefined) {
    intent.reference_price = terms.reference_price;
    intent.price_source = terms.price_source;
    intent.price_as_of = terms.price_as_of;
  }
  return intent;
}

/** Turns a validated full-depth market FillResult into ledger rows. */
function executeMarket(work: Work, terms: OrderIntent, fill: FillResult, rules: ProductRules, time: string): OrderState {
  const order = newOrder(work, terms, rules, time);
  order.order_type = 'MARKET';
  const base = parseStoredDecimal(fill.receipt.base_size, 'receipt base_size');
  order.base_size = formatUnits(base);
  order.remaining_size = order.base_size;
  const receipt = fill.receipt;
  const equity = rules.product_type === 'EQUITY';
  work.bases.set(order.order_id, {
    source: receipt.source,
    assumptions: { ...receipt.assumptions, order_model_version: ORDER_MODEL_VERSION, taker_fee_bps: formatUnits(work.taker) },
    notice: receipt.notice,
    extra: { requested: receipt.requested, price_verification: receipt.price_verification, price_age_seconds: receipt.price_age_seconds },
  });
  addEvent(work, order, 'ACCEPTED', time, { order_type: 'MARKET' });
  const rows = receipt.fills.map((row) => ({ price: parseStoredDecimal(row.price, 'fill price'), size: parseStoredDecimal(row.size, 'fill size') }));
  applyBatch(work, order, rows, 'TAKER', time, ['place'], equity
    ? { kind: 'external_quote', price_as_of: receipt.snapshot_time, provider: 'external' }
    : { kind: 'book', snapshot_time: receipt.snapshot_time });
  work.snapshots.set(order.order_id, receipt.snapshot_time);
  if (formatUnits(work.cash) !== fill.cash || formatUnits(work.realized) !== fill.realized_pnl) throw stateError('market execution accounting disagrees with the simulator');
  order.status = 'FILLED';
  touch(work, order, time);
  return order;
}

// --------------------------------------------------------------- edits

function sameEditTerms(order: OrderState, edit: EditOrderInput): boolean {
  const attachedChange = edit.cancel_attached_order === true || edit.attached_take_profit_price !== undefined || edit.attached_stop_loss_price !== undefined;
  const nextTp = edit.cancel_attached_order ? null : attachedChange ? edit.attached_take_profit_price ?? null : order.attached_take_profit_price;
  const nextSl = edit.cancel_attached_order ? null : attachedChange ? edit.attached_stop_loss_price ?? null : order.attached_stop_loss_price;
  return (edit.base_size === undefined || edit.base_size === order.base_size)
    && (edit.limit_price === undefined || edit.limit_price === order.limit_price)
    && nextTp === order.attached_take_profit_price && nextSl === order.attached_stop_loss_price;
}

/** True when an edit would change nothing; a no-op edit needs no book. */
export function editIsNoop(ledger: LedgerSnapshot, orderId: string, edit: EditOrderInput): boolean {
  const normalized = normalizeEditInput(edit);
  const order = ledger.orders.find((row) => row.order_id === orderId);
  return order !== undefined && order.status === 'OPEN' && sameEditTerms(order, normalized);
}

export function planEdit(ledger: LedgerSnapshot, orderId: string, edit: EditOrderInput, market: PlacementMarket | null, now: number): OrderMutation {
  checkNow(now);
  const changes = normalizeEditInput(edit);
  const work = openWork(ledger);
  const order = work.orders.get(orderId);
  if (!order) throw new PaperError('ORDER_NOT_FOUND', `No paper order ${orderId} exists in this account.`, 'Check the ID and --data-dir with coinbase-paper orders list. Nothing was changed.');
  if (order.status !== 'OPEN') {
    throw new PaperError('PAPER_ORDER_NOT_OPEN', `Order ${orderId} is ${order.status}; this operation requires an open order.`, `Run coinbase-paper orders get ${orderId}. Completed executions cannot be edited or undone.`, { order_id: orderId, status: order.status });
  }
  const invalid = (reason: string) => new PaperError('PAPER_INVALID_ORDER_EDIT', `Cannot edit order ${orderId}: ${reason}.`, EDIT_HINT, { order_id: orderId });
  if (order.order_type === 'MARKET' || order.product_type === 'EQUITY') throw invalid('only open crypto limit, stoplimit or bracket orders can be edited');
  const attachedChange = changes.cancel_attached_order === true || changes.attached_take_profit_price !== undefined || changes.attached_stop_loss_price !== undefined;
  if (attachedChange) {
    if (order.order_type !== 'LIMIT' || order.side !== 'BUY') throw invalid('attached exits can change only on a limit BUY parent');
    const children = [...work.orders.values()].some((row) => row.parent_order_id === order.order_id);
    if (units(order.filled_size, 'filled_size') > 0n || children) throw invalid('attached exits are already active; cancel or edit the active exit order by its own order ID');
  }
  if (sameEditTerms(order, changes)) {
    const receipt = { ...viewOf(work, order), edited: false };
    return { account: { cash: formatUnits(work.cash), realized_pnl: formatUnits(work.realized), quote_increment: work.quoteIncrement === null ? null : formatUnits(work.quoteIncrement) }, positions: [], orders: [], fills: [], events: [], acceptances: [], receipt };
  }
  if (order.order_type === 'BRACKET' && changes.limit_price !== undefined && order.take_profit_status !== 'OPEN') {
    throw invalid('the take-profit leg is no longer open');
  }
  if (order.order_type === 'BRACKET' && changes.limit_price !== undefined && order.stop_price !== null && units(changes.limit_price, 'limit_price') <= units(order.stop_price, 'stop_price')) {
    throw invalid('the take-profit limit_price must stay above stop_price');
  }
  if (order.order_type === 'BRACKET' && order.take_profit_status === null && changes.limit_price !== undefined) throw invalid('this exit has no take-profit leg');
  const filled = units(order.filled_size, 'filled_size');
  if (changes.base_size !== undefined && units(changes.base_size, 'base_size') <= filled) {
    throw invalid(`base_size is the new total size and must exceed the filled size ${order.filled_size}`);
  }
  // Time can pass between reconciliation and this write (book read, lock wait). An order whose
  // expiry has been reached must not take new terms or fill; the next reconciliation expires it.
  if (order.end_time !== null && Date.parse(order.end_time) <= now) {
    throw new PaperError('PAPER_RECONCILIATION_STALE', 'Open paper orders could not be reconciled; no new order or edit was executed.', `Order ${orderId} reached its end_time ${order.end_time} after this command reconciled. Run coinbase-paper orders get ${orderId} to see its current status; nothing was changed.`, { order_id: orderId, end_time: order.end_time });
  }
  if (market === null || plainObject(market) === null || (market as { kind?: unknown }).kind !== 'crypto') throw requestError('a real edit needs a fresh crypto order book');
  const book = parseBook((market as { book: unknown }).book, order.product_id);
  checkFresh(book.time, now);
  const time = new Date(now).toISOString();
  const before = { base_size: order.base_size, limit_price: order.limit_price, attached_take_profit_price: order.attached_take_profit_price, attached_stop_loss_price: order.attached_stop_loss_price };
  if (changes.base_size !== undefined) order.base_size = changes.base_size;
  if (changes.limit_price !== undefined) order.limit_price = changes.limit_price;
  if (attachedChange) {
    order.attached_take_profit_price = changes.cancel_attached_order ? null : changes.attached_take_profit_price ?? null;
    order.attached_stop_loss_price = changes.cancel_attached_order ? null : changes.attached_stop_loss_price ?? null;
  }
  order.remaining_size = formatUnits(units(order.base_size, 'base_size') - filled);
  order.priority_at = time;
  order.evaluate_after = time;
  const rules = rulesOf(order);
  checkPriceIncrements(order, rules);
  const after = { base_size: order.base_size, limit_price: order.limit_price, attached_take_profit_price: order.attached_take_profit_price, attached_stop_loss_price: order.attached_stop_loss_price };
  const key = `edit:${time}:${JSON.stringify(after)}`;
  touch(work, order, time);
  addEvent(work, order, 'EDITED', time, { before, after }, [key]);
  placeAgainstBook(work, order, book, rules, time, key, { accepted: false });
  const rows = finishWork(work);
  const receipt = { ...((rows.orders.find((row) => row.order_id === orderId) as OrderState).current_receipt as OrderReceipt), edited: true };
  return { ...rows, receipt };
}

// -------------------------------------------------------------- cancels

export function planCancel(ledger: LedgerSnapshot, orderIds: string[], now: number): CancelMutation {
  checkNow(now);
  if (!Array.isArray(orderIds) || orderIds.length === 0 || orderIds.length > MAX_CANCEL_IDS) {
    throw argError(`order_ids must list 1 to ${MAX_CANCEL_IDS} order IDs`, 'Pass order_ids=UUID1,UUID2. Nothing was cancelled.');
  }
  const work = openWork(ledger);
  const time = new Date(now).toISOString();
  const results: CancelResult[] = [];
  const seen = new Set<string>();
  for (const raw of orderIds) {
    const id = typeof raw === 'string' ? raw.toLowerCase() : '';
    if (!UUID.test(id) || seen.has(id)) throw argError('order_ids must be distinct UUIDs', 'Pass order_ids=UUID1,UUID2. Nothing was cancelled.');
    seen.add(id);
    const order = work.orders.get(id);
    if (!order) {
      results.push({ order_id: id, success: false, error: { code: 'ORDER_NOT_FOUND', message: `No paper order ${id} exists in this account.`, hint: 'Check the ID and --data-dir with coinbase-paper orders list.' } });
      continue;
    }
    if (order.status === 'CANCELLED') {
      results.push({ order_id: id, success: true, status: 'CANCELLED' });
      continue;
    }
    if (order.status === 'FILLED' || order.status === 'EXPIRED') {
      results.push({ order_id: id, success: false, error: { code: 'PAPER_ORDER_NOT_OPEN', message: `Order ${id} is ${order.status}; this operation requires an open order.`, hint: `Run coinbase-paper orders get ${id}. Completed executions cannot be edited or undone.`, details: { order_id: id, status: order.status } } });
      continue;
    }
    const pending = order.status === 'PENDING';
    finish(work, order, 'CANCELLED', time, pending ? 'CANCELLED_BEFORE_EXECUTION' : 'USER_CANCELLED', ['cancel']);
    if (pending) work.bases.set(id, { source: {}, assumptions: { model_version: ORDER_MODEL_VERSION }, notice: PAPER_NOTICE });
    results.push({ order_id: id, success: true, status: 'CANCELLED' });
  }
  const rows = finishWork(work);
  for (const order of rows.orders) {
    if (order.terminal_reason === 'CANCELLED_BEFORE_EXECUTION' && ledger.orders.find((row) => row.order_id === order.order_id)?.status === 'PENDING') {
      rows.acceptances.push({ request_id: order.order_id, terms: '', receipt: JSON.stringify(order.current_receipt) });
    }
  }
  return { ...rows, results };
}

export type { OrderStatus };
