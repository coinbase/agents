// Lazy reconciliation of resting paper orders against completed public candles.
// There is no daemon: account commands call reconcileAccount once, which plans
// bounded candle reads, fetches them outside any write transaction, and commits
// one deterministic plan only if the ledger did not change meanwhile.
import { parseStoredDecimal, toIncrement } from './decimal.ts';
import {
  activateChild,
  addEvent,
  applyBatch,
  finishWork,
  finish,
  openWork,
  rulesOf,
  touch,
  type Work,
} from './engine.ts';
import { CANDLE_SECONDS, REQUEST_BUDGET } from './market-data.ts';
import {
  PaperError,
  type Candle,
  type CandleGranularity,
  type CandleWindow,
  type CandleWindowRequest,
  type CandleWindowSource,
  type CommandMarketData,
  type LedgerSnapshot,
  type OrderState,
  type ReconcileMutation,
  type ReconciliationReport,
} from './types.ts';

const MAX_PER_PAGE = REQUEST_BUDGET.max_candles_per_request;
const RETRY_HINT = 'Retry the same command later; reads and explicit cancels remain available. No fills were guessed.';

/** Minimal store surface reconciliation needs; PaperStore implements it. */
export interface ReconcilingStore {
  readLedger(): LedgerSnapshot;
  applyReconciliation(expectedRevision: number, mutation: ReconcileMutation): boolean;
}

export interface ProductWindow {
  product_id: string;
  granularity: CandleGranularity;
  /** Aligned UNIX seconds, inclusive. */
  start: number;
  /** Aligned UNIX seconds, exclusive; never after the command time. */
  end: number;
  pages: CandleWindowRequest[];
}

/** Granularity ladder by the gap from the earliest evaluation cursor to now. */
export function granularityFor(gapSeconds: number): CandleGranularity {
  if (gapSeconds <= 6 * 3600) return 'ONE_MINUTE';
  if (gapSeconds <= 24 * 3600) return 'FIVE_MINUTE';
  if (gapSeconds <= 30 * 86400) return 'ONE_HOUR';
  return 'ONE_DAY';
}

function seconds(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

/** First whole second at or after a (possibly fractional) timestamp, so a cursor never admits earlier price action. */
function secondsCeil(iso: string): number {
  return Math.ceil(Date.parse(iso) / 1000);
}

function ceilTo(value: number, step: number): number {
  return Math.ceil(value / step) * step;
}

function floorTo(value: number, step: number): number {
  return Math.floor(value / step) * step;
}

function iso(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

/** Open orders the candle model evaluates: resting crypto limit, stop-limit and bracket orders. */
export function reconcilable(order: OrderState): boolean {
  return order.status === 'OPEN' && order.product_type === 'SPOT' && order.order_type !== 'MARKET';
}

/**
 * First second an order may no longer use: min(now, end_time). A BUY parent with
 * attached exits needs coverage through now, because an exit it activates is GTC
 * and must be evaluated in this same pass even after the parent's own expiry.
 */
function neededEnd(order: OrderState, nowSeconds: number): number {
  if (order.end_time === null) return nowSeconds;
  if (order.attached_take_profit_price !== null || order.attached_stop_loss_price !== null) return nowSeconds;
  return Math.min(nowSeconds, Math.floor(Date.parse(order.end_time) / 1000));
}

/**
 * The completed, aligned candle windows reconciliation needs per product, paged
 * at the provider cap. A candle is usable for an order only if it starts at or
 * after the order's cursor, so straddling buckets are excluded.
 */
export function planCandleWindows(ledger: LedgerSnapshot, now: number): ProductWindow[] {
  const nowSeconds = Math.floor(now / 1000);
  const byProduct = new Map<string, OrderState[]>();
  for (const order of ledger.orders) {
    if (!reconcilable(order)) continue;
    const list = byProduct.get(order.product_id) ?? [];
    list.push(order);
    byProduct.set(order.product_id, list);
  }
  const windows: ProductWindow[] = [];
  for (const [productId, orders] of [...byProduct].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const earliest = Math.min(...orders.map((order) => seconds(order.evaluate_after)));
    const granularity = granularityFor(Math.max(0, nowSeconds - earliest));
    const step = CANDLE_SECONDS[granularity];
    let start = Infinity;
    let end = -Infinity;
    for (const order of orders) {
      const from = ceilTo(secondsCeil(order.evaluate_after), step);
      const to = floorTo(neededEnd(order, nowSeconds), step);
      if (to <= from) continue;
      start = Math.min(start, from);
      end = Math.max(end, to);
    }
    if (!(end > start)) continue;
    const pages: CandleWindowRequest[] = [];
    for (let pageStart = start; pageStart < end; pageStart += step * MAX_PER_PAGE) {
      pages.push({ product_id: productId, start: pageStart, end: Math.min(end, pageStart + step * MAX_PER_PAGE), granularity });
    }
    windows.push({ product_id: productId, granularity, start, end, pages });
  }
  return windows;
}

interface Bar {
  start: number;
  end: number;
  granularity: CandleGranularity;
  open: bigint;
  high: bigint;
  low: bigint;
  volume: bigint;
}

function incomplete(productId: string, detail: string): PaperError {
  return new PaperError('MARKET_DATA_INCOMPLETE', `public candles for ${productId} ${detail}; missing intervals are not treated as no-trade candles`, RETRY_HINT);
}

/** Merges pages into one gap-free, de-duplicated candle series for a planned window. */
function barsFor(window: ProductWindow, supplied: readonly CandleWindow[] | undefined): Bar[] {
  const step = CANDLE_SECONDS[window.granularity];
  const byStart = new Map<number, Candle>();
  for (const page of supplied ?? []) {
    if (page.request.product_id !== window.product_id || page.request.granularity !== window.granularity) continue;
    for (const candle of page.candles) {
      const start = Number(candle.start);
      const prior = byStart.get(start);
      if (prior && JSON.stringify(prior) !== JSON.stringify(candle)) throw incomplete(window.product_id, `conflict at ${iso(start)}`);
      byStart.set(start, candle);
    }
  }
  const bars: Bar[] = [];
  for (let start = window.start; start < window.end; start += step) {
    const candle = byStart.get(start);
    if (!candle) throw incomplete(window.product_id, `are missing the ${window.granularity} interval starting ${iso(start)}`);
    const read = (key: 'open' | 'high' | 'low' | 'volume') => parseStoredDecimal(candle[key], `candle ${key}`);
    bars.push({ start, end: start + step, granularity: window.granularity, open: read('open'), high: read('high'), low: read('low'), volume: read('volume') });
  }
  return bars;
}

function units(value: string | null, name: string): bigint {
  return parseStoredDecimal(value, name);
}

/** Candle execution price, rounded adversely onto the quote increment without crossing the limit. */
function candlePrice(side: 'BUY' | 'SELL', limit: bigint, open: bigint, quoteInc: bigint): bigint {
  if (side === 'BUY') {
    const price = toIncrement(open < limit ? open : limit, 1n, quoteInc, 'ceil');
    return price > limit ? limit : price;
  }
  const price = toIncrement(open > limit ? open : limit, 1n, quoteInc, 'floor');
  return price < limit ? limit : price;
}

function crosses(side: 'BUY' | 'SELL', limit: bigint, bar: Bar): boolean {
  return side === 'BUY' ? bar.low < limit : bar.high > limit;
}

interface Pass {
  work: Work;
  filled: Set<string>;
}

function eligible(order: OrderState, bar: Bar): boolean {
  if (!reconcilable(order)) return false;
  // Exact milliseconds: a candle starting before a fractional cursor straddles it; one ending after a fractional expiry is excluded.
  if (bar.start * 1000 < Date.parse(order.evaluate_after)) return false;
  if (order.end_time !== null && bar.end * 1000 > Date.parse(order.end_time)) return false;
  return true;
}

function key(bar: Bar, ...rest: string[]): string[] {
  return ['candle', bar.granularity, String(bar.start), ...rest];
}

function source(bar: Bar, productId: string, rule: string): Record<string, unknown> {
  return { kind: 'candle', product_id: productId, candle_start: iso(bar.start), candle_end: iso(bar.end), granularity: bar.granularity, rule };
}

/** Executes the whole remainder at `price` if the shared candle volume covers it. */
function fillAll(pass: Pass, order: OrderState, bar: Bar, price: bigint, liquidity: 'MAKER' | 'TAKER', budget: { volume: bigint }, rule: string): boolean {
  const remaining = units(order.remaining_size, 'remaining_size');
  if (remaining <= 0n || budget.volume < remaining) return false;
  budget.volume -= remaining;
  const time = iso(bar.end);
  applyBatch(pass.work, order, [{ price, size: remaining }], liquidity, time, key(bar), source(bar, order.product_id, rule));
  order.status = 'FILLED';
  touch(pass.work, order, time);
  pass.filled.add(order.order_id);
  if (order.side === 'BUY' && order.parent_order_id === null) activateChild(pass.work, order, remaining, time, key(bar));
  return true;
}

function trigger(pass: Pass, order: OrderState, bar: Bar, details: Record<string, unknown>): void {
  const time = iso(bar.end);
  order.triggered_at = time;
  touch(pass.work, order, time);
  addEvent(pass.work, order, 'TRIGGERED', time, { ...details, candle_start: iso(bar.start), candle_end: time, granularity: bar.granularity }, key(bar, 'trigger'));
}

function evaluate(pass: Pass, order: OrderState, bar: Bar, budget: { volume: bigint }): void {
  const quoteInc = rulesOf(order).quote_increment;
  if (order.order_type === 'LIMIT' || (order.order_type === 'STOPLIMIT' && order.triggered_at !== null)) {
    const limit = units(order.limit_price, 'limit_price');
    if (crosses(order.side, limit, bar)) fillAll(pass, order, bar, candlePrice(order.side, limit, bar.open, quoteInc), 'MAKER', budget, 'resting_limit_trade_through');
    return;
  }
  if (order.order_type === 'STOPLIMIT') {
    const stop = units(order.stop_price, 'stop_price');
    const up = order.stop_direction === 'STOP_DIRECTION_STOP_UP';
    if (!(up ? bar.high >= stop : bar.low <= stop)) return;
    trigger(pass, order, bar, { stop_price: order.stop_price, stop_direction: order.stop_direction });
    const limit = units(order.limit_price, 'limit_price');
    const openBeyond = up ? bar.open >= stop : bar.open <= stop;
    const marketable = order.side === 'BUY' ? bar.open <= limit : bar.open >= limit;
    if (openBeyond && marketable) fillAll(pass, order, bar, candlePrice(order.side, limit, bar.open, quoteInc), 'TAKER', budget, 'stop_triggered_at_open');
    return;
  }
  // Composite SELL exit: take profit and stop loss share one base hold.
  if (order.stop_loss_status === 'TRIGGERED') {
    const floor = units(order.stop_limit_price, 'stop_limit_price');
    if (crosses('SELL', floor, bar) && fillAll(pass, order, bar, candlePrice('SELL', floor, bar.open, quoteInc), 'MAKER', budget, 'stop_loss_aggressive_limit')) order.stop_loss_status = 'FILLED';
    return;
  }
  const tpOpen = order.take_profit_status === 'OPEN';
  const tp = tpOpen ? units(order.limit_price, 'limit_price') : 0n;
  const tpCross = tpOpen && bar.high > tp;
  const slHit = order.stop_loss_status === 'OPEN' && bar.low <= units(order.stop_price, 'stop_price');
  const time = iso(bar.end);
  if (slHit) {
    const stop = units(order.stop_price, 'stop_price');
    const floor = units(order.stop_limit_price, 'stop_limit_price');
    order.stop_loss_status = 'TRIGGERED';
    if (tpOpen) order.take_profit_status = 'CANCELLED';
    trigger(pass, order, bar, { stop_price: order.stop_price, stop_limit_price: order.stop_limit_price, leg: 'stop_loss' });
    if (tpCross) {
      addEvent(pass.work, order, 'AMBIGUOUS_OCO', time, {
        candle_start: iso(bar.start), candle_end: time, granularity: bar.granularity,
        assumption: 'both legs were reached in one candle; the stop loss is assumed first (worst case) and the take profit was not filled',
      }, key(bar, 'ambiguous'));
    }
    let filled = false;
    if (bar.open <= stop) {
      if (bar.open >= floor) filled = fillAll(pass, order, bar, candlePrice('SELL', floor, bar.open, quoteInc), 'TAKER', budget, 'stop_loss_gap_at_open');
    } else {
      filled = fillAll(pass, order, bar, stop, 'TAKER', budget, 'stop_loss_at_stop_price');
    }
    if (filled) order.stop_loss_status = 'FILLED';
    touch(pass.work, order, time);
    return;
  }
  if (tpCross && fillAll(pass, order, bar, candlePrice('SELL', tp, bar.open, quoteInc), 'MAKER', budget, 'take_profit_trade_through')) {
    order.take_profit_status = 'FILLED';
    if (order.stop_loss_status === 'OPEN') order.stop_loss_status = 'CANCELLED';
    touch(pass.work, order, time);
  }
}

function priority(a: OrderState, b: OrderState): number {
  if (a.priority_at !== b.priority_at) return a.priority_at < b.priority_at ? -1 : 1;
  return a.order_id < b.order_id ? -1 : a.order_id > b.order_id ? 1 : 0;
}

/**
 * Pure reconciliation plan: evaluates completed candles in time order, with one
 * shared volume budget per product candle, then expires GTD orders. Throws
 * MARKET_DATA_INCOMPLETE when a required interval is missing.
 */
export function planReconciliation(ledger: LedgerSnapshot, candles: ReadonlyMap<string, CandleWindow[]>, now: number): ReconcileMutation {
  const windows = planCandleWindows(ledger, now);
  const work = openWork(ledger);
  const pass: Pass = { work, filled: new Set() };
  const checked = ledger.orders.filter(reconcilable).length;
  const timeline: Array<{ product: string; bar: Bar }> = [];
  for (const window of windows) for (const bar of barsFor(window, candles.get(window.product_id))) timeline.push({ product: window.product_id, bar });
  timeline.sort((a, b) => a.bar.end - b.bar.end || a.bar.start - b.bar.start || (a.product < b.product ? -1 : a.product > b.product ? 1 : 0));
  for (const { product, bar } of timeline) {
    const budget = { volume: bar.volume };
    const orders = [...work.orders.values()].filter((order) => order.product_id === product && eligible(order, bar)).sort(priority);
    for (const order of orders) if (order.status === 'OPEN') evaluate(pass, order, bar, budget);
  }
  let expired = 0;
  for (const order of [...work.orders.values()].sort((a, b) => a.order_seq - b.order_seq)) {
    if (!reconcilable(order) || order.end_time === null || Date.parse(order.end_time) > now) continue;
    finish(work, order, 'EXPIRED', order.end_time, 'GTD_EXPIRED', ['expire']);
    expired += 1;
  }
  const frontier = new Map(windows.map((window) => [window.product_id, window.end]));
  for (const order of work.orders.values()) {
    const end = frontier.get(order.product_id);
    if (end === undefined || !reconcilable(order) || Date.parse(order.evaluate_after) >= end * 1000) continue;
    order.evaluate_after = iso(end);
    work.orders.set(order.order_id, order);
    work.touchedOrders.add(order.order_id);
  }
  const rows = finishWork(work);
  const reconciledAt = new Date(now).toISOString();
  return {
    ...rows,
    account: { ...rows.account, last_reconciled_at: reconciledAt },
    orders_checked: checked,
    orders_filled: pass.filled.size,
    orders_expired: expired,
    reconciled_at: reconciledAt,
  };
}

function windowSources(windows: ProductWindow[], fetched: Map<string, CandleWindow[]>, used: boolean, provider: string): CandleWindowSource[] {
  const out: CandleWindowSource[] = [];
  for (const window of windows) {
    const pages = fetched.get(window.product_id) ?? [];
    for (const page of pages) {
      out.push({
        product_id: window.product_id,
        start: iso(page.request.start),
        end: iso(page.request.end),
        granularity: page.request.granularity,
        count: page.candles.length,
        provider: page.provider ?? provider,
        completed_only: true,
        used,
      });
    }
  }
  return out;
}

function reason(error: unknown): { code: string; message: string; hint: string } {
  if (error instanceof PaperError) return { code: error.code, message: error.message, hint: error.hint };
  return { code: 'MARKET_DATA_FAILED', message: 'public candle data could not be used', hint: RETRY_HINT };
}

/**
 * One reconciliation pass: bounded candle reads, a pure plan and one
 * revision-checked commit. Failures return STALE and change nothing.
 */
export async function reconcileAccount(store: ReconcilingStore, market: CommandMarketData, now: number): Promise<ReconciliationReport> {
  const attemptedAt = new Date(now).toISOString();
  const ledger = store.readLedger();
  const prior = ledger.account.last_reconciled_at;
  const checked = ledger.orders.filter(reconcilable).length;
  const stale = (why: { code: string; message: string; hint: string }, windows: CandleWindowSource[] = []): ReconciliationReport => ({
    status: 'STALE', attempted_at: attemptedAt, reconciled_at: prior, reason: why,
    orders_checked: checked, orders_filled: 0, orders_expired: 0, windows,
  });
  if (checked === 0) {
    return { status: 'NOT_NEEDED', attempted_at: attemptedAt, reconciled_at: attemptedAt, reason: null, orders_checked: 0, orders_filled: 0, orders_expired: 0, windows: [] };
  }
  const windows = planCandleWindows(ledger, now);
  const pages = windows.reduce((sum, window) => sum + window.pages.length, 0);
  const available = REQUEST_BUDGET.max_candle_requests - market.stats().candles;
  if (pages > available) {
    return stale({
      code: 'PAPER_REQUEST_BUDGET_EXCEEDED',
      message: `Paper command requires ${pages} candle requests; the per-command work budget is ${available}.`,
      hint: 'No candle fills were guessed. Reduce the requested performance period or inspect/cancel unneeded open orders; retry without switching to live trading.',
    });
  }
  const fetched = new Map<string, CandleWindow[]>();
  for (const window of windows) {
    for (const page of window.pages) {
      try {
        const result = await market.candleWindow(page);
        const list = fetched.get(window.product_id) ?? [];
        list.push(result);
        fetched.set(window.product_id, list);
      } catch (error) {
        return stale(reason(error), windowSources(windows, fetched, false, market.provider));
      }
    }
  }
  let mutation: ReconcileMutation;
  try {
    mutation = planReconciliation(ledger, fetched, now);
  } catch (error) {
    if (!(error instanceof PaperError) || error.code !== 'MARKET_DATA_INCOMPLETE') throw error;
    return stale(reason(error), windowSources(windows, fetched, false, market.provider));
  }
  if (!store.applyReconciliation(ledger.account.revision, mutation)) {
    return stale({
      code: 'STATE_CHANGED',
      message: 'Another paper command changed this account during reconciliation; this pass applied nothing.',
      hint: 'Retry the same command; the other command already updated the account.',
    }, windowSources(windows, fetched, false, market.provider));
  }
  return {
    status: 'OK',
    attempted_at: attemptedAt,
    reconciled_at: mutation.reconciled_at,
    reason: null,
    orders_checked: mutation.orders_checked,
    orders_filled: mutation.orders_filled,
    orders_expired: mutation.orders_expired,
    windows: windowSources(windows, fetched, true, market.provider),
  };
}

