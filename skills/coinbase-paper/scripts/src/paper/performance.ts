// Paper performance: an equity curve reconstructed from the complete fill ledger
// and completed public candle closes. Exact bigint arithmetic throughout; a
// sample whose holdings cannot be marked from a completed candle is unpriced,
// never interpolated or forward-filled.
import { divRound, formatAmount, formatRatio, parseStoredDecimal, toIncrement, UNIT } from './decimal.ts';
import type { LedgerFillView, LedgerView } from './balance.ts';
import { REQUEST_BUDGET, type Candle } from './market-data.ts';
import { PAPER_NOTICE, PaperError } from './types.ts';

export type PerformancePeriod = '1D' | '1W' | '1M' | 'ALL';
export type PerformanceGranularity = 'ONE_HOUR' | 'ONE_DAY';

export interface PerformanceRequest {
  period: PerformancePeriod;
  chart: boolean;
}

export interface PerformancePoint {
  timestamp: string;
  equity: string | null;
  cash: string;
  market_value: string | null;
  profit_loss: string | null;
  profit_loss_pct: string | null;
  priced: boolean;
  mark_time: string | null;
  unpriced_products: string[];
}

export type PerformanceGapCode = 'PAPER_REQUEST_BUDGET_EXCEEDED' | 'EQUITY_UNPRICED' | 'MISSING_CANDLE' | `MARKET_DATA_${string}`;

export interface PerformanceGap {
  product_id: string;
  start: string;
  end: string;
  code: PerformanceGapCode;
  message: string;
}

export interface PerformanceResult {
  mode: 'PAPER';
  ok: true;
  account_id: string;
  currency: string;
  period: PerformancePeriod;
  start: string;
  end: string;
  granularity: PerformanceGranularity;
  status: 'COMPLETE' | 'PARTIAL';
  baseline_equity: string | null;
  ending_equity: string | null;
  profit_loss: string | null;
  profit_loss_pct: string | null;
  time_weighted_return_pct: string | null;
  max_drawdown_pct: string | null;
  realized_pnl: string;
  fees_paid: string;
  points: PerformancePoint[];
  gaps: PerformanceGap[];
  chart?: string;
  notice: string;
}

/** Structural view of the command market-data session's candle windows. */
export interface CandleWindowRequestView {
  product_id: string;
  start: number;
  end: number;
  granularity: string;
}

export interface CandleWindowView {
  request: CandleWindowRequestView;
  candles: readonly Candle[];
  provider: string;
  fetched_at: string;
}

export interface PerformanceMarket {
  candleWindow(request: CandleWindowRequestView & { granularity: PerformanceGranularity }): Promise<CandleWindowView>;
  stats(): { candles: number; total: number };
}

// Shared per-command request budget (see the market-data session).
const MAX_CANDLE_REQUESTS = REQUEST_BUDGET.max_candle_requests;
const MAX_TOTAL_REQUESTS = REQUEST_BUDGET.max_total_requests;
const MAX_CANDLES_PER_REQUEST = REQUEST_BUDGET.max_candles_per_request;

const PERIOD_SECONDS: Record<Exclude<PerformancePeriod, 'ALL'>, number> = { '1D': 86_400, '1W': 604_800, '1M': 2_592_000 };
const GRANULARITY_SECONDS: Record<PerformanceGranularity, number> = { ONE_HOUR: 3600, ONE_DAY: 86_400 };
const CHART_TITLE = 'PAPER — reconstructed candle-close equity (not broker-recorded portfolio history)';
const PERFORMANCE_NOTICE = `${PAPER_NOTICE} Performance is reconstructed from paper fills and completed public candle closes, not broker-recorded portfolio history. Each sample, including the end point, is marked at the close of the last completed candle, not a fresh order book; missing candles and equity holdings leave samples unpriced rather than estimated. No deposits or withdrawals exist, so the time-weighted return equals the period return.`;

interface Gap {
  product_id: string;
  start: number; // UNIX seconds, inclusive
  end: number; // UNIX seconds, exclusive
  code: PerformanceGapCode;
  message: string;
}

interface Sample {
  ms: number;
  cash: bigint;
  holdings: Map<string, bigint>;
}

interface Plan {
  accountId: string;
  currency: string;
  money: bigint | null;
  startMs: number;
  endMs: number;
  granularity: PerformanceGranularity;
  seconds: number;
  samples: Sample[];
  productTypes: Map<string, string>;
  periodRealized: bigint;
  periodFees: bigint;
}

function stateError(message: string): PaperError {
  return new PaperError('STATE_INVALID', `paper state ${message}`, 'Stop and run coinbase-paper doctor; do not reinitialize or edit the account.');
}

function requestError(message: string): PaperError {
  return new PaperError('INVALID_REQUEST', message);
}

function time(value: unknown, what: string): number {
  const ms = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(ms)) throw stateError(`${what} is not a timestamp`);
  return ms;
}

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function bucketFor(ms: number, seconds: number): number {
  const end = Math.floor(ms / 1000 / seconds) * seconds;
  return end - seconds;
}

function fillRealized(fill: LedgerFillView): bigint {
  if (fill.realized_pnl !== null) return parseStoredDecimal(fill.realized_pnl, 'fill realized_pnl', { allowNegative: true });
  return parseStoredDecimal(fill.notional, 'fill notional') - parseStoredDecimal(fill.commission, 'fill commission') - parseStoredDecimal(fill.cost_basis_removed, 'fill cost_basis_removed');
}

/** Replays the complete ledger: holdings at every sample time and the period's realized P&L and fees. */
function plan(ledger: LedgerView, request: PerformanceRequest, now: number): Plan {
  if (!Number.isSafeInteger(now) || now < 0) throw requestError('now must be a millisecond timestamp');
  if (request === null || typeof request !== 'object' || typeof request.chart !== 'boolean') throw requestError('performance request must have period and chart');
  const { period } = request;
  if (period !== 'ALL' && !Object.hasOwn(PERIOD_SECONDS, period)) throw requestError('period must be 1D, 1W, 1M or ALL');
  const { account } = ledger;
  const money = account.quote_increment === null ? null : parseStoredDecimal(account.quote_increment, 'quote_increment', { allowZero: false });
  const created = time(account.created_at, 'account created_at');
  let startMs = period === 'ALL' ? created : Math.max(created, now - PERIOD_SECONDS[period] * 1000);
  startMs = Math.min(startMs, now);
  const granularity: PerformanceGranularity = period === '1D' || period === '1W' ? 'ONE_HOUR' : 'ONE_DAY';
  const seconds = GRANULARITY_SECONDS[granularity];

  const times = [startMs];
  for (let s = (Math.floor(startMs / 1000 / seconds) + 1) * seconds; s * 1000 < now; s += seconds) times.push(s * 1000);
  if (now > startMs) times.push(now);

  if (!Array.isArray(ledger.fills)) throw stateError('fills are not a list');
  const fills = ledger.fills.map((fill) => {
    if (!Number.isSafeInteger(fill.fill_seq)) throw stateError('fill sequence is invalid');
    if (fill.side !== 'BUY' && fill.side !== 'SELL') throw stateError('fill side is invalid');
    return {
      fill,
      ms: time(fill.trade_time, 'fill trade_time'),
      size: parseStoredDecimal(fill.size, 'fill size', { allowZero: false }),
      notional: parseStoredDecimal(fill.notional, 'fill notional'),
      commission: parseStoredDecimal(fill.commission, 'fill commission'),
    };
  });
  fills.sort((a, b) => a.ms - b.ms || a.fill.fill_seq - b.fill.fill_seq);

  const productTypes = new Map<string, string>();
  for (const { fill } of fills) {
    const known = productTypes.get(fill.product_id);
    if (known !== undefined && known !== fill.product_type) throw stateError(`fills disagree on the asset class of ${fill.product_id}`);
    productTypes.set(fill.product_id, fill.product_type);
  }

  let cash = parseStoredDecimal(account.initial_cash, 'initial_cash', { allowZero: false });
  const holdings = new Map<string, bigint>();
  const samples: Sample[] = [];
  let periodRealized = 0n;
  let periodFees = 0n;
  let next = 0;
  const apply = (entry: (typeof fills)[number]) => {
    const { fill } = entry;
    const held = holdings.get(fill.product_id) ?? 0n;
    if (fill.side === 'BUY') {
      cash -= entry.notional + entry.commission;
      holdings.set(fill.product_id, held + entry.size);
    } else {
      cash += entry.notional - entry.commission;
      if (entry.size > held) throw stateError(`fills sell more ${fill.product_id} than was held`);
      if (held === entry.size) holdings.delete(fill.product_id);
      else holdings.set(fill.product_id, held - entry.size);
    }
    if (entry.ms > startMs && entry.ms <= now) {
      periodFees += entry.commission;
      if (fill.side === 'SELL') periodRealized += fillRealized(fill);
    }
  };
  for (const ms of times) {
    while (next < fills.length && fills[next].ms <= ms) apply(fills[next++]);
    samples.push({ ms, cash, holdings: new Map(holdings) });
  }
  while (next < fills.length) apply(fills[next++]);

  // The complete ledger must reproduce the stored account; otherwise the curve would be fiction.
  if (cash !== parseStoredDecimal(account.cash, 'cash')) throw stateError('fills do not reproduce account cash');
  const stored = new Map(ledger.positions.map((p) => [p.product_id, parseStoredDecimal(p.quantity, 'position quantity')]));
  if (stored.size !== holdings.size || [...holdings].some(([id, qty]) => stored.get(id) !== qty)) {
    throw stateError('fills do not reproduce positions');
  }

  return {
    accountId: account.account_id,
    currency: account.currency,
    money,
    startMs,
    endMs: now,
    granularity,
    seconds,
    samples,
    productTypes,
    periodRealized,
    periodFees,
  };
}

/** Candle buckets each held crypto product needs, as sorted bucket-start seconds. */
function requiredBuckets(p: Plan): Map<string, number[]> {
  const required = new Map<string, Set<number>>();
  for (const sample of p.samples) {
    for (const productId of sample.holdings.keys()) {
      if (p.productTypes.get(productId) === 'EQUITY') continue;
      let set = required.get(productId);
      if (!set) required.set(productId, (set = new Set()));
      set.add(bucketFor(sample.ms, p.seconds));
    }
  }
  const sorted = [...required].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return new Map(sorted.map(([id, set]) => [id, [...set].sort((a, b) => a - b)]));
}

/** Contiguous bucket runs, split into windows of at most MAX_CANDLES_PER_REQUEST candles. */
export function planCandleWindows(buckets: ReadonlyMap<string, readonly number[]>, granularity: PerformanceGranularity): Array<CandleWindowRequestView & { granularity: PerformanceGranularity }> {
  const seconds = GRANULARITY_SECONDS[granularity];
  const windows: Array<CandleWindowRequestView & { granularity: PerformanceGranularity }> = [];
  for (const [productId, starts] of buckets) {
    let first = -1;
    let last = -1;
    const flush = () => {
      if (first >= 0) windows.push({ product_id: productId, start: first, end: last + seconds, granularity });
    };
    for (const start of starts) {
      if (first >= 0 && start === last + seconds && (start - first) / seconds < MAX_CANDLES_PER_REQUEST) {
        last = start;
        continue;
      }
      flush();
      first = start;
      last = start;
    }
    flush();
  }
  return windows;
}

function indexCandles(candles: ReadonlyMap<string, readonly CandleWindowView[]>, p: Plan): Map<string, Map<number, bigint | null>> {
  const index = new Map<string, Map<number, bigint | null>>();
  const nowSeconds = Math.floor(p.endMs / 1000);
  for (const [productId, windows] of candles) {
    const closes = new Map<number, bigint | null>();
    index.set(productId, closes);
    for (const window of windows) {
      const { request } = window;
      if (request.product_id !== productId || request.granularity !== p.granularity) continue;
      for (const candle of window.candles) {
        const start = Number(candle.start);
        // Only aligned, completed candles inside the requested window; no lookahead.
        if (!/^(0|[1-9]\d{0,10})$/.test(candle.start) || start % p.seconds !== 0 || start < request.start || start >= request.end || start + p.seconds > nowSeconds) continue;
        const close = parseStoredDecimal(candle.close, 'candle close', { allowZero: false });
        const seen = closes.get(start);
        // Conflicting duplicates are unusable rather than resolved by guessing.
        closes.set(start, seen === undefined || seen === close ? close : null);
      }
    }
  }
  return index;
}

function pct(delta: bigint, base: bigint): string {
  return formatRatio(delta * 100n * UNIT, base);
}

function calculate(
  ledger: LedgerView,
  request: PerformanceRequest,
  candles: ReadonlyMap<string, readonly CandleWindowView[]>,
  now: number,
  unavailable: readonly Gap[],
): PerformanceResult {
  const p = plan(ledger, request, now);
  const fmt = (value: bigint) => formatAmount(value, p.money);
  const index = indexCandles(candles, p);
  const gaps: Gap[] = [];
  const addGap = (productId: string, bucket: number, code: PerformanceGapCode, message: string) => {
    const end = bucket + p.seconds;
    let prior: Gap | undefined;
    for (const gap of gaps) if (gap.product_id === productId && gap.code === code) prior = gap;
    if (prior && prior.start <= bucket && bucket < prior.end) return;
    if (prior && prior.end === bucket && prior.message === message) prior.end = end;
    else gaps.push({ product_id: productId, start: bucket, end, code, message });
  };

  const values: Array<bigint | null> = [];
  const points = p.samples.map((sample): PerformancePoint => {
    const bucket = bucketFor(sample.ms, p.seconds);
    let market = 0n;
    let marked = false;
    const unpriced: string[] = [];
    for (const [productId, quantity] of sample.holdings) {
      if (p.productTypes.get(productId) === 'EQUITY') {
        unpriced.push(productId);
        addGap(productId, bucket, 'EQUITY_UNPRICED', 'Equity holdings have no keyless historical price; supplied order quotes are not historical marks.');
        continue;
      }
      const close = index.get(productId)?.get(bucket);
      if (close === undefined || close === null) {
        unpriced.push(productId);
        const cause = unavailable.find((gap) => gap.product_id === productId && gap.start <= bucket && bucket < gap.end);
        if (cause) addGap(productId, bucket, cause.code, cause.message);
        else addGap(productId, bucket, 'MISSING_CANDLE', close === null ? 'Conflicting duplicate candles; the bucket was not used.' : 'No completed candle for this bucket; no price was interpolated or carried forward.');
        continue;
      }
      market += toIncrement(quantity * close, UNIT, p.money ?? 1n, 'floor');
      marked = true;
    }
    unpriced.sort();
    const priced = unpriced.length === 0;
    const equity = priced ? sample.cash + market : null;
    values.push(equity);
    return {
      timestamp: new Date(sample.ms).toISOString(),
      equity: equity === null ? null : fmt(equity),
      cash: fmt(sample.cash),
      market_value: priced ? fmt(market) : null,
      profit_loss: null,
      profit_loss_pct: null,
      priced,
      mark_time: marked ? iso(bucket + p.seconds) : null,
      unpriced_products: unpriced,
    };
  });

  const baseline = values[0];
  const ending = values[values.length - 1];
  if (baseline !== null) {
    points.forEach((point, i) => {
      const value = values[i];
      if (value === null) return;
      point.profit_loss = fmt(value - baseline);
      point.profit_loss_pct = baseline > 0n ? pct(value - baseline, baseline) : null;
    });
  }
  const complete = values.every((value) => value !== null);
  const known = baseline !== null && ending !== null;
  const periodPct = known && baseline > 0n ? pct(ending - baseline, baseline) : null;

  let drawdown: string | null = null;
  if (complete && baseline !== null && baseline > 0n) {
    let peak = baseline;
    let worstNum = 0n;
    let worstDen = 1n;
    let valid = true;
    for (const value of values as bigint[]) {
      if (value > peak) peak = value;
      if (peak <= 0n) {
        valid = false;
        break;
      }
      const num = peak - value;
      if (num * worstDen > worstNum * peak) {
        worstNum = num;
        worstDen = peak;
      }
    }
    drawdown = valid ? pct(worstNum, worstDen) : null;
  }

  const result: PerformanceResult = {
    mode: 'PAPER',
    ok: true,
    account_id: p.accountId,
    currency: p.currency,
    period: request.period,
    start: new Date(p.startMs).toISOString(),
    end: new Date(p.endMs).toISOString(),
    granularity: p.granularity,
    status: complete ? 'COMPLETE' : 'PARTIAL',
    baseline_equity: baseline === null ? null : fmt(baseline),
    ending_equity: ending === null ? null : fmt(ending),
    profit_loss: known ? fmt(ending - baseline) : null,
    profit_loss_pct: periodPct,
    time_weighted_return_pct: complete ? periodPct : null,
    max_drawdown_pct: drawdown,
    realized_pnl: fmt(p.periodRealized),
    fees_paid: fmt(p.periodFees),
    points,
    gaps: gaps.map((gap) => ({ product_id: gap.product_id, start: iso(gap.start), end: iso(gap.end), code: gap.code, message: gap.message })),
    notice: complete ? PERFORMANCE_NOTICE : `${PERFORMANCE_NOTICE} This curve is PARTIAL: see gaps.`,
  };
  if (request.chart) result.chart = renderPerformanceChart(points);
  return result;
}

/** Pure calculation from already-fetched candle windows keyed by product_id. */
export function calculatePerformance(
  ledger: LedgerView,
  request: PerformanceRequest,
  candles: ReadonlyMap<string, readonly CandleWindowView[]>,
  now: number,
): PerformanceResult {
  return calculate(ledger, request, candles, now, []);
}

/**
 * Fetches the candle windows the curve needs within the remaining shared request
 * budget, then calculates. Windows over budget or failing become explicit gaps.
 * Never reconciles; the caller already did.
 */
export async function buildPerformance(
  ledger: LedgerView,
  market: PerformanceMarket,
  request: PerformanceRequest,
  now: number,
): Promise<PerformanceResult> {
  const p = plan(ledger, request, now);
  const windows = planCandleWindows(requiredBuckets(p), p.granularity);
  const candles = new Map<string, CandleWindowView[]>();
  const unavailable: Gap[] = [];
  for (const window of windows) {
    const stats = market.stats();
    if (stats.candles >= MAX_CANDLE_REQUESTS || stats.total >= MAX_TOTAL_REQUESTS) {
      unavailable.push({
        product_id: window.product_id,
        start: window.start,
        end: window.end,
        code: 'PAPER_REQUEST_BUDGET_EXCEEDED',
        message: `Candles were not requested: the per-command budget of ${MAX_CANDLE_REQUESTS} candle requests is used up. Choose a shorter --period.`,
      });
      continue;
    }
    try {
      const fetched = await market.candleWindow(window);
      const list = candles.get(window.product_id) ?? [];
      list.push(fetched);
      candles.set(window.product_id, list);
    } catch (error) {
      if (!(error instanceof PaperError)) throw error;
      unavailable.push({
        product_id: window.product_id,
        start: window.start,
        end: window.end,
        code: error.code.startsWith('MARKET_DATA_') ? (error.code as PerformanceGapCode) : 'MARKET_DATA_UNAVAILABLE',
        message: error.message,
      });
    }
  }
  return calculate(ledger, request, candles, now, unavailable);
}

/**
 * Renders equity points as a bounded ASCII plot (width columns x height rows).
 * Unpriced samples stay gaps ('?' on the axis); nothing is drawn through them.
 */
export function renderPerformanceChart(points: readonly PerformancePoint[], width = 60, height = 10): string {
  if (!Number.isSafeInteger(width) || width < 2 || width > 200 || !Number.isSafeInteger(height) || height < 2 || height > 50) {
    throw new PaperError('INVALID_ARGUMENT', 'chart width must be 2-200 and height 2-50');
  }
  const n = points.length;
  const priced = points.filter((point) => point.equity !== null);
  if (priced.length === 0) return `${CHART_TITLE}\n(no priced samples to chart)`;

  const column = (i: number) => (n <= width ? (n === 1 ? 0 : Math.floor((i * (width - 1)) / (n - 1))) : Math.floor((i * width) / n));
  const cells: Array<{ value: bigint; label: string } | 'gap' | null> = new Array(width).fill(null);
  points.forEach((point, i) => {
    const c = column(i);
    if (point.equity === null) cells[c] = 'gap';
    else if (cells[c] !== 'gap') cells[c] = { value: parseStoredDecimal(point.equity, 'chart equity', { allowNegative: true }), label: point.equity };
  });
  const filled = cells.filter((cell): cell is { value: bigint; label: string } => cell !== null && cell !== 'gap');
  if (filled.length === 0) return `${CHART_TITLE}\n(no priced samples to chart)`;
  let hi = filled[0];
  let lo = filled[0];
  for (const cell of filled) {
    if (cell.value > hi.value) hi = cell;
    if (cell.value < lo.value) lo = cell;
  }
  const top = BigInt(height - 1);
  const span = hi.value - lo.value;
  const rowOf = (value: bigint) => Number(span === 0n ? top / 2n : divRound((value - lo.value) * top, span, 'half_even'));

  const grid = Array.from({ length: height }, () => new Array<string>(width).fill(' '));
  cells.forEach((cell, c) => {
    if (cell !== null && cell !== 'gap') grid[height - 1 - rowOf(cell.value)][c] = '*';
  });
  const labelWidth = Math.max(hi.label.length, lo.label.length);
  const lines = [CHART_TITLE];
  const labels = new Map([[height - 1 - rowOf(lo.value), lo.label], [height - 1 - rowOf(hi.value), hi.label]]);
  grid.forEach((row, r) => {
    const label = labels.get(r) ?? '';
    lines.push(`${label.padStart(labelWidth)} |${row.join('').trimEnd()}`);
  });
  lines.push(`${' '.repeat(labelWidth)} +${cells.map((cell) => (cell === 'gap' ? '?' : '-')).join('')}`);
  lines.push(`${' '.repeat(labelWidth)}  ${points[0].timestamp} .. ${points[n - 1].timestamp}${cells.includes('gap') ? '  (? = unpriced sample)' : ''}`);
  return lines.join('\n');
}
