import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildBalance, type LedgerFillView, type LedgerView } from './balance.ts';
import { PaperError, type Position } from './types.ts';

const NOW = Date.UTC(2026, 0, 2, 12, 0, 0);
const BOOK_TIME = '2026-01-02T11:59:50.000Z';
const ACCOUNT_ID = 'paper-6f1c1b8e-6a43-4d5b-9b1e-1c2d3e4f5a6b';
const code = (expected: string) => (error: unknown) => {
  assert.ok(error instanceof PaperError, String(error));
  assert.equal(error.code, expected, error.message);
  return true;
};

function fill(overrides: Partial<LedgerFillView>): LedgerFillView {
  return {
    fill_seq: 1,
    order_id: '11111111-1111-4111-8111-111111111111',
    product_id: 'BTC-USD',
    product_type: 'SPOT',
    side: 'BUY',
    trade_time: '2026-01-02T10:00:00.000Z',
    price: '100000',
    size: '0.5',
    notional: '50000.00',
    commission: '50.00',
    cost_basis_removed: '0',
    realized_pnl: null,
    ...overrides,
  };
}

const BTC: Position = { product_id: 'BTC-USD', quantity: '0.5', cost_basis: '50050', base_increment: '0.00000001', quote_increment: '0.01' };
const AAPL: Position = { product_id: 'AAPL-USD', quantity: '2', cost_basis: '400.40', base_increment: '0.00001', quote_increment: '0.01', asset_class: 'EQUITY' };

function ledger(overrides: { cash?: string; realized?: string; positions?: Position[]; fills?: LedgerFillView[]; cashHold?: string; holds?: Record<string, string>; quoteIncrement?: string | null } = {}): LedgerView {
  return {
    account: {
      account_id: ACCOUNT_ID,
      currency: 'USD',
      initial_cash: '10000',
      cash: overrides.cash ?? '1000',
      realized_pnl: overrides.realized ?? '-2',
      fee_bps: '10',
      maker_fee_bps: '5',
      taker_fee_bps: '10',
      quote_increment: overrides.quoteIncrement === undefined ? '0.01' : overrides.quoteIncrement,
      created_at: '2026-01-01T00:00:00.000Z',
      revision: 3,
      last_reconciled_at: null,
    },
    positions: overrides.positions ?? [BTC],
    fills: overrides.fills ?? [fill({}), fill({ fill_seq: 2, side: 'SELL', commission: '1.00', notional: '1000.00', size: '0.01', cost_basis_removed: '1001.00', realized_pnl: '-2.00' })],
    holds: { cash: overrides.cashHold ?? '101.1', positions: overrides.holds ?? { 'BTC-USD': '0.2' } },
  };
}

function book(bid: string, time = BOOK_TIME) {
  return { pricebook: { product_id: 'BTC-USD', time, bids: [{ price: bid, size: '5' }], asks: [{ price: '110001', size: '5' }] } };
}

describe('buildBalance', () => {
  it('reports a cash-only account as known cash equity without claiming a mark', () => {
    const result = buildBalance(ledger({ cash: '10000', realized: '0', positions: [], fills: [], cashHold: '0', holds: {}, quoteIncrement: null }), null, NOW);
    assert.equal(result.valuation_status, 'CASH_ONLY');
    assert.equal(result.priced, false);
    assert.equal(result.marked_at, null);
    assert.equal(result.equity, '10000');
    assert.equal(result.unrealized_pnl, '0');
    assert.equal(result.total_pnl, '0');
    assert.equal(result.buying_power, '10000');
    assert.deepEqual(result.cash_balance, { total: '10000', available: '10000', hold: '0' });
    assert.equal(result.fees_paid, '0');
    assert.deepEqual(result.unpriced_positions, []);
  });

  it('marks fresh books, keeps holds in equity but out of available, and counts fees once', () => {
    const result = buildBalance(ledger(), { 'BTC-USD': book('110000') }, NOW);
    assert.equal(result.valuation_status, 'MARKED');
    assert.equal(result.priced, true);
    assert.equal(result.marked_at, '2026-01-02T12:00:00.000Z');
    assert.equal(result.cash, '1000.00');
    assert.deepEqual(result.cash_balance, { total: '1000.00', available: '898.90', hold: '101.10' });
    assert.equal(result.buying_power, '898.90');
    // 0.5 x 110000 = 55000.00; basis 50050.00 already includes the 50.00 entry fee.
    assert.equal(result.priced_market_value, '55000.00');
    assert.equal(result.unrealized_pnl, '4950.00');
    assert.equal(result.total_pnl, '4948.00');
    // Equity is total cash plus value, held cash included; fees_paid is not subtracted again.
    assert.equal(result.equity, '56000.00');
    assert.notEqual(result.equity, '55949.00');
    assert.equal(result.fees_paid, '51.00');
    assert.equal(result.maker_fee_bps, '5');
    assert.equal(result.taker_fee_bps, '10');
    const [position] = result.positions;
    assert.equal(position.total, '0.50000000');
    assert.equal(position.available, '0.30000000');
    assert.equal(position.hold, '0.20000000');
    assert.equal(position.average_entry_price, '100100.00');
    assert.equal(position.mark_time, BOOK_TIME);
  });

  it('never marks without a refresh', () => {
    const result = buildBalance(ledger(), null, NOW);
    assert.equal(result.valuation_status, 'UNPRICED');
    assert.equal(result.priced, false);
    assert.equal(result.marked_at, null);
    assert.equal(result.equity, null);
    assert.equal(result.unrealized_pnl, null);
    assert.equal(result.total_pnl, null);
    assert.equal(result.priced_market_value, null);
    assert.equal(result.buying_power, '898.90');
    assert.equal(result.unpriced_positions.length, 1);
    assert.match(result.unpriced_positions[0].unpriced_reason, /--refresh/);
  });

  it('treats a stale book as unpriced rather than using an old price', () => {
    const result = buildBalance(ledger(), { 'BTC-USD': book('110000', '2026-01-02T11:00:00.000Z') }, NOW);
    assert.equal(result.valuation_status, 'UNPRICED');
    assert.equal(result.equity, null);
    assert.match(result.unpriced_positions[0].unpriced_reason, /STALE/);
  });

  it('reports priced subtotals but no whole-account value for a partial crypto/equity refresh', () => {
    const result = buildBalance(ledger({ positions: [BTC, AAPL] }), { 'BTC-USD': book('110000') }, NOW);
    assert.equal(result.valuation_status, 'PARTIAL');
    assert.equal(result.priced, false);
    assert.equal(result.equity, null);
    assert.equal(result.total_pnl, null);
    assert.equal(result.priced_market_value, '55000.00');
    assert.equal(result.priced_unrealized_pnl, '4950.00');
    assert.equal(result.marked_at, '2026-01-02T12:00:00.000Z');
    assert.deepEqual(result.unpriced_positions.map((p) => p.product_id), ['AAPL-USD']);
    const aapl = result.positions.find((p) => p.product_id === 'AAPL-USD');
    assert.equal(aapl?.available, '2.00000');
    assert.equal(aapl?.hold, '0.00000');
  });

  it('rejects holds that exceed the held amounts', () => {
    assert.throws(() => buildBalance(ledger({ cashHold: '1000.01' }), null, NOW), code('STATE_INVALID'));
    assert.throws(() => buildBalance(ledger({ holds: { 'BTC-USD': '0.50000001' } }), null, NOW), code('STATE_INVALID'));
    assert.throws(() => buildBalance(ledger({ holds: { 'ETH-USD': '1' } }), null, NOW), code('STATE_INVALID'));
    assert.throws(() => buildBalance(ledger({ cashHold: '-1' }), null, NOW), code('STATE_INVALID'));
  });
});
