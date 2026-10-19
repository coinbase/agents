import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { normalizeClosePositionInput, normalizeOrderInput } from './engine.ts';
import { createCommandMarketData } from './market-data.ts';
import { granularityFor, planCandleWindows, planReconciliation, reconcileAccount } from './reconcile.ts';
import { initAccount, openAccount, resolvePaths, type PaperStore } from './store.ts';
import { PaperError, type Candle, type MarketData, type OrderInput } from './types.ts';

// Hand-computed golden cases against the real store with injected public data.
// Product: increments 0.01 base / 0.01 quote; fees maker 10 bps, taker 20 bps.
const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);
const S0 = T0 / 1000;
const iso = (s: number) => new Date(s * 1000).toISOString();
const PRODUCT = {
  product_id: 'BTC-USD', product_type: 'SPOT', base_currency_id: 'BTC', quote_currency_id: 'USD', status: 'online',
  is_disabled: false, trading_disabled: false, cancel_only: false, limit_only: false, post_only: false, auction_mode: false,
  base_increment: '0.01', quote_increment: '0.01', base_min_size: '0.01', base_max_size: '1000', quote_min_size: '0.01', quote_max_size: '10000000',
};
const book = (atMs: number, bid = '99', ask = '101', size = '10') => ({ pricebook: { product_id: 'BTC-USD', time: new Date(atMs).toISOString(), bids: [{ price: bid, size }], asks: [{ price: ask, size }] } });
const bar = (start: number, open: string, high: string, low: string, volume = '10'): Candle => ({ start: String(start), open, high, low, close: open, volume });

class FakeData implements MarketData {
  calls = { product: 0, book: 0, candles: 0 };
  bars: Candle[];
  fail: boolean;
  constructor(bars: Candle[] = [], fail = false) {
    this.bars = bars;
    this.fail = fail;
  }
  async product() { this.calls.product++; return PRODUCT; }
  async book() { this.calls.book++; return book(T0); }
  async candles(_id: string, start: string, end: string) {
    this.calls.candles++;
    if (this.fail) throw new PaperError('MARKET_DATA_UNAVAILABLE', 'down');
    return { candles: this.bars.filter((c) => Number(c.start) >= Number(start) && Number(c.start) <= Number(end)) };
  }
}

const ACCOUNT_IDS = new Map<PaperStore, string>();
let counter = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;

async function account(cash = '10000'): Promise<PaperStore> {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'paper-reconcile-')));
  const paths = resolvePaths(path.join(dir, 'data'), {}, '/nonexistent');
  const made = await initAccount(paths, { cash, currency: 'USD', fee_bps: '20', maker_fee_bps: '10', taker_fee_bps: '20', now: () => T0 });
  const store = await openAccount(paths);
  ACCOUNT_IDS.set(store, String(made.account_id));
  return store;
}

function place(store: PaperStore, fields: Partial<OrderInput>, atMs: number, bk = book(atMs)) {
  const intent = normalizeOrderInput({ request_id: uuid(), account_id: ACCOUNT_IDS.get(store) as string, product_id: 'BTC-USD', side: 'BUY', type: 'limit', ...fields } as OrderInput);
  return store.placeOrder(intent, { kind: 'crypto', product: PRODUCT, book: bk }, () => atMs);
}

async function reconcile(store: PaperStore, bars: Candle[], nowMs: number, source = new FakeData(bars)) {
  const md = createCommandMarketData(source, { provider: 'injected', now: () => nowMs });
  return { report: await reconcileAccount(store, md, nowMs), md, source };
}

const order = (store: PaperStore, id: string) => store.readLedger().orders.find((o) => o.order_id === id)!;

describe('resting limit candle model', () => {
  it('touch is not a fill, insufficient volume is not a fill, then a gap open improves the price (MAKER)', async () => {
    const store = await account();
    const r = place(store, { base_size: '1', limit_price: '100' }, T0 + 30_000);
    assert.equal(r.status, 'OPEN');
    // Hold = ceil(100 x 1) + ceil(100 x max(10,20) bps) = 100 + 0.20.
    let ledger = store.readLedger();
    assert.equal(ledger.holds.cash, '100.2');
    assert.equal(ledger.account.cash, '10000');
    const { report, source } = await reconcile(store, [
      bar(S0 + 60, '100.5', '101', '100'), // low == limit: touch only
      bar(S0 + 120, '99.5', '100.5', '99', '0.5'), // trades through but volume 0.5 < 1
      bar(S0 + 180, '99.234', '100', '98'), // gap: min(100, 99.234) rounded up to 99.24
    ], T0 + 240_000);
    assert.equal(report.status, 'OK');
    assert.equal(report.orders_filled, 1);
    assert.equal(source.calls.candles, 1, 'one page; the candle straddling creation is excluded');
    assert.deepEqual(report.windows.map((w) => [w.start, w.end, w.granularity, w.count]), [[iso(S0 + 60), iso(S0 + 240), 'ONE_MINUTE', 3]]);
    const o = order(store, r.order_id);
    assert.equal(o.status, 'FILLED');
    ledger = store.readLedger();
    const fill = ledger.fills.at(-1)!;
    assert.deepEqual([fill.price, fill.size, fill.notional, fill.commission, fill.liquidity_indicator, fill.trade_time], ['99.24', '1', '99.24', '0.1', 'MAKER', iso(S0 + 240)]);
    // 10000 - 99.24 - ceil(0.09924) = 9900.66; hold released.
    assert.equal(ledger.account.cash, '9900.66');
    assert.equal(ledger.holds.cash, '0');
    assert.equal(ledger.positions[0].cost_basis, '99.34', 'BUY fee enters cost basis');
    assert.equal(o.current_receipt?.average_filled_price, '99.24');
  });

  it('SELL needs strict high > limit; price is max(limit, open)', async () => {
    const store = await account();
    place(store, { type: 'market', base_size: '2' }, T0);
    const r = place(store, { side: 'SELL', base_size: '1', limit_price: '105' }, T0 + 1_000);
    assert.deepEqual(store.readLedger().holds.positions, { 'BTC-USD': '1' });
    await reconcile(store, [bar(S0 + 60, '104', '105', '103'), bar(S0 + 120, '106.5', '107', '104')], T0 + 180_000);
    const fill = store.readLedger().fills.at(-1)!;
    assert.equal(order(store, r.order_id).status, 'FILLED');
    assert.deepEqual([fill.price, fill.notional, fill.commission, fill.trade_time], ['106.5', '106.5', '0.11', iso(S0 + 180)]);
  });

  it('shares one candle volume budget by priority time, then order ID', async () => {
    const store = await account();
    const first = place(store, { base_size: '1', limit_price: '100' }, T0 + 1_000);
    const second = place(store, { base_size: '1', limit_price: '100' }, T0 + 2_000);
    await reconcile(store, [bar(S0 + 60, '99.5', '100', '99', '1.5')], T0 + 120_000);
    assert.equal(order(store, first.order_id).status, 'FILLED');
    assert.equal(order(store, second.order_id).status, 'OPEN', 'remaining volume 0.5 cannot fill the second order');
  });
});

describe('placement', () => {
  it('crossing limits take liquidity; post-only rejects; IOC cancels the rest; FOK is all-or-nothing', async () => {
    const store = await account();
    const marketable = place(store, { base_size: '1', limit_price: '102' }, T0, book(T0, '99', '101', '0.4'));
    // 0.4 @101 TAKER: notional 40.40, fee ceil(0.0808) = 0.09; remainder 0.6 rests.
    assert.equal(marketable.status, 'OPEN');
    assert.deepEqual([marketable.filled_size, marketable.remaining_size, marketable.fee, marketable.fills[0].liquidity_indicator], ['0.40', '0.60', '0.09', 'TAKER']);
    assert.throws(() => place(store, { base_size: '1', limit_price: '101', post_only: true }, T0), (e: PaperError) => e.code === 'PAPER_POST_ONLY_WOULD_CROSS');
    const ioc = place(store, { base_size: '1', limit_price: '101', time_in_force: 'IOC' }, T0, book(T0, '99', '101', '0.25'));
    assert.deepEqual([ioc.status, ioc.filled_size, ioc.terminal_reason], ['CANCELLED', '0.25', 'IOC_REMAINDER_CANCELLED']);
    const fok = place(store, { base_size: '1', limit_price: '101', time_in_force: 'FOK' }, T0, book(T0, '99', '101', '0.99'));
    assert.deepEqual([fok.status, fok.filled_size, fok.terminal_reason], ['CANCELLED', '0.00', 'FOK_NOT_FILLED']);
    const ledger = store.readLedger();
    // Remainder hold: ceil(0.6 x 102) + ceil(61.20 x 20 bps) = 61.20 + 0.13.
    assert.equal(ledger.holds.cash, '61.33');
    // cash = 10000 - (40.40 + 0.09) - IOC (25.25 + 0.06); total = available + hold.
    assert.equal(ledger.account.cash, '9934.2');
  });
});

describe('stop-limit', () => {
  const stop = (store: PaperStore, at = T0 + 1_000) => place(store, { type: 'stoplimit', base_size: '1', stop_price: '105', limit_price: '106', stop_direction: 'up' }, at);

  it('triggers on high >= stop, then fills from the next candle as MAKER', async () => {
    const store = await account();
    const r = stop(store);
    assert.deepEqual([r.status, r.triggered_at, r.hold.cash], ['OPEN', null, '106.22']);
    await reconcile(store, [bar(S0 + 60, '102', '105', '101'), bar(S0 + 120, '105.8', '107', '105.5')], T0 + 180_000);
    const o = order(store, r.order_id);
    assert.equal(o.triggered_at, iso(S0 + 120), 'the trigger candle (high == stop) is persisted');
    assert.equal(o.status, 'FILLED');
    const fill = store.readLedger().fills.at(-1)!;
    assert.deepEqual([fill.price, fill.liquidity_indicator, fill.trade_time], ['105.8', 'MAKER', iso(S0 + 180)]);
    assert.deepEqual(store.readLedger().events.filter((e) => e.order_id === r.order_id).map((e) => e.event_type), ['ACCEPTED', 'OPENED', 'TRIGGERED', 'FILL']);
  });

  it('a trigger candle opening beyond the stop and marketable fills at the open as TAKER', async () => {
    const store = await account();
    const r = stop(store);
    await reconcile(store, [bar(S0 + 60, '105.2', '106', '105')], T0 + 120_000);
    const fill = store.readLedger().fills.at(-1)!;
    assert.equal(order(store, r.order_id).status, 'FILLED');
    // 105.20 TAKER: fee ceil(105.2 x 20 bps = 0.2104) = 0.22.
    assert.deepEqual([fill.price, fill.liquidity_indicator, fill.commission], ['105.2', 'TAKER', '0.22']);
  });

  it('a stop already met by the book triggers at placement and rests as a triggered limit', async () => {
    const store = await account();
    const r = place(store, { type: 'stoplimit', base_size: '1', stop_price: '100', limit_price: '100.5', stop_direction: 'up' }, T0, book(T0, '99', '101'));
    assert.deepEqual([r.status, r.triggered_at, r.filled_size], ['OPEN', new Date(T0).toISOString(), '0.00']);
  });
});

describe('brackets and attached exits', () => {
  async function bracket() {
    const store = await account();
    place(store, { type: 'market', base_size: '2' }, T0);
    const r = place(store, { type: 'bracket', side: 'SELL', base_size: '1', limit_price: '110', stop_price: '95' }, T0 + 1_000);
    assert.equal(r.order_configuration.stop_limit_price, '90.25', 'floor(95 x 0.95)');
    assert.deepEqual(store.readLedger().holds.positions, { 'BTC-USD': '1' }, 'one base hold for both legs');
    return { store, r };
  }

  it('one candle reaching both legs: stop first at the stop price (TAKER), AMBIGUOUS_OCO recorded, no take profit', async () => {
    const { store, r } = await bracket();
    await reconcile(store, [bar(S0 + 60, '100', '111', '94')], T0 + 120_000);
    const o = order(store, r.order_id);
    assert.deepEqual([o.status, o.stop_loss_status, o.take_profit_status], ['FILLED', 'FILLED', 'CANCELLED']);
    const fill = store.readLedger().fills.at(-1)!;
    assert.deepEqual([fill.price, fill.liquidity_indicator], ['95', 'TAKER']);
    assert.ok(store.readLedger().events.some((e) => e.order_id === r.order_id && e.event_type === 'AMBIGUOUS_OCO'));
  });

  it('ambiguity is recorded even when volume prevents the stop fill; the take profit never fills afterwards', async () => {
    const { store, r } = await bracket();
    await reconcile(store, [bar(S0 + 60, '100', '111', '94', '0.5'), bar(S0 + 120, '100', '112', '99')], T0 + 180_000);
    const o = order(store, r.order_id);
    assert.ok(store.readLedger().events.some((e) => e.order_id === r.order_id && e.event_type === 'AMBIGUOUS_OCO'));
    // Candle 2 reaches the take profit (high 112 > 110), but that leg was cancelled at the trigger; the stop's
    // aggressive limit trades through as a resting SELL at max(90.25, open 100), MAKER.
    assert.deepEqual([o.status, o.stop_loss_status, o.take_profit_status], ['FILLED', 'FILLED', 'CANCELLED']);
    const fill = store.readLedger().fills.at(-1)!;
    assert.deepEqual([fill.price, fill.liquidity_indicator, fill.trade_time], ['100', 'MAKER', iso(S0 + 180)]);
  });

  it('a gap below the aggressive floor does not invent a fill; the limit rests and fills later as MAKER', async () => {
    const { store, r } = await bracket();
    await reconcile(store, [bar(S0 + 60, '89', '90', '88'), bar(S0 + 120, '90', '91', '89.5')], T0 + 180_000);
    const o = order(store, r.order_id);
    assert.deepEqual([o.status, o.stop_loss_status], ['FILLED', 'FILLED']);
    const fill = store.readLedger().fills.at(-1)!;
    assert.deepEqual([fill.price, fill.liquidity_indicator, fill.trade_time], ['90.25', 'MAKER', iso(S0 + 180)]);
  });

  it('an immediately marketable parent with attached exits reports its final status on every event', async () => {
    const store = await account();
    const full = place(store, { base_size: '1', limit_price: '102', attached_take_profit_price: '110' }, T0 + 1_000, book(T0 + 1_000, '99', '101', '5'));
    assert.equal(full.status, 'FILLED');
    const fullEvents = store.readLedger().events.filter((e) => e.order_id === full.order_id);
    assert.deepEqual(fullEvents.map((e) => [e.event_type, e.status]).slice(-2), [['FILL', 'FILLED'], ['ATTACHED_ACTIVATED', 'FILLED']]);
    const partial = place(store, { base_size: '1', limit_price: '102', attached_take_profit_price: '110' }, T0 + 2_000, book(T0 + 2_000, '99', '101', '0.4'));
    assert.equal(partial.status, 'OPEN');
    const last = store.readLedger().events.filter((e) => e.order_id === partial.order_id).at(-1)!;
    assert.deepEqual([last.event_type, last.status], ['ATTACHED_ACTIVATED', 'OPEN']);
  });

  it('partial parent fills activate independent GTC children that cannot fill in the parent candle', async () => {
    const store = await account();
    const parent = place(store, { base_size: '1', limit_price: '102', attached_take_profit_price: '110', attached_stop_loss_price: '90' }, T0 + 1_000, book(T0 + 1_000, '99', '101', '0.4'));
    assert.equal(parent.attached_order_ids.length, 1);
    const child = order(store, parent.attached_order_ids[0]);
    assert.deepEqual([child.side, child.order_type, child.base_size, child.base_hold, child.time_in_force, child.parent_order_id], ['SELL', 'BRACKET', '0.4', '0.4', 'GTC', parent.order_id]);
    // The resting parent remainder fills in candle 1, which also reaches the child take profit: the new child must wait.
    await reconcile(store, [bar(S0 + 60, '101', '111', '100'), bar(S0 + 120, '111', '112', '110.5')], T0 + 180_000);
    const ledger = store.readLedger();
    const view = order(store, parent.order_id).current_receipt!;
    assert.equal(view.status, 'FILLED');
    assert.equal(view.attached_order_ids.length, 2);
    const second = order(store, view.attached_order_ids[1]);
    assert.equal(second.created_at, iso(S0 + 120));
    const secondFill = ledger.fills.find((f) => f.order_id === second.order_id)!;
    assert.equal(secondFill.trade_time, iso(S0 + 180), 'child filled in the next candle, not the parent candle');
    assert.ok(ledger.fills.filter((f) => f.order_id === parent.order_id).every((f) => f.side === 'BUY'), 'child fills are not parent fills');
    // Cancelling the filled parent is rejected; the first child keeps its protection independently.
    const [result] = store.cancelOrders([parent.order_id], T0 + 200_000);
    assert.equal(result.error?.code, 'PAPER_ORDER_NOT_OPEN');
  });
});

describe('expiry', () => {
  const gtd = (store: PaperStore, end: number) => place(store, { base_size: '1', limit_price: '100', time_in_force: 'GTD', end_time: iso(end) }, T0 + 30_000);

  it('a final eligible candle ending exactly at expiry may fill first', async () => {
    const store = await account();
    const r = gtd(store, S0 + 120);
    await reconcile(store, [bar(S0 + 60, '99.5', '100', '99')], T0 + 300_000);
    assert.equal(order(store, r.order_id).status, 'FILLED', 'FILLED is never overwritten with EXPIRED');
  });

  it('expires at end_time after pre-expiry candles; the straddling bucket is excluded and the hold released', async () => {
    const store = await account();
    const r = gtd(store, S0 + 150);
    const { report } = await reconcile(store, [bar(S0 + 60, '100.5', '101', '100.1'), bar(S0 + 120, '99', '99', '98')], T0 + 300_000);
    const o = order(store, r.order_id);
    assert.deepEqual([o.status, o.updated_at, o.terminal_reason, o.cash_hold], ['EXPIRED', iso(S0 + 150), 'GTD_EXPIRED', '0']);
    assert.equal(report.orders_expired, 1);
    assert.equal(store.readLedger().holds.cash, '0');
    assert.equal(store.readLedger().account.cash, '10000');
  });

  it('a stale backlog does not silently expire an order with eligible pre-expiry candles', async () => {
    const store = await account();
    const r = gtd(store, S0 + 150);
    const { report } = await reconcile(store, [], T0 + 300_000, new FakeData([], true));
    assert.equal(report.status, 'STALE');
    assert.equal(order(store, r.order_id).status, 'OPEN');
  });

  it('with no eligible pre-expiry candle, expiry needs no candle request', async () => {
    const store = await account();
    const r = gtd(store, S0 + 59);
    const { report, source } = await reconcile(store, [], T0 + 300_000);
    assert.deepEqual([report.status, source.calls.candles, order(store, r.order_id).status], ['OK', 0, 'EXPIRED']);
  });
});

describe('stale data, replay and concurrency', () => {
  it('a missing required candle is a data gap: STALE, holds kept, nothing advanced', async () => {
    const store = await account();
    const r = place(store, { base_size: '1', limit_price: '100' }, T0 + 30_000);
    const before = store.readLedger();
    const { report } = await reconcile(store, [bar(S0 + 60, '101', '101', '100.5'), bar(S0 + 180, '99', '99', '98')], T0 + 240_000);
    assert.equal(report.status, 'STALE');
    assert.equal(report.reason?.code, 'MARKET_DATA_INCOMPLETE');
    assert.equal(report.reconciled_at, null, 'failure time is not reported as a successful reconciliation');
    assert.deepEqual(store.readLedger(), before);
    assert.equal(order(store, r.order_id).evaluate_after, before.orders[0].evaluate_after);
  });

  it('a successful pass with no open orders makes no requests', async () => {
    const store = await account();
    const { report, md } = await reconcile(store, [], T0 + 240_000);
    assert.equal(report.status, 'NOT_NEEDED');
    assert.equal(md.stats().total, 0);
  });

  it('planning is deterministic; a crashed (rolled back) commit replays to the same result; plans never double-apply', async () => {
    const store = await account();
    place(store, { base_size: '1', limit_price: '100' }, T0 + 30_000);
    const bars = [bar(S0 + 60, '99.5', '100', '99')];
    const ledger = store.readLedger();
    const window = { request: { product_id: 'BTC-USD', start: S0 + 60, end: S0 + 120, granularity: 'ONE_MINUTE' as const }, candles: bars, provider: 'injected', fetched_at: iso(S0 + 120) };
    const candles = new Map([['BTC-USD', [window]]]);
    const plan = planReconciliation(ledger, candles, T0 + 120_000);
    assert.deepEqual(planReconciliation(ledger, candles, T0 + 120_000), plan);
    // A failure mid-commit (here a duplicate event key on the last row) rolls back every row of the plan.
    const broken = { ...plan, events: [...plan.events, plan.events[0]] };
    assert.throws(() => store.applyReconciliation(ledger.account.revision, broken));
    assert.deepEqual(store.readLedger(), ledger);
    assert.equal(store.applyReconciliation(ledger.account.revision, plan), true);
    const after = store.readLedger();
    assert.equal(after.fills.length, 1);
    assert.equal(store.applyReconciliation(ledger.account.revision, plan), false, 'a stale plan is refused');
    assert.deepEqual(store.readLedger(), after);
    const { report } = await reconcile(store, bars, T0 + 120_000);
    assert.equal(report.status, 'NOT_NEEDED');
    assert.equal(store.readLedger().fills.length, 1, 'no double fill on replay');
  });

  it('two reconcilers on one ledger: the second reports STATE_CHANGED and applies nothing', async () => {
    const store = await account();
    place(store, { base_size: '1', limit_price: '100' }, T0 + 30_000);
    const bars = [bar(S0 + 60, '99.5', '100', '99')];
    const ledger = store.readLedger();
    const racing = { readLedger: () => ledger, applyReconciliation: store.applyReconciliation.bind(store) };
    const md = () => createCommandMarketData(new FakeData(bars), { provider: 'injected', now: () => T0 + 120_000 });
    assert.equal((await reconcileAccount(racing, md(), T0 + 120_000)).status, 'OK');
    const second = await reconcileAccount(racing, md(), T0 + 120_000);
    assert.deepEqual([second.status, second.reason?.code], ['STALE', 'STATE_CHANGED']);
    assert.equal(store.readLedger().fills.length, 1);
  });

  it('STALE reads still allow explicit cancels that release only the stored hold', async () => {
    const store = await account();
    const r = place(store, { base_size: '1', limit_price: '100' }, T0 + 30_000);
    const { report } = await reconcile(store, [], T0 + 240_000, new FakeData([], true));
    assert.equal(report.status, 'STALE');
    assert.deepEqual(store.cancelOrders([r.order_id, r.order_id.replace(/.$/, 'f')], T0 + 240_000).map((x) => x.success), [true, false]);
    assert.deepEqual(store.cancelOrders([r.order_id], T0 + 240_000), [{ order_id: r.order_id, success: true, status: 'CANCELLED' }]);
    assert.equal(store.readLedger().holds.cash, '0');
  });
});

describe('candle planning and request budgets', () => {
  it('chooses the granularity ladder by gap', () => {
    assert.deepEqual([6 * 3600, 6 * 3600 + 1, 86400, 30 * 86400, 30 * 86400 + 1].map(granularityFor), ['ONE_MINUTE', 'FIVE_MINUTE', 'FIVE_MINUTE', 'ONE_HOUR', 'ONE_DAY']);
  });

  it('pages 360 minutes and 720 hours at 350 candles per request, merged without duplicates', async () => {
    const store = await account();
    place(store, { base_size: '1', limit_price: '100' }, T0);
    const minutes = planCandleWindows(store.readLedger(), T0 + 360 * 60_000);
    assert.deepEqual(minutes[0].pages.map((p) => [p.granularity, (p.end - p.start) / 60]), [['ONE_MINUTE', 350], ['ONE_MINUTE', 10]]);
    const hours = planCandleWindows(store.readLedger(), T0 + 720 * 3_600_000);
    assert.deepEqual(hours[0].pages.map((p) => [p.granularity, (p.end - p.start) / 3600]), [['ONE_HOUR', 350], ['ONE_HOUR', 350], ['ONE_HOUR', 20]]);
    const bars = Array.from({ length: 360 }, (_, i) => bar(S0 + i * 60, '101', '101', '100.5', '1'));
    const { report, md } = await reconcile(store, bars, T0 + 360 * 60_000);
    assert.equal(report.status, 'OK');
    assert.deepEqual(report.windows.map((w) => w.count), [350, 10]);
    assert.equal(md.stats().candles, 2);
  });

  it('returns STALE before fetching when planned coverage exceeds the 32-page budget', async () => {
    const store = await account();
    // Coverage needs 2 pages, but this command already spent 31 of its 32 candle requests.
    place(store, { base_size: '1', limit_price: '100' }, T0);
    const source = new FakeData([]);
    const md = createCommandMarketData(source, { provider: 'injected', now: () => T0 });
    for (let i = 0; i < 31; i++) await md.candles('BTC-USD', String(i), String(i + 1), 'ONE_MINUTE');
    const report = await reconcileAccount(store, md, T0 + 360 * 60_000);
    assert.deepEqual([report.status, report.reason?.code], ['STALE', 'PAPER_REQUEST_BUDGET_EXCEEDED']);
    assert.equal(source.calls.candles, 31, 'no subset was fetched');
  });

  it('caches identical calls (including failures), counts budgets and reports unknown HTTP attempts as null', async () => {
    const source = new FakeData([], true);
    const md = createCommandMarketData(source, { provider: 'injected', now: () => T0 });
    await md.product('BTC-USD');
    await md.product('BTC-USD');
    await assert.rejects(md.product('ETH-USD'), (e: PaperError) => e.code === 'PAPER_REQUEST_BUDGET_EXCEEDED');
    const req = { product_id: 'BTC-USD', start: S0 - 120, end: S0, granularity: 'ONE_MINUTE' as const };
    await assert.rejects(md.candleWindow(req), (e: PaperError) => e.code === 'MARKET_DATA_UNAVAILABLE');
    await assert.rejects(md.candleWindow(req), (e: PaperError) => e.code === 'MARKET_DATA_UNAVAILABLE');
    assert.deepEqual(md.stats(), { product: 1, book: 0, candles: 1, total: 2, cache_hits: 2, http_attempts: null });
    assert.deepEqual(source.calls, { product: 1, book: 0, candles: 1 });
    await assert.rejects(md.candleWindow({ ...req, end: S0 + 60 }), (e: PaperError) => e.code === 'INVALID_REQUEST', 'incomplete buckets are never requested');
  });

  it('validates injected candles: duplicates, misalignment, out-of-range and bad OHLC fail closed', async () => {
    const req = { product_id: 'BTC-USD', start: S0 - 120, end: S0, granularity: 'ONE_MINUTE' as const };
    for (const rows of [
      [bar(S0 - 120, '1', '1', '1'), bar(S0 - 120, '1', '1', '1')],
      [bar(S0 - 90, '1', '1', '1')],
      [bar(S0, '1', '1', '1')],
      [bar(S0 - 60, '2', '1', '1')],
      [{ ...bar(S0 - 60, '1', '1', '1'), volume: '-1' }],
    ]) {
      const raw: MarketData = { product: async () => PRODUCT, book: async () => book(T0), candles: async () => ({ candles: rows }) };
      const md = createCommandMarketData(raw, { provider: 'injected', now: () => T0 });
      await assert.rejects(md.candleWindow(req), (e: PaperError) => e.code === 'MARKET_DATA_INVALID', JSON.stringify(rows));
    }
  });
});

describe('close-position', () => {
  it('omitted size closes the full position; held quantity blocks a full close', async () => {
    const store = await account();
    place(store, { type: 'market', base_size: '2' }, T0);
    const sell = place(store, { side: 'SELL', base_size: '1', limit_price: '150' }, T0);
    const close = (id: string) => store.closePosition(normalizeClosePositionInput({ request_id: id, account_id: ACCOUNT_IDS.get(store)!, product_id: 'BTC-USD' }), { kind: 'crypto', product: PRODUCT, book: book(T0) }, () => T0);
    assert.throws(() => close(uuid()), (e: PaperError) => e.code === 'INSUFFICIENT_HOLDINGS' && e.details?.hold === '1.00');
    store.cancelOrders([sell.order_id], T0);
    const r = close(uuid());
    assert.deepEqual([r.success, r.status, r.base_size, r.requested], [true, 'FILLED', '2.00', {}]);
    assert.throws(() => close(uuid()), (e: PaperError) => e.code === 'PAPER_NO_POSITION');
  });
});

describe('review regressions', () => {
  it('a fractional-second creation cursor never admits the candle it straddles', async () => {
    const store = await account();
    const r = place(store, { base_size: '1', limit_price: '100' }, T0 + 60_001);
    // The 12:01:00 candle trades through but started 1 ms before the order existed.
    const { report } = await reconcile(store, [bar(S0 + 60, '99', '99.5', '98'), bar(S0 + 120, '100.5', '101', '100.1')], T0 + 180_000);
    assert.equal(report.status, 'OK');
    assert.equal(order(store, r.order_id).status, 'OPEN');
    assert.equal(store.readLedger().fills.length, 0);
  });

  it('a fractional-second end_time is not expired before it is reached, and its event is never in the future', async () => {
    const store = await account();
    const end = T0 + 60_500;
    const r = place(store, { base_size: '1', limit_price: '100', time_in_force: 'GTD', end_time: new Date(end).toISOString() }, T0 + 1_000);
    await reconcile(store, [], T0 + 60_100);
    assert.equal(order(store, r.order_id).status, 'OPEN', 'end_time 400 ms in the future');
    await reconcile(store, [], end);
    const o = order(store, r.order_id);
    assert.deepEqual([o.status, o.updated_at], ['EXPIRED', new Date(end).toISOString()]);
  });

  it('a GTD parent expiring mid-window still lets its GTC exit be reconciled through command time in the same pass', async () => {
    const store = await account();
    const parent = place(store, { base_size: '1', limit_price: '100', time_in_force: 'GTD', end_time: iso(S0 + 120), attached_take_profit_price: '110' }, T0 + 1_000);
    // Parent fills in 12:01; parent expiry is 12:02; the child take profit is reached in 12:02-12:03.
    await reconcile(store, [bar(S0 + 60, '99.5', '100', '99'), bar(S0 + 120, '109', '111', '108')], T0 + 180_000);
    const view = order(store, parent.order_id).current_receipt!;
    assert.equal(view.status, 'FILLED');
    const child = order(store, view.attached_order_ids[0]);
    assert.equal(child.status, 'FILLED', 'one pass is enough');
    assert.equal(store.readLedger().fills.find((f) => f.order_id === child.order_id)?.trade_time, iso(S0 + 180));
  });

  it('a real edit cannot apply or fill once the order has reached end_time after reconciliation', async () => {
    const store = await account();
    const r = place(store, { base_size: '1', limit_price: '90', time_in_force: 'GTD', end_time: new Date(T0 + 30_000).toISOString() }, T0 + 1_000);
    const at = T0 + 31_000;
    assert.throws(() => store.editOrder(r.order_id, { limit_price: '102' }, { kind: 'crypto', product: null, book: book(at) }, () => at),
      (e: PaperError) => e.code === 'PAPER_RECONCILIATION_STALE' && e.details?.order_id === r.order_id);
    const o = order(store, r.order_id);
    assert.deepEqual([o.status, o.limit_price, o.filled_size], ['OPEN', '90', '0']);
  });

  it('stop-loss-only and take-profit-only exits can be resized', async () => {
    for (const exit of [{ attached_stop_loss_price: '90' }, { attached_take_profit_price: '110' }]) {
      const store = await account();
      const parent = place(store, { type: 'market', base_size: '1', ...exit }, T0);
      const childId = parent.attached_order_ids[0];
      const edited = store.editOrder(childId, { base_size: '0.5' }, { kind: 'crypto', product: null, book: book(T0 + 1_000) }, () => T0 + 1_000);
      assert.deepEqual([edited.edited, edited.status, order(store, childId).base_size], [true, 'OPEN', '0.5'], JSON.stringify(exit));
    }
  });

  it('market BUY attachments are validated against the quote increment before the parent executes', async () => {
    const store = await account();
    assert.throws(() => place(store, { type: 'market', base_size: '1', attached_take_profit_price: '110.005' }, T0), (e: PaperError) => e.code === 'INVALID_INCREMENT');
    assert.equal(store.readLedger().fills.length, 0);
  });

  it('a fill that completes an order is recorded as FILLED in activity and status history', async () => {
    const store = await account();
    const market = place(store, { type: 'market', base_size: '1' }, T0);
    const resting = place(store, { base_size: '1', limit_price: '100' }, T0 + 1_000);
    await reconcile(store, [bar(S0 + 60, '99.5', '100', '99')], T0 + 120_000);
    for (const id of [market.order_id, resting.order_id]) {
      const history = store.getOrder(id)!.status_history;
      assert.deepEqual([history.at(-1)?.event_type, history.at(-1)?.status], ['FILL', 'FILLED'], id);
    }
    const partial = place(store, { base_size: '1', limit_price: '102' }, T0 + 130_000, book(T0 + 130_000, '99', '101', '0.4'));
    assert.equal(store.getOrder(partial.order_id)!.status_history.find((e) => e.event_type === 'FILL')?.status, 'OPEN', 'a partial fill stays OPEN');
  });

  it('placement names the market-data provider and persists a successful pass time, so it never moves backwards', async () => {
    const store = await account();
    const reconciliation = { status: 'NOT_NEEDED' as const, attempted_at: iso(S0 + 30), reconciled_at: iso(S0 + 30), reason: null, orders_checked: 0, orders_filled: 0, orders_expired: 0, windows: [] };
    const intent = normalizeOrderInput({ request_id: uuid(), account_id: ACCOUNT_IDS.get(store)!, product_id: 'BTC-USD', side: 'BUY', type: 'limit', base_size: '1', limit_price: '90' });
    const receipt = store.placeOrder(intent, { kind: 'crypto', product: PRODUCT, book: book(T0 + 30_000) }, () => T0 + 30_000, { reconciliation, requests: { product: 1, book: 1, candles: 0, total: 2, cache_hits: 0, http_attempts: null }, provider: 'injected' });
    assert.equal(receipt.source.provider, 'injected');
    assert.equal(store.readLedger().account.last_reconciled_at, iso(S0 + 30));
    const { report } = await reconcile(store, [], T0 + 600_000, new FakeData([], true));
    assert.deepEqual([report.status, report.reconciled_at], ['STALE', iso(S0 + 30)]);
  });
});
