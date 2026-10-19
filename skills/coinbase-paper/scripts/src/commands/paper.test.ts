import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { editIsNoop, parsePaperArgs, parseTimestamp, renderTable, runPaper, sqliteRuntimeSupported, type CommandMarketDataView, type PageView, type PaperServices, type PaperStoreView, type ParsedPaperArgs, type PlacementMarketView, type Provenance, type ReconciliationView } from './paper.ts';
import { PaperError, type MarketData, type Position } from '../paper/types.ts';


const UUID = '3f2a8c1e-7b4d-4e9a-9c3b-1d2e3f4a5b6c';
const UUID2 = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const NOW = Date.parse('2026-01-15T12:00:00.000Z');

function parsed(args: string[]): ParsedPaperArgs {
  const p = parsePaperArgs(args);
  assert.ok(!('help' in p), 'expected a command, got help');
  return p;
}

function parseError(args: string[]): PaperError {
  try { parsePaperArgs(args); } catch (err) { assert.ok(err instanceof PaperError); return err; }
  assert.fail(`expected PaperError for ${args.join(' ')}`);
}

const CREATE = ['orders', 'create', 'product_id=BTC-USD', 'side=BUY', 'type=market'];

describe('parsePaperArgs', () => {
  it('returns help for no args, --help, help, orders, and per-command --help', () => {
    for (const args of [[], ['--help'], ['-h'], ['help'], ['help', 'orders', 'create'], ['orders'], ['orders', '--help'], ['orders', 'create', '--help'], ['balance', '-h', '--live']]) {
      const p = parsePaperArgs(args);
      assert.ok('help' in p, args.join(' '));
    }
    const create = parsePaperArgs(['orders', 'create', '--help']);
    assert.ok('help' in create && /client_order_id=UUID/.test(create.help) && /Same fields as coinbase orders create/.test(create.help));
  });

  it('parses live-style orders create fields and flags', () => {
    assert.deepEqual(parsed([...CREATE, 'quote_size=25', `client_order_id=${UUID}`, '--data-dir', '/abs/dir']), {
      command: 'orders create', positionals: [], flags: { 'data-dir': '/abs/dir' },
      fields: { product_id: 'BTC-USD', side: 'BUY', type: 'market', quote_size: '25', client_order_id: UUID },
    });
    assert.deepEqual(parsed(['balance', '--refresh']).flags, { refresh: true });
    assert.deepEqual(parsed(['orders', 'list', 'limit==5', 'side=SELL']).fields, { limit: '5', side: 'SELL' });
    assert.deepEqual(parsed(['orders', 'get', UUID]).positionals, [UUID]);
  });

  it('requires live-required fields, market type and exactly one size', () => {
    assert.match(parseError(['orders', 'create', 'product_id=BTC-USD', 'side=BUY', 'quote_size=1']).message, /requires type/);
    assert.match(parseError(['orders', 'create', 'product_id=BTC-USD', 'side=BUY', 'type=limit', 'base_size=1']).message, /type=limit requires limit_price/);
    assert.equal(parseError(['orders', 'create', 'product_id=BTC-USD', 'side=BUY', 'type=twap', 'base_size=1']).code, 'PAPER_UNSUPPORTED_ORDER_TYPE');
    assert.match(parseError(['orders', 'create', 'product_id=BTC-USD', 'side=buy', 'type=market', 'base_size=1']).message, /BUY or SELL/);
    assert.match(parseError(CREATE).message, /exactly one/);
    assert.match(parseError([...CREATE, 'base_size=1', 'quote_size=2']).message, /exactly one/);
    assert.equal(parsed(['orders', 'create', 'product_id=BTC-USD', 'side=SELL', 'type=market', 'quote_size=2']).fields.quote_size, '2', 'crypto market SELL converts quote_size');
    assert.equal(parseError(['orders', 'create', 'product_id=BRK.B-USD', 'side=SELL', 'type=market', 'quote_size=2']).code, 'PAPER_UNSUPPORTED_FIELD');
    assert.match(parseError([...CREATE, 'quote_size=1', 'client_order_id=not-a-uuid']).message, /must be a UUID/);
  });

  it('rejects live-only, unknown, query and duplicate fields', () => {
    for (const field of ['portfolio_id=abc', 'reduce_only=true', 'preview_id=x', 'leverage=2']) {
      const err = parseError([...CREATE, 'base_size=1', field]);
      assert.equal(err.code, 'PAPER_UNSUPPORTED_FIELD', field);
      assert.match(err.hint, /not simulated/);
    }
    assert.match(parseError([...CREATE, 'base_size==1']).message, /not base_size==/);
    assert.match(parseError([...CREATE, 'base_size=1', 'base_size=2']).message, /more than once/);
    assert.equal(parseError(['orders', 'list', 'order_status=OPEN']).code, 'PAPER_UNSUPPORTED_FIELD');
    assert.match(parseError(['orders', 'list', 'order_status=OPEN']).hint, /status=OPEN/);
    assert.match(parseError([...CREATE, 'base_size=1', 'limit_price=40000']).message, /limit_price does not apply to type=market/);
  });

  it('rejects env, live, paper, unknown, and duplicate flags', () => {
    assert.match(parseError(['balance', '-e', 'prod']).hint, /remove --env/);
    assert.match(parseError(['balance', '--env=prod']).hint, /remove --env/);
    assert.match(parseError([...CREATE, 'quote_size=1', '--live']).hint, /no live mode/);
    assert.match(parseError(['balance', '--paper']).hint, /always simulated/);
    assert.match(parseError([...CREATE, 'quote_size=1', '--dry-run']).message, /does not accept --dry-run/);
    assert.match(parseError(['balance', '--refresh', '--refresh']).message, /more than once/);
    assert.match(parseError(['--env', 'prod', 'balance']).hint, /remove --env/);
  });

  it('maps earlier preview names to the live-mirrored commands', () => {
    for (const [old, hint] of [['buy', /orders create .*side=BUY/], ['sell', /side=SELL/], ['status', /paper balance/], ['history', /orders list/]] as const) {
      const err = parseError([old, 'BTC-USD']);
      assert.equal(err.code, 'UNKNOWN_COMMAND');
      assert.match(err.hint, hint);
    }
  });

  it('rejects wrong positionals, missing values, flag values on switches, and unknown commands', () => {
    assert.match(parseError([...CREATE, 'BTC-USD', 'quote_size=1']).message, /expects no positional/);
    assert.match(parseError(['balance', 'extra']).message, /expects no positional/);
    assert.match(parseError(['orders', 'get']).message, /expects ORDER_ID/);
    assert.match(parseError(['backup', '--output']).message, /--output requires a value/);
    assert.match(parseError(['balance', '--refresh=yes']).message, /does not take a value/);
    assert.equal(parseError(['reset']).code, 'PAPER_RESET_CONFIRMATION_REQUIRED');
    assert.match(parseError(['orders', 'cancel', UUID]).message, /expects no positional/);
    assert.equal(parseError(['orders', 'replace']).code, 'UNKNOWN_COMMAND');
  });
});

describe('sqliteRuntimeSupported', () => {
  it('matches the node:sqlite unflagged minimums', () => {
    for (const v of ['22.13.0', '22.23.2', '23.4.0', '24.0.0', '24.12.0', 'v25.1.0']) assert.equal(sqliteRuntimeSupported(v), true, v);
    for (const v of ['20.18.0', '22.6.0', '22.12.9', '23.3.0', 'garbage']) assert.equal(sqliteRuntimeSupported(v), false, v);
  });
});

function product(id = 'BTC-USD') {
  const [base, quote] = id.split('-');
  return {
    product_id: id, base_currency_id: base, quote_currency_id: quote, product_type: 'SPOT', status: 'online',
    base_increment: '0.00000001', quote_increment: '0.01', base_min_size: '0.00000001', base_max_size: '3400',
    quote_min_size: '1', quote_max_size: '150000000', trading_disabled: false, is_disabled: false,
    cancel_only: false, limit_only: false, post_only: false, auction_mode: false, view_only: false,
  };
}

function book(id = 'BTC-USD', now = NOW) {
  return {
    pricebook: {
      product_id: id, time: new Date(now).toISOString(),
      bids: [{ price: '50000.00', size: '2' }], asks: [{ price: '50010.00', size: '2' }],
    },
  };
}

class FakeMarket implements MarketData {
  calls: string[] = [];
  failProduct = false;
  /** Products the public API answers with a definitive 404 NOT_FOUND. */
  notFound = new Set(['AAPL-USD', 'AAPL-USDC']);
  async product(id: string) {
    this.calls.push(`product:${id}`);
    if (this.failProduct) throw new PaperError('MARKET_UNAVAILABLE', 'down');
    if (this.notFound.has(id)) throw new PaperError('PRODUCT_NOT_FOUND', 'public product was not found (HTTP 404 NOT_FOUND)');
    return product(id);
  }
  async book(id: string) { this.calls.push(`book:${id}`); return book(id); }
  async candles(id: string, start: string, end: string, granularity: string): Promise<unknown> {
    this.calls.push(`candles:${id}:${start}:${end}:${granularity}`);
    return { candles: [{ start, low: '1', high: '2', open: '1', close: '2', volume: '3' }] };
  }
}

interface Run { code: number; out: string; err: string; json: any }

describe('runPaper', () => {
  let dir: string;
  let market: FakeMarket;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'coinbase-paper-cmd-')); market = new FakeMarket(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  async function run(args: string[]): Promise<Run> {
    let out = '';
    let err = '';
    const code = await runPaper(args, {
      marketData: market, now: () => NOW, env: { COINBASE_PAPER_HOME: join(dir, 'data') }, home: dir,
      stdout: t => { out += t; }, stderr: t => { err += t; },
    });
    const text = code === 0 ? out : err;
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* help text */ }
    return { code, out, err, json };
  }

  it('prints plain help to stderr and no JSON', async () => {
    const r = await run(['--help']);
    assert.equal(r.code, 0);
    assert.equal(r.out, '');
    assert.match(r.err, /coinbase-paper <command>/);
    assert.match(r.err, /never places a real order/i);
    assert.match(r.err, /Preview feature/);
  });

  it('emits a structured PAPER error on stderr and never reads market data for bad input', async () => {
    const r = await run([...CREATE, 'portfolio_id=1', 'base_size=1']);
    assert.equal(r.code, 1);
    assert.equal(r.out, '');
    assert.equal(r.json.mode, 'PAPER');
    assert.equal(r.json.ok, false);
    assert.equal(r.json.error.code, 'PAPER_UNSUPPORTED_FIELD');
    assert.ok(r.json.error.hint);
    assert.deepEqual(market.calls, []);
  });

  it('candles returns public research data with provenance and needs no account', async () => {
    const r = await run(['candles', 'BTC-USD', '--start', '1700000000', '--end', '1700003600', '--granularity', 'ONE_HOUR']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json.mode, 'PAPER');
    assert.equal(r.json.candles.length, 1);
    assert.deepEqual(r.json.source, { provider: 'injected', fetched_at: new Date(NOW).toISOString(), used_for_fills: false });
    assert.deepEqual(market.calls, ['candles:BTC-USD:1700000000:1700003600:ONE_HOUR']);
    assert.equal(existsSync(join(dir, 'data')), false);
  });

  it('candles fails closed on a response without a candle list', async () => {
    market.candles = async () => ({ nope: true });
    const r = await run(['candles', 'BTC-USD', '--start', '1', '--end', '2', '--granularity', 'ONE_MINUTE']);
    assert.equal(r.code, 1);
    assert.equal(r.json.error.code, 'INVALID_CANDLES');
  });

  it('orders list rejects an out-of-range limit before opening state', async () => {
    const r = await run(['orders', 'list', 'limit=0']);
    assert.equal(r.code, 1);
    assert.match(r.json.error.message, /limit/);
  });

  it('doctor separates runtime, account readiness and unverified durability without creating state', async () => {
    const r = await run(['doctor']);
    assert.equal(r.json.mode, 'PAPER');
    assert.equal(r.json.runtime.supported, sqliteRuntimeSupported(process.versions.node));
    assert.equal(r.json.ready, false);
    assert.match(r.json.host_durability, /^UNVERIFIED/);
    assert.equal(existsSync(join(dir, 'data')) ? readdirSync(join(dir, 'data')).length : 0, 0);
  });

  it('trading without an explicit init fails without market reads or auto-seeding', async () => {
    const r = await run([...CREATE, 'quote_size=100', `client_order_id=${UUID}`]);
    assert.equal(r.code, 1);
    assert.equal(r.json.mode, 'PAPER');
    assert.deepEqual(market.calls, []);
    assert.equal((await run(['balance'])).code, 1);
  });

  it('init returns one disclaimer and real-fee guidance', async () => {
    const init = await run(['init']);
    assert.equal(init.code, 0, init.err);
    assert.match(init.json.disclaimer, /Preview feature/);
    assert.match(init.json.disclaimer, /runs locally/);
    assert.match(init.json.disclaimer, /do not predict or guarantee live results/);
    assert.match(init.json.fee_note, /coinbase fees/);
    assert.match(init.json.fee_note, /taker_fee_rate x 10000/);
    assert.match(init.json.fee_note, /never reads credentials/);
    assert.equal(init.json.live_trading, undefined, 'the standalone tool has no live-trading lock');
  });

  it('init, create, replay, balance, refresh, list, get, backup end to end', async () => {
    const init = await run(['init']);
    assert.equal(init.code, 0, init.err);
    {
      const { openAccount, resolvePaths } = await import('../paper/store.ts');
      const store = await openAccount(resolvePaths(undefined, { COINBASE_PAPER_HOME: join(dir, 'data') }, dir));
      try {
        assert.equal((await store.readSnapshot()).account.created_at, new Date(NOW).toISOString(), 'init uses the injected clock');
      } finally { store.close(); }
    }
    assert.equal((await run(['init'])).code, 1, 'init never reseeds');

    const buy = await run([...CREATE, 'quote_size=100', `client_order_id=${UUID}`]);
    assert.equal(buy.code, 0, buy.err);
    assert.equal(buy.json.mode, 'PAPER');
    assert.equal(buy.json.client_order_id, UUID);
    assert.equal(buy.json.order_id, UUID);
    assert.equal(buy.json.client_order_id_generated, undefined);
    assert.deepEqual(market.calls, ['product:BTC-USD', 'book:BTC-USD']);

    const replay = await run([...CREATE, 'quote_size=100', `client_order_id=${UUID}`]);
    assert.equal(replay.code, 0, replay.err);
    assert.deepEqual(replay.json, buy.json);
    assert.equal(market.calls.length, 2, 'replay must not fetch market data');

    const conflict = await run([...CREATE, 'quote_size=200', `client_order_id=${UUID}`]);
    assert.equal(conflict.code, 1);
    assert.equal(conflict.json.error.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(market.calls.length, 2, 'conflicting terms must fail before market data');

    const offline = await run(['balance']);
    assert.equal(offline.code, 0, offline.err);
    assert.equal(market.calls.length, 2, 'offline balance uses no network');

    const refreshed = await run(['balance', '--refresh']);
    assert.equal(refreshed.code, 0, refreshed.err);
    assert.deepEqual(market.calls.slice(2), ['book:BTC-USD']);
    assert.equal(refreshed.json.source.provider, 'injected');

    const list = await run(['orders', 'list', 'limit=5']);
    assert.equal(list.code, 0, list.err);
    assert.equal(list.json.orders.length, 1);
    assert.equal(list.json.orders[0].order_id, UUID);
    assert.equal((await run(['orders', 'list', 'product_ids=ETH-USD'])).json.orders.length, 0);
    assert.equal((await run(['orders', 'list', 'side==SELL'])).json.orders.length, 0);

    const got = await run(['orders', 'get', UUID.toUpperCase()]);
    assert.equal(got.code, 0, got.err);
    assert.equal(got.json.order_id, UUID);
    assert.equal(got.json.status, 'FILLED');
    assert.ok(Array.isArray(got.json.status_history));
    const missing = await run(['orders', 'get', UUID2]);
    assert.equal(missing.code, 1);
    assert.equal(missing.json.error.code, 'ORDER_NOT_FOUND');

    const output = join(dir, 'backup.sqlite3');
    assert.equal((await run(['backup', '--output', output])).code, 0);
    assert.ok(existsSync(output));
    assert.equal((await run(['backup', '--output', output])).code, 1, 'backup never overwrites');
  });

  it('generates a client_order_id when omitted, like live orders, and says how to retry safely', async () => {
    assert.equal((await run(['init'])).code, 0);
    const r = await run([...CREATE, 'quote_size=100']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.json.client_order_id, /^[0-9a-f-]{36}$/);
    assert.equal(r.json.client_order_id_generated, true);
    assert.ok(r.json.retry_hint.includes(`client_order_id=${r.json.client_order_id}`), r.json.retry_hint);
    assert.equal((await run(['orders', 'get', r.json.client_order_id])).json.order_id, r.json.client_order_id);
  });

  it('refresh refuses a stale or malformed position book rather than returning a partial valuation', async () => {
    assert.equal((await run(['init'])).code, 0);
    assert.equal((await run([...CREATE, 'base_size=0.001', `client_order_id=${UUID}`])).code, 0);
    for (const response of [{}, { pricebook: { product_id: 'BTC-USD', time: '2000-01-01T00:00:00Z', bids: [{ price: '50000', size: '1' }], asks: [{ price: '50001', size: '1' }] } }]) {
      const source: MarketData = market;
      source.book = async () => response;
      const result = await run(['balance', '--refresh']);
      assert.equal(result.code, 1);
      assert.equal(result.json.error.code, 'MARKET_DATA_INVALID');
      assert.equal((await run(['balance'])).code, 0, 'offline holdings remain accessible');
    }
  });

  it('a failed market read keeps the pending terms and the same id can be retried', async () => {
    assert.equal((await run(['init'])).code, 0);
    market.failProduct = true;
    const failed = await run([...CREATE, 'base_size=0.001', `client_order_id=${UUID2}`]);
    assert.equal(failed.code, 1);
    assert.equal(failed.json.error.code, 'MARKET_UNAVAILABLE');
    const pending = await run(['orders', 'get', UUID2]);
    assert.equal(pending.code, 0, pending.err);
    assert.equal(pending.json.status, 'PENDING');

    const changed = await run([...CREATE, 'base_size=0.002', `client_order_id=${UUID2}`]);
    assert.equal(changed.code, 1);
    assert.equal(market.calls.length, 1, 'pending terms conflict is detected before market data');

    market.failProduct = false;
    const retried = await run([...CREATE, 'base_size=0.001', `client_order_id=${UUID2}`]);
    assert.equal(retried.code, 0, retried.err);
    assert.equal(retried.json.base_size, '0.00100000', 'receipt sizes are padded to the base increment');
  });

  const QUOTE_AT = new Date(NOW - 20 * 60_000).toISOString().replace('.000Z', 'Z');
  const QUOTE = ['reference_price=212.34', 'price_source=https://www.nasdaq.com/market-activity/stocks/aapl', `price_as_of=${QUOTE_AT}`];
  const EQUITY = ['orders', 'create', 'product_id=AAPL-USD', 'side=BUY', 'type=market'];

  it('parses the paper-only quote fields', () => {
    assert.deepEqual(parsed([...EQUITY, 'base_size=2', ...QUOTE]).fields, {
      product_id: 'AAPL-USD', side: 'BUY', type: 'market', base_size: '2',
      reference_price: '212.34', price_source: 'https://www.nasdaq.com/market-activity/stocks/aapl', price_as_of: QUOTE_AT,
    });
    assert.match(parseError([...EQUITY, 'base_size=2', 'reference_price=1', 'reference_price=2']).message, /more than once/);
  });

  it('fills an external-quote equity order after a definitive crypto not-found, with no book read', async () => {
    assert.equal((await run(['init'])).code, 0);
    const buy = await run([...EQUITY, 'quote_size=500', `client_order_id=${UUID}`, ...QUOTE]);
    assert.equal(buy.code, 0, buy.err);
    assert.deepEqual(market.calls, ['product:AAPL-USD']);
    assert.deepEqual([buy.json.asset_class, buy.json.price_verification, buy.json.price_age_seconds, buy.json.average_price, buy.json.base_size, buy.json.total], ['EQUITY', 'UNVERIFIED_EXTERNAL_QUOTE', 1200, '212.56', '2.34992', '500.00']);
    // Quote provenance is kept; this command's request accounting (the crypto not-found lookup) is added.
    assert.deepEqual(buy.json.source, { provider: 'external', url: 'https://www.nasdaq.com/market-activity/stocks/aapl', as_of: QUOTE_AT, reference_price: '212.34', slippage_bps: '10', metadata: 'assumed', requests: { product: 1, book: 0, candles: 0, total: 1, cache_hits: 0, http_attempts: null } });
    assert.match(buy.json.notice, /UNVERIFIED external quote/);
    assert.match(buy.json.notice, /not searchable by ticker/);

    const replay = await run([...EQUITY, 'quote_size=500', `client_order_id=${UUID}`, ...QUOTE]);
    assert.deepEqual(replay.json, buy.json);
    assert.equal(market.calls.length, 1, 'replay reads no market data');
    const changed = await run([...EQUITY, 'quote_size=500', `client_order_id=${UUID}`, 'reference_price=212.35', ...QUOTE.slice(1)]);
    assert.equal(changed.json.error.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(market.calls.length, 1);

    const dotted = await run(['orders', 'create', 'product_id=BRK.B-USD', 'side=BUY', 'type=market', 'base_size=1', `client_order_id=${UUID2}`, 'reference_price=480', ...QUOTE.slice(1)]);
    assert.equal(dotted.code, 0, dotted.err);
    assert.equal(market.calls.length, 1, 'a dotted ticker cannot be a crypto product and needs no lookup');
  });

  it('requires a quote for equities and rejects quote fields on crypto', async () => {
    assert.equal((await run(['init'])).code, 0);
    const noQuote = await run([...EQUITY, 'base_size=1', `client_order_id=${UUID}`]);
    assert.equal(noQuote.json.error.code, 'EXTERNAL_QUOTE_REQUIRED');
    assert.match(noQuote.json.error.hint, /does not publish equity prices/);
    assert.match(noQuote.json.error.hint, /do not trade; never invent or estimate a price/);
    assert.match(noQuote.json.error.hint, /new client_order_id/);
    const list = await run(['orders', 'list']);
    assert.deepEqual(list.json.orders, [], 'a rejected attempt leaves no orphan PENDING order');
    const sameIdWithQuote = await run([...EQUITY, 'base_size=1', `client_order_id=${UUID}`, ...QUOTE]);
    assert.equal(sameIdWithQuote.json.status, 'FILLED', 'nothing was kept from the rejected attempt, so its ID can carry the quoted order');
    const partial = await run([...EQUITY, 'base_size=1', `client_order_id=${UUID2}`, QUOTE[0]]);
    assert.equal(partial.json.error.code, 'EXTERNAL_QUOTE_REQUIRED');
    assert.equal(market.calls.length, 2, 'one product lookup each for the rejected and the quoted order; a partial quote fails before market data');

    const cashBefore = (await run(['balance'])).json.cash;
    for (const field of QUOTE) {
      const id = crypto.randomUUID();
      const r = await run([...CREATE, 'base_size=0.001', `client_order_id=${id}`, ...QUOTE]);
      assert.equal(r.json.error.code, 'REFERENCE_PRICE_NOT_ALLOWED', field);
    }
    assert.ok(market.calls.every((call) => !call.startsWith('book:')), 'crypto with a quote never fills');
    assert.equal((await run(['balance'])).json.cash, cashBefore);
    assert.ok((await run(['orders', 'list'])).json.orders.every((o: any) => o.status !== 'PENDING'), 'rejections leave no PENDING orders');
  });

  it('skill docs say quote errors need a new client_order_id and quote fields are never for crypto', () => {
    const skill = readFileSync(new URL('../../../SKILL.md', import.meta.url), 'utf8');
    const ref = readFileSync(new URL('../../../references/commands.md', import.meta.url), 'utf8');
    assert.doesNotMatch(ref, /does not consume the ID/);
    assert.match(ref, /EXTERNAL_QUOTE_REQUIRED`, `EXTERNAL_QUOTE_STALE`, `REFERENCE_PRICE_NOT_ALLOWED`, `PRODUCT_NOT_FOUND`\) leaves no order behind; place the corrected order with a new `client_order_id`/);
    assert.match(skill, /`EXTERNAL_QUOTE_REQUIRED`:[^\n]*new `client_order_id`/);
    assert.match(skill, /`REFERENCE_PRICE_NOT_ALLOWED`:[^\n]*cannot be paper-traded/);
    assert.match(skill, /Never use them for a crypto asset, even one Coinbase does not list/);
  });

  it('never falls back to a quote when the crypto lookup fails for any other reason', async () => {
    assert.equal((await run(['init'])).code, 0);
    for (const code of ['MARKET_DATA_UNAVAILABLE', 'MARKET_DATA_RATE_LIMITED', 'MARKET_DATA_REJECTED', 'MARKET_DATA_INVALID']) {
      (market as MarketData).product = async () => { throw new PaperError(code, 'down'); };
      const r = await run([...EQUITY, 'base_size=1', `client_order_id=${crypto.randomUUID()}`, ...QUOTE]);
      assert.equal(r.json.error.code, code);
    }
    (market as MarketData).product = async () => product('AAPL-USD');
    market.notFound.clear();
    const crypto2 = await run([...EQUITY, 'base_size=1', `client_order_id=${crypto.randomUUID()}`, ...QUOTE]);
    assert.equal(crypto2.json.error.code, 'REFERENCE_PRICE_NOT_ALLOWED', 'a listed product is crypto even with an equity-like id');
    assert.match(crypto2.json.error.hint, /stock whose ticker matches this crypto product, it cannot be paper-traded/);
    assert.equal((await run(['balance'])).json.positions.length, 0);
  });

  it('final rejections (post-only cross, insufficient funds) leave no PENDING order; the ID can be reused', async () => {
    assert.equal((await run(['init'])).code, 0);
    const cross = await run(['orders', 'create', 'product_id=BTC-USD', 'side=BUY', 'type=limit', 'base_size=0.001', 'limit_price=10000000', 'post_only=true', `client_order_id=${UUID}`]);
    assert.equal(cross.json.error.code, 'PAPER_POST_ONLY_WOULD_CROSS');
    const broke = await run([...CREATE, 'base_size=100', `client_order_id=${UUID2}`]);
    assert.match(broke.json.error.code, /^INSUFFICIENT_/);
    assert.deepEqual((await run(['orders', 'list'])).json.orders, [], 'no orphan PENDING orders');
    const reuse = await run([...CREATE, 'base_size=0.001', `client_order_id=${UUID}`]);
    assert.equal(reuse.json.status, 'FILLED');
  });

  it('rejects stale, future and wrong-currency quotes and leaves no order behind', async () => {
    assert.equal((await run(['init'])).code, 0);
    const old = new Date(NOW - 86_400_000 - 1000).toISOString().replace('.000Z', 'Z');
    const stale = await run([...EQUITY, 'base_size=1', `client_order_id=${UUID}`, ...QUOTE.slice(0, 2), `price_as_of=${old}`]);
    assert.equal(stale.json.error.code, 'EXTERNAL_QUOTE_STALE');
    assert.match(stale.json.error.hint, /no order is kept/);
    assert.equal((await run(['orders', 'get', UUID])).json.error.code, 'ORDER_NOT_FOUND');
    const ahead = new Date(NOW + 301_000).toISOString().replace('.000Z', 'Z');
    assert.equal((await run([...EQUITY, 'base_size=1', `client_order_id=${UUID2}`, ...QUOTE.slice(0, 2), `price_as_of=${ahead}`])).json.error.code, 'EXTERNAL_QUOTE_STALE');
    const usdc = await run(['orders', 'create', 'product_id=AAPL-USDC', 'side=BUY', 'type=market', 'base_size=1', `client_order_id=${crypto.randomUUID()}`, ...QUOTE]);
    assert.equal(usdc.json.error.code, 'CURRENCY_MISMATCH');
  });

  it('balance --refresh marks crypto, leaves equities unpriced with priced_* subtotals, and still fails on a bad crypto book', async () => {
    assert.equal((await run(['init'])).code, 0);
    assert.equal((await run([...EQUITY, 'base_size=2', `client_order_id=${UUID}`, ...QUOTE])).code, 0);
    const equityOnly = await run(['balance', '--refresh']);
    assert.equal(equityOnly.code, 0, equityOnly.err);
    assert.deepEqual([equityOnly.json.priced, equityOnly.json.equity, equityOnly.json.total_pnl, equityOnly.json.priced_market_value], [false, null, null, '0.00']);
    assert.equal(equityOnly.json.unpriced_positions[0].product_id, 'AAPL-USD');
    assert.ok(market.calls.every((call) => call !== 'book:AAPL-USD'), 'refresh never reads a book for an equity');

    assert.equal((await run([...CREATE, 'base_size=0.001', `client_order_id=${UUID2}`])).code, 0);
    const mixed = await run(['balance', '--refresh']);
    assert.equal(mixed.code, 0, mixed.err);
    assert.deepEqual([mixed.json.priced, mixed.json.equity, mixed.json.unrealized_pnl, mixed.json.total_pnl], [false, null, null, null]);
    assert.deepEqual([mixed.json.priced_market_value, mixed.json.priced_unrealized_pnl], ['50.00', '-0.07']);
    assert.deepEqual(mixed.json.source.books, ['BTC-USD']);
    assert.match(mixed.json.source.equities, /refresh does not price equities/);
    assert.match(mixed.json.positions[0].unpriced_reason, /priced only at order time, from a supplied quote/);

    (market as MarketData).book = async () => ({});
    const failed = await run(['balance', '--refresh']);
    assert.equal(failed.code, 1);
    assert.equal(failed.json.error.code, 'MARKET_DATA_INVALID');
  });

  it('a held crypto product is never re-traded as an equity', async () => {
    assert.equal((await run(['init'])).code, 0);
    market.notFound.delete('AAPL-USD');
    const listed = await run([...EQUITY, 'base_size=0.01', `client_order_id=${UUID}`]);
    assert.equal(listed.code, 0, listed.err);
    market.notFound.add('AAPL-USD');
    const r = await run(['orders', 'create', 'product_id=AAPL-USD', 'side=SELL', 'type=market', 'base_size=0.01', `client_order_id=${UUID2}`, ...QUOTE]);
    assert.equal(r.json.error.code, 'PRODUCT_CLASS_CONFLICT');
    assert.equal((await run(['balance'])).json.positions[0].asset_class, undefined);
  });

});

describe('paper order grammar', () => {
  const LIMIT = ['orders', 'create', 'product_id=BTC-USD', 'side=BUY', 'type=limit', 'base_size=0.01', 'limit_price=50000'];
  const STOP = ['orders', 'create', 'product_id=BTC-USD', 'side=SELL', 'type=stoplimit', 'base_size=0.01', 'limit_price=49000', 'stop_price=49500'];
  const BRACKET = ['orders', 'create', 'product_id=BTC-USD', 'side=SELL', 'type=bracket', 'base_size=0.01', 'limit_price=60000', 'stop_price=45000'];
  const code = (args: string[], now?: number) => { try { parsePaperArgs(args, now); } catch (err) { assert.ok(err instanceof PaperError); return err.code; } return 'OK'; };

  it('accepts each order type with its live fields and normalizes ids, directions and times', () => {
    const limit = parsed([...LIMIT, 'time_in_force=GTD', 'end_time=2026-01-15T14:00:00+01:00', 'post_only=true', `client_order_id=${UUID.toUpperCase()}`, 'attached_take_profit_price=60000', 'attached_stop_loss_price=45000']);
    assert.equal(limit.fields.end_time, '2026-01-15T13:00:00.000Z');
    assert.equal(limit.fields.client_order_id, UUID);
    assert.equal(parsed([...STOP, 'stop_direction=down']).fields.stop_direction, 'STOP_DIRECTION_STOP_DOWN');
    assert.equal(parsed([...STOP, 'stop_direction=STOP_DIRECTION_STOP_UP', 'time_in_force=GTC']).fields.stop_direction, 'STOP_DIRECTION_STOP_UP');
    assert.equal(parsed(BRACKET).fields.type, 'bracket');
    assert.equal(parsed([...CREATE, 'quote_size=100', 'time_in_force=FOK', 'attached_stop_loss_price=1']).fields.time_in_force, 'FOK');
    assert.equal(parsed(['orders', 'create', 'product_id=BTC-USD', 'side=SELL', 'type=limit', 'quote_size=100', 'limit_price=50000', 'post_only=false', 'time_in_force=IOC']).fields.post_only, 'false');
  });

  it('enforces the type, size, price and time-in-force matrix before opening any account', () => {
    const cases: Array<[string[], string, RegExp?]> = [
      [[...STOP], 'INVALID_ARGUMENT', /requires stop_direction/],
      [['orders', 'create', 'product_id=BTC-USD', 'side=SELL', 'type=stoplimit', 'quote_size=1', 'limit_price=1', 'stop_price=1', 'stop_direction=up'], 'INVALID_ARGUMENT', /requires base_size/],
      [[...STOP, 'stop_direction=sideways'], 'INVALID_ARGUMENT', /stop_direction/],
      [[...STOP, 'stop_direction=up', 'time_in_force=IOC'], 'INVALID_ARGUMENT', /not valid for type=stoplimit/],
      [[...STOP, 'stop_direction=up', 'post_only=true'], 'INVALID_ARGUMENT', /post_only does not apply/],
      [['orders', 'create', 'product_id=BTC-USD', 'side=BUY', 'type=bracket', 'base_size=1', 'limit_price=2', 'stop_price=1'], 'INVALID_ARGUMENT', /requires side=SELL/],
      [[...BRACKET.slice(0, -1), 'stop_price=60000'], 'INVALID_ARGUMENT', /stop_price below limit_price/],
      [[...BRACKET, 'stop_direction=down'], 'INVALID_ARGUMENT', /does not apply to type=bracket/],
      [[...BRACKET, 'attached_take_profit_price=1'], 'INVALID_ARGUMENT', /does not apply/],
      [[...LIMIT, 'time_in_force=GTD'], 'INVALID_ARGUMENT', /requires end_time/],
      [[...LIMIT, 'end_time=2026-02-01T00:00:00Z'], 'INVALID_ARGUMENT', /requires time_in_force=GTD/],
      [[...LIMIT, 'time_in_force=GTD', 'end_time=2026-02-01T00:00:00.1234Z'], 'INVALID_ARGUMENT', /millisecond/],
      [[...LIMIT, 'time_in_force=GTD', 'end_time=2026-02-30T00:00:00Z'], 'INVALID_ARGUMENT', /RFC 3339/],
      [[...LIMIT, 'time_in_force=GTD', 'end_time=2026-02-01T00:00:00'], 'INVALID_ARGUMENT', /timezone/],
      [[...LIMIT, 'time_in_force=DAY'], 'INVALID_ARGUMENT', /not valid for type=limit/],
      [[...LIMIT, 'post_only=true', 'time_in_force=IOC'], 'INVALID_ARGUMENT', /GTC or GTD/],
      [[...LIMIT, 'post_only=yes'], 'INVALID_ARGUMENT', /true or false/],
      [[...LIMIT, 'stop_price=1'], 'INVALID_ARGUMENT', /stop_price does not apply to type=limit/],
      [[...LIMIT, 'limit_price=1'], 'INVALID_ARGUMENT', /more than once/],
      [[...LIMIT.slice(0, -1), 'limit_price=-1'], 'INVALID_DECIMAL'],
      [[...CREATE, 'base_size=1', 'time_in_force=GTC'], 'INVALID_ARGUMENT', /not valid for type=market/],
      [[...CREATE, 'base_size=1', 'post_only=false'], 'INVALID_ARGUMENT', /post_only does not apply/],
      [['orders', 'create', 'product_id=BTC-USD', 'side=SELL', 'type=market', 'base_size=1', 'attached_stop_loss_price=1'], 'INVALID_ARGUMENT', /BUY parents/],
      [[...LIMIT, 'attached_take_profit_price=40000', 'attached_stop_loss_price=45000'], 'INVALID_ARGUMENT', /below attached_take_profit_price/],
      [[...LIMIT, 'reference_price=1'], 'PAPER_UNSUPPORTED_ORDER_TYPE', /Equity paper orders support type=market/],
      [['orders', 'create', 'product_id=BRK.B-USD', 'side=BUY', 'type=limit', 'base_size=1', 'limit_price=1'], 'PAPER_UNSUPPORTED_ORDER_TYPE', /type=limit is not simulated/],
      [['orders', 'create', 'product_id=BTC-USD', 'side=BUY', 'type=LIMIT', 'base_size=1', 'limit_price=1'], 'INVALID_ARGUMENT', /type=LIMIT must be lowercase, like the live CLI: type=limit/],
      [['orders', 'create', 'product_id=BRK.B-USD', 'side=BUY', 'type=market', 'base_size=1', 'attached_stop_loss_price=1'], 'PAPER_UNSUPPORTED_ORDER_TYPE', /attached exits/],
      [[...CREATE, 'base_size=1', 'equity_trading_session=EXTENDED'], 'PAPER_UNSUPPORTED_FIELD'],
      [['orders', 'create', 'product_id=BTC-USD', 'side=BUY', 'type=scaled', 'base_size=1'], 'PAPER_UNSUPPORTED_ORDER_TYPE'],
    ];
    for (const [args, expected, message] of cases) {
      const err = parseError(args);
      assert.equal(err.code, expected, args.join(' '));
      if (message) assert.match(err.message, message, args.join(' '));
    }
    assert.equal(code([...LIMIT, 'time_in_force=GTD', 'end_time=2026-01-15T11:59:59Z'], NOW), 'INVALID_ARGUMENT', 'GTD end_time must be in the future');
    assert.equal(code([...LIMIT, 'time_in_force=GTD', 'end_time=2026-01-15T12:00:01Z'], NOW), 'OK');
  });

  it('parses order_ids from a list or a JSON array and rejects malformed members', () => {
    assert.equal(parsed(['orders', 'cancel', `order_ids=${UUID.toUpperCase()},${UUID2}`]).fields.order_ids, `${UUID},${UUID2}`);
    assert.equal(parsed(['orders', 'cancel', `order_ids:=["${UUID}","${UUID2}"]`]).fields.order_ids, `${UUID},${UUID2}`);
    assert.equal(parsed(['orders', 'fills', `order_ids==${UUID}`]).fields.order_ids, UUID);
    for (const [arg, message] of [
      [`order_ids=${UUID},${UUID.toUpperCase()}`, /more than once/],
      [`order_ids=${UUID},`, /empty member/],
      ['order_ids:=[]', /at least one/],
      [`order_ids:=[1]`, /must be strings/],
      [`order_ids:={"a":1}`, /JSON array/],
      ['order_ids:=[nope', /JSON array/],
      ['order_ids=abc', /not an order ID/],
      [`order_ids==${UUID}`, /not order_ids==/],
    ] as const) {
      assert.match(parseError(['orders', 'cancel', arg]).message, message, arg);
    }
    assert.match(parseError(['orders', 'list', 'status:=["OPEN"]']).message, /only for array fields/);
    assert.match(parseError(['orders', 'cancel']).message, /requires order_ids/);
    const many = Array.from({ length: 101 }, () => crypto.randomUUID()).join(',');
    assert.match(parseError(['orders', 'cancel', `order_ids=${many}`]).message, /at most 100/);
  });

  it('validates read filters and pagination with live spellings', () => {
    assert.deepEqual(parsed(['orders', 'list', 'status==OPEN', 'product_ids=BTC-USD,AAPL-USD', 'product_type=SPOT', 'start=2026-01-01T00:00:00+01:00', 'end==2026-01-02T00:00:00Z', 'limit=5', 'cursor=eyJ2IjoxfQ']).fields, {
      status: 'OPEN', product_ids: 'BTC-USD,AAPL-USD', product_type: 'SPOT', start: '2025-12-31T23:00:00.000Z', end: '2026-01-02T00:00:00.000Z', limit: '5', cursor: 'eyJ2IjoxfQ',
    });
    assert.match(parseError(['orders', 'list', 'status=open']).message, /status must be one of/);
    assert.match(parseError(['orders', 'list', 'product_ids=btc-usd']).message, /not a product ID/);
    assert.match(parseError(['orders', 'list', 'product_ids=BTC-USD,BTC-USD']).message, /more than once/);
    assert.match(parseError(['orders', 'list', 'product_type=OPTION']).message, /SPOT, EQUITY or FUTURE/);
    assert.match(parseError(['orders', 'fills', 'start=2026-01-02T00:00:00Z', 'end=2026-01-01T00:00:00Z']).message, /start must be before end/);
    assert.match(parseError(['activity', 'limit=1001']).message, /limit must be/);
    assert.equal(parseError(['activity', 'cursor=not a cursor!']).code, 'PAPER_INVALID_CURSOR');
    assert.equal(parseError(['activity', 'side=BUY']).code, 'PAPER_UNSUPPORTED_FIELD');
    assert.match(parseError(['orders', 'fills', 'portfolio_id=x']).hint, /--data-dir/);
  });

  it('parses edit, close-position, performance, reset and format', () => {
    assert.deepEqual(parsed(['orders', 'edit', UUID.toUpperCase(), 'limit_price=51000', 'cancel_attached_order=true']).positionals, [UUID]);
    assert.match(parseError(['orders', 'edit', UUID]).message, /at least one change/);
    assert.match(parseError(['orders', 'edit', UUID, 'cancel_attached_order=false']).message, /at least one change/);
    assert.match(parseError(['orders', 'edit', UUID, 'cancel_attached_order=true', 'attached_stop_loss_price=1']).message, /cannot be combined/);
    assert.match(parseError(['orders', 'edit', UUID, 'cancel_attached_order=1']).message, /true or false/);
    assert.match(parseError(['orders', 'edit', 'abc', 'limit_price=1']).message, /UUID/);
    assert.equal(parseError(['orders', 'edit', UUID, 'stop_price=1']).code, 'PAPER_UNSUPPORTED_FIELD');
    assert.deepEqual(parsed(['orders', 'close-position', `client_order_id=${UUID}`, 'product_id=BTC-USD', 'size=0.5']).fields, { client_order_id: UUID, product_id: 'BTC-USD', size: '0.5' });
    assert.match(parseError(['orders', 'close-position', 'product_id=BTC-USD']).message, /requires client_order_id/);
    assert.match(parseError(['orders', 'close-position', `client_order_id=${UUID}`, 'product_id=BTC-USD', 'base_size=1']).hint, /size=N/);
    assert.deepEqual(parsed(['performance', '--period', '1W', '--chart']).flags, { period: '1W', chart: true });
    assert.match(parseError(['performance', '--period', '1Y']).message, /--period/);
    assert.deepEqual(parsed(['reset', '--confirm']).flags, { confirm: true });
    assert.equal(parsed(['balance', '--format', 'table']).flags.format, 'table');
    assert.match(parseError(['balance', '--format', 'yaml']).message, /json or table/);
    assert.match(parseError(['candles', 'BTC-USD', '--start', '1', '--end', '2', '--granularity', 'ONE_DAY', '--data-dir', '/x']).message, /does not accept --data-dir/);
    assert.match(parseError(['init', '--fee-bps', '5', '--maker-fee-bps', '2']).message, /cannot be combined/);
    assert.deepEqual(parsed(['init', '--maker-fee-bps', '2', '--taker-fee-bps', '6']).flags, { 'maker-fee-bps': '2', 'taker-fee-bps': '6' });
  });

  it('recognizes preview and streaming as unsupported paper operations without executing', () => {
    const preview = parseError(['orders', 'preview', 'product_id=BTC-USD', 'side=BUY', 'type=market', 'quote_size=1']);
    assert.equal(preview.code, 'PAPER_UNSUPPORTED_OPERATION');
    assert.match(preview.hint, /nothing was placed/);
    assert.doesNotMatch(preview.hint, /orders create/);
    assert.ok('help' in parsePaperArgs(['orders', 'preview', '--help']));
    assert.equal(parseError(['orders', 'list', '--watch']).code, 'PAPER_UNSUPPORTED_OPERATION');
    assert.equal(parseError(['orders', 'fills', '--until', 'filled']).code, 'PAPER_UNSUPPORTED_OPERATION');
  });

  it('every command has local help mirroring the live field names', () => {
    for (const cmd of ['orders create', 'orders get', 'orders list', 'orders fills', 'orders cancel', 'orders edit', 'orders close-position', 'orders preview', 'activity', 'performance', 'reset', 'balance', 'init', 'backup', 'bind', 'doctor', 'candles']) {
      const help = parsePaperArgs([...cmd.split(' '), '--help']);
      assert.ok('help' in help && help.help.startsWith(`Usage: coinbase-paper ${cmd}`), cmd);
    }
    const text = (args: string[]) => { const h = parsePaperArgs(args); assert.ok('help' in h); return h.help; };
    assert.match(text(['orders', 'list', '--help']), /status=STATUS/);
    assert.match(text(['orders', 'close-position', '--help']), /client_order_id=UUID product_id=PRODUCT \[size=N\]/);
    assert.match(text(['orders', 'edit', '--help']), /cancel_attached_order=true/);
    assert.match(text(['orders', 'cancel', '--help']), /order_ids:=/);
    assert.match(text(['orders', 'create', '--help']), /total spend INCLUDING the assumed fee/);
    assert.match(text(['orders', 'create', '--help']), /ORIGINAL receipt/);
    assert.match(text(['balance', '--help']), /may still read public candles/);
    assert.match(text(['--help']), /--format json\|table/);
  });

  it('parseTimestamp normalizes valid RFC 3339 and rejects invalid ones', () => {
    assert.equal(parseTimestamp('2026-01-15T12:00:00.5-05:30', 't'), '2026-01-15T17:30:00.500Z');
    for (const bad of ['2026-01-15 12:00:00Z', '2026-13-01T00:00:00Z', '2026-01-15T24:00:00Z', '2026-01-15T12:00:00+24:00', '2026-01-15t12:00:00z']) {
      assert.throws(() => parseTimestamp(bad, 't'), /RFC 3339/, bad);
    }
  });
});

describe('editIsNoop', () => {
  const order = { order_configuration: { base_size: '1.00000000', limit_price: '50000.00' }, attached_order_configuration: { attached_take_profit_price: '60000', attached_stop_loss_price: null } };
  it('treats numerically equal terms as unchanged and attachment replacement as a whole', () => {
    assert.equal(editIsNoop(order, { base_size: '1', limit_price: '50000' }), true);
    assert.equal(editIsNoop(order, { limit_price: '50001' }), false);
    assert.equal(editIsNoop(order, { attached_take_profit_price: '60000.0' }), true);
    assert.equal(editIsNoop(order, { attached_stop_loss_price: '40000' }), false, 'a stop-only attachment drops the take-profit');
    assert.equal(editIsNoop(order, { cancel_attached_order: 'true' }), false);
    assert.equal(editIsNoop({ ...order, attached_order_configuration: null }, { cancel_attached_order: 'true' }), true);
  });
});

// ---------------------------------------------------------- orchestration with injected fakes

const ACCOUNT_ID = 'paper-0e0f6a4c-1b2d-4c3e-8f4a-5b6c7d8e9f00';
const OK_RECON: ReconciliationView = { status: 'NOT_NEEDED', attempted_at: new Date(NOW).toISOString(), reconciled_at: new Date(NOW).toISOString(), reason: null, orders_checked: 0, orders_filled: 0, orders_expired: 0, windows: [] };
const STALE_RECON: ReconciliationView = { ...OK_RECON, status: 'STALE', reconciled_at: '2026-01-15T11:00:00.000Z', reason: { code: 'MARKET_DATA_UNAVAILABLE', message: 'candles unavailable', hint: 'retry later' } };

// Partial fakes: they implement only what each orchestration test exercises.
class FakeLedgerStore {
  calls: string[] = [];
  accepted = new Map<string, Record<string, unknown>>();
  reserved: unknown[] = [];
  placed: Array<{ intent: any; market: PlacementMarketView; provenance: Provenance }> = [];
  edits: Array<{ id: string; edit: Record<string, unknown>; market: PlacementMarketView | null }> = [];
  filters: Array<Record<string, unknown>> = [];
  orders = new Map<string, Record<string, unknown>>();
  positions: Position[] = [];
  placeError: PaperError | null = null;
  closed = 0;
  readSnapshot() {
    return { account: { account_id: ACCOUNT_ID, currency: 'USD', initial_cash: '10000', cash: '10000', realized_pnl: '0', fee_bps: '10', quote_increment: '0.01', created_at: new Date(NOW).toISOString() }, positions: this.positions };
  }
  readLedger() { this.calls.push('readLedger'); return { ...this.readSnapshot(), orders: [...this.orders.values()], fills: [], events: [], holds: { cash: '0', positions: {} } }; }
  findAcceptance(intent: any) { this.calls.push('findAcceptance'); return this.accepted.get(intent.request_id) ?? null; }
  reserveOrder(intent: unknown) { this.calls.push('reserveOrder'); this.reserved.push(intent); return null; }
  abandoned: string[] = [];
  abandonReservation(intent: any) { this.calls.push('abandonReservation'); this.abandoned.push(intent.request_id); return true; }
  placeOrder(intent: any, market: PlacementMarketView, _now: () => number, provenance: Provenance) {
    this.calls.push('placeOrder');
    if (this.placeError) throw this.placeError;
    this.placed.push({ intent, market, provenance });
    const receipt = { mode: 'PAPER', ok: true, request_id: intent.request_id, order_id: intent.request_id, client_order_id: intent.request_id, status: 'OPEN', product_id: intent.product_id, reconciliation: provenance.reconciliation, source: { provider: 'injected', requests: provenance.requests } };
    this.accepted.set(intent.request_id, receipt);
    return receipt;
  }
  editOrder(id: string, edit: Record<string, unknown>, market: PlacementMarketView | null) {
    this.calls.push('editOrder');
    this.edits.push({ id, edit, market });
    return { ...this.orders.get(id), edited: market !== null };
  }
  cancelOrders(ids: string[]) {
    this.calls.push('cancelOrders');
    return ids.map((id) => this.orders.has(id)
      ? { order_id: id, success: true, status: 'CANCELLED' }
      : { order_id: id, success: false, error: { code: 'ORDER_NOT_FOUND', message: 'not found', hint: 'check' } });
  }
  getOrder(id: string) { this.calls.push('getOrder'); return this.orders.get(id); }
  page(filter: Record<string, unknown>): PageView { this.filters.push(filter); return { items: [...this.orders.values()].map((o) => ({ ...o })), has_next: true, cursor: 'next-cursor' }; }
  listOrders(filter: Record<string, unknown>) { this.calls.push('listOrders'); return this.page(filter); }
  listFills(filter: Record<string, unknown>) { this.calls.push('listFills'); return { ...this.page(filter), items: [{ trade_id: 't1', order_id: UUID, trade_time: '2026-01-15T11:01:00.000Z', price: '50000.00', size: '0.01', commission: '0.50', product_id: 'BTC-USD', side: 'BUY', liquidity_indicator: 'MAKER' }] }; }
  listActivity(filter: Record<string, unknown>) { this.calls.push('listActivity'); return { ...this.page(filter), items: [{ event_id: 'e1', order_id: UUID, product_id: 'BTC-USD', event_time: '2026-01-15T11:00:00.000Z', event_type: 'ACCEPTED', status: 'OPEN', details: {} }] }; }
  async backup(output: string) { this.calls.push('backup'); return { backup: output, revision: 7 }; }
  close() { this.closed++; }
}

class CountingMarket {
  provider: string;
  counts = { product: 0, book: 0, candles: 0 };
  source: MarketData;
  constructor(source: MarketData, provider: string) { this.source = source; this.provider = provider; }
  async product(id: string) { this.counts.product++; return this.source.product(id); }
  async book(id: string) { this.counts.book++; return this.source.book(id); }
  async candles(id: string, start: string, end: string, granularity: string) { this.counts.candles++; return this.source.candles(id, start, end, granularity); }
  stats() { const { product, book, candles } = this.counts; return { product, book, candles, total: product + book + candles, cache_hits: 0, http_attempts: null }; }
}

describe('runPaper orchestration (injected engine, store and account modules)', () => {
  let dir: string;
  let market: FakeMarket;
  let store: FakeLedgerStore;
  let recon: ReconciliationView;
  let log: { opened: number; reconcile: number; balance: Array<unknown>; performance: Array<unknown>; reset: number };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'coinbase-paper-orch-'));
    market = new FakeMarket();
    store = new FakeLedgerStore();
    recon = OK_RECON;
    log = { opened: 0, reconcile: 0, balance: [], performance: [], reset: 0 };
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function services(): Partial<PaperServices> {
    const fakes: Record<keyof PaperServices, (...args: any[]) => Promise<unknown>> = {
      openAccount: async () => { log.opened++; return store as unknown as PaperStoreView; },
      createCommandMarketData: async (source: MarketData, { provider }: { provider: string }) => new CountingMarket(source, provider) as unknown as CommandMarketDataView,
      reconcileAccount: async () => { log.reconcile++; return recon; },
      normalizeOrderInput: async (input: object) => ({ operation: 'create', ...input }),
      normalizeClosePositionInput: async (input: object) => ({ operation: 'close-position', ...input }),
      normalizeEditInput: async (input: object) => input,
      buildBalance: async (_ledger: unknown, books: Record<string, unknown> | null, now: number) => {
        log.balance.push(books);
        const priced = books !== null;
        return { account_id: ACCOUNT_ID, cash: '10000', cash_balance: { total: '10000', available: '9000', hold: '1000' }, buying_power: '9000', priced, marked_at: priced ? new Date(now).toISOString() : null, valuation_status: priced ? 'MARKED' : 'UNPRICED', positions: store.positions.map((p) => ({ product_id: p.product_id, total: p.quantity, available: p.quantity, hold: '0', mark_status: priced && p.asset_class !== 'EQUITY' ? 'FRESH' : 'MISSING', asset_class: p.asset_class })) };
      },
      buildPerformance: async (_ledger: unknown, _market: unknown, request: { period: string; chart: boolean }) => { log.performance.push(request); return { period: request.period, status: 'PARTIAL', points: [], gaps: [{ product_id: 'BTC-USD', code: 'MISSING_CANDLE' }], ...(request.chart ? { chart: 'PAPER — reconstructed candle-close equity\n*---*' } : {}) }; },
      resetAccount: async () => { log.reset++; return { previous_account_id: ACCOUNT_ID, account_id: 'paper-new', archive: '/a', state: '/s', schema_version: 4 }; },
    };
    return fakes as unknown as Partial<PaperServices>;
  }

  async function run(args: string[]): Promise<Run> {
    let out = '';
    let err = '';
    const code = await runPaper(args, {
      marketData: market, now: () => NOW, env: { COINBASE_PAPER_HOME: join(dir, 'data') }, home: dir,
      stdout: (t) => { out += t; }, stderr: (t) => { err += t; }, services: services(),
    });
    let json: any = null;
    try { json = JSON.parse(code === 0 ? out : err); } catch { /* table or help */ }
    return { code, out, err, json };
  }

  it('help, doctor and rejected syntax never open the account, reconcile or read market data', async () => {
    for (const args of [['orders', 'fills', '--help'], ['help', 'activity'], ['doctor'], ['orders', 'list', 'status=nope'], ['reset'], ['orders', 'preview']]) {
      await run(args);
    }
    assert.deepEqual([log.opened, log.reconcile, market.calls.length], [0, 0, 0]);
    const reset = await run(['reset']);
    assert.equal(reset.json.error.code, 'PAPER_RESET_CONFIRMATION_REQUIRED');
  });

  it('a new crypto limit order reconciles once, reads one product and one book, and passes provenance to the store', async () => {
    const r = await run(['orders', 'create', 'product_id=BTC-USD', 'side=BUY', 'type=limit', 'base_size=0.01', 'limit_price=49000', 'post_only=true', `client_order_id=${UUID}`, 'attached_stop_loss_price=40000']);
    assert.equal(r.code, 0, r.err);
    assert.equal(log.reconcile, 1);
    assert.deepEqual(market.calls, ['product:BTC-USD', 'book:BTC-USD']);
    assert.deepEqual(store.calls, ['findAcceptance', 'reserveOrder', 'placeOrder']);
    const [{ intent, market: placement, provenance }] = store.placed;
    assert.deepEqual(intent, { operation: 'create', request_id: UUID, account_id: ACCOUNT_ID, product_id: 'BTC-USD', side: 'BUY', type: 'limit', base_size: '0.01', limit_price: '49000', attached_stop_loss_price: '40000', post_only: true });
    assert.equal(placement.kind, 'crypto');
    assert.equal(provenance.reconciliation.status, 'NOT_NEEDED');
    assert.deepEqual(provenance.requests, { product: 1, book: 1, candles: 0, total: 2, cache_hits: 0, http_attempts: null });
    assert.equal(r.json.order_id, UUID);
    assert.equal(r.json.reconciliation.status, 'NOT_NEEDED');
    assert.equal(store.closed, 1);
  });

  it('an accepted create replays its stored receipt byte-for-byte with zero reconciliation or market reads', async () => {
    const args = ['orders', 'create', 'product_id=BTC-USD', 'side=BUY', 'type=limit', 'base_size=0.01', 'limit_price=49000', `client_order_id=${UUID}`];
    const first = await run(args);
    const replay = await run(args);
    assert.equal(replay.code, 0, replay.err);
    assert.equal(replay.out, first.out);
    assert.equal(log.reconcile, 1, 'only the first run reconciles');
    assert.equal(market.calls.length, 2, 'replay reads no market data');
  });

  it('a same-ID create that loses a race during a STALE pass returns the winner, not STALE', async () => {
    recon = STALE_RECON;
    const winner = { mode: 'PAPER', ok: true, request_id: UUID2, order_id: UUID2, client_order_id: UUID2, status: 'OPEN', product_id: 'BTC-USD' };
    let lookups = 0;
    // First lookup (before reconciliation) finds nothing; the winner is stored while this command reconciles.
    store.findAcceptance = (intent: any) => { store.calls.push('findAcceptance'); return ++lookups === 1 ? null : (intent.request_id === UUID2 ? winner : null); };
    const r = await run(['orders', 'create', 'product_id=BTC-USD', 'side=BUY', 'type=limit', 'base_size=0.01', 'limit_price=49000', `client_order_id=${UUID2}`]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json.order_id, UUID2);
    assert.deepEqual(store.calls, ['findAcceptance', 'reserveOrder', 'findAcceptance']);
    assert.deepEqual(market.calls, [], 'no placement read');
  });

  it('STALE edits hint to retry the edit, not a client_order_id', async () => {
    recon = STALE_RECON;
    store.orders.set(UUID, { order_id: UUID, product_id: 'BTC-USD', status: 'OPEN', order_type: 'LIMIT', order_configuration: { base_size: '1', limit_price: '50000' }, attached_order_configuration: null });
    const r = await run(['orders', 'edit', UUID, 'limit_price=49000']);
    assert.equal(r.json.error.code, 'PAPER_RECONCILIATION_STALE');
    assert.match(r.json.error.hint, /Retry the same edit command/);
    assert.doesNotMatch(r.json.error.hint, /client_order_id/);
  });

  it('STALE reconciliation blocks new orders after reserving, but reads, backup and cancels still answer', async () => {
    recon = STALE_RECON;
    store.orders.set(UUID, { order_id: UUID, product_id: 'BTC-USD', status: 'OPEN', order_type: 'LIMIT', order_configuration: { base_size: '1', limit_price: '50000' }, attached_order_configuration: null });
    const create = await run(['orders', 'create', 'product_id=BTC-USD', 'side=BUY', 'type=market', 'quote_size=10', `client_order_id=${UUID2}`]);
    assert.equal(create.code, 1);
    assert.equal(create.json.error.code, 'PAPER_RECONCILIATION_STALE');
    assert.equal(create.json.reconciliation.status, 'STALE');
    assert.deepEqual(create.json.source.requests, { product: 0, book: 0, candles: 0, total: 0, cache_hits: 0, http_attempts: null });
    assert.equal(store.reserved.length, 1, 'the pending request stays reserved');
    assert.deepEqual(market.calls, []);

    const list = await run(['orders', 'list', 'status=OPEN']);
    assert.equal(list.code, 0, list.err);
    assert.equal(list.json.reconciliation.status, 'STALE');
    assert.match(list.json.notice, /STALE/);

    const cancel = await run(['orders', 'cancel', `order_ids=${UUID},${UUID2}`]);
    assert.equal(cancel.code, 0, 'a partial cancel batch still exits 0');
    assert.equal(cancel.json.ok, true);
    assert.deepEqual(cancel.json.results.map((x: any) => [x.order_id, x.success]), [[UUID, true], [UUID2, false]]);
    assert.equal(cancel.json.results[1].error.code, 'ORDER_NOT_FOUND');
    assert.match(cancel.json.notice, /Historical reconciliation was unavailable/);

    const edit = await run(['orders', 'edit', UUID, 'limit_price=51000']);
    assert.equal(edit.json.error.code, 'PAPER_RECONCILIATION_STALE');
    const noop = await run(['orders', 'edit', UUID, 'limit_price=50000.00']);
    assert.equal(noop.code, 0, noop.err);
    assert.equal(noop.json.edited, false);
    assert.equal(store.edits.at(-1)!.market, null);
    assert.deepEqual(market.calls, [], 'stale and no-op edits read no book');

    assert.equal((await run(['backup', '--output', join(dir, 'b.sqlite3')])).json.reconciliation.status, 'STALE');
  });

  it('a real edit reads one book with saved product rules and returns the current view', async () => {
    store.orders.set(UUID, { order_id: UUID, product_id: 'BTC-USD', status: 'OPEN', order_configuration: { base_size: '1', limit_price: '50000' }, attached_order_configuration: null });
    const r = await run(['orders', 'edit', UUID, 'base_size=2', 'attached_take_profit_price=60000', 'attached_stop_loss_price=40000']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json.edited, true);
    assert.deepEqual(market.calls, ['book:BTC-USD']);
    assert.deepEqual(store.edits[0].edit, { base_size: '2', attached_take_profit_price: '60000', attached_stop_loss_price: '40000' });
    assert.equal(r.json.source.requests.book, 1);
    assert.equal((await run(['orders', 'edit', UUID2, 'limit_price=1'])).json.error.code, 'ORDER_NOT_FOUND');
    store.orders.set(UUID2, { order_id: UUID2, product_id: 'BTC-USD', status: 'FILLED', order_configuration: {} });
    await run(['orders', 'edit', UUID2, 'limit_price=1']);
    assert.equal(store.edits.at(-1)!.market, null, 'a non-open order is answered by the store without a book');
    assert.equal(market.calls.length, 1);
  });

  it('read commands pass normalized filters and return the paginated envelope', async () => {
    store.orders.set(UUID, { request_id: UUID, product_id: 'BTC-USD', status: 'OPEN' });
    const list = await run(['orders', 'list', 'status==OPEN', 'product_ids=BTC-USD,ETH-USD', 'start=2026-01-01T01:00:00+01:00', 'limit=5', 'cursor=abc']);
    assert.equal(list.code, 0, list.err);
    assert.deepEqual(store.filters[0], { limit: 5, status: 'OPEN', product_ids: ['BTC-USD', 'ETH-USD'], start: '2026-01-01T00:00:00.000Z', cursor: 'abc' });
    assert.deepEqual([list.json.orders[0].order_id, list.json.has_next, list.json.cursor], [UUID, true, 'next-cursor']);
    assert.deepEqual(list.json.source.budget, { max_product_requests: 1, max_book_requests: 100, max_candle_requests: 32, max_total_requests: 133, max_candles_per_request: 350 });

    const fills = await run(['orders', 'fills', `order_ids:=["${UUID}"]`, 'side==BUY']);
    assert.deepEqual(store.filters[1], { limit: 50, side: 'BUY', order_ids: [UUID] });
    assert.equal(fills.json.fills[0].liquidity_indicator, 'MAKER');
    const activity = await run(['activity', 'limit=2']);
    assert.equal(activity.json.activities[0].event_type, 'ACCEPTED');

    const future = await run(['orders', 'list', 'product_type=FUTURE']);
    assert.deepEqual([future.json.orders, future.json.has_next, future.json.cursor], [[], false, null]);
    assert.equal(store.filters.length, 3, 'FUTURE never reaches the store');
    assert.equal(log.reconcile, 4, 'each read reconciles exactly once');

    const got = await run(['orders', 'get', UUID]);
    assert.equal(got.json.order_id, UUID);
    store.orders.set(UUID, { order_id: UUID, status: 'FILLED', source: { provider: 'external', url: 'https://example.com/q' } });
    const quoted = await run(['orders', 'get', UUID]);
    assert.deepEqual(quoted.json.source, { provider: 'external', url: 'https://example.com/q' }, 'an order view keeps its execution provenance');
    assert.equal(quoted.json.command_source.requests.total, 0);
    store.orders.set(UUID2, { order_id: UUID2, status: 'PENDING' });
    assert.match((await run(['orders', 'get', UUID2])).json.hint, /same client_order_id/);
    assert.equal((await run(['orders', 'get', crypto.randomUUID()])).json.error.code, 'ORDER_NOT_FOUND');
  });

  it('close-position uses size, requires a position before reserving, and adds success', async () => {
    const none = await run(['orders', 'close-position', `client_order_id=${UUID}`, 'product_id=BTC-USD']);
    assert.equal(none.json.error.code, 'PAPER_NO_POSITION');
    assert.deepEqual([log.reconcile, store.reserved.length, market.calls.length], [0, 0, 0]);

    store.positions = [{ product_id: 'BTC-USD', quantity: '0.5', cost_basis: '25000', base_increment: '0.00000001', quote_increment: '0.01' }];
    const closed = await run(['orders', 'close-position', `client_order_id=${UUID}`, 'product_id=BTC-USD', 'size=0.1']);
    assert.equal(closed.code, 0, closed.err);
    assert.equal(closed.json.success, true);
    assert.deepEqual(store.placed[0].intent, { operation: 'close-position', request_id: UUID, account_id: ACCOUNT_ID, product_id: 'BTC-USD', size: '0.1' });
    assert.deepEqual(market.calls, ['product:BTC-USD', 'book:BTC-USD']);

    store.positions.push({ product_id: 'AAPL-USD', quantity: '2', cost_basis: '400', base_increment: '0.00001', quote_increment: '0.01', asset_class: 'EQUITY' });
    const equity = await run(['orders', 'close-position', `client_order_id=${UUID2}`, 'product_id=AAPL-USD']);
    assert.equal(equity.json.error.code, 'EXTERNAL_QUOTE_REQUIRED');
    assert.equal(market.calls.length, 2, 'equity close never reads crypto data');
  });

  it('equity resting orders are rejected after a definitive not-found, before any quote or book', async () => {
    const r = await run(['orders', 'create', 'product_id=AAPL-USD', 'side=BUY', 'type=limit', 'base_size=1', 'limit_price=200', `client_order_id=${UUID}`]);
    assert.equal(r.json.error.code, 'PAPER_UNSUPPORTED_ORDER_TYPE');
    assert.match(r.json.error.hint, /reference_price, price_source and price_as_of/);
    assert.deepEqual(market.calls, ['product:AAPL-USD']);
    const sell = await run(['orders', 'create', 'product_id=AAPL-USD', 'side=SELL', 'type=market', 'quote_size=100', `client_order_id=${UUID2}`]);
    assert.equal(sell.json.error.code, 'PAPER_UNSUPPORTED_FIELD');
  });

  it('insufficient-funds errors carry the figures as structured details plus command provenance', async () => {
    const err = new PaperError('INSUFFICIENT_CASH', 'Insufficient paper cash: available 900.00 USD; required 1000.50 USD; shortfall 100.50 USD.', 'Run coinbase-paper balance.');
    Object.assign(err, { details: { currency: 'USD', available: '900.00', required: '1000.50', shortfall: '100.50', hold: '9100.00' } });
    store.placeError = err;
    const r = await run(['orders', 'create', 'product_id=BTC-USD', 'side=BUY', 'type=limit', 'base_size=0.02', 'limit_price=50000', `client_order_id=${UUID}`]);
    assert.equal(r.code, 1);
    assert.equal(r.out, '');
    assert.deepEqual(r.json.error.details, { currency: 'USD', available: '900.00', required: '1000.50', shortfall: '100.50', hold: '9100.00' });
    assert.match(r.json.error.message, /available 900.00 USD; required 1000.50 USD; shortfall 100.50 USD/);
    assert.equal(r.json.reconciliation.status, 'NOT_NEEDED');
    assert.equal(r.json.source.requests.book, 1);
  });

  it('balance reads books only with --refresh and only for open crypto positions', async () => {
    store.positions = [
      { product_id: 'BTC-USD', quantity: '0.5', cost_basis: '25000', base_increment: '0.00000001', quote_increment: '0.01' },
      { product_id: 'ETH-USD', quantity: '0', cost_basis: '0', base_increment: '0.00000001', quote_increment: '0.01' },
      { product_id: 'AAPL-USD', quantity: '2', cost_basis: '400', base_increment: '0.00001', quote_increment: '0.01', asset_class: 'EQUITY' },
    ];
    const offline = await run(['balance']);
    assert.equal(offline.code, 0, offline.err);
    assert.deepEqual([log.balance[0], market.calls.length, offline.json.priced, offline.json.marked_at], [null, 0, false, null]);
    assert.equal(offline.json.source.marks, 'none: balance marks positions only with --refresh');
    const refreshed = await run(['balance', '--refresh']);
    assert.equal(refreshed.code, 0, refreshed.err);
    assert.deepEqual(market.calls, ['book:BTC-USD']);
    assert.deepEqual(refreshed.json.source.books, ['BTC-USD']);
    assert.match(refreshed.json.source.equities, /does not price equities/);
    assert.equal(log.reconcile, 2);
  });

  it('JSON stays the default; --format table labels PAPER with reconciliation and valuation caveats; errors stay JSON', async () => {
    const json = await run(['balance']);
    assert.doesNotThrow(() => JSON.parse(json.out));
    const table = await run(['balance', '--format', 'table']);
    assert.equal(table.code, 0, table.err);
    assert.match(table.out, /^PAPER {2}coinbase-paper balance {2}\(simulated with virtual funds; never a live order\)/);
    assert.match(table.out, /reconciliation: NOT_NEEDED/);
    assert.match(table.out, /valuation: UNPRICED; not marked to market/);
    assert.match(table.out, /cash_balance\.available: 9000/);
    assert.throws(() => JSON.parse(table.out));

    recon = STALE_RECON;
    store.orders.set(UUID, { order_id: UUID, product_id: 'BTC-USD', side: 'BUY', order_type: 'LIMIT', status: 'OPEN', filled_size: '0', remaining_size: '1' });
    const list = await run(['orders', 'list', '--format', 'table']);
    assert.match(list.out, /reconciliation: STALE; last reconciled 2026-01-15T11:00:00.000Z; MARKET_DATA_UNAVAILABLE/);
    assert.match(list.out, /ORDER_ID +PRODUCT_ID +SIDE +ORDER_TYPE +STATUS/);
    assert.match(list.out, new RegExp(`${UUID} +BTC-USD +BUY +LIMIT +OPEN`));

    const err = await run(['orders', 'create', 'product_id=BTC-USD', 'side=BUY', 'type=market', 'quote_size=1', `client_order_id=${UUID2}`, '--format', 'table']);
    assert.equal(err.code, 1);
    assert.equal(err.json.error.code, 'PAPER_RECONCILIATION_STALE', 'errors are JSON on stderr in table mode');

    const perf = await run(['performance', '--period', '1W', '--chart', '--format', 'table']);
    assert.match(perf.out, /PAPER — reconstructed candle-close equity\n\*---\*/);
    assert.match(perf.out, /gaps \(1\)/);
  });

  it('performance and reset dispatch after one reconciliation with their requests and notices', async () => {
    const perf = await run(['performance']);
    assert.equal(perf.code, 0, perf.err);
    assert.deepEqual(log.performance, [{ period: 'ALL', chart: false }]);
    assert.equal(perf.json.chart, undefined);
    const reset = await run(['reset', '--confirm']);
    assert.equal(reset.code, 0, reset.err);
    assert.deepEqual([log.reset, log.reconcile], [1, 2]);
    assert.equal(reset.json.account_id, 'paper-new');
    assert.match(reset.json.notice, /archived the old one first/);
  });
});

describe('renderTable', () => {
  it('renders cancel results with error codes and source accounting', () => {
    const text = renderTable('orders cancel', { mode: 'PAPER', ok: true, results: [{ order_id: UUID, success: false, error: { code: 'PAPER_ORDER_NOT_OPEN' } }], source: { provider: 'injected', requests: { total: 0, http_attempts: null } }, notice: 'PAPER simulation' });
    assert.match(text, /^PAPER/);
    assert.match(text, /results \(1\)\nORDER_ID +SUCCESS +ERROR\n.* +false +PAPER_ORDER_NOT_OPEN/);
    assert.match(text, /source: injected; requests 0 \(http attempts -\)/);
  });
});
