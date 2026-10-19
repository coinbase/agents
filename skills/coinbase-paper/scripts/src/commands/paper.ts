// coinbase-paper — local PAPER trading simulator: virtual funds, public market data, never live orders.
//
// Everything here is local accounting; it never reads credentials and never calls an authenticated
// Coinbase API. Store, engine, and market modules load lazily so help and parsing stay fast.
//
// Trading commands mirror the live grammar (`orders create product_id=... side=... type=limit ...`),
// so switching between practice and real trading is the `paper` prefix and nothing else.
//
// Resting orders are evaluated lazily: every account command runs exactly one reconciliation pass
// against completed public candles before it acts, and reports what it used. There is no daemon.

import { randomUUID } from 'node:crypto';
import { parseInputDecimal } from '../paper/decimal.ts';
import { REQUEST_BUDGET } from '../paper/market-data.ts';
import { PAPER_MODE, PAPER_NOTICE, PaperError } from '../paper/types.ts';
import type {
  AccountSnapshot, ClosePositionInput, CommandMarketData, EditOrderInput, LedgerSnapshot, MarketData, OrderInput, OrderIntent,
  Page, PaperOptions, PaperPaths, PlacementMarket, PlacementProvenance, ReconciliationReport,
} from '../paper/types.ts';
import type { PaperStore } from '../paper/store.ts';
import type { BalanceResult } from '../paper/balance.ts';
import type { PerformancePeriod, PerformanceRequest, PerformanceResult } from '../paper/performance.ts';
import type { ResetResult } from '../paper/reset.ts';

const MAX_REFRESH_POSITIONS = 100;
const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 50;
const MAX_CANCEL_IDS = 100;
const HOST_DURABILITY = 'UNVERIFIED: this simulator cannot certify that the host keeps the data directory across sessions, VMs, or machines; confirm durable storage with the host.';
const CANDLE_NOTICE = 'PAPER research data: public Coinbase candles. This command never fills or marks orders; account commands reconcile resting orders against completed candles separately.';
const NO_LIVE_HINT = 'Paper commands are always simulated. Do not fall back to a live trading command.';
const DISCLAIMER = 'Preview feature. Paper trading runs locally on this device with virtual funds; only public market data is read from Coinbase and no order is ever sent. Simulated fills use public order-book snapshots, completed public candles and assumed fees, so real orders can fill at different prices, sizes, fees and times. Paper results do not predict or guarantee live results.';
const FEE_NOTE = 'maker_fee_bps and taker_fee_bps are assumed fees, not your Coinbase fee tier (fee_bps is a deprecated alias of the taker fee). For realistic costs, with the user\'s consent run the read-only `coinbase fees` (uses their API key) and create a NEW paper account with --maker-fee-bps = fee_tier.maker_fee_rate x 10000 and --taker-fee-bps = fee_tier.taker_fee_rate x 10000 (for example 0.006 -> 60). Paper itself never reads credentials.';
const STALE_NOTICE = 'Reconciliation is STALE: open orders were not evaluated against recent candles, so no fills, triggers or expiries were applied and holds are unchanged.';
const CANCEL_STALE_NOTICE = 'Historical reconciliation was unavailable: cancel released only the currently stored remainder; fills that recent candles might have produced were not evaluated.';
const RESET_NOTICE = 'Reset created a NEW paper account with the same settings and archived the old one first; the old account file was kept.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Crypto product ids never contain a dot, so a dotted id (BRK.B-USD) needs no crypto lookup.
const CRYPTO_PRODUCT = /^[A-Z0-9]{1,15}-[A-Z0-9]{1,10}$/;
const FILTER_PRODUCT = /^[A-Z0-9][A-Z0-9.]{0,14}-[A-Z0-9]{1,10}$/;
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;
const CURSOR = /^[A-Za-z0-9_-]{1,4096}$/;

type Json = Record<string, unknown>;
type FlagSpec = { value: boolean; required?: boolean };
interface CommandSpec {
  positionals: string[];
  flags: Record<string, FlagSpec>;
  /** Live-style `key=value` fields. */
  fields?: readonly string[];
  /** Read filters also accept live query syntax `key==value`. */
  query?: boolean;
  /** Fields that also accept a JSON string array via `key:=[...]`. */
  arrays?: readonly string[];
}

const FORMAT: Record<string, FlagSpec> = { format: { value: true } };
const ACCOUNT: Record<string, FlagSpec> = { 'data-dir': { value: true }, ...FORMAT };
const QUOTE_FIELDS = ['reference_price', 'price_source', 'price_as_of'] as const;
const ATTACHED_FIELDS = ['attached_take_profit_price', 'attached_stop_loss_price'] as const;
const CREATE_FIELDS = [
  'product_id', 'side', 'type', 'base_size', 'quote_size', 'client_order_id', 'time_in_force', 'end_time',
  'limit_price', 'stop_price', 'stop_direction', 'post_only', ...ATTACHED_FIELDS, ...QUOTE_FIELDS,
] as const;
const LIST_FIELDS = ['status', 'product_ids', 'side', 'product_type', 'start', 'end', 'limit', 'cursor'] as const;
const FILLS_FIELDS = ['order_ids', 'product_ids', 'side', 'start', 'end', 'limit', 'cursor'] as const;
const ACTIVITY_FIELDS = ['order_ids', 'product_ids', 'start', 'end', 'limit', 'cursor'] as const;
const EDIT_FIELDS = ['base_size', 'limit_price', ...ATTACHED_FIELDS, 'cancel_attached_order'] as const;
const CLOSE_FIELDS = ['client_order_id', 'product_id', 'size', ...QUOTE_FIELDS] as const;
const ORDER_TYPES = ['market', 'limit', 'stoplimit', 'bracket'] as const;
const DEFERRED_TYPES = new Set(['twap', 'scaled', 'stop', 'stop_market', 'stopmarket', 'trailing_stop', 'trailing']);
const STATUSES = ['PENDING', 'OPEN', 'FILLED', 'CANCELLED', 'EXPIRED'] as const;
const PERIODS = ['1D', '1W', '1M', 'ALL'] as const;

// Per-command allowed flags and fields. Anything else fails closed.
const COMMANDS: Record<string, CommandSpec> = {
  doctor: { positionals: [], flags: { ...ACCOUNT } },
  init: {
    positionals: [],
    flags: { ...ACCOUNT, cash: { value: true }, currency: { value: true }, 'fee-bps': { value: true }, 'maker-fee-bps': { value: true }, 'taker-fee-bps': { value: true } },
  },
  bind: { positionals: [], flags: { ...ACCOUNT, state: { value: true, required: true }, 'account-id': { value: true, required: true } } },
  balance: { positionals: [], flags: { ...ACCOUNT, refresh: { value: false } } },
  'orders create': { positionals: [], flags: { ...ACCOUNT }, fields: CREATE_FIELDS },
  'orders get': { positionals: ['ORDER_ID'], flags: { ...ACCOUNT } },
  'orders list': { positionals: [], flags: { ...ACCOUNT }, fields: LIST_FIELDS, query: true },
  'orders fills': { positionals: [], flags: { ...ACCOUNT }, fields: FILLS_FIELDS, query: true, arrays: ['order_ids'] },
  'orders cancel': { positionals: [], flags: { ...ACCOUNT }, fields: ['order_ids'], arrays: ['order_ids'] },
  'orders edit': { positionals: ['ORDER_ID'], flags: { ...ACCOUNT }, fields: EDIT_FIELDS },
  'orders close-position': { positionals: [], flags: { ...ACCOUNT }, fields: CLOSE_FIELDS },
  'orders preview': { positionals: [], flags: { ...ACCOUNT } },
  activity: { positionals: [], flags: { ...ACCOUNT }, fields: ACTIVITY_FIELDS, query: true, arrays: ['order_ids'] },
  performance: { positionals: [], flags: { ...ACCOUNT, period: { value: true }, chart: { value: false } } },
  reset: { positionals: [], flags: { ...ACCOUNT, confirm: { value: false } } },
  backup: { positionals: [], flags: { ...ACCOUNT, output: { value: true, required: true } } },
  candles: { positionals: ['PRODUCT'], flags: { ...FORMAT, start: { value: true, required: true }, end: { value: true, required: true }, granularity: { value: true, required: true } } },
};

// Earlier preview names map to the live-mirrored commands.
const RENAMED: Record<string, string> = {
  buy: 'coinbase-paper orders create product_id=BTC-USD side=BUY type=market quote_size=100 client_order_id=<UUID>',
  sell: 'coinbase-paper orders create product_id=BTC-USD side=SELL type=market base_size=0.001 client_order_id=<UUID>',
  status: 'coinbase-paper balance [--refresh]',
  history: 'coinbase-paper orders list [limit=50]',
};

const ORDER_SUBCOMMANDS = 'create, get, list, fills, cancel, edit, close-position';
const COMMAND_LIST = `doctor, init, bind, balance, orders (${ORDER_SUBCOMMANDS}), activity, performance, reset, backup, candles`;

export interface ParsedPaperArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | true>;
  fields: Record<string, string>;
}

export type PaperParse = { help: string } | ParsedPaperArgs;

function flagHint(name: string): string {
  if (name === 'env' || name === 'e') return 'Paper never uses a Coinbase environment or credentials; remove --env. To choose an account, pass --data-dir ABS.';
  if (name === 'paper') return 'Commands under coinbase-paper are always simulated; remove --paper.';
  if (name === 'live' || name === 'real') return 'Paper has no live mode. Real trading is a separate, explicitly approved workflow (coinbase orders ...), never a paper fallback.';
  return 'Run coinbase-paper --help for the flags each command accepts.';
}

function orderHint(): string {
  return 'Paper simulates type=market|limit|stoplimit|bracket: product_id, side=BUY|SELL, type and exactly one of base_size or quote_size, plus client_order_id=<new UUID>. Run coinbase-paper orders create --help for each type\'s fields.';
}

function unsupportedOperation(operation: string): PaperError {
  return new PaperError('PAPER_UNSUPPORTED_OPERATION', `paper ${operation} is not simulated.`, 'This paper feature does not support previews/streaming. Use the documented paper commands; nothing was placed. Do not fall back to live trading.');
}

function invalid(message: string, hint: string): PaperError {
  return new PaperError('INVALID_ARGUMENT', message, hint);
}

/**
 * Pure parser for `coinbase-paper ...` arguments (without the leading `paper`). Throws PaperError.
 * `now` (ms) enables checks against the clock, such as a future GTD end_time.
 */
export function parsePaperArgs(args: string[], now?: number): PaperParse {
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help' || args[0] === 'help') {
    const topic = args[0] === 'help' ? args.slice(1).join(' ') : '';
    return { help: topic && COMMANDS[topic] ? commandHelp(topic) : topic === 'orders' ? ORDERS_HELP : PAPER_HELP };
  }
  let [command, ...rest] = args;
  if (command === 'orders') {
    const sub = rest[0];
    if (sub === undefined || sub === '-h' || sub === '--help' || sub === 'help') return { help: ORDERS_HELP };
    command = `orders ${sub}`;
    rest = rest.slice(1);
    if (!COMMANDS[command]) {
      throw new PaperError('UNKNOWN_COMMAND', `unknown paper command "${command}"`, `Paper orders supports ${ORDER_SUBCOMMANDS}. Previews are not simulated.`);
    }
  }
  const spec = COMMANDS[command];
  if (!spec) {
    if (command.startsWith('-')) {
      const name = command.replace(/^-+/, '').split('=')[0];
      throw invalid(`unknown flag ${command.split('=')[0]} before a paper command`, flagHint(name));
    }
    if (RENAMED[command]) {
      throw new PaperError('UNKNOWN_COMMAND', `paper ${command} was renamed to match live trading commands`, `Use: ${RENAMED[command]}`);
    }
    throw new PaperError('UNKNOWN_COMMAND', `unknown paper command "${command}"`, `Run coinbase-paper --help. Paper supports ${COMMAND_LIST}.`);
  }
  if (rest.includes('-h') || rest.includes('--help')) return { help: commandHelp(command) };
  // Recognized so agents get an explicit paper-only answer, never an execution.
  if (command === 'orders preview') throw unsupportedOperation('orders preview');

  const flags: Record<string, string | true> = {};
  const fields: Record<string, string> = {};
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith('-')) {
      const match = spec.fields ? /^([A-Za-z0-9_]+)(:=|==|=)([\s\S]*)$/.exec(arg) : null;
      if (!match) { positionals.push(arg); continue; }
      const [, key, op, value] = match;
      if (op === '==' && !spec.query) throw invalid(`paper ${command} takes key=value fields, not ${key}==`, `Use ${key}=VALUE.`);
      if (!spec.fields!.includes(key)) throw unsupportedField(command, key);
      if (op === ':=' && !spec.arrays?.includes(key)) throw invalid(`${key}:= is not accepted; := is only for array fields`, `Use ${key}=VALUE.`);
      if (key in fields) throw invalid(`${key} was given more than once`, 'Pass each field once with the exact value you intend.');
      if (value === '') throw invalid(`${key} requires a value`, `Run coinbase-paper ${command} --help.`);
      fields[key] = spec.arrays?.includes(key) ? parseIdArray(key, value, op === ':=') : value;
      continue;
    }
    if (arg === '-') { positionals.push(arg); continue; }
    if (arg === '--') throw invalid('paper commands do not accept "--"', flagHint(''));
    const eq = arg.indexOf('=');
    const display = eq > 0 ? arg.slice(0, eq) : arg;
    const long = arg.startsWith('--');
    const name = display.replace(/^-+/, '');
    const flag = long ? spec.flags[name] : undefined;
    if (!flag) {
      if (long && (name === 'watch' || name === 'until')) throw unsupportedOperation(`streaming (--${name})`);
      throw invalid(`paper ${command} does not accept ${display}`, flagHint(!long && name.startsWith('e') ? 'e' : name));
    }
    if (name in flags) throw invalid(`${display} was given more than once`, 'Pass each flag once with the exact value you intend.');
    if (!flag.value) {
      if (eq > 0) throw invalid(`${display} does not take a value`, `Pass ${display} on its own.`);
      flags[name] = true;
      continue;
    }
    const value = eq > 0 ? arg.slice(eq + 1) : rest[++i];
    if (value === undefined || value === '' || (eq < 0 && value.startsWith('--'))) {
      throw invalid(`${display} requires a value`, `Run coinbase-paper ${command} --help.`);
    }
    flags[name] = value;
  }

  if (positionals.length !== spec.positionals.length) {
    const want = spec.positionals.length ? spec.positionals.join(' ') : 'no positional arguments';
    const hint = command === 'orders create' ? orderHint() : `Run coinbase-paper ${command} --help.`;
    throw invalid(`paper ${command} expects ${want}; got ${positionals.length}`, hint);
  }
  if (command === 'reset' && !flags.confirm) {
    throw new PaperError('PAPER_RESET_CONFIRMATION_REQUIRED', 'Reset requires --confirm; the paper account was not changed.', 'Run coinbase-paper reset --confirm only when the user explicitly wants a fresh account. The old account will be archived first.');
  }
  for (const [name, flag] of Object.entries(spec.flags)) {
    if (flag.required && !(name in flags)) throw invalid(`paper ${command} requires --${name}`, `Run coinbase-paper ${command} --help.`);
  }
  if (flags.format !== undefined && flags.format !== 'json' && flags.format !== 'table') {
    throw invalid('--format must be json or table', 'JSON is the default; pass --format table for a human-readable view.');
  }
  validateCommand(command, positionals, flags, fields, now);
  return { command, positionals, flags, fields };
}

function unsupportedField(command: string, key: string): PaperError {
  if (command === 'orders create') {
    return new PaperError('PAPER_UNSUPPORTED_FIELD', `${key} is not supported in paper orders`, `Supported fields: ${CREATE_FIELDS.join(', ')}. twap/scaled orders, preview_id, portfolio_id, reduce_only, equity session/date fields and futures are not simulated.`);
  }
  if (key === 'order_status') {
    return new PaperError('PAPER_UNSUPPORTED_FIELD', `paper ${command} does not accept order_status`, 'Use status=OPEN|FILLED|CANCELLED|EXPIRED|PENDING, as in coinbase orders list.');
  }
  if (key === 'portfolio_id') {
    return new PaperError('PAPER_UNSUPPORTED_FIELD', `paper ${command} does not accept portfolio_id`, 'Paper accounts have no portfolios; choose an account with --data-dir ABS.');
  }
  if (command === 'orders close-position' && key === 'base_size') {
    return new PaperError('PAPER_UNSUPPORTED_FIELD', 'paper orders close-position takes size, not base_size', 'Pass size=N for a partial close, or omit it to close the full position, as in coinbase orders close-position.');
  }
  const allowed = COMMANDS[command]?.fields?.join(', ') ?? 'none';
  return new PaperError('PAPER_UNSUPPORTED_FIELD', `paper ${command} does not accept ${key}`, `Supported fields: ${allowed}.`);
}

/** Normalized comma-joined lowercase UUIDs from `a,b` or a JSON string array. */
function parseIdArray(key: string, raw: string, json: boolean): string {
  let items: unknown[];
  if (json) {
    try {
      items = JSON.parse(raw);
    } catch {
      throw invalid(`${key} must be a JSON array of order ID strings`, `Example: ${key}:='["<UUID>","<UUID>"]' or ${key}=<UUID>,<UUID>`);
    }
    if (!Array.isArray(items)) throw invalid(`${key} must be a JSON array of order ID strings`, `Example: ${key}:='["<UUID>"]'`);
  } else {
    items = raw.split(',');
  }
  if (items.length === 0) throw invalid(`${key} must list at least one order ID`, `Example: ${key}=<UUID>`);
  const seen = new Set<string>();
  for (const item of items) {
    if (typeof item !== 'string') throw invalid(`${key} members must be strings`, `Example: ${key}:='["<UUID>"]'`);
    if (item === '') throw invalid(`${key} has an empty member`, 'Remove the empty entry or trailing comma.');
    if (!UUID.test(item)) throw invalid(`${key} member "${item.slice(0, 40)}" is not an order ID (UUID)`, 'Find order IDs with coinbase-paper orders list.');
    const id = item.toLowerCase();
    if (seen.has(id)) throw invalid(`${key} lists ${id} more than once`, 'Pass each order ID once.');
    seen.add(id);
  }
  return [...seen].join(',');
}

function idList(value: string | undefined): string[] | undefined {
  return value === undefined ? undefined : value.split(',');
}

/** Strict RFC 3339 with zone and at most millisecond precision, normalized to a UTC ISO string. */
export function parseTimestamp(value: string, key: string): string {
  const m = RFC3339.exec(value);
  const fail = () => invalid(`${key} must be an RFC 3339 time with timezone and at most millisecond precision`, `Example: ${key}=2026-01-15T12:00:00Z`);
  if (!m) throw fail();
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  const millis = Number((m[7] ?? '').padEnd(3, '0'));
  const base = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  const date = new Date(base);
  if (year < 1970 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) throw fail();
  let offset = 0;
  if (m[8] !== 'Z') {
    const hours = Number(m[8].slice(1, 3));
    const minutes = Number(m[8].slice(4, 6));
    if (hours > 23 || minutes > 59) throw fail();
    offset = (m[8][0] === '-' ? -1 : 1) * (hours * 60 + minutes) * 60_000;
  }
  return new Date(base - offset).toISOString();
}

function parseBoolean(value: string, key: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw invalid(`${key} must be true or false`, `Example: ${key}=true`);
}

function checkDecimal(fields: Record<string, string>, key: string): bigint | undefined {
  return key in fields ? parseInputDecimal(fields[key], key) : undefined;
}

function checkProductList(value: string): string {
  const ids = value.split(',');
  const seen = new Set<string>();
  for (const id of ids) {
    if (!FILTER_PRODUCT.test(id)) throw invalid(`product_ids member "${id.slice(0, 40)}" is not a product ID`, 'Use uppercase product IDs such as BTC-USD,ETH-USD.');
    if (seen.has(id)) throw invalid(`product_ids lists ${id} more than once`, 'Pass each product once.');
    seen.add(id);
  }
  return ids.join(',');
}

function checkSide(fields: Record<string, string>, hint: string): void {
  if ('side' in fields && fields.side !== 'BUY' && fields.side !== 'SELL') throw invalid('side must be BUY or SELL', hint);
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!/^[1-9]\d{0,3}$/.test(value) || Number(value) > MAX_LIMIT) {
    throw invalid(`limit must be an integer 1-${MAX_LIMIT}`, 'Example: coinbase-paper orders list limit=20');
  }
  return Number(value);
}

function checkFilters(command: string, fields: Record<string, string>): void {
  checkSide(fields, `Example: coinbase-paper ${command} side==BUY`);
  if ('product_ids' in fields) fields.product_ids = checkProductList(fields.product_ids);
  if ('status' in fields && !(STATUSES as readonly string[]).includes(fields.status)) {
    throw invalid(`status must be one of ${STATUSES.join(', ')}`, 'Partial fills stay OPEN; inspect filled_size and remaining_size. Example: coinbase-paper orders list status=OPEN');
  }
  if ('product_type' in fields && !['SPOT', 'EQUITY', 'FUTURE'].includes(fields.product_type)) {
    throw invalid('product_type must be SPOT, EQUITY or FUTURE', 'Paper accounts hold SPOT crypto and EQUITY positions only.');
  }
  for (const key of ['start', 'end'] as const) if (key in fields) fields[key] = parseTimestamp(fields[key], key);
  if (fields.start !== undefined && fields.end !== undefined && fields.start >= fields.end) {
    throw invalid('start must be before end (start is inclusive, end is exclusive)', `Example: start=2026-01-01T00:00:00Z end=2026-02-01T00:00:00Z`);
  }
  parseLimit(fields.limit);
  if ('cursor' in fields && !CURSOR.test(fields.cursor)) {
    throw new PaperError('PAPER_INVALID_CURSOR', 'The pagination cursor is invalid or does not match this account, resource, or filter.', 'Restart the query without cursor, keeping the intended filters.');
  }
}

function equityTypeError(type: string): PaperError {
  return new PaperError('PAPER_UNSUPPORTED_ORDER_TYPE', `Equity paper orders support type=market with a supplied quote; ${type} is not simulated.`, 'Place an equity type=market order with reference_price, price_source and price_as_of from a current quote you showed the user. Do not substitute crypto candles or any other price.');
}

function validateCommand(command: string, positionals: string[], flags: Record<string, string | true>, fields: Record<string, string>, now: number | undefined): void {
  switch (command) {
    case 'init':
      if ('fee-bps' in flags && ('maker-fee-bps' in flags || 'taker-fee-bps' in flags)) {
        throw invalid('--fee-bps cannot be combined with --maker-fee-bps or --taker-fee-bps', 'Pass --fee-bps N to set both rates, or set each with --maker-fee-bps and --taker-fee-bps.');
      }
      return;
    case 'orders create':
      return validateCreate(fields, now);
    case 'orders get':
    case 'orders edit':
      if (!UUID.test(positionals[0])) throw invalid('ORDER_ID must be the order\'s ID (a UUID)', 'Find it with coinbase-paper orders list.');
      positionals[0] = positionals[0].toLowerCase();
      if (command === 'orders edit') validateEdit(fields);
      return;
    case 'orders list':
    case 'orders fills':
    case 'activity':
      return checkFilters(command, fields);
    case 'orders cancel': {
      if (!('order_ids' in fields)) throw invalid('paper orders cancel requires order_ids', 'Example: coinbase-paper orders cancel order_ids=<UUID>,<UUID> (or order_ids:=\'["<UUID>"]\')');
      const count = fields.order_ids.split(',').length;
      if (count > MAX_CANCEL_IDS) throw invalid(`paper orders cancel accepts at most ${MAX_CANCEL_IDS} order IDs; got ${count}`, 'Split the cancel into batches of at most 100 IDs.');
      return;
    }
    case 'orders close-position':
      for (const key of ['client_order_id', 'product_id'] as const) {
        if (!(key in fields)) throw invalid(`paper orders close-position requires ${key}`, 'Example: coinbase-paper orders close-position client_order_id=<new UUID> product_id=BTC-USD [size=N]');
      }
      checkClientId(fields);
      checkDecimal(fields, 'size');
      return;
    case 'performance':
      if (flags.period !== undefined && !(PERIODS as readonly string[]).includes(flags.period as string)) {
        throw invalid(`--period must be one of ${PERIODS.join(', ')}`, 'Example: coinbase-paper performance --period 1W --chart');
      }
      return;
  }
}

function checkClientId(fields: Record<string, string>): void {
  if (!('client_order_id' in fields)) return;
  if (!UUID.test(fields.client_order_id)) {
    throw invalid('client_order_id must be a UUID', 'Generate one new UUID per new order (for example: node -e "console.log(crypto.randomUUID())") and reuse it only to retry that exact order.');
  }
  fields.client_order_id = fields.client_order_id.toLowerCase();
}

// Fields each type accepts beyond product_id, side, type, one size and client_order_id.
const TYPE_FIELDS: Record<string, readonly string[]> = {
  market: ['time_in_force', ...ATTACHED_FIELDS, ...QUOTE_FIELDS],
  limit: ['limit_price', 'post_only', 'time_in_force', 'end_time', ...ATTACHED_FIELDS],
  stoplimit: ['limit_price', 'stop_price', 'stop_direction', 'time_in_force', 'end_time'],
  bracket: ['limit_price', 'stop_price', 'time_in_force', 'end_time'],
};
const TYPE_TIF: Record<string, readonly string[]> = {
  market: ['IOC', 'FOK'],
  limit: ['GTC', 'GTD', 'IOC', 'FOK'],
  stoplimit: ['GTC', 'GTD'],
  bracket: ['GTC', 'GTD'],
};

function validateCreate(fields: Record<string, string>, now: number | undefined): void {
  for (const key of ['product_id', 'side', 'type'] as const) {
    if (!(key in fields)) throw invalid(`paper orders create requires ${key}`, orderHint());
  }
  const type = fields.type;
  const dotted = fields.product_id.includes('.');
  if (!(ORDER_TYPES as readonly string[]).includes(type)) {
    const deferred = DEFERRED_TYPES.has(type.toLowerCase());
    const lower = type.toLowerCase();
    if ((ORDER_TYPES as readonly string[]).includes(lower)) {
      throw invalid(`type=${type} must be lowercase, like the live CLI: type=${lower}`, orderHint());
    }
    throw new PaperError('PAPER_UNSUPPORTED_ORDER_TYPE', `type=${type} is not simulated; paper supports ${ORDER_TYPES.join(', ')}`, deferred
      ? 'twap, scaled, stop-market and trailing-stop orders are not simulated. Use a limit, stoplimit or bracket order, or explain the limitation to the user.'
      : orderHint());
  }
  // Dotted tickers are always equities, so their order-type limits apply before any lookup.
  if (dotted && (type !== 'market' || ATTACHED_FIELDS.some((key) => key in fields))) throw equityTypeError(ATTACHED_FIELDS.some((key) => key in fields) && type === 'market' ? 'attached exits' : `type=${type}`);
  if (type !== 'market' && QUOTE_FIELDS.some((key) => key in fields)) throw equityTypeError(`type=${type}`);
  if (fields.side !== 'BUY' && fields.side !== 'SELL') throw invalid('side must be BUY or SELL', orderHint());
  if (('base_size' in fields) === ('quote_size' in fields)) {
    throw invalid('paper orders create requires exactly one of base_size or quote_size', 'base_size is the asset quantity. quote_size: market BUY spends it including the fee; limit and market SELL convert it to base_size; stoplimit and bracket require base_size.');
  }
  for (const key of CREATE_FIELDS) {
    if (!(key in fields) || ['product_id', 'side', 'type', 'base_size', 'quote_size', 'client_order_id'].includes(key)) continue;
    if (!TYPE_FIELDS[type].includes(key)) throw invalid(`${key} does not apply to type=${type}`, `type=${type} accepts: ${TYPE_FIELDS[type].join(', ')}. Run coinbase-paper orders create --help.`);
  }
  if ((type === 'stoplimit' || type === 'bracket') && !('base_size' in fields)) throw invalid(`type=${type} requires base_size`, 'Pass the asset quantity as base_size.');
  if (type === 'bracket' && fields.side !== 'SELL') {
    throw invalid('spot type=bracket requires side=SELL', 'For an entry with exits, use a market or limit BUY with attached_take_profit_price and/or attached_stop_loss_price.');
  }
  if (dotted && fields.side === 'SELL' && 'quote_size' in fields) {
    throw new PaperError('PAPER_UNSUPPORTED_FIELD', 'paper equity SELL orders take base_size, not quote_size', 'Pass the number of shares to sell as base_size.');
  }
  const required: Record<string, readonly string[]> = { market: [], limit: ['limit_price'], stoplimit: ['limit_price', 'stop_price', 'stop_direction'], bracket: ['limit_price', 'stop_price'] };
  for (const key of required[type]) {
    if (!(key in fields)) throw invalid(`type=${type} requires ${key}`, `type=${type} needs ${required[type].join(', ')}. Run coinbase-paper orders create --help.`);
  }
  checkClientId(fields);
  for (const key of ['base_size', 'quote_size'] as const) checkDecimal(fields, key);
  const limit = checkDecimal(fields, 'limit_price');
  const stop = checkDecimal(fields, 'stop_price');
  const takeProfit = checkDecimal(fields, 'attached_take_profit_price');
  const stopLoss = checkDecimal(fields, 'attached_stop_loss_price');

  if ('time_in_force' in fields && !TYPE_TIF[type].includes(fields.time_in_force)) {
    throw invalid(`time_in_force=${fields.time_in_force} is not valid for type=${type}`, `type=${type} accepts time_in_force ${TYPE_TIF[type].join(', ')}${type === 'market' ? '' : ' (default GTC)'}.`);
  }
  const gtd = fields.time_in_force === 'GTD';
  if (gtd !== ('end_time' in fields)) {
    throw invalid(gtd ? 'time_in_force=GTD requires end_time' : 'end_time requires time_in_force=GTD', 'Example: time_in_force=GTD end_time=2026-12-31T23:59:59Z');
  }
  if (gtd) {
    fields.end_time = parseTimestamp(fields.end_time, 'end_time');
    if (now !== undefined && Date.parse(fields.end_time) <= now) throw invalid('end_time must be in the future', 'Choose a later end_time for a GTD order.');
  }
  if ('post_only' in fields && parseBoolean(fields.post_only, 'post_only') && fields.time_in_force !== undefined && !gtd && fields.time_in_force !== 'GTC') {
    throw invalid('post_only=true requires time_in_force GTC or GTD', 'A post-only order rests on the book; IOC and FOK orders take liquidity.');
  }
  if ('stop_direction' in fields) {
    const direction = { up: 'STOP_DIRECTION_STOP_UP', down: 'STOP_DIRECTION_STOP_DOWN', STOP_DIRECTION_STOP_UP: 'STOP_DIRECTION_STOP_UP', STOP_DIRECTION_STOP_DOWN: 'STOP_DIRECTION_STOP_DOWN' }[fields.stop_direction];
    if (!direction) throw invalid('stop_direction must be up, down, STOP_DIRECTION_STOP_UP or STOP_DIRECTION_STOP_DOWN', 'up triggers when the price rises to stop_price; down when it falls to it.');
    fields.stop_direction = direction;
  }
  if (type === 'bracket' && stop !== undefined && limit !== undefined && stop >= limit) {
    throw invalid('a SELL bracket needs stop_price below limit_price', 'limit_price is the take-profit; stop_price is the stop-loss trigger.');
  }
  if (takeProfit !== undefined || stopLoss !== undefined) {
    if (fields.side !== 'BUY') throw invalid('attached exits apply only to BUY parents', 'Attach exits to a market or limit BUY; for a SELL exit use type=bracket.');
    if (takeProfit !== undefined && stopLoss !== undefined && stopLoss >= takeProfit) {
      throw invalid('attached_stop_loss_price must be below attached_take_profit_price', 'Pass a take-profit above the stop-loss trigger.');
    }
  }
}

function validateEdit(fields: Record<string, string>): void {
  const hint = 'Example: coinbase-paper orders edit <ORDER_ID> limit_price=64000 [base_size=N] [attached_take_profit_price=N attached_stop_loss_price=N | cancel_attached_order=true]';
  for (const key of ['base_size', 'limit_price', ...ATTACHED_FIELDS]) checkDecimal(fields, key);
  const cancelAttached = 'cancel_attached_order' in fields ? parseBoolean(fields.cancel_attached_order, 'cancel_attached_order') : false;
  const attached = ATTACHED_FIELDS.some((key) => key in fields);
  if (cancelAttached && attached) throw invalid('cancel_attached_order cannot be combined with attached_take_profit_price or attached_stop_loss_price', 'Either remove both exits with cancel_attached_order=true, or replace them by sending both attached prices.');
  if (!cancelAttached && !attached && !('base_size' in fields) && !('limit_price' in fields)) {
    throw invalid('paper orders edit requires at least one change', hint);
  }
  const tp = checkDecimal(fields, 'attached_take_profit_price');
  const sl = checkDecimal(fields, 'attached_stop_loss_price');
  if (tp !== undefined && sl !== undefined && sl >= tp) throw invalid('attached_stop_loss_price must be below attached_take_profit_price', 'Pass a take-profit above the stop-loss trigger.');
}

/** Provenance for errors raised after reconciliation or market reads already happened. */
const ERROR_CONTEXT = new WeakMap<PaperError, Json>();

function plainObject(value: unknown): Json | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
}

export function paperErrorJson(err: PaperError): string {
  const error: Json = { code: err.code, message: err.message, hint: err.hint };
  // Structured amounts (available/required/shortfall/hold) set by the engine.
  const details = plainObject((err as PaperError & { details?: unknown }).details);
  if (details) error.details = details;
  return JSON.stringify({ mode: PAPER_MODE, ok: false, error, ...ERROR_CONTEXT.get(err) }, null, 2) + '\n';
}

/** node:sqlite is unflagged from Node 22.13 and 23.4; any 24+ release has it. */
export function sqliteRuntimeSupported(version: string): boolean {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  if (major === 22) return minor >= 13;
  if (major === 23) return minor >= 4;
  return major >= 24;
}

const RUNTIME_HINT = 'Paper storage needs Node.js >=22.13 (22.x) or >=23.4 (23.x); Node 24 LTS is recommended. Upgrade Node, then retry. Do not fall back to a live trading command.';

function assertRuntime(): void {
  if (!sqliteRuntimeSupported(process.versions.node)) {
    throw new PaperError('UNSUPPORTED_RUNTIME', `Node.js ${process.versions.node} lacks the built-in node:sqlite module paper storage needs`, RUNTIME_HINT);
  }
}

function ok(result: object): Json {
  return Object.assign({ mode: PAPER_MODE, ok: true }, result, { mode: PAPER_MODE, ok: true });
}

// ------------------------------------------------------------- engine/store/account seam
//
// The command reads the frozen paper module interfaces (engine, store, reconcile, market-data,
// balance, performance, reset) directly. Tests inject fakes through PaperCommandOptions.services.

export type ReconciliationView = ReconciliationReport;
export type CommandMarketDataView = CommandMarketData;
export type PlacementMarketView = PlacementMarket;
export type PageView = Page<Json>;
export type Provenance = PlacementProvenance;

/** The store operations this command (and reconcile/reset, which it hands the store to) uses. */
export type PaperStoreView = Pick<PaperStore,
  | 'accountId' | 'state' | 'readSnapshot' | 'readLedger' | 'findAcceptance' | 'reserveOrder' | 'abandonReservation' | 'placeOrder' | 'closePosition'
  | 'editOrder' | 'cancelOrders' | 'applyReconciliation' | 'getOrder' | 'listOrders' | 'listFills' | 'listActivity'
  | 'switchBinding' | 'backup' | 'close'>;

export interface PaperServices {
  openAccount(paths: PaperPaths): Promise<PaperStoreView>;
  createCommandMarketData(source: MarketData, options: { provider: string; now: () => number }): Promise<CommandMarketData>;
  reconcileAccount(store: PaperStoreView, market: CommandMarketData, now: number): Promise<ReconciliationReport>;
  normalizeOrderInput(input: OrderInput): Promise<OrderIntent>;
  normalizeClosePositionInput(input: ClosePositionInput): Promise<OrderIntent>;
  normalizeEditInput(input: EditOrderInput): Promise<EditOrderInput>;
  buildBalance(ledger: LedgerSnapshot, books: Readonly<Record<string, unknown>> | null, now: number): Promise<BalanceResult>;
  buildPerformance(ledger: LedgerSnapshot, market: CommandMarketData, request: PerformanceRequest, now: number): Promise<PerformanceResult>;
  resetAccount(paths: PaperPaths, store: PaperStoreView, now: number): Promise<ResetResult>;
}

export interface PaperCommandOptions extends PaperOptions {
  services?: Partial<PaperServices>;
}

const engineModule = async () => import('../paper/engine.ts');

const DEFAULT_SERVICES: PaperServices = {
  async openAccount(paths) {
    const { openAccount } = await import('../paper/store.ts');
    return openAccount(paths);
  },
  async createCommandMarketData(source, options) {
    const { createCommandMarketData } = await import('../paper/market-data.ts');
    return createCommandMarketData(source, options);
  },
  async reconcileAccount(store, market, now) { return (await import('../paper/reconcile.ts')).reconcileAccount(store, market, now); },
  async normalizeOrderInput(input) { return (await engineModule()).normalizeOrderInput(input); },
  async normalizeClosePositionInput(input) { return (await engineModule()).normalizeClosePositionInput(input); },
  async normalizeEditInput(input) { return (await engineModule()).normalizeEditInput(input); },
  async buildBalance(ledger, books, now) { return (await import('../paper/balance.ts')).buildBalance(ledger, books, now); },
  async buildPerformance(ledger, market, request, now) { return (await import('../paper/performance.ts')).buildPerformance(ledger, market, request, now); },
  async resetAccount(paths, store, now) { return (await import('../paper/reset.ts')).resetAccount(paths, store, now); },
};

function servicesFor(options: PaperCommandOptions): PaperServices {
  return { ...DEFAULT_SERVICES, ...options.services };
}

async function sourceFor(options: PaperOptions): Promise<{ md: MarketData; provider: string }> {
  if (options.marketData) return { md: options.marketData, provider: 'injected' };
  const { PublicMarketData } = await import('../paper/market-data.ts');
  return { md: new PublicMarketData(), provider: 'coinbase-public-market-data' };
}

async function resolve(flags: Record<string, string | true>, options: PaperOptions): Promise<PaperPaths> {
  const { resolvePaths } = await import('../paper/store.ts');
  return resolvePaths(flags['data-dir'] as string | undefined, options.env ?? process.env, options.home);
}

interface Session {
  store: PaperStoreView;
  market: CommandMarketDataView;
  reconciliation: ReconciliationView;
  paths: PaperPaths;
  services: PaperServices;
  provider: string;
}

function sourceBlock(session: Session, extra?: unknown): Json {
  return { ...plainObject(extra), provider: session.market.provider ?? session.provider, requests: session.market.stats(), budget: REQUEST_BUDGET };
}

/**
 * Command provenance added to every reconciled success result. An order view keeps its own
 * execution `source` (for example an external quote); this command's requests go in `command_source`.
 */
function envelope(session: Session, output: object, notice: string = PAPER_NOTICE, orderView = false): Json {
  const result = output as Json;
  const stale = session.reconciliation.status === 'STALE';
  const provenance = orderView && plainObject(result.source)
    ? { source: result.source, command_source: sourceBlock(session) }
    : { source: sourceBlock(session, result.source) };
  return {
    ...ok(result),
    reconciliation: session.reconciliation,
    ...provenance,
    notice: stale ? `${notice} ${STALE_NOTICE}` : notice,
  };
}

function staleError(edit = false): PaperError {
  const hint = edit
    ? 'Retry the same edit command after public data is available. Reads and explicit cancels remain available.'
    : 'Retry the same command with the same client_order_id after public data is available. Reads and explicit cancels remain available.';
  return new PaperError('PAPER_RECONCILIATION_STALE', 'Open paper orders could not be reconciled; no new order or edit was executed.', hint);
}

/**
 * Opens the bound account and runs `fn`. Unless `beforeReconcile` returns a result (an immutable
 * replay), it first runs exactly one reconciliation pass in a command-scoped market-data session.
 */
async function withAccount(
  p: ParsedPaperArgs,
  options: PaperCommandOptions,
  now: () => number,
  fn: (session: Session) => Promise<object>,
  beforeReconcile?: (store: PaperStoreView, services: PaperServices) => Promise<object | null>,
): Promise<Json> {
  assertRuntime();
  const services = servicesFor(options);
  const paths = await resolve(p.flags, options);
  const store = await services.openAccount(paths);
  let session: Session | undefined;
  try {
    if (beforeReconcile) {
      const replay = await beforeReconcile(store, services);
      if (replay) return replay as Json;
    }
    const { md, provider } = await sourceFor(options);
    const market = await services.createCommandMarketData(md, { provider, now });
    const reconciliation = await services.reconcileAccount(store, market, now());
    session = { store, market, reconciliation, paths, services, provider };
    return (await fn(session)) as Json;
  } catch (err) {
    if (session && err instanceof PaperError && !ERROR_CONTEXT.has(err)) {
      ERROR_CONTEXT.set(err, { reconciliation: session.reconciliation, source: sourceBlock(session) });
    }
    throw err;
  } finally {
    store.close();
  }
}

async function doctor(flags: Record<string, string | true>, options: PaperOptions): Promise<{ result: Json; healthy: boolean }> {
  const supported = sqliteRuntimeSupported(process.versions.node);
  const runtime: Json = {
    node: process.versions.node,
    supported,
    storage: 'node:sqlite (built-in; not a stable Node API: experimental or release-candidate depending on Node version)',
    minimum: 'Node.js >=22.13 (22.x), >=23.4 (23.x), or 24+; Node 24 LTS recommended',
  };
  if (!supported) runtime.hint = RUNTIME_HINT;
  let account: Json = { status: 'UNCHECKED', reason: 'runtime does not support paper storage' };
  let healthy = supported;
  if (supported) {
    const { doctor: storeDoctor } = await import('../paper/store.ts');
    account = (await storeDoctor(await resolve(flags, options))) as Json;
    if (account.ok === false) healthy = false;
  }
  return {
    result: {
      mode: PAPER_MODE,
      ok: healthy,
      ready: healthy && account.ready === true,
      runtime,
      account,
      host_durability: HOST_DURABILITY,
      network: 'not used by doctor',
      notice: PAPER_NOTICE,
    },
    healthy,
  };
}

/** Public crypto product metadata, or null only after a definitive not-found. Every other failure propagates. */
async function cryptoProduct(md: MarketData, productId: string): Promise<unknown | null> {
  if (!CRYPTO_PRODUCT.test(productId)) return null;
  try {
    return await md.product(productId);
  } catch (err) {
    if (err instanceof PaperError && err.code === 'PRODUCT_NOT_FOUND') return null;
    throw err;
  }
}

function withOrderIds(view: object): Json {
  const receipt = view as Json;
  const id = (receipt.order_id ?? receipt.request_id) as string | undefined;
  return { ...receipt, order_id: id, client_order_id: receipt.client_order_id ?? id };
}

function copyFields(fields: Record<string, string>, keys: readonly string[], into: Json): void {
  for (const key of keys) if (key in fields) into[key] = fields[key];
}

function toOrderInput(fields: Record<string, string>, requestId: string, accountId: string): OrderInput {
  const input: Json = { request_id: requestId, account_id: accountId, product_id: fields.product_id, side: fields.side, type: fields.type };
  copyFields(fields, ['base_size', 'quote_size', 'limit_price', 'stop_price', 'stop_direction', 'time_in_force', 'end_time', ...ATTACHED_FIELDS, ...QUOTE_FIELDS], input);
  if ('post_only' in fields) input.post_only = fields.post_only === 'true';
  // The parser checked the grammar; the engine normalizer validates every term.
  return input as unknown as OrderInput;
}

/** Shared create/close flow: replay before any network, reserve, reconcile once, then place. */
/**
 * Failures after which the PENDING reservation is kept, because a same-ID retry can still succeed
 * (temporary market data or store conditions) or the outcome is uncertain. Any other paper
 * rejection is final for these terms, so its reservation is removed and no orphan order remains.
 */
const RETRYABLE_OR_UNCERTAIN = new Set([
  'MARKET_DATA_UNAVAILABLE', 'MARKET_DATA_INVALID', 'MARKET_DATA_INCOMPLETE', 'INVALID_BOOK', 'STALE_BOOK', 'INVALID_CANDLES',
  'PRODUCT_UNAVAILABLE', 'PAPER_RECONCILIATION_STALE', 'STATE_INVALID', 'STATE_UNSUPPORTED', 'STATE_PATH_UNAVAILABLE', 'STATE_NOT_FOUND',
  'STATE_CLOSED', 'STATE_BUSY', 'STATE_CHANGED', 'INTENT_NOT_RESERVED', 'IDEMPOTENCY_CONFLICT', 'ACCOUNT_MISMATCH', 'HOME_UNAVAILABLE', 'INTERNAL_ERROR',
  'PAPER_REQUEST_BUDGET_EXCEEDED',
]);
/** Any market-data, state or availability failure keeps the reservation; only known final rejections remove it. */
function keepsReservation(code: string): boolean {
  // A stale equity quote is final: the quote is part of the terms and only gets older.
  if (code === 'EXTERNAL_QUOTE_STALE') return false;
  return RETRYABLE_OR_UNCERTAIN.has(code) || /^(MARKET_|STATE_)|STALE|UNAVAILABLE|BUSY/.test(code);
}

async function placeFlow(
  p: ParsedPaperArgs,
  options: PaperCommandOptions,
  now: () => number,
  normalize: (services: PaperServices, snapshot: AccountSnapshot) => Promise<OrderIntent>,
  checkBeforeReserve: (snapshot: AccountSnapshot) => void,
  placement: (session: Session, snapshot: AccountSnapshot) => Promise<PlacementMarketView>,
): Promise<Json> {
  let intent: OrderIntent;
  let snapshot: AccountSnapshot;
  return withAccount(p, options, now, async (session) => {
    if (session.reconciliation.status === 'STALE') {
      // A concurrent same-ID command may have won while this one reconciled; return its stored result.
      const winner = session.store.findAcceptance(intent);
      if (winner) return winner;
      throw staleError();
    }
    try {
      const market = await placement(session, snapshot);
      return session.store.placeOrder(intent, market, now, { reconciliation: session.reconciliation, requests: session.market.stats(), provider: session.market.provider });
    } catch (error) {
      // A rejection no retry can fix leaves no orphan PENDING order behind; transient failures keep the reservation for a same-ID retry.
      if (error instanceof PaperError && !keepsReservation(error.code)) session.store.abandonReservation(intent);
      throw error;
    }
  }, async (store, services) => {
    snapshot = store.readSnapshot();
    intent = await normalize(services, snapshot);
    // Immutable terms are matched, or the original result returned, before any market read.
    const accepted = store.findAcceptance(intent);
    if (accepted) return accepted;
    checkBeforeReserve(snapshot);
    return store.reserveOrder(intent, now());
  });
}

async function cryptoPlacement(session: Session, product: unknown, productId: string): Promise<PlacementMarketView> {
  return { kind: 'crypto', product, book: await session.market.book(productId) };
}

async function createOrder(p: ParsedPaperArgs, options: PaperCommandOptions, now: () => number): Promise<Json> {
  const f = p.fields;
  const generated = !('client_order_id' in f);
  const clientOrderId = f.client_order_id ?? randomUUID();
  const receipt = await placeFlow(p, options, now,
    (services, snapshot) => services.normalizeOrderInput(toOrderInput(f, clientOrderId, snapshot.account.account_id)),
    () => {},
    async (session, snapshot) => {
      const { EQUITY_PRODUCT, classConflict, externalQuoteRequired, referenceOnCrypto, resolveEquityMetadata } = await import('../paper/engine.ts');
      const product = await cryptoProduct(session.market, f.product_id);
      if (product !== null) {
        if (f.reference_price !== undefined) throw referenceOnCrypto();
        return cryptoPlacement(session, product, f.product_id);
      }
      if (snapshot.positions.some((pos) => pos.product_id === f.product_id && pos.asset_class !== 'EQUITY')) {
        throw classConflict(f.product_id, 'a crypto', 'an equity');
      }
      if (!EQUITY_PRODUCT.test(f.product_id)) {
        throw new PaperError('PRODUCT_NOT_FOUND', `${f.product_id} is not a Coinbase crypto product`, 'Check the product_id. Equities use a ticker quoted in USD or USDC, such as AAPL-USD, with an external quote.');
      }
      if (f.type !== 'market') throw equityTypeError(`type=${f.type}`);
      if (ATTACHED_FIELDS.some((key) => key in f)) throw equityTypeError('attached exits');
      if (f.side === 'SELL' && 'quote_size' in f) {
        throw new PaperError('PAPER_UNSUPPORTED_FIELD', 'paper equity SELL orders take base_size, not quote_size', 'Pass the number of shares to sell as base_size.');
      }
      if (f.reference_price === undefined) throw externalQuoteRequired(f.product_id);
      // Coinbase's public equity listing is not searchable by ticker, so instrument details are assumed and labeled.
      return { kind: 'equity', metadata: resolveEquityMetadata(null, f.product_id) };
    });
  const result = withOrderIds(receipt);
  if (generated) {
    result.client_order_id_generated = true;
    result.retry_hint = `No client_order_id was passed, so ${clientOrderId} was generated. To retry this exact order safely, rerun it with client_order_id=${clientOrderId}; use a new client_order_id for any other order.`;
  }
  return result;
}

async function closePosition(p: ParsedPaperArgs, options: PaperCommandOptions, now: () => number): Promise<Json> {
  const f = p.fields;
  const held = (snapshot: AccountSnapshot) => snapshot.positions.find((pos) => pos.product_id === f.product_id && /[1-9]/.test(pos.quantity));
  const receipt = await placeFlow(p, options, now,
    (services, snapshot) => {
      const input: Json = { request_id: f.client_order_id, account_id: snapshot.account.account_id, product_id: f.product_id };
      copyFields(f, ['size', ...QUOTE_FIELDS], input);
      return services.normalizeClosePositionInput(input as unknown as ClosePositionInput);
    },
    (snapshot) => {
      if (!held(snapshot)) throw new PaperError('PAPER_NO_POSITION', `No open paper position exists for ${f.product_id}.`, 'Run coinbase-paper balance and check --data-dir and product_id.');
    },
    async (session, snapshot) => {
      const { externalQuoteRequired, referenceOnCrypto, resolveEquityMetadata } = await import('../paper/engine.ts');
      const position = held(snapshot);
      if (!position) throw new PaperError('PAPER_NO_POSITION', `No open paper position exists for ${f.product_id}.`, 'Run coinbase-paper balance and check --data-dir and product_id.');
      if (position.asset_class === 'EQUITY') {
        if (f.reference_price === undefined) throw externalQuoteRequired(f.product_id);
        return { kind: 'equity', metadata: resolveEquityMetadata(null, f.product_id) };
      }
      if (f.reference_price !== undefined) throw referenceOnCrypto();
      return cryptoPlacement(session, await session.market.product(f.product_id), f.product_id);
    });
  return { ...withOrderIds(receipt), success: true };
}

function sameDecimal(a: unknown, b: string): boolean {
  if (typeof a !== 'string') return false;
  try { return parseInputDecimal(a, 'current') === parseInputDecimal(b, 'edit'); } catch { return false; }
}

/** True when every supplied edit term already matches the order, so no book read is needed. */
export function editIsNoop(view: object, fields: Record<string, string>): boolean {
  const order = view as Json;
  const config = plainObject(order.order_configuration) ?? {};
  const attached = plainObject(order.attached_order_configuration);
  if ('base_size' in fields && !sameDecimal(config.base_size, fields.base_size)) return false;
  if ('limit_price' in fields && !sameDecimal(config.limit_price, fields.limit_price)) return false;
  if (fields.cancel_attached_order === 'true') return attached === null || ATTACHED_FIELDS.every((key) => attached[key] == null);
  if (ATTACHED_FIELDS.some((key) => key in fields)) {
    // A supplied attachment replaces both legs.
    for (const key of ATTACHED_FIELDS) {
      const current = attached?.[key] ?? null;
      if (key in fields ? !sameDecimal(current, fields[key]) : current !== null) return false;
    }
  }
  return true;
}

function orderNotFound(): PaperError {
  return new PaperError('ORDER_NOT_FOUND', 'No paper order has that ID in this account.', 'Check the ID and --data-dir with coinbase-paper orders list. Nothing was changed.');
}

async function editOrder(p: ParsedPaperArgs, options: PaperCommandOptions, now: () => number): Promise<Json> {
  const id = p.positionals[0];
  return withAccount(p, options, now, async (session) => {
    const edit: Json = {};
    copyFields(p.fields, ['base_size', 'limit_price', ...ATTACHED_FIELDS], edit);
    if ('cancel_attached_order' in p.fields) edit.cancel_attached_order = p.fields.cancel_attached_order === 'true';
    const normalized = await session.services.normalizeEditInput(edit as EditOrderInput);
    const order = session.store.getOrder(id);
    if (!order) throw orderNotFound();
    // Ineligible orders and no-op edits are answered from stored state without a book read.
    if (order.status !== 'OPEN' || editIsNoop(order, p.fields)) {
      return envelope(session, session.store.editOrder(id, normalized, null, now), PAPER_NOTICE, true);
    }
    if (session.reconciliation.status === 'STALE') throw staleError(true);
    const book = await session.market.book(order.product_id as string);
    // Saved admitted product rules apply; the edit reads no product metadata.
    return envelope(session, session.store.editOrder(id, normalized, { kind: 'crypto', product: null, book }, now), PAPER_NOTICE, true);
  });
}

async function cancelOrders(p: ParsedPaperArgs, options: PaperCommandOptions, now: () => number): Promise<Json> {
  return withAccount(p, options, now, async (session) => {
    const results = session.store.cancelOrders(idList(p.fields.order_ids)!, now());
    const stale = session.reconciliation.status === 'STALE';
    const result = envelope(session, { results });
    if (stale) result.notice = `${PAPER_NOTICE} ${CANCEL_STALE_NOTICE}`;
    return result;
  });
}

async function getOrder(p: ParsedPaperArgs, options: PaperCommandOptions, now: () => number): Promise<Json> {
  return withAccount(p, options, now, async (session) => {
    const order = session.store.getOrder(p.positionals[0]);
    if (!order) throw orderNotFound();
    const result = withOrderIds(order);
    if (order.status === 'PENDING' && result.hint === undefined) {
      result.hint = 'The order was recorded but not confirmed. Rerun the original orders create command with the same client_order_id to finish or confirm it.';
    }
    return envelope(session, result, PAPER_NOTICE, true);
  });
}

function pageFilter(fields: Record<string, string>): Json {
  const filter: Json = { limit: parseLimit(fields.limit) };
  copyFields(fields, ['status', 'side', 'product_type', 'start', 'end', 'cursor'], filter);
  if ('product_ids' in fields) filter.product_ids = fields.product_ids.split(',');
  if ('order_ids' in fields) filter.order_ids = idList(fields.order_ids);
  return filter;
}

async function listPage(p: ParsedPaperArgs, options: PaperCommandOptions, now: () => number, key: 'orders' | 'fills' | 'activities'): Promise<Json> {
  return withAccount(p, options, now, async (session) => {
    const filter = pageFilter(p.fields);
    // Paper accounts cannot hold futures, so FUTURE matches nothing.
    const page: Page<object> = filter.product_type === 'FUTURE'
      ? { items: [], has_next: false, cursor: null }
      : key === 'orders' ? session.store.listOrders(filter) : key === 'fills' ? session.store.listFills(filter) : session.store.listActivity(filter);
    const items = key === 'orders' ? page.items.map(withOrderIds) : page.items;
    return envelope(session, { [key]: items, has_next: page.has_next, cursor: page.cursor });
  });
}

async function balance(p: ParsedPaperArgs, options: PaperCommandOptions, now: () => number): Promise<Json> {
  return withAccount(p, options, now, async (session) => {
    const ledger = session.store.readLedger();
    if (!p.flags.refresh) {
      const result = await session.services.buildBalance(ledger, null, now());
      return envelope(session, { ...result, source: { marks: 'none: balance marks positions only with --refresh' } });
    }
    const open = ledger.positions.filter((pos) => /[1-9]/.test(pos.quantity));
    if (open.length > MAX_REFRESH_POSITIONS) {
      throw new PaperError('TOO_MANY_POSITIONS', `balance --refresh supports at most ${MAX_REFRESH_POSITIONS} open positions; this account has ${open.length}`, 'Run coinbase-paper balance (without --refresh) to see cash and unpriced positions.');
    }
    // Every open crypto position needs its own book; any failed read fails the whole refresh.
    // Equity positions have no keyless price and are reported unpriced, never marked.
    const crypto = open.filter((pos) => pos.asset_class !== 'EQUITY');
    const books: Record<string, unknown> = Object.create(null);
    for (const pos of crypto) books[pos.product_id] = await session.market.book(pos.product_id);
    const result = await session.services.buildBalance(ledger, books, now());
    if (result.positions.some((row) => row.asset_class !== 'EQUITY' && row.mark_status !== undefined && row.mark_status !== 'FRESH')) {
      throw new PaperError('MARKET_DATA_INVALID', 'One or more position books are stale, future-dated or malformed; no portfolio valuation was returned.', 'Retry balance --refresh for fresh books, or use paper balance for holdings and cash without marks.');
    }
    const source: Json = { marks: 'best bid from order-book snapshots', books: crypto.map((pos) => pos.product_id), fetched_at: new Date(now()).toISOString() };
    if (crypto.length !== open.length) source.equities = 'unpriced: refresh does not price equities; they are priced only at order time, from a supplied quote';
    return envelope(session, { ...result, source }, typeof result.notice === 'string' ? result.notice : PAPER_NOTICE);
  });
}

async function performance(p: ParsedPaperArgs, options: PaperCommandOptions, now: () => number): Promise<Json> {
  return withAccount(p, options, now, async (session) => {
    // The parser already restricted --period to the supported values.
    const request: PerformanceRequest = { period: (p.flags.period as PerformancePeriod | undefined) ?? 'ALL', chart: p.flags.chart === true };
    const result = await session.services.buildPerformance(session.store.readLedger(), session.market, request, now());
    return envelope(session, result, typeof result.notice === 'string' ? result.notice : PAPER_NOTICE);
  });
}

async function reset(p: ParsedPaperArgs, options: PaperCommandOptions, now: () => number): Promise<Json> {
  return withAccount(p, options, now, async (session) => {
    const result = await session.services.resetAccount(session.paths, session.store, now());
    return envelope(session, { ...result, host_durability: HOST_DURABILITY }, `${RESET_NOTICE} ${PAPER_NOTICE}`);
  });
}

async function backup(p: ParsedPaperArgs, options: PaperCommandOptions, now: () => number): Promise<Json> {
  return withAccount(p, options, now, async (session) => {
    const result = await session.store.backup(p.flags.output as string);
    return envelope(session, { ...result, host_durability: HOST_DURABILITY });
  });
}

async function candles(p: ParsedPaperArgs, options: PaperOptions, now: () => number): Promise<Json> {
  const [productId] = p.positionals;
  const { start, end, granularity } = p.flags as Record<string, string>;
  const { md, provider } = await sourceFor(options);
  const raw = await md.candles(productId, start, end, granularity);
  const list = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? (raw as { candles?: unknown }).candles : undefined);
  if (!Array.isArray(list)) throw new PaperError('INVALID_CANDLES', 'public candle response has no candle list', 'Retry later; never substitute research candles for paper fills.');
  return ok({
    product_id: productId, start, end, granularity, candles: list,
    source: { provider, fetched_at: new Date(now()).toISOString(), used_for_fills: false },
    notice: CANDLE_NOTICE,
  });
}

async function init(p: ParsedPaperArgs, options: PaperOptions, now: () => number): Promise<Json> {
  assertRuntime();
  const { validateInitialAccount } = await import('../paper/engine.ts');
  const { initAccount } = await import('../paper/store.ts');
  const both = p.flags['fee-bps'] as string | undefined;
  const cash = (p.flags.cash as string) ?? '10000';
  const currency = (p.flags.currency as string) ?? 'USD';
  // Each rate uses the existing fee bounds; an omitted counterpart defaults to 10 bps.
  const taker = validateInitialAccount(cash, currency, both ?? (p.flags['taker-fee-bps'] as string) ?? '10');
  const maker = validateInitialAccount(cash, currency, both ?? (p.flags['maker-fee-bps'] as string) ?? '10');
  const initial = { ...taker, maker_fee_bps: maker.fee_bps, taker_fee_bps: taker.fee_bps, now };
  const created = await initAccount(await resolve(p.flags, options), initial);
  return ok({ ...created, fee_note: FEE_NOTE, disclaimer: DISCLAIMER, host_durability: HOST_DURABILITY, notice: PAPER_NOTICE });
}


async function execute(p: ParsedPaperArgs, options: PaperCommandOptions, now: () => number): Promise<{ result: Json; healthy: boolean }> {
  const done = (result: Json) => ({ result, healthy: true });
  switch (p.command) {
    case 'doctor': return doctor(p.flags, options);
    case 'init': return done(await init(p, options, now));
    case 'bind': {
      assertRuntime();
      const { bindAccount } = await import('../paper/store.ts');
      const bound = await bindAccount(await resolve(p.flags, options), p.flags.state as string, p.flags['account-id'] as string);
      return done(ok({ ...bound, host_durability: HOST_DURABILITY }));
    }
    case 'orders create': return done(ok(await createOrder(p, options, now)));
    case 'orders close-position': return done(ok(await closePosition(p, options, now)));
    case 'orders get': return done(await getOrder(p, options, now));
    case 'orders list': return done(await listPage(p, options, now, 'orders'));
    case 'orders fills': return done(await listPage(p, options, now, 'fills'));
    case 'activity': return done(await listPage(p, options, now, 'activities'));
    case 'orders cancel': return done(await cancelOrders(p, options, now));
    case 'orders edit': return done(await editOrder(p, options, now));
    case 'balance': return done(await balance(p, options, now));
    case 'performance': return done(await performance(p, options, now));
    case 'reset': return done(await reset(p, options, now));
    case 'backup': return done(await backup(p, options, now));
    case 'candles': return done(await candles(p, options, now));
  }
  throw new PaperError('UNKNOWN_COMMAND', `unknown paper command "${p.command}"`);
}

// ------------------------------------------------------------------ table output

const TABLE_COLUMNS: Record<string, readonly string[]> = {
  orders: ['order_id', 'product_id', 'side', 'order_type', 'status', 'filled_size', 'remaining_size', 'average_filled_price', 'created_time'],
  fills: ['trade_time', 'order_id', 'product_id', 'side', 'price', 'size', 'commission', 'liquidity_indicator'],
  activities: ['event_time', 'event_type', 'order_id', 'product_id', 'status'],
  status_history: ['event_time', 'event_type', 'status'],
  positions: ['product_id', 'total', 'quantity', 'available', 'hold', 'average_entry_price', 'mark', 'market_value', 'unrealized_pnl'],
  results: ['order_id', 'success', 'status', 'error'],
  gaps: ['product_id', 'start', 'end', 'code'],
  candles: ['start', 'open', 'high', 'low', 'close', 'volume'],
};
const SKIPPED_KEYS = new Set(['mode', 'ok', 'notice', 'reconciliation', 'source', 'chart', 'points']);

function cell(value: unknown): string {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'object') {
    const code = plainObject(value)?.code;
    return typeof code === 'string' ? code : JSON.stringify(value);
  }
  return String(value);
}

function columnTable(rows: Json[], preferred: readonly string[] | undefined): string[] {
  const present = (key: string) => rows.some((row) => row[key] !== undefined);
  const columns = (preferred ?? [...new Set(rows.flatMap((row) => Object.keys(row).filter((k) => typeof row[k] !== 'object' || row[k] === null)))]).filter(present);
  if (columns.length === 0) return [];
  const widths = columns.map((col) => Math.max(col.length, ...rows.map((row) => cell(row[col]).length)));
  const line = (values: string[]) => values.map((v, i) => v.padEnd(widths[i])).join('  ').trimEnd();
  return [line(columns.map((c) => c.toUpperCase())), ...rows.map((row) => line(columns.map((col) => cell(row[col]))))];
}

function reconciliationLine(value: unknown): string | null {
  const r = plainObject(value);
  if (!r) return null;
  const reason = plainObject(r.reason);
  const parts = [`reconciliation: ${cell(r.status)}`, `last reconciled ${cell(r.reconciled_at)}`];
  if (reason) parts.push(`${cell(reason.code)}: ${cell(reason.message)}`);
  return parts.join('; ');
}

/** Human-readable view of a success result; always labeled PAPER with its reconciliation and valuation caveats. */
export function renderTable(command: string, result: Json): string {
  const out = [`PAPER  coinbase-paper ${command}  (simulated with virtual funds; never a live order)`];
  const rec = reconciliationLine(result.reconciliation);
  if (rec) out.push(rec);
  if ('priced' in result || 'valuation_status' in result) {
    const marked = result.priced === true ? `marked at ${cell(result.marked_at)}` : 'not marked to market';
    out.push(`valuation: ${cell(result.valuation_status ?? (result.priced ? 'MARKED' : 'UNPRICED'))}; ${marked}`);
  }
  const sections: string[] = [];
  for (const [key, value] of Object.entries(result)) {
    if (SKIPPED_KEYS.has(key)) continue;
    if (Array.isArray(value)) {
      const rows = value.filter((row): row is Json => plainObject(row) !== null);
      sections.push('', `${key} (${value.length})`, ...(rows.length ? columnTable(rows, TABLE_COLUMNS[key]) : value.map(cell)));
    } else if (plainObject(value)) {
      for (const [sub, inner] of Object.entries(value as Json)) {
        if (typeof inner !== 'object' || inner === null) out.push(`${key}.${sub}: ${cell(inner)}`);
      }
    } else {
      out.push(`${key}: ${cell(value)}`);
    }
  }
  out.push(...sections);
  if (typeof result.chart === 'string') out.push('', result.chart.trimEnd());
  const source = plainObject(result.source);
  const requests = plainObject(source?.requests);
  if (source) out.push('', `source: ${cell(source.provider)}${requests ? `; requests ${cell(requests.total)} (http attempts ${cell(requests.http_attempts)})` : ''}`);
  if (typeof result.notice === 'string') out.push(result.notice);
  return out.join('\n') + '\n';
}

/** Entry point for `coinbase-paper ...`. Success output goes to stdout, error JSON to stderr; returns the exit code. */
export async function runPaper(args: string[], options: PaperCommandOptions = {}): Promise<number> {
  const stdout = options.stdout ?? ((t: string) => { process.stdout.write(t); });
  const stderr = options.stderr ?? ((t: string) => { process.stderr.write(t); });
  const now = options.now ?? Date.now;
  try {
    const parsed = parsePaperArgs(args, now());
    if ('help' in parsed) { stderr(parsed.help); return 0; }
    const { result, healthy } = await execute(parsed, options, now);
    if (!healthy) { stderr(JSON.stringify(result, null, 2) + '\n'); return 1; }
    stdout(parsed.flags.format === 'table' ? renderTable(parsed.command, result) : JSON.stringify(result, null, 2) + '\n');
    return 0;
  } catch (err) {
    if (err instanceof PaperError) { stderr(paperErrorJson(err)); return 1; }
    // Fail closed without echoing raw input, response bodies, or paths.
    const name = err instanceof Error ? err.name : 'Error';
    stderr(paperErrorJson(new PaperError('INTERNAL_ERROR', `unexpected ${name}; no simulated order was confirmed`, 'Retry the same command with the same client_order_id, or run coinbase-paper doctor. ' + NO_LIVE_HINT)));
    return 1;
  }
}

// ------------------------------------------------------------------ help

/** Wraps prose to 100 columns for help text. */
function wrap(text: string, width = 100): string {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

const ACCOUNT_FLAGS = '[--data-dir ABS] [--format json|table]';
const RECONCILE_NOTE = `Reconciles open orders once against completed public candles before answering; the result's
reconciliation says whether that worked (OK, NOT_NEEDED or STALE) and source counts the requests.`;

const COMMAND_HELP: Record<string, string> = {
  doctor: `Usage: coinbase-paper doctor ${ACCOUNT_FLAGS}

Read-only diagnostics. Never creates or migrates state and never uses the network. Reports:
  runtime           whether this Node.js can run paper storage (node:sqlite)
  account           whether a paper account is bound and readable (ready: true); an older
                    account is upgraded on its next normal account command
  host_durability   always UNVERIFIED: the simulator cannot prove the host keeps the data directory
`,
  init: `Usage: coinbase-paper init [--cash 10000] [--currency USD] [--fee-bps N | --maker-fee-bps N --taker-fee-bps N] ${ACCOUNT_FLAGS}

Create and bind a NEW paper account. Refuses when a profile or database already exists; never reseeds.
Default 10000 USD with 10 bps maker and taker fees. --fee-bps sets both; --maker-fee-bps and
--taker-fee-bps set each (an omitted one stays 10); --fee-bps cannot be combined with them. Each is
0-1000 bps with at most 4 decimals. These are assumed fees, not your Coinbase fee tier: with the
user's consent run the read-only coinbase fees and pass fee_tier.maker_fee_rate / taker_fee_rate
x 10000 (0.006 -> 60).
`,
  bind: `Usage: coinbase-paper bind --state ABS --account-id ID ${ACCOUNT_FLAGS}

Adopt an existing paper database (for example a restored backup) into an empty data directory after
verifying its account ID. Never copies, overwrites, migrates, or adds cash. The bound file becomes the
live account; keep a separate untouched copy of any backup you bind.
`,
  balance: `Usage: coinbase-paper balance [--refresh] ${ACCOUNT_FLAGS}

Cash (total, available, hold), buying power, positions (total, available, hold, average entry
including fees), realized P&L and fees paid. Holds reserve cash and quantity for open orders; they
reduce available amounts, not equity.
Without --refresh no position is marked: priced is false and marked_at null. A cash-only account
reports equity = cash with valuation_status CASH_ONLY. Balance may still read public candles to
reconcile open orders; with no open orders it uses no network.
--refresh also reads a public book for every open crypto position (at most 100) and marks at the
best bid, or fails as a whole. Refresh does not price equities: with equity positions, the
whole-account equity/unrealized_pnl/total_pnl stay null and priced_* subtotals cover crypto only.
${RECONCILE_NOTE}
`,
  'orders create': `Usage: coinbase-paper orders create product_id=PRODUCT side=BUY|SELL type=TYPE (base_size=N | quote_size=N) [client_order_id=UUID] [fields...] ${ACCOUNT_FLAGS}

Same fields as coinbase orders create, simulated with virtual funds. Crypto SPOT:
  type=market     time_in_force IOC|FOK optional. Fills fully against a fresh public book or fails;
                  never partial. BUY quote_size is the total spend INCLUDING the assumed fee; SELL
                  quote_size converts to base_size at the best bid (rounded down).
  type=limit      limit_price required; time_in_force GTC (default), GTD (+ end_time), IOC or FOK;
                  post_only=true|false (true only with GTC/GTD). quote_size converts to base_size
                  at limit_price (a notional target, not a fee budget). A crossing limit fills now
                  as taker by walking the book up to limit_price; IOC cancels the rest, FOK fills
                  all or is CANCELLED (FOK_NOT_FILLED); a GTC/GTD remainder rests as maker.
  type=stoplimit  base_size, limit_price, stop_price, stop_direction=up|down (or
                  STOP_DIRECTION_STOP_UP/DOWN) required; GTC or GTD.
  type=bracket    SELL only: base_size, limit_price (take profit), stop_price (stop-loss trigger,
                  below limit_price); GTC or GTD. Stops become an aggressive limit exit at
                  stop_price - 5% (paper assumption); fills and loss limits are not guaranteed.
  attached exits  attached_take_profit_price and/or attached_stop_loss_price on a market or limit
                  BUY; exits activate as the parent fills, including partial fills.
Open orders hold cash (limit notional + max fee) or quantity until filled, cancelled or expired.
Resting orders fill only when a later paper command reconciles them against completed public
candles: strict trade-through (touch is not a fill), full remaining size if candle volume allows,
never after end_time.
${RECONCILE_NOTE}

Pass a new client_order_id per order and reuse it only to retry that exact order: an accepted order
returns its ORIGINAL receipt and provenance without new requests. For current status, fills and holds
run coinbase-paper orders get ORDER_ID.

Equities (paper only): type=market only. Coinbase's public API publishes no equity prices, so a
product that is not a Coinbase crypto product needs a current quote you looked up and showed the
user: reference_price, price_source (https URL, at most 300 characters) and price_as_of (the quote's
own time, UTC). The quote must be at most 24 h old and at most 5 min in the future. It fills at
reference_price +/- 10 bps assumed slippage; the receipt says UNVERIFIED_EXTERNAL_QUOTE. Instrument
details are assumed (0.00001 shares, 0.01 price increment): halts, sessions and fractionability are
not checked. SELL takes base_size. No quote: do not trade. Crypto orders reject the quote fields.
Not simulated: twap, scaled, stop-market, trailing stop, preview_id, portfolio_id, reduce_only,
equity session/date fields, futures, margin and shorting.
`,
  'orders get': `Usage: coinbase-paper orders get ORDER_ID ${ACCOUNT_FLAGS}

Current state of one paper order (its client_order_id): status, filled_size, remaining_size, hold,
fills, attached_order_ids and status_history. A recorded but unconfirmed order shows status PENDING;
finish it by rerunning the original create with the same client_order_id.
${RECONCILE_NOTE}
`,
  'orders list': `Usage: coinbase-paper orders list [status=STATUS] [product_ids=BTC-USD,ETH-USD] [side=BUY|SELL] [product_type=SPOT|EQUITY] [start=RFC3339] [end=RFC3339] [limit=50] [cursor=C] ${ACCOUNT_FLAGS}

Paper orders, newest first. status is one of PENDING, OPEN, FILLED, CANCELLED, EXPIRED (partial
fills stay OPEN). start is inclusive and end exclusive, by creation time. limit 1-${MAX_LIMIT}.
Pass the returned cursor (with the same filters) for the next page. key==value is also accepted.
Use status=OPEN to find orders you can edit or cancel.
${RECONCILE_NOTE}
`,
  'orders fills': `Usage: coinbase-paper orders fills [order_ids=ID,ID] [product_ids=...] [side=BUY|SELL] [start=RFC3339] [end=RFC3339] [limit=50] [cursor=C] ${ACCOUNT_FLAGS}

Individual simulated executions, newest first: trade_id, order_id, trade_time, price, size,
commission, liquidity_indicator (MAKER or TAKER), product_id, side. Candle fills are timestamped at
the candle's end. order_ids also accepts order_ids:='["ID"]'; key==value is accepted.
${RECONCILE_NOTE}
`,
  'orders cancel': `Usage: coinbase-paper orders cancel order_ids=ID,ID ${ACCOUNT_FLAGS}
       coinbase-paper orders cancel order_ids:='["ID","ID"]'

Cancel up to 100 open or pending paper orders and release their holds; filled portions are
unaffected. Returns per-order results in input order and exits 0 even when some fail (FILLED or
EXPIRED orders fail with PAPER_ORDER_NOT_OPEN, unknown IDs with ORDER_NOT_FOUND). Cancelling an
already CANCELLED order succeeds. Works even when reconciliation is STALE.
${RECONCILE_NOTE}
`,
  'orders edit': `Usage: coinbase-paper orders edit ORDER_ID [base_size=N] [limit_price=N] [attached_take_profit_price=N] [attached_stop_loss_price=N] [cancel_attached_order=true] ${ACCOUNT_FLAGS}

Atomically change an OPEN limit, stoplimit or bracket order without cancelling. base_size is the new
TOTAL size and must exceed what has already filled. Omit attached fields to keep existing exits;
sending either attached price replaces both legs (send both to keep both). cancel_attached_order=true
removes both and cannot be combined with attached prices. Exits can change only on an unfilled limit
BUY; once an exit has activated, manage it by its own order ID. An edit that changes nothing returns
edited:false. A real edit re-checks holds against one fresh book; on failure the old terms remain.
${RECONCILE_NOTE}
`,
  'orders close-position': `Usage: coinbase-paper orders close-position client_order_id=UUID product_id=PRODUCT [size=N] ${ACCOUNT_FLAGS}

Market SELL to flatten a paper position, as coinbase orders close-position. Omit size for the full
position; it fails (rather than closing less) if open orders hold part of it. Same full-fill, retry
and equity quote rules (reference_price, price_source, price_as_of) as orders create.
${RECONCILE_NOTE}
`,
  'orders preview': `Usage: coinbase-paper orders preview

Not simulated: returns PAPER_UNSUPPORTED_OPERATION and places nothing. Do not run orders create as a
preview, and do not fall back to a live preview.
`,
  activity: `Usage: coinbase-paper activity [order_ids=ID,ID] [product_ids=...] [start=RFC3339] [end=RFC3339] [limit=50] [cursor=C] ${ACCOUNT_FLAGS}

Order events oldest first: ACCEPTED, OPENED, TRIGGERED, FILL, EDITED, CANCELLED, EXPIRED,
ATTACHED_ACTIVATED and AMBIGUOUS_OCO (a candle crossed both bracket legs; the stop was assumed first).
Paper accounts have no deposits, transfers, dividends or interest.
${RECONCILE_NOTE}
`,
  performance: `Usage: coinbase-paper performance [--period 1D|1W|1M|ALL] [--chart] ${ACCOUNT_FLAGS}

Equity curve reconstructed from paper fills and completed public candle closes (hourly for 1D/1W,
daily for 1M/ALL; default ALL): P&L, time-weighted return and max drawdown. Missing data and equity
holdings are reported as gaps and unpriced points, never filled in. --chart adds an ASCII chart.
This is a reconstruction, not broker-recorded portfolio history.
${RECONCILE_NOTE}
`,
  reset: `Usage: coinbase-paper reset --confirm ${ACCOUNT_FLAGS}

Archive the current paper account, then bind a NEW account with the same cash, currency and fees and
no history. The old account file and the archive are kept. Without --confirm nothing is read or
changed. Run only when the user explicitly wants a fresh account.
`,
  backup: `Usage: coinbase-paper backup --output ABS ${ACCOUNT_FLAGS}

Write a consistent private copy of the account (including pending and open orders) to a NEW absolute
path. Never overwrites. To restore, keep a separate untouched copy, then bind the file into a new data
directory: the bound file becomes the live account. Never use two bindings of one account ID.
`,
  candles: `Usage: coinbase-paper candles PRODUCT --start UNIX --end UNIX --granularity ENUM [--format json|table]

Public candles for research; needs no account. This command never fills or marks orders.
ENUM: ONE_MINUTE FIVE_MINUTE FIFTEEN_MINUTE THIRTY_MINUTE ONE_HOUR TWO_HOUR FOUR_HOUR SIX_HOUR ONE_DAY
(at most 350 intervals per request).
`,
};

const ORDERS_HELP = `Usage: coinbase-paper orders <create|get|list|fills|cancel|edit|close-position> [fields...]

Same shape as coinbase orders, simulated with virtual funds:
  create          product_id=... side=BUY|SELL type=market|limit|stoplimit|bracket base_size=N|quote_size=N [client_order_id=UUID]
  get             ORDER_ID
  list            [status=OPEN] [product_ids=...] [side=...] [product_type=...] [start=...] [end=...] [limit=N] [cursor=...]
  fills           [order_ids=...] [product_ids=...] [side=...] [start=...] [end=...] [limit=N] [cursor=...]
  cancel          order_ids=ID,ID
  edit            ORDER_ID [base_size=N] [limit_price=N] [attached_take_profit_price=N] [attached_stop_loss_price=N] [cancel_attached_order=true]
  close-position  client_order_id=UUID product_id=... [size=N]
preview is not simulated.

${NO_LIVE_HINT}
`;

function commandHelp(command: string): string {
  return `${COMMAND_HELP[command]}\n${NO_LIVE_HINT}\n`;
}

const PAPER_HELP = `coinbase-paper — local PAPER trading simulator (preview)

Virtual cash and simulated fills against public Coinbase market data. Never places a real order and
never reads credentials or balances. Trading commands use the same fields as live coinbase orders.

Usage:
  coinbase-paper <command> [fields...] [flags]

Trading (same fields as live):
  orders create         market, limit, stoplimit and bracket orders; attached exits on BUYs
  orders get ID         Current state of one paper order, with status history
  orders list           Paper orders [status=OPEN] [product_ids=...] [side=...] [limit=N]
  orders fills          Simulated executions with fees and MAKER/TAKER
  orders cancel         order_ids=ID,ID (per-order results)
  orders edit ID        Change an open order's price, size or attached exits
  orders close-position client_order_id=UUID product_id=... [size=N]
  balance               Cash, holds, buying power, positions and P&L; --refresh marks crypto

Account (paper only):
  activity              Order events (fills, triggers, edits, cancels, expiries), oldest first
  performance           Reconstructed equity curve, return and drawdown [--period] [--chart]
  doctor                Read-only runtime/account diagnostics (no network)
  init                  Create a new paper account (default 10000 USD, 10 bps maker/taker fees)
  bind                  Adopt an existing paper database (e.g. a restored backup)
  backup                Consistent private copy to a new path (--output ABS)
  reset --confirm       Archive this account and start a new one with the same settings
  candles PRODUCT       Public research candles (--start, --end, --granularity)

Flags:
  --data-dir ABS        Account directory (default: COINBASE_PAPER_HOME, then
                        $XDG_DATA_HOME/coinbase-paper, then ~/.local/share/coinbase-paper)
  --format json|table   Success output format; JSON is the default (errors are always JSON)
  -h, --help            Show help for paper or a paper command

Resting orders: there is no background process. Each account command first reconciles open orders
against completed public candles since they were last evaluated, and reports reconciliation status
(OK, NOT_NEEDED, or STALE when data was unavailable: nothing is guessed, holds stay, and new orders
and edits wait). Orders fill only when you run a paper command.

Retries: one new client_order_id per new order. If a result is uncertain, rerun the exact same command
with the same client_order_id; an accepted order returns its original receipt without new requests.

Output: success JSON on stdout, error JSON {mode, ok:false, error:{code,message,hint[,details]}} on
stderr; exit 0 on success, 1 on error. Amounts are decimal strings.

Scope: crypto SPOT orders, plus equity market orders priced from an external quote you supply (see
orders create --help); one quote currency per account. No previews, streaming, MCP tools, futures,
margin, shorting or scheduling. Requires Node.js >=22.13 (22.x), >=23.4 (23.x), or 24+ for the
built-in node:sqlite module.

${wrap(DISCLAIMER)}
`;
