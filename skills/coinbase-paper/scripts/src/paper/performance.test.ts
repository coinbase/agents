import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { LedgerFillView, LedgerView } from './balance.ts';
import type { Candle } from './market-data.ts';
import {
  buildPerformance,
  calculatePerformance,
  renderPerformanceChart,
  type CandleWindowRequestView,
  type CandleWindowView,
  type PerformanceMarket,
  type PerformancePoint,
} from './performance.ts';
import { PaperError, type Position } from './types.ts';

const ACCOUNT_ID = 'paper-6f1c1b8e-6a43-4d5b-9b1e-1c2d3e4f5a6b';
const H = 3600;
const sec = (iso: string) => Date.parse(iso) / 1000;
const code = (expected: string) => (error: unknown) => {
  assert.ok(error instanceof PaperError, String(error));
  assert.equal(error.code, expected, error.message);
  return true;
};

let seq = 0;
function fill(side: 'BUY' | 'SELL', at: string, size: string, price: string, notional: string, commission: string, extra: Partial<LedgerFillView> = {}): LedgerFillView {
  seq += 1;
  return {
    fill_seq: seq,
    order_id: '11111111-1111-4111-8111-111111111111',
    product_id: 'BTC-USD',
    product_type: 'SPOT',
    side,
    trade_time: at,
    price,
    size,
    notional,
    commission,
    cost_basis_removed: '0',
    realized_pnl: null,
    ...extra,
  };
}

function ledger(createdAt: string, cash: string, positions: Position[], fills: LedgerFillView[]): LedgerView {
  return {
    account: {
      account_id: ACCOUNT_ID,
      currency: 'USD',
      initial_cash: '10000',
      cash,
      realized_pnl: '0',
      fee_bps: '10',
      maker_fee_bps: '10',
      taker_fee_bps: '10',
      quote_increment: '0.01',
      created_at: createdAt,
      revision: 1,
      last_reconciled_at: null,
    },
    positions,
    fills,
    holds: { cash: '0', positions: {} },
  };
}

function btc(quantity: string, basis: string): Position {
  return { product_id: 'BTC-USD', quantity, cost_basis: basis, base_increment: '0.00000001', quote_increment: '0.01' };
}

function candle(start: string, close: string): Candle {
  return { start: String(sec(start)), low: '1', high: '100000', open: close, close, volume: '10' };
}

function window(productId: string, start: string, end: string, candles: Candle[], granularity = 'ONE_HOUR'): CandleWindowView {
  return { request: { product_id: productId, start: sec(start), end: sec(end), granularity }, candles, provider: 'injected', fetched_at: end };
}

// Hand-computed scenario. Account opens 09:00 with 10000.00 USD.
//  09:10 BUY 0.1 @ 1000.00: notional 100.00, fee 0.10 -> cash 9899.90
//  11:20 SELL 0.05 @ 1200.00: notional 60.00, fee 0.06 -> cash 9959.84;
//        basis removed 50.05, realized 59.94 - 50.05 = 9.89
// Hourly closes: 09:00-10:00 1100, 10:00-11:00 900, 11:00-12:00 1300.
function scenario(): LedgerView {
  seq = 0;
  return ledger('2026-01-02T09:00:00.000Z', '9959.84', [btc('0.05', '50.05')], [
    fill('BUY', '2026-01-02T09:10:00.000Z', '0.1', '1000.00', '100.00', '0.10'),
    fill('SELL', '2026-01-02T11:20:00.000Z', '0.05', '1200.00', '60.00', '0.06', { cost_basis_removed: '50.05', realized_pnl: '9.89' }),
  ]);
}
const NOW = Date.parse('2026-01-02T12:30:00.000Z');
const CLOSES = [candle('2026-01-02T09:00:00Z', '1100'), candle('2026-01-02T10:00:00Z', '900'), candle('2026-01-02T11:00:00Z', '1300')];

describe('calculatePerformance', () => {
  it('matches the hand-computed equity curve, return and drawdown', () => {
    const candles = new Map([['BTC-USD', [window('BTC-USD', '2026-01-02T09:00:00Z', '2026-01-02T12:00:00Z', CLOSES)]]]);
    const result = calculatePerformance(scenario(), { period: '1D', chart: false }, candles, NOW);
    assert.equal(result.start, '2026-01-02T09:00:00.000Z');
    assert.equal(result.end, '2026-01-02T12:30:00.000Z');
    assert.equal(result.granularity, 'ONE_HOUR');
    assert.deepEqual(result.points.map((p) => [p.timestamp, p.cash, p.market_value, p.equity, p.profit_loss, p.mark_time]), [
      ['2026-01-02T09:00:00.000Z', '10000.00', '0.00', '10000.00', '0.00', null],
      ['2026-01-02T10:00:00.000Z', '9899.90', '110.00', '10009.90', '9.90', '2026-01-02T10:00:00.000Z'],
      ['2026-01-02T11:00:00.000Z', '9899.90', '90.00', '9989.90', '-10.10', '2026-01-02T11:00:00.000Z'],
      ['2026-01-02T12:00:00.000Z', '9959.84', '65.00', '10024.84', '24.84', '2026-01-02T12:00:00.000Z'],
      ['2026-01-02T12:30:00.000Z', '9959.84', '65.00', '10024.84', '24.84', '2026-01-02T12:00:00.000Z'],
    ]);
    assert.equal(result.points[2].profit_loss_pct, '-0.101');
    assert.equal(result.status, 'COMPLETE');
    assert.equal(result.baseline_equity, '10000.00');
    assert.equal(result.ending_equity, '10024.84');
    assert.equal(result.profit_loss, '24.84');
    assert.equal(result.profit_loss_pct, '0.2484');
    assert.equal(result.time_weighted_return_pct, '0.2484');
    // (10009.90 - 9989.90) / 10009.90 x 100, half-even at 18 places.
    assert.equal(result.max_drawdown_pct, '0.199802195826132129');
    assert.equal(result.realized_pnl, '9.89');
    assert.equal(result.fees_paid, '0.16');
    assert.deepEqual(result.gaps, []);
    assert.equal(result.chart, undefined);
  });

  it('never uses an incomplete candle or carries a price across a missing bucket', () => {
    const candles = new Map([['BTC-USD', [window('BTC-USD', '2026-01-02T09:00:00Z', '2026-01-02T13:00:00Z', [
      CLOSES[0],
      CLOSES[1],
      candle('2026-01-02T12:00:00Z', '99999'), // ends 13:00, after the command time
    ])]]]);
    const result = calculatePerformance(scenario(), { period: '1D', chart: true }, candles, NOW);
    assert.deepEqual(result.points.map((p) => p.equity), ['10000.00', '10009.90', '9989.90', null, null]);
    assert.deepEqual(result.points[3].unpriced_products, ['BTC-USD']);
    assert.equal(result.points[3].market_value, null);
    assert.equal(result.status, 'PARTIAL');
    assert.equal(result.ending_equity, null);
    assert.equal(result.profit_loss, null);
    assert.equal(result.time_weighted_return_pct, null);
    assert.equal(result.max_drawdown_pct, null);
    assert.deepEqual(result.gaps.map((g) => [g.product_id, g.start, g.end, g.code]), [['BTC-USD', '2026-01-02T11:00:00.000Z', '2026-01-02T12:00:00.000Z', 'MISSING_CANDLE']]);
    assert.match(result.chart ?? '', /PAPER — reconstructed candle-close equity/);
    const axis = (result.chart ?? '').split('\n').find((line) => line.trimStart().startsWith('+')) ?? '';
    assert.equal([...axis].filter((c) => c === '?').length, 2);
  });

  it('marks holdings from before the period that were not traded in it', () => {
    seq = 0;
    const l = ledger('2026-01-01T00:00:00.000Z', '9899.90', [btc('0.1', '100.10')], [fill('BUY', '2026-01-01T01:00:00.000Z', '0.1', '1000.00', '100.00', '0.10')]);
    const now = Date.parse('2026-01-03T00:00:00.000Z');
    const flat = Array.from({ length: 25 }, (_, i) => candle(new Date(Date.parse('2026-01-01T23:00:00Z') + i * H * 1000).toISOString(), '1000'));
    const candles = new Map([['BTC-USD', [window('BTC-USD', '2026-01-01T23:00:00Z', '2026-01-03T00:00:00Z', flat)]]]);
    const result = calculatePerformance(l, { period: '1D', chart: false }, candles, now);
    assert.equal(result.points.length, 25);
    assert.equal(result.baseline_equity, '9999.90');
    assert.equal(result.ending_equity, '9999.90');
    assert.equal(result.time_weighted_return_pct, '0');
    assert.equal(result.max_drawdown_pct, '0');
    assert.equal(result.fees_paid, '0.00');
    assert.equal(result.realized_pnl, '0.00');
  });

  it('leaves equity holdings unpriced instead of using order quotes', () => {
    seq = 0;
    const aapl: Position = { product_id: 'AAPL-USD', quantity: '1', cost_basis: '200.20', base_increment: '0.00001', quote_increment: '0.01', asset_class: 'EQUITY' };
    const l = ledger('2026-01-02T09:00:00.000Z', '9799.80', [aapl], [fill('BUY', '2026-01-02T09:30:00.000Z', '1', '200.00', '200.00', '0.20', { product_id: 'AAPL-USD', product_type: 'EQUITY' })]);
    const result = calculatePerformance(l, { period: '1D', chart: false }, new Map(), NOW);
    assert.equal(result.points[0].equity, '10000.00');
    assert.ok(result.points.slice(1).every((p) => p.equity === null && p.unpriced_products[0] === 'AAPL-USD'));
    assert.equal(result.status, 'PARTIAL');
    assert.deepEqual(result.gaps.map((g) => [g.code, g.start, g.end]), [['EQUITY_UNPRICED', '2026-01-02T09:00:00.000Z', '2026-01-02T12:00:00.000Z']]);
  });

  it('replays more than 1000 fills, including same-time fills in durable order', () => {
    seq = 0;
    const fills: LedgerFillView[] = [];
    for (let i = 0; i < 600; i++) {
      const at = new Date(Date.parse('2026-01-02T09:05:00Z') + i * 1000).toISOString();
      fills.push(fill('BUY', at, '1', '10.00', '10.00', '0.01'));
      fills.push(fill('SELL', at, '1', '10.00', '10.00', '0.01', { cost_basis_removed: '10.01', realized_pnl: null }));
    }
    fills.reverse(); // input order must not matter
    const result = calculatePerformance(ledger('2026-01-02T09:00:00.000Z', '9988.00', [], fills), { period: 'ALL', chart: false }, new Map(), NOW);
    assert.equal(fills.length, 1200);
    assert.equal(result.granularity, 'ONE_DAY');
    assert.deepEqual(result.points.map((p) => p.equity), ['10000.00', '9988.00']);
    assert.equal(result.realized_pnl, '-12.00');
    assert.equal(result.fees_paid, '12.00');
    assert.equal(result.profit_loss_pct, '-0.12');
    assert.equal(result.status, 'COMPLETE');
  });

  it('refuses a ledger whose fills do not reproduce the stored account', () => {
    const l = scenario();
    l.account.cash = '9959.85';
    assert.throws(() => calculatePerformance(l, { period: '1D', chart: false }, new Map(), NOW), code('STATE_INVALID'));
    const m = scenario();
    m.positions = [];
    assert.throws(() => calculatePerformance(m, { period: '1D', chart: false }, new Map(), NOW), code('STATE_INVALID'));
  });
});

function fakeMarket(respond: (request: CandleWindowRequestView) => CandleWindowView, used = { candles: 0, total: 0 }) {
  const calls: CandleWindowRequestView[] = [];
  const market: PerformanceMarket = {
    async candleWindow(request) {
      calls.push(request);
      used.candles += 1;
      used.total += 1;
      return respond(request);
    },
    stats: () => ({ ...used }),
  };
  return { market, calls };
}

describe('buildPerformance', () => {
  it('requests only the held buckets in one bounded window', async () => {
    const { market, calls } = fakeMarket((request) => ({ request, candles: CLOSES, provider: 'injected', fetched_at: '2026-01-02T12:30:00Z' }));
    const result = await buildPerformance(scenario(), market, { period: '1D', chart: false }, NOW);
    assert.deepEqual(calls, [{ product_id: 'BTC-USD', start: sec('2026-01-02T09:00:00Z'), end: sec('2026-01-02T12:00:00Z'), granularity: 'ONE_HOUR' }]);
    assert.equal(result.ending_equity, '10024.84');
    assert.equal(result.status, 'COMPLETE');
  });

  it('makes no request when nothing was held at any sample', async () => {
    seq = 0;
    const l = ledger('2026-01-02T09:00:00.000Z', '9999.80', [], [
      fill('BUY', '2026-01-02T09:10:00.000Z', '0.1', '1000.00', '100.00', '0.10'),
      fill('SELL', '2026-01-02T09:20:00.000Z', '0.1', '1000.00', '100.00', '0.10', { cost_basis_removed: '100.10', realized_pnl: '-0.20' }),
    ]);
    const { market, calls } = fakeMarket(() => assert.fail('no candles needed'));
    const result = await buildPerformance(l, market, { period: '1D', chart: false }, NOW);
    assert.equal(calls.length, 0);
    assert.equal(result.ending_equity, '9999.80');
    assert.equal(result.realized_pnl, '-0.20');
    assert.equal(result.status, 'COMPLETE');
  });

  it('reports the exhausted shared budget as a gap without requesting', async () => {
    const { market, calls } = fakeMarket(() => assert.fail('over budget'), { candles: 32, total: 32 });
    const result = await buildPerformance(scenario(), market, { period: '1D', chart: false }, NOW);
    assert.equal(calls.length, 0);
    assert.equal(result.status, 'PARTIAL');
    assert.equal(result.time_weighted_return_pct, null);
    assert.deepEqual(result.gaps.map((g) => [g.code, g.start, g.end]), [['PAPER_REQUEST_BUDGET_EXCEEDED', '2026-01-02T09:00:00.000Z', '2026-01-02T12:00:00.000Z']]);
  });

  it('reports a failed candle request as a market-data gap', async () => {
    const { market } = fakeMarket(() => {
      throw new PaperError('MARKET_DATA_UNAVAILABLE', 'public candles request failed');
    });
    const result = await buildPerformance(scenario(), market, { period: '1D', chart: false }, NOW);
    assert.equal(result.points[0].equity, '10000.00');
    assert.equal(result.ending_equity, null);
    assert.deepEqual(result.gaps.map((g) => g.code), ['MARKET_DATA_UNAVAILABLE']);
  });

  it('pages long daily histories at 350 candles per request', async () => {
    seq = 0;
    const l = ledger('2025-01-01T00:00:00.000Z', '9899.90', [btc('0.1', '100.10')], [fill('BUY', '2025-01-01T01:00:00.000Z', '0.1', '1000.00', '100.00', '0.10')]);
    const { market, calls } = fakeMarket((request) => ({ request, candles: [], provider: 'injected', fetched_at: '2026-01-02T12:30:00Z' }));
    await buildPerformance(l, market, { period: 'ALL', chart: false }, NOW);
    // Samples 2025-01-02 .. 2026-01-02 plus the end need buckets 2025-01-01 .. 2026-01-01: 366 days.
    assert.deepEqual(calls.map((c) => (c.end - c.start) / 86_400), [350, 16]);
    assert.equal(calls[1].start, calls[0].end);
  });
});

function point(equity: string | null, i: number): PerformancePoint {
  return { timestamp: `2026-01-0${i + 1}T00:00:00.000Z`, equity, cash: '0', market_value: null, profit_loss: null, profit_loss_pct: null, priced: equity !== null, mark_time: null, unpriced_products: [] };
}

describe('renderPerformanceChart', () => {
  it('draws a falling curve with a preserved gap', () => {
    const chart = renderPerformanceChart(['100', '90', null, '80'].map(point), 4, 3);
    assert.equal(chart, [
      'PAPER — reconstructed candle-close equity (not broker-recorded portfolio history)',
      '100 |*',
      '    | *',
      ' 80 |   *',
      '    +--?-',
      '     2026-01-01T00:00:00.000Z .. 2026-01-04T00:00:00.000Z  (? = unpriced sample)',
    ].join('\n'));
  });

  it('draws a flat curve on the middle row within bounds', () => {
    const chart = renderPerformanceChart(Array.from({ length: 5 }, (_, i) => point('10000.00', i)));
    const lines = chart.split('\n');
    assert.equal(lines.length, 13);
    assert.equal(lines[6], '10000.00 |*             *              *              *              *');
    assert.ok(lines.every((line, i) => i !== 6 || line.length <= 9 + 1 + 60));
  });

  it('scales values beyond float precision exactly', () => {
    const chart = renderPerformanceChart([point('123456789012345.123456789012345678', 0), point('123456789012345.123456789012345679', 1)], 2, 2);
    assert.deepEqual(chart.split('\n').slice(1, 3), ['123456789012345.123456789012345679 | *', '123456789012345.123456789012345678 |*']);
  });

  it('says when nothing is priced and rejects out-of-range bounds', () => {
    assert.match(renderPerformanceChart([point(null, 0)]), /no priced samples/);
    assert.throws(() => renderPerformanceChart([point('1', 0)], 1, 10), code('INVALID_ARGUMENT'));
    assert.throws(() => renderPerformanceChart([point('1', 0)], 60, 51), code('INVALID_ARGUMENT'));
  });
});
