import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ASSUMED_EQUITY_METADATA, checkExternalFresh, checkFresh, markPortfolio, normalizeIntent, resolveEquityMetadata, simulate, simulateExternal, validateInitialAccount } from './engine.ts';
import { EXTERNAL_QUOTE_MODEL_VERSION, PAPER_MODEL_VERSION, PAPER_NOTICE, PaperError, type Account, type EquityMetadata, type Intent, type Position, type Receipt } from './types.ts';

// Golden cases were produced once by the unreleased Python prototype's
// execute() with identical inputs; they pin its economics, not a runtime link.
interface Scenario {
  currency: string;
  initial_cash: string;
  fee_bps: string;
  product_id: string;
  product: string[];
  bids: string[][];
  asks: string[][];
  steps: Array<{ request_id: string; side: 'BUY' | 'SELL'; size_type: 'base_size' | 'quote_size'; size: string }>;
}
type Golden =
  | { error: string }
  | { receipt: Record<string, unknown>; cash: string; realized_pnl: string; position: Omit<Position, 'product_id'> | null };

const SCENARIOS: Scenario[] = [{"currency": "USD", "initial_cash": "10000", "fee_bps": "10", "product_id": "BTC-USD", "product": ["0.00000001", "0.01"], "bids": [["86800.01", "0.01"], ["86799.5", "0.5"], ["86000", "2"]], "asks": [["86800.02", "0.005"], ["86801.33", "0.01"], ["86900", "3"]], "steps": [{"request_id": "11111111-1111-4111-8111-111111111111", "side": "BUY", "size_type": "base_size", "size": "0.0123"}, {"request_id": "22222222-2222-4222-8222-222222222222", "side": "BUY", "size_type": "quote_size", "size": "1000"}, {"request_id": "33333333-3333-4333-8333-333333333333", "side": "SELL", "size_type": "base_size", "size": "0.00777777"}, {"request_id": "44444444-4444-4444-8444-444444444444", "side": "SELL", "size_type": "base_size", "size": "0.01"}, {"request_id": "55555555-5555-4555-8555-555555555555", "side": "BUY", "size_type": "quote_size", "size": "99999"}, {"request_id": "66666666-6666-4666-8666-666666666666", "side": "SELL", "size_type": "base_size", "size": "0.00603134"}]}, {"currency": "USDC", "initial_cash": "123456789012345.123456789012345678", "fee_bps": "12.3456", "product_id": "SHIB-USDC", "product": ["1", "0.000001", "1", "100000000000000", "0.000001", "999999999999999"], "bids": [["0.000012345678901234", "1000000000"], ["0.000012", "50000000000"]], "asks": [["0.000012345678901235", "333333333"], ["0.000012999999999999", "999999999999"]], "steps": [{"request_id": "AAAAAAAA-1111-4111-8111-111111111111", "side": "BUY", "size_type": "base_size", "size": "777777777"}, {"request_id": "BBBBBBBB-2222-4222-8222-222222222222", "side": "BUY", "size_type": "quote_size", "size": "12345.678901"}, {"request_id": "CCCCCCCC-3333-4333-8333-333333333333", "side": "SELL", "size_type": "base_size", "size": "123456789"}, {"request_id": "DDDDDDDD-3333-4333-8333-333333333333", "side": "SELL", "size_type": "base_size", "size": "0.5"}]}, {"currency": "USD", "initial_cash": "100", "fee_bps": "1000", "product_id": "ETH-USD", "product": ["0.0001", "1", "0.0001", "100", "1", "1000000"], "bids": [["2999", "1"]], "asks": [["3001", "1"], ["3002.5", "0.3"]], "steps": [{"request_id": "77777777-1111-4111-8111-111111111111", "side": "BUY", "size_type": "quote_size", "size": "100"}, {"request_id": "88888888-1111-4111-8111-111111111111", "side": "SELL", "size_type": "base_size", "size": "0.0101"}, {"request_id": "99999999-1111-4111-8111-111111111111", "side": "SELL", "size_type": "base_size", "size": "0.0198"}]}];

const GOLDEN: Golden[][] = [[{"receipt": {"request_id": "11111111-1111-4111-8111-111111111111", "product_id": "BTC-USD", "side": "BUY", "requested": {"base_size": "0.0123"}, "base_size": "0.01230000", "notional": "1067.65", "fee": "1.07", "total": "1068.72", "average_price": "86800.797479674796747967", "realized_pnl": null, "cash": "8931.28", "position": {"quantity": "0.01230000", "cost_basis": "1068.72"}, "fills": [{"price": "86800.02", "size": "0.005"}, {"price": "86801.33", "size": "0.0073"}]}, "cash": "8931.28", "realized_pnl": "0", "position": {"quantity": "0.0123", "cost_basis": "1068.72", "base_increment": "0.00000001", "quote_increment": "0.01"}}, {"receipt": {"request_id": "22222222-2222-4222-8222-222222222222", "product_id": "BTC-USD", "side": "BUY", "requested": {"quote_size": "1000"}, "base_size": "0.01150911", "notional": "999.00", "fee": "1.00", "total": "1000.00", "average_price": "86800.760885620173931781", "realized_pnl": null, "cash": "7931.28", "position": {"quantity": "0.02380911", "cost_basis": "2068.72"}, "fills": [{"price": "86800.02", "size": "0.005"}, {"price": "86801.33", "size": "0.00650911"}]}, "cash": "7931.28", "realized_pnl": "0", "position": {"quantity": "0.02380911", "cost_basis": "2068.72", "base_increment": "0.00000001", "quote_increment": "0.01"}}, {"receipt": {"request_id": "33333333-3333-4333-8333-333333333333", "product_id": "BTC-USD", "side": "SELL", "requested": {"base_size": "0.00777777"}, "base_size": "0.00777777", "notional": "675.11", "fee": "0.68", "total": "674.43", "average_price": "86800.01", "realized_pnl": "-1.36", "cash": "8605.71", "position": {"quantity": "0.01603134", "cost_basis": "1392.93"}, "fills": [{"price": "86800.01", "size": "0.00777777"}]}, "cash": "8605.71", "realized_pnl": "-1.36", "position": {"quantity": "0.01603134", "cost_basis": "1392.93", "base_increment": "0.00000001", "quote_increment": "0.01"}}, {"receipt": {"request_id": "44444444-4444-4444-8444-444444444444", "product_id": "BTC-USD", "side": "SELL", "requested": {"base_size": "0.01"}, "base_size": "0.01000000", "notional": "868.00", "fee": "0.87", "total": "867.13", "average_price": "86800.01", "realized_pnl": "-1.75", "cash": "9472.84", "position": {"quantity": "0.00603134", "cost_basis": "524.05"}, "fills": [{"price": "86800.01", "size": "0.01"}]}, "cash": "9472.84", "realized_pnl": "-3.11", "position": {"quantity": "0.00603134", "cost_basis": "524.05", "base_increment": "0.00000001", "quote_increment": "0.01"}}, {"error": "INSUFFICIENT_CASH"}, {"receipt": {"request_id": "66666666-6666-4666-8666-666666666666", "product_id": "BTC-USD", "side": "SELL", "requested": {"base_size": "0.00603134"}, "base_size": "0.00603134", "notional": "523.52", "fee": "0.53", "total": "522.99", "average_price": "86800.01", "realized_pnl": "-1.06", "cash": "9995.83", "position": {"quantity": "0.00000000", "cost_basis": "0.00"}, "fills": [{"price": "86800.01", "size": "0.00603134"}]}, "cash": "9995.83", "realized_pnl": "-4.17", "position": null}], [{"receipt": {"request_id": "aaaaaaaa-1111-4111-8111-111111111111", "product_id": "SHIB-USDC", "side": "BUY", "requested": {"base_size": "777777777"}, "base_size": "777777777", "notional": "9893.004069", "fee": "12.213508", "total": "9905.217577", "average_price": "0.000012719576671957", "realized_pnl": null, "cash": "123456789002439.905879789012345678", "position": {"quantity": "777777777", "cost_basis": "9905.217577"}, "fills": [{"price": "0.000012345678901235", "size": "333333333"}, {"price": "0.000012999999999999", "size": "444444444"}]}, "cash": "123456789002439.905879789012345678", "realized_pnl": "0", "position": {"quantity": "777777777", "cost_basis": "9905.217577", "base_increment": "1", "quote_increment": "0.000001"}}, {"receipt": {"request_id": "bbbbbbbb-2222-4222-8222-222222222222", "product_id": "SHIB-USDC", "side": "BUY", "requested": {"quote_size": "12345.678901"}, "base_size": "965274095", "notional": "12330.456203", "fee": "15.222689", "total": "12345.678892", "average_price": "0.00001277404652851", "realized_pnl": null, "cash": "123456788990094.226987789012345678", "position": {"quantity": "1743051872", "cost_basis": "22250.896469"}, "fills": [{"price": "0.000012345678901235", "size": "333333333"}, {"price": "0.000012999999999999", "size": "631940762"}]}, "cash": "123456788990094.226987789012345678", "realized_pnl": "0", "position": {"quantity": "1743051872", "cost_basis": "22250.896469", "base_increment": "1", "quote_increment": "0.000001"}}, {"receipt": {"request_id": "cccccccc-3333-4333-8333-333333333333", "product_id": "SHIB-USDC", "side": "SELL", "requested": {"base_size": "123456789"}, "base_size": "123456789", "notional": "1524.157875", "fee": "1.881665", "total": "1522.276210", "average_price": "0.000012345678901234", "realized_pnl": "-53.709149", "cash": "123456788991616.503197789012345678", "position": {"quantity": "1619595083", "cost_basis": "20674.911110"}, "fills": [{"price": "0.000012345678901234", "size": "123456789"}]}, "cash": "123456788991616.503197789012345678", "realized_pnl": "-53.709149", "position": {"quantity": "1619595083", "cost_basis": "20674.91111", "base_increment": "1", "quote_increment": "0.000001"}}, {"error": "INVALID_INCREMENT"}], [{"receipt": {"request_id": "77777777-1111-4111-8111-111111111111", "product_id": "ETH-USD", "side": "BUY", "requested": {"quote_size": "100"}, "base_size": "0.0299", "notional": "90", "fee": "9", "total": "99", "average_price": "3001", "realized_pnl": null, "cash": "1", "position": {"quantity": "0.0299", "cost_basis": "99"}, "fills": [{"price": "3001", "size": "0.0299"}]}, "cash": "1", "realized_pnl": "0", "position": {"quantity": "0.0299", "cost_basis": "99", "base_increment": "0.0001", "quote_increment": "1"}}, {"receipt": {"request_id": "88888888-1111-4111-8111-111111111111", "product_id": "ETH-USD", "side": "SELL", "requested": {"base_size": "0.0101"}, "base_size": "0.0101", "notional": "30", "fee": "3", "total": "27", "average_price": "2999", "realized_pnl": "-6", "cash": "28", "position": {"quantity": "0.0198", "cost_basis": "66"}, "fills": [{"price": "2999", "size": "0.0101"}]}, "cash": "28", "realized_pnl": "-6", "position": {"quantity": "0.0198", "cost_basis": "66", "base_increment": "0.0001", "quote_increment": "1"}}, {"receipt": {"request_id": "99999999-1111-4111-8111-111111111111", "product_id": "ETH-USD", "side": "SELL", "requested": {"base_size": "0.0198"}, "base_size": "0.0198", "notional": "59", "fee": "6", "total": "53", "average_price": "2999", "realized_pnl": "-13", "cash": "81", "position": {"quantity": "0.0000", "cost_basis": "0"}, "fills": [{"price": "2999", "size": "0.0198"}]}, "cash": "81", "realized_pnl": "-19", "position": null}]];

const NOW = Date.UTC(2026, 0, 2, 3, 4, 5);
const BOOK_TIME = '2026-01-02T03:04:00.123456Z';
const ACCOUNT_ID = 'paper-6f1c1b8e-6a43-4d5b-9b1e-1c2d3e4f5a6b';
const code = (expected: string) => (error: unknown) => {
  assert.ok(error instanceof PaperError, String(error));
  assert.equal(error.code, expected, error.message);
  return true;
};

function product(id: string, limits: string[] = ['0.00000001', '0.01']): Record<string, unknown> {
  const [base, quote] = id.split('-');
  const [baseIncrement, quoteIncrement, baseMin = '0.00000001', baseMax = '10000', quoteMin = '1', quoteMax = '10000000'] = limits;
  return {
    product_id: id,
    product_type: 'SPOT',
    base_currency_id: base,
    quote_currency_id: quote,
    status: 'online',
    is_disabled: false,
    trading_disabled: false,
    cancel_only: false,
    limit_only: false,
    post_only: false,
    auction_mode: false,
    base_increment: baseIncrement,
    quote_increment: quoteIncrement,
    base_min_size: baseMin,
    base_max_size: baseMax,
    quote_min_size: quoteMin,
    quote_max_size: quoteMax,
  };
}

function book(id: string, bids: string[][], asks: string[][], time = BOOK_TIME) {
  const levels = (rows: string[][]) => rows.map(([price, size]) => ({ price, size }));
  return { pricebook: { product_id: id, time, bids: levels(bids), asks: levels(asks) } };
}

function account(cash = '10000', overrides: Partial<Account> = {}): Account {
  return {
    account_id: ACCOUNT_ID,
    currency: 'USD',
    initial_cash: '10000',
    cash,
    realized_pnl: '0',
    fee_bps: '10',
    quote_increment: '0.01',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function intent(side: 'BUY' | 'SELL', sizeType: 'base_size' | 'quote_size', size: string, productId = 'BTC-USD'): Intent {
  return normalizeIntent({ request_id: '11111111-1111-4111-8111-111111111111', account_id: ACCOUNT_ID, product_id: productId, side, [sizeType]: size });
}

const BTC_BOOK = book('BTC-USD', [['86800.01', '0.01'], ['86799.5', '0.5'], ['86000', '2']], [['86800.02', '0.005'], ['86801.33', '0.01'], ['86900', '3']]);
const BTC = product('BTC-USD');

function position(quantity: string, costBasis: string, productId = 'BTC-USD'): Position {
  return { product_id: productId, quantity, cost_basis: costBasis, base_increment: '0.00000001', quote_increment: '0.01' };
}

describe('simulate golden fixtures', () => {
  SCENARIOS.forEach((scenario, index) => {
    it(`matches prototype economics for ${scenario.product_id} case ${index}`, () => {
      let acct = account(scenario.initial_cash, {
        currency: scenario.currency,
        initial_cash: scenario.initial_cash,
        fee_bps: scenario.fee_bps,
        quote_increment: null,
      });
      let held: Position | null = null;
      scenario.steps.forEach((step, stepIndex) => {
        const expected = GOLDEN[index][stepIndex];
        const terms = normalizeIntent({
          request_id: step.request_id,
          account_id: ACCOUNT_ID,
          product_id: scenario.product_id,
          side: step.side,
          [step.size_type]: step.size,
        });
        const run = () =>
          simulate(acct, held, terms, product(scenario.product_id, scenario.product), book(scenario.product_id, scenario.bids, scenario.asks), NOW);
        if ('error' in expected) {
          assert.throws(run, code(expected.error));
          return;
        }
        const result = run();
        const { mode, ok, status, order_type, account_id, currency, snapshot_time, filled_at, source, assumptions, notice, ...rest } = result.receipt;
        assert.deepEqual(rest, expected.receipt);
        assert.deepEqual([mode, ok, status, order_type, account_id, currency, snapshot_time, filled_at, notice], [
          'PAPER', true, 'FILLED', 'MARKET', ACCOUNT_ID, scenario.currency, BOOK_TIME, '2026-01-02T03:04:05.000Z', PAPER_NOTICE,
        ]);
        assert.equal(assumptions.model_version, PAPER_MODEL_VERSION);
        assert.equal(assumptions.fee_bps, scenario.fee_bps);
        assert.equal((source.product as Record<string, string>).quote_increment, scenario.product[1]);
        assert.equal(result.cash, expected.cash);
        assert.equal(result.realized_pnl, expected.realized_pnl);
        if (expected.position === null) {
          assert.equal(result.position.quantity, '0');
          assert.equal(result.position.cost_basis, '0');
          held = null;
        } else {
          assert.deepEqual(result.position, { product_id: scenario.product_id, ...expected.position });
          held = result.position;
        }
        acct = { ...acct, cash: result.cash, realized_pnl: result.realized_pnl };
        assert.deepEqual(JSON.parse(JSON.stringify(result.receipt)), result.receipt);
      });
    });
  });
});

// A few cases from an independent seeded oracle corpus of the prior Decimal
// implementation: sell-all, all-in quote budget, partial sell, insufficient cash.
const ORACLE_CASES = [{"fee_bps": "10", "cash": "10000", "position": ["0.07823484", "6942.54"], "side": "SELL", "size_type": "base_size", "size": "0.07823484", "expect": {"base_size": "0.07823484", "notional": "4693.80", "fee": "4.70", "total": "4689.10", "average_price": "59996.384623525784675983", "realized_pnl": "-2253.44", "cash": "14689.10", "position": {"quantity": "0.00000000", "cost_basis": "0.00"}, "fills": [{"price": "59999.99", "size": "0.05"}, {"price": "59990", "size": "0.02823484"}]}}, {"fee_bps": "0", "cash": "10000", "position": null, "side": "BUY", "size_type": "quote_size", "size": "7697.01", "expect": {"base_size": "0.12827044", "notional": "7697.01", "fee": "0.00", "total": "7697.01", "average_price": "60006.105883787410411939", "realized_pnl": null, "cash": "2302.99", "position": {"quantity": "0.12827044", "cost_basis": "7697.01"}, "fills": [{"price": "60000.01", "size": "0.05"}, {"price": "60010", "size": "0.07827044"}]}}, {"fee_bps": "26", "cash": "10000", "position": ["0.10971787", "3740.04"], "side": "SELL", "size_type": "base_size", "size": "0.05485894", "expect": {"base_size": "0.05485894", "notional": "3291.48", "fee": "8.56", "total": "3282.92", "average_price": "59999.10517046082188245", "realized_pnl": "1412.90", "cash": "13282.92", "position": {"quantity": "0.05485893", "cost_basis": "1870.02"}, "fills": [{"price": "59999.99", "size": "0.05"}, {"price": "59990", "size": "0.00485894"}]}}, {"fee_bps": "10", "cash": "10000", "position": null, "side": "BUY", "size_type": "base_size", "size": "0.18464096", "expect": {"error": "INSUFFICIENT_CASH"}}];

describe('simulate oracle cross-check', () => {
  const oracleBook = book('BTC-USD', [['59999.99', '0.05'], ['59990', '0.1'], ['59900', '1']], [['60000.01', '0.05'], ['60010', '0.1'], ['60100', '1']]);
  const oracleProduct = product('BTC-USD', ['0.00000001', '0.01', '0.00000001', '100', '0.01', '100000000']);
  ORACLE_CASES.forEach((c, index) => {
    it(`matches oracle case ${index} (${c.side} ${c.size_type} ${c.size})`, () => {
      const run = () =>
        simulate(
          account(c.cash, { fee_bps: c.fee_bps, quote_increment: null }),
          c.position ? position(c.position[0], c.position[1]) : null,
          intent(c.side as 'BUY' | 'SELL', c.size_type as 'base_size' | 'quote_size', c.size),
          oracleProduct,
          oracleBook,
          NOW,
        );
      if ('error' in c.expect) {
        assert.throws(run, code(c.expect.error as string));
        return;
      }
      const receipt = run().receipt as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(c.expect)) assert.deepEqual(receipt[key], value, key);
    });
  });
});

describe('normalizeIntent', () => {
  const base = { request_id: 'AAAAAAAA-1111-4111-8111-111111111111', account_id: ACCOUNT_ID, product_id: 'BTC-USD', side: 'BUY' };

  it('canonicalizes UUIDs and decimals into a fixed key order', () => {
    const result = normalizeIntent({ ...base, account_id: ACCOUNT_ID.toUpperCase().replace('PAPER-', 'paper-'), base_size: '1.50', quote_size: undefined });
    assert.deepEqual(result, {
      request_id: 'aaaaaaaa-1111-4111-8111-111111111111',
      account_id: ACCOUNT_ID,
      product_id: 'BTC-USD',
      side: 'BUY',
      size_type: 'base_size',
      size: '1.5',
    });
    assert.deepEqual(Object.keys(result), ['request_id', 'account_id', 'product_id', 'side', 'size_type', 'size']);
    assert.equal(normalizeIntent({ ...base, quote_size: '100.000' }).size, '100');
  });

  it('rejects unknown, dangerous, duplicate and malformed terms', () => {
    const cases: unknown[] = [
      null,
      [],
      'BUY',
      { ...base },
      { ...base, base_size: '1', quote_size: '1' },
      { ...base, base_size: '1', limit_price: '1' },
      { ...base, base_size: '1', paper: true },
      { ...base, base_size: '1', limit_price: undefined },
      JSON.parse('{"__proto__":{"x":1},"request_id":"aaaaaaaa-1111-4111-8111-111111111111","account_id":"' + ACCOUNT_ID + '","product_id":"BTC-USD","side":"BUY","base_size":"1"}'),
      { ...base, side: 'buy', base_size: '1' },
      { ...base, side: 'SELL', quote_size: '1' },
      { ...base, request_id: 'not-a-uuid', base_size: '1' },
      { ...base, request_id: '{aaaaaaaa-1111-4111-8111-111111111111}', base_size: '1' },
      { ...base, account_id: 'someone-else', base_size: '1' },
      { ...base, product_id: 'btc-usd', base_size: '1' },
      { ...base, product_id: 'AAPL', base_size: '1' },
      Object.assign(Object.create({ inherited: 1 }), { ...base, base_size: '1' }),
      Object.defineProperty({ ...base }, 'base_size', { get: () => '1', enumerable: true }),
      Object.defineProperty({ ...base, base_size: '1' }, 'hidden', { value: 1, enumerable: false }),
      { ...base, base_size: '1', [Symbol('x')]: 1 },
    ];
    for (const value of cases) assert.throws(() => normalizeIntent(value), code('INVALID_REQUEST'), JSON.stringify(value));
  });

  it('rejects non-string or unbounded sizes', () => {
    for (const size of [1, '1e3', '-1', '0', '01', '1.0000000000000000001', '1234567890123456']) {
      assert.throws(() => normalizeIntent({ ...base, base_size: size }), code('INVALID_DECIMAL'), String(size));
    }
  });
});

describe('validateInitialAccount', () => {
  it('returns canonical strings', () => {
    assert.deepEqual(validateInitialAccount('10000.00', 'USD', '10.5000'), { cash: '10000', currency: 'USD', fee_bps: '10.5', maker_fee_bps: '10.5', taker_fee_bps: '10.5' });
    assert.deepEqual(validateInitialAccount('1', 'USDC', '0'), { cash: '1', currency: 'USDC', fee_bps: '0', maker_fee_bps: '0', taker_fee_bps: '0' });
    assert.deepEqual(validateInitialAccount('1', 'USD', '10', '2.5'), { cash: '1', currency: 'USD', fee_bps: '10', maker_fee_bps: '2.5', taker_fee_bps: '10' });
    assert.equal(validateInitialAccount('1', 'USD', '1000').fee_bps, '1000');
  });

  it('rejects invalid cash, currency and fee', () => {
    assert.throws(() => validateInitialAccount('0', 'USD', '10'), code('INVALID_DECIMAL'));
    assert.throws(() => validateInitialAccount(10000, 'USD', '10'), code('INVALID_DECIMAL'));
    assert.throws(() => validateInitialAccount('1', 'usd', '10'), code('INVALID_ARGUMENT'));
    assert.throws(() => validateInitialAccount('1', 'U', '10'), code('INVALID_ARGUMENT'));
    assert.throws(() => validateInitialAccount('1', 'USD', '1000.0001'), code('INVALID_ARGUMENT'));
    assert.throws(() => validateInitialAccount('1', 'USD', '1.00001'), code('INVALID_ARGUMENT'));
    assert.throws(() => validateInitialAccount('1', 'USD', '-1'), code('INVALID_DECIMAL'));
  });
});

describe('checkFresh', () => {
  const now = Date.UTC(2026, 0, 2, 3, 5, 0);

  it('accepts books up to 60s old and 5s ahead, with any zone offset', () => {
    checkFresh('2026-01-02T03:04:00Z', now);
    checkFresh('2026-01-02T03:05:05Z', now);
    checkFresh('2026-01-02T04:04:30+01:00', now);
    checkFresh('2026-01-01T22:04:30.999999999-05:00', now);
  });

  it('rejects stale and future books', () => {
    assert.throws(() => checkFresh('2026-01-02T03:03:59.999Z', now), code('STALE_BOOK'));
    assert.throws(() => checkFresh('2026-01-02T03:05:05.001Z', now), code('FUTURE_BOOK'));
    assert.throws(() => checkFresh('2026-01-02T04:05:06+01:00', now), code('FUTURE_BOOK'));
  });

  it('rejects malformed or zone-less timestamps and invalid now', () => {
    for (const time of ['2026-01-02T03:04:30', '2026-02-30T00:00:00Z', '2026-01-02T24:00:00Z', '2026-01-02T03:60:00Z', '2026-01-02T03:04:60Z', '2026-01-02 03:04:30Z', '2026-01-02T03:04:30+24:00', '1767323070']) {
      assert.throws(() => checkFresh(time, now), code('INVALID_BOOK'), time);
    }
    assert.throws(() => checkFresh(5 as unknown as string, now), code('INVALID_BOOK'));
    assert.throws(() => checkFresh('2026-01-02T03:04:30Z', Number.NaN), code('INVALID_ARGUMENT'));
    assert.throws(() => checkFresh('2026-01-02T03:04:30Z', 1.5), code('INVALID_ARGUMENT'));
  });
});

describe('simulate product validation', () => {
  const buy = intent('BUY', 'base_size', '0.001');
  const run = (meta: unknown) => simulate(account(), null, buy, meta, BTC_BOOK, NOW);

  it('blocks every unavailable flag and non-online status', () => {
    for (const flag of ['is_disabled', 'trading_disabled', 'cancel_only', 'limit_only', 'post_only', 'auction_mode', 'view_only']) {
      assert.throws(() => run({ ...BTC, [flag]: true }), code('PRODUCT_UNAVAILABLE'), flag);
    }
    assert.throws(() => run({ ...BTC, status: 'offline' }), code('PRODUCT_UNAVAILABLE'));
    run({ ...BTC, view_only: false, status: 'ONLINE' });
  });

  it('rejects absent or malformed metadata', () => {
    for (const key of ['is_disabled', 'trading_disabled', 'cancel_only', 'limit_only', 'post_only', 'auction_mode', 'status', 'base_increment', 'quote_increment', 'base_min_size', 'base_max_size', 'quote_min_size', 'quote_max_size']) {
      const meta = { ...BTC };
      delete meta[key];
      assert.throws(() => run(meta), code('INVALID_PRODUCT'), key);
    }
    assert.throws(() => run({ ...BTC, is_disabled: 'false' }), code('INVALID_PRODUCT'));
    assert.throws(() => run({ ...BTC, view_only: null }), code('INVALID_PRODUCT'));
    assert.throws(() => run({ ...BTC, quote_increment: 0.01 }), code('INVALID_PRODUCT'));
    assert.throws(() => run({ ...BTC, base_increment: '0' }), code('INVALID_PRODUCT'));
    assert.throws(() => run({ ...BTC, base_min_size: '20000' }), code('INVALID_PRODUCT'));
    assert.throws(() => run(null), code('INVALID_PRODUCT'));
    assert.throws(() => run({ ...BTC, product_type: 'FUTURE' }), code('UNSUPPORTED_PRODUCT'));
    assert.throws(() => run({ ...BTC, product_type: undefined }), code('UNSUPPORTED_PRODUCT'));
    assert.throws(() => run({ ...BTC, product_id: 'ETH-USD' }), code('PRODUCT_MISMATCH'));
    assert.throws(() => run({ ...BTC, base_currency_id: 'ETH' }), code('PRODUCT_MISMATCH'));
  });

  it('rejects a product quoted in another currency', () => {
    const eur = intent('BUY', 'base_size', '0.001', 'BTC-EUR');
    assert.throws(
      () => simulate(account(), null, eur, product('BTC-EUR'), book('BTC-EUR', [['1', '1']], [['2', '1']]), NOW),
      code('CURRENCY_MISMATCH'),
    );
  });
});

describe('simulate book validation', () => {
  const buy = intent('BUY', 'base_size', '0.001');
  const run = (raw: unknown, now = NOW) => simulate(account(), null, buy, BTC, raw, now);

  it('rejects crossed, locked, unordered, empty and malformed books', () => {
    const cases: unknown[] = [
      book('BTC-USD', [['100', '1']], [['99', '1']]),
      book('BTC-USD', [['100', '1']], [['100', '1']]),
      book('BTC-USD', [['100', '1'], ['101', '1']], [['102', '1']]),
      book('BTC-USD', [['100', '1'], ['100', '1']], [['102', '1']]),
      book('BTC-USD', [['100', '1']], [['103', '1'], ['102', '1']]),
      book('BTC-USD', [], [['102', '1']]),
      book('BTC-USD', [['100', '0']], [['102', '1']]),
      { pricebook: { ...BTC_BOOK.pricebook, bids: [{ price: 100, size: '1' }] } },
      { pricebook: { ...BTC_BOOK.pricebook, bids: [['100', '1']] } },
      { pricebook: { ...BTC_BOOK.pricebook, product_id: undefined } },
      { pricebook: { ...BTC_BOOK.pricebook, time: undefined } },
      { pricebook: { ...BTC_BOOK.pricebook, time: '2026-01-02T03:04:00' } },
      { pricebook: { ...BTC_BOOK.pricebook, asks: Array.from({ length: 1001 }, (_, i) => ({ price: String(90000 + i), size: '1' })) } },
      BTC_BOOK.pricebook,
      null,
    ];
    for (const raw of cases) {
      assert.throws(() => run(raw), (e) => e instanceof PaperError && (e.code === 'INVALID_BOOK' || e.code === 'INVALID_DECIMAL'), JSON.stringify(raw)?.slice(0, 120));
    }
    assert.throws(() => run(book('ETH-USD', [['1', '1']], [['2', '1']])), code('PRODUCT_MISMATCH'));
  });

  it('rejects stale and future books at the explicit now', () => {
    assert.throws(() => run(BTC_BOOK, Date.parse(BOOK_TIME) + 60_001), code('STALE_BOOK'));
    assert.throws(() => run(BTC_BOOK, Date.parse(BOOK_TIME) - 5_001), code('FUTURE_BOOK'));
    assert.equal(run(BTC_BOOK, Date.parse(BOOK_TIME) + 60_000).receipt.status, 'FILLED');
  });
});

describe('simulate order rules', () => {
  it('declines instead of partially filling', () => {
    assert.throws(() => simulate(account('1000000'), null, intent('BUY', 'base_size', '3.016'), BTC, BTC_BOOK, NOW), code('INSUFFICIENT_LIQUIDITY'));
    assert.throws(() => simulate(account('1000000'), null, intent('BUY', 'quote_size', '400000'), BTC, BTC_BOOK, NOW), code('INSUFFICIENT_LIQUIDITY'));
    assert.throws(() => simulate(account('1000000'), position('5', '1'), intent('SELL', 'base_size', '2.6'), BTC, BTC_BOOK, NOW), code('INSUFFICIENT_LIQUIDITY'));
  });

  it('enforces cash, holdings, increments and product limits', () => {
    assert.throws(() => simulate(account('100'), null, intent('BUY', 'base_size', '0.0012'), BTC, BTC_BOOK, NOW), code('INSUFFICIENT_CASH'));
    assert.throws(() => simulate(account('100'), null, intent('BUY', 'quote_size', '100.01'), BTC, BTC_BOOK, NOW), code('INSUFFICIENT_CASH'));
    // Changed terms need a new client_order_id; reusing the pending one would be an idempotency conflict.
    assert.throws(() => simulate(account('100'), null, intent('BUY', 'base_size', '0.0012'), BTC, BTC_BOOK, NOW), (e: PaperError) => /new client_order_id/.test(e.hint ?? '') && /never reseeded/.test(e.hint ?? ''));
    assert.throws(() => simulate(account(), null, intent('BUY', 'base_size', '0.00001'), BTC, BTC_BOOK, NOW), (e: PaperError) => /new client_order_id/.test(e.hint ?? ''));
    assert.throws(() => simulate(account(), null, intent('BUY', 'quote_size', '100.001'), BTC, BTC_BOOK, NOW), code('INVALID_INCREMENT'));
    assert.throws(() => simulate(account(), null, intent('BUY', 'base_size', '0.000000001'), BTC, BTC_BOOK, NOW), code('INVALID_INCREMENT'));
    assert.throws(() => simulate(account(), null, intent('SELL', 'base_size', '0.001'), BTC, BTC_BOOK, NOW), code('INSUFFICIENT_HOLDINGS'));
    assert.throws(() => simulate(account(), position('0.001', '87'), intent('SELL', 'base_size', '0.0011'), BTC, BTC_BOOK, NOW), code('INSUFFICIENT_HOLDINGS'));
    assert.throws(() => simulate(account(), null, intent('BUY', 'base_size', '0.00001'), BTC, BTC_BOOK, NOW), code('BELOW_MINIMUM'));
    assert.throws(() => simulate(account(), null, intent('BUY', 'base_size', '0.001'), { ...BTC, base_min_size: '0.01' }, BTC_BOOK, NOW), code('BELOW_MINIMUM'));
    assert.throws(() => simulate(account(), null, intent('BUY', 'base_size', '0.1'), { ...BTC, base_max_size: '0.01' }, BTC_BOOK, NOW), code('ABOVE_MAXIMUM'));
    assert.throws(() => simulate(account(), null, intent('BUY', 'base_size', '0.1'), { ...BTC, quote_max_size: '1000' }, BTC_BOOK, NOW), code('ABOVE_MAXIMUM'));
    assert.throws(() => simulate(account(), null, intent('BUY', 'quote_size', '0.05'), BTC, BTC_BOOK, NOW), code('BELOW_MINIMUM'));
  });

  it('rejects a quote-size sell even when built by hand', () => {
    const bad = { ...intent('SELL', 'base_size', '0.001'), size_type: 'quote_size' } as Intent;
    assert.throws(() => simulate(account(), position('1', '1'), bad, BTC, BTC_BOOK, NOW), code('INVALID_REQUEST'));
  });

  it('rejects non-normalized intents, mismatched accounts and malformed state', () => {
    const buy = intent('BUY', 'base_size', '0.001');
    assert.throws(() => simulate(account(), null, { ...buy, size: '0.0010' }, BTC, BTC_BOOK, NOW), code('INVALID_REQUEST'));
    assert.throws(() => simulate(account(), null, { ...buy, extra: 1 } as Intent, BTC, BTC_BOOK, NOW), code('INVALID_REQUEST'));
    assert.throws(
      () => simulate(account('10000', { account_id: 'paper-00000000-0000-4000-8000-000000000000' }), null, buy, BTC, BTC_BOOK, NOW),
      code('ACCOUNT_MISMATCH'),
    );
    assert.throws(() => simulate(account('1e4'), null, buy, BTC, BTC_BOOK, NOW), code('STATE_INVALID'));
    assert.throws(() => simulate(account('-1'), null, buy, BTC, BTC_BOOK, NOW), code('STATE_INVALID'));
    assert.throws(() => simulate(account('10000', { fee_bps: '2000' }), null, buy, BTC, BTC_BOOK, NOW), code('STATE_INVALID'));
    assert.throws(() => simulate(account('10000', { cash: 10000 as unknown as string }), null, buy, BTC, BTC_BOOK, NOW), code('STATE_INVALID'));
    assert.throws(() => simulate(account(), position('1', '1', 'ETH-USD'), buy, BTC, BTC_BOOK, NOW), code('STATE_INVALID'));
    assert.throws(() => simulate(account(), position('0', '0'), buy, BTC, BTC_BOOK, NOW), code('STATE_INVALID'));
  });

  it('sells all including sub-increment dust and clears basis exactly', () => {
    const result = simulate(account(), position('0.000000015', '0.01'), intent('SELL', 'base_size', '0.000000015'), { ...BTC, base_min_size: '0', quote_min_size: '0' }, BTC_BOOK, NOW);
    assert.equal(result.position.quantity, '0');
    assert.equal(result.position.cost_basis, '0');
    assert.equal(result.receipt.notional, '0.00');
    assert.equal(result.realized_pnl, '-0.01');
    assert.throws(
      () => simulate(account(), position('0.000000025', '0.01'), intent('SELL', 'base_size', '0.000000015'), { ...BTC, base_min_size: '0', quote_min_size: '0' }, BTC_BOOK, NOW),
      code('INVALID_INCREMENT'),
    );
  });

  it('rounds the exact product once: buy up, sell down, fee up', () => {
    const meta = product('XYZ-USD', ['1', '0.01', '1', '1000', '0', '1000000']);
    const thirds = book('XYZ-USD', [['0.333333333333333333', '10']], [['0.333333333333333334', '10']]);
    const bought = simulate(account(), null, intent('BUY', 'base_size', '3', 'XYZ-USD'), meta, thirds, NOW);
    assert.equal(bought.receipt.notional, '1.01');
    assert.equal(bought.receipt.fee, '0.01');
    assert.equal(bought.receipt.average_price, '0.333333333333333334');
    const sold = simulate(account(), position('3', '1.02', 'XYZ-USD'), intent('SELL', 'base_size', '3', 'XYZ-USD'), meta, thirds, NOW);
    assert.equal(sold.receipt.notional, '0.99');
    assert.equal(sold.receipt.fee, '0.01');
    assert.equal(sold.receipt.total, '0.98');
    assert.equal(sold.realized_pnl, '-0.04');
  });

  it('is deterministic and does not mutate inputs', () => {
    const acct = account();
    const meta = structuredClone(BTC);
    const raw = structuredClone(BTC_BOOK);
    const buy = intent('BUY', 'quote_size', '250');
    const first = simulate(acct, null, buy, meta, raw, NOW);
    assert.deepEqual(simulate(acct, null, buy, meta, raw, NOW), first);
    assert.deepEqual(acct, account());
    assert.deepEqual(meta, BTC);
    assert.deepEqual(raw, BTC_BOOK);
  });
});

// Deterministic PRNG so property failures reproduce.
function rng(seed: number) {
  let state = seed >>> 0;
  return (max: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % max;
  };
}

const big = (text: string) => BigInt(text.replace('.', '')) * 10n ** BigInt(18 - (text.split('.')[1]?.length ?? 0));

describe('simulate invariants', () => {
  it('holds accounting invariants across random books and sizes', () => {
    const next = rng(42);
    let buys = 0;
    let roundTrips = 0;
    for (let trial = 0; trial < 150; trial++) {
      const levels = 1 + next(6);
      const best = 1000 + next(100000);
      const asks: string[][] = [];
      const bids: string[][] = [];
      let ask = best + 1;
      let bid = best;
      for (let i = 0; i < levels; i++) {
        asks.push([`${ask}.${String(next(100)).padStart(2, '0')}`, `0.${String(1 + next(99999999)).padStart(8, '0')}`]);
        bids.push([`${bid}.${String(next(100)).padStart(2, '0')}`, `0.${String(1 + next(99999999)).padStart(8, '0')}`]);
        ask += 1 + next(50);
        bid -= 1 + next(50);
      }
      const raw = book('BTC-USD', bids, asks);
      const fee = String(next(1001));
      const acct = account('1000000', { fee_bps: fee });
      const budget = `${1 + next(500)}.${String(next(100)).padStart(2, '0')}`;
      let result;
      try {
        result = simulate(acct, null, intent('BUY', 'quote_size', budget), { ...BTC, quote_min_size: '0' }, raw, NOW);
      } catch (error) {
        assert.ok(error instanceof PaperError && ['INSUFFICIENT_LIQUIDITY', 'BELOW_MINIMUM'].includes(error.code), String(error));
        continue;
      }
      buys++;
      const r: Receipt = result.receipt;
      const notional = big(r.notional);
      const feeUnits = big(r.fee);
      const exact = r.fills.reduce((sum, fill) => sum + big(fill.price) * big(fill.size), 0n);
      assert.equal(big(r.total), notional + feeUnits);
      assert.ok(big(r.total) <= big(budget), 'quote-size buy stays within budget');
      assert.ok(notional * 10n ** 18n >= exact && (notional - big('0.01')) * 10n ** 18n < exact, 'buy notional rounds up once');
      assert.ok(feeUnits * 10_000n * 10n ** 18n >= notional * big(fee), 'fee rounds up');
      assert.equal(big(result.cash), big('1000000') - big(r.total));
      assert.equal(big(r.position.cost_basis), big(r.total));
      // Maximality: one more base increment would exceed the budget or the book.
      const more = (BigInt(r.base_size.replace('.', '')) + 1n).toString().padStart(9, '0');
      const moreSize = `${more.slice(0, -8)}.${more.slice(-8)}`;
      try {
        const bigger = simulate(acct, null, intent('BUY', 'base_size', moreSize), { ...BTC, quote_min_size: '0' }, raw, NOW);
        assert.ok(big(bigger.receipt.total) > big(budget), 'quote-size buy is maximal');
      } catch (error) {
        assert.ok(error instanceof PaperError && error.code === 'INSUFFICIENT_LIQUIDITY');
      }
      // Partial then full sell conserves basis and cash.
      const held = result.position;
      const quantity = big(held.quantity);
      const part = (quantity / 2n / 10n ** 10n) * 10n ** 10n;
      let state = { acct: { ...acct, cash: result.cash, realized_pnl: result.realized_pnl }, held };
      const sizes = part > 0n ? [part, quantity - part] : [quantity];
      let realizedSum = 0n;
      let proceeds = 0n;
      for (const units of sizes) {
        const text = formatSize(units);
        let sold;
        try {
          sold = simulate(state.acct, state.held, intent('SELL', 'base_size', text), { ...BTC, quote_min_size: '0' }, raw, NOW);
        } catch (error) {
          assert.ok(error instanceof PaperError && error.code === 'INSUFFICIENT_LIQUIDITY');
          break;
        }
        const s = sold.receipt;
        const soldExact = s.fills.reduce((sum, fill) => sum + big(fill.price) * big(fill.size), 0n);
        assert.ok(big(s.notional) * 10n ** 18n <= soldExact && (big(s.notional) + big('0.01')) * 10n ** 18n > soldExact, 'sell notional rounds down once');
        assert.equal(big(s.total), big(s.notional) - big(s.fee));
        assert.ok(big(s.total) >= 0n);
        assert.equal(big(s.cash), big(state.acct.cash) + big(s.total));
        const removed = big(state.held.cost_basis) - big(sold.position.cost_basis);
        assert.ok(removed >= 0n && removed <= big(state.held.cost_basis));
        assert.equal(big(s.realized_pnl as string), big(s.total) - removed);
        realizedSum += big(s.realized_pnl as string);
        proceeds += big(s.total);
        state = { acct: { ...state.acct, cash: sold.cash, realized_pnl: sold.realized_pnl }, held: sold.position };
      }
      if (big(state.held.quantity) === 0n) {
        roundTrips++;
        assert.equal(state.held.cost_basis, '0');
        assert.equal(realizedSum, proceeds - big(r.total), 'round-trip P&L equals proceeds minus cost');
        assert.equal(big(state.acct.realized_pnl), realizedSum);
      }
    }
    assert.ok(buys >= 100 && roundTrips >= 100, `exercised ${buys} buys and ${roundTrips} round trips`);
  });
});

function formatSize(units: bigint): string {
  const digits = units.toString().padStart(19, '0');
  const frac = digits.slice(-18).replace(/0+$/, '');
  return `${digits.slice(0, -18)}${frac ? `.${frac}` : ''}`;
}

describe('markPortfolio', () => {
  const positions = [position('0.5', '40000'), position('2', '6000.01', 'ETH-USD')];
  const eth = book('ETH-USD', [['3100.555', '10']], [['3101', '10']]);

  it('offline reports never invent prices', () => {
    const report = markPortfolio(account('1000'), positions, null, NOW);
    assert.equal(report.priced, false);
    assert.equal(report.equity, null);
    assert.equal(report.unrealized_pnl, null);
    assert.equal(report.total_pnl, null);
    assert.equal(report.cash, '1000.00');
    assert.deepEqual(report.positions.map((row) => [row.product_id, row.mark, row.market_value, row.mark_status, row.mark_time]), [
      ['BTC-USD', null, null, 'MISSING', null],
      ['ETH-USD', null, null, 'MISSING', null],
    ]);
    assert.equal(report.positions[1].average_cost, '3000.005');
    assert.match(report.notice, /unpriced/);
  });

  it('marks fresh books at the best bid, rounded down', () => {
    const report = markPortfolio(account('1000', { realized_pnl: '-4.17' }), positions, { 'BTC-USD': BTC_BOOK, 'ETH-USD': eth }, NOW);
    assert.equal(report.priced, true);
    assert.deepEqual(report.positions.map((row) => [row.mark, row.market_value, row.unrealized_pnl, row.mark_status]), [
      ['86800.01', '43400.00', '3400.00', 'FRESH'],
      ['3100.555', '6201.11', '201.10', 'FRESH'],
    ]);
    assert.equal(report.unrealized_pnl, '3601.10');
    assert.equal(report.total_pnl, '3596.93');
    assert.equal(report.equity, '50601.11');
    assert.equal(report.notice, PAPER_NOTICE);
  });

  it('reports stale, future, invalid and missing marks honestly', () => {
    const stale = book('BTC-USD', [['1', '1']], [['2', '1']], '2026-01-02T03:03:04Z');
    const future = book('ETH-USD', [['1', '1']], [['2', '1']], '2026-01-02T03:04:11Z');
    const report = markPortfolio(account(), positions, { 'BTC-USD': stale, 'ETH-USD': future }, NOW);
    assert.deepEqual(report.positions.map((row) => [row.mark_status, row.mark, row.mark_time]), [
      ['STALE', null, '2026-01-02T03:03:04Z'],
      ['FUTURE', null, '2026-01-02T03:04:11Z'],
    ]);
    assert.equal(report.equity, null);
    const invalid = markPortfolio(account(), positions, { 'BTC-USD': eth, 'ETH-USD': { pricebook: {} } }, NOW);
    assert.deepEqual(invalid.positions.map((row) => row.mark_status), ['INVALID', 'INVALID']);
    const partial = markPortfolio(account(), positions, { 'BTC-USD': BTC_BOOK }, NOW);
    assert.deepEqual(partial.positions.map((row) => row.mark_status), ['FRESH', 'MISSING']);
    assert.equal(partial.priced, false);
    assert.equal(partial.positions[0].market_value, '43400.00');
  });

  it('prices an empty portfolio as cash and rejects malformed state', () => {
    const empty = markPortfolio(account('123.4'), [], null, NOW);
    assert.equal(empty.priced, true);
    assert.equal(empty.equity, '123.40');
    assert.throws(() => markPortfolio(account(), [position('1', '1'), position('2', '2')], null, NOW), code('STATE_INVALID'));
    assert.throws(() => markPortfolio(account(), [position('-1', '1')], null, NOW), code('STATE_INVALID'));
    assert.throws(() => markPortfolio(account(), positions, [] as unknown as Record<string, unknown>, NOW), code('INVALID_ARGUMENT'));
  });
});

// ------------------------------------------------------- external-quote equities

const QUOTE = { reference_price: '212.34', price_source: 'https://www.nasdaq.com/market-activity/stocks/aapl', price_as_of: '2026-01-02T03:00:00Z' };
const QUOTE_MS = Date.parse(QUOTE.price_as_of);

function equityIntent(side: 'BUY' | 'SELL', sizeType: 'base_size' | 'quote_size', size: string, overrides: Record<string, unknown> = {}): Intent {
  return normalizeIntent({ request_id: '11111111-1111-4111-8111-111111111111', account_id: ACCOUNT_ID, product_id: 'AAPL-USD', side, [sizeType]: size, ...QUOTE, ...overrides });
}

function equityPosition(quantity: string, costBasis: string, productId = 'AAPL-USD'): Position {
  return { product_id: productId, quantity, cost_basis: costBasis, base_increment: '0.00001', quote_increment: '0.01', asset_class: 'EQUITY' };
}

const WHOLE: EquityMetadata = { source: 'coinbase-public-listing', base_increment: '1', quote_increment: '0.01', whole_shares: true };

function listing(overrides: Record<string, unknown> = {}, details: Record<string, unknown> = {}, ticker = 'AAPL', quote = 'USD') {
  return {
    product_id: '0069b582c4c3b08f',
    product_type: 'EQUITY',
    base_currency_id: ticker,
    quote_currency_id: quote,
    base_increment: '0.0001',
    quote_increment: '0.01',
    is_disabled: false,
    trading_disabled: false,
    cancel_only: false,
    limit_only: false,
    post_only: false,
    auction_mode: false,
    equity_product_details: { ticker, fractionable: true, trading_halted: false, ...details },
    ...overrides,
  };
}

describe('external quote parsing', () => {
  it('normalizes all three quote fields into the intent and accepts dotted tickers', () => {
    const terms = equityIntent('BUY', 'quote_size', '100.50', { reference_price: '212.340', product_id: 'BRK.B-USD' });
    assert.deepEqual(terms, {
      request_id: '11111111-1111-4111-8111-111111111111', account_id: ACCOUNT_ID, product_id: 'BRK.B-USD', side: 'BUY',
      size_type: 'quote_size', size: '100.5', reference_price: '212.34', price_source: QUOTE.price_source, price_as_of: QUOTE.price_as_of,
    });
    assert.equal(Object.hasOwn(intent('BUY', 'base_size', '1'), 'reference_price'), false, 'crypto intents carry no quote keys');
  });

  it('rejects partial, malformed and non-UTC quotes without consulting the clock', () => {
    for (const missing of ['reference_price', 'price_source', 'price_as_of']) {
      assert.throws(() => equityIntent('BUY', 'base_size', '1', { [missing]: undefined }), code('EXTERNAL_QUOTE_REQUIRED'), missing);
    }
    const bad: Array<Record<string, unknown>> = [
      { reference_price: '0' }, { reference_price: '-1' }, { reference_price: '1e3' }, { reference_price: 212.34 },
      { price_source: 'http://example.com/q' }, { price_source: 'https://' }, { price_source: 'ftp://x/y' },
      { price_source: `https://example.com/${'a'.repeat(281)}` }, { price_source: 'https://user:pw@example.com/q' }, { price_source: 'https://example.com/a b' },
      { price_as_of: '2026-01-02T03:00:00+00:00' }, { price_as_of: '2026-01-02 03:00:00Z' }, { price_as_of: '2026-02-30T03:00:00Z' },
      { price_as_of: '2026-01-02T24:00:00Z' }, { price_as_of: '2026-01-02' }, { price_as_of: 'yesterday' },
      { product_id: 'aapl-USD' }, { product_id: 'AAPL-EUR.X' }, { product_id: '.AAPL-USD' },
    ];
    for (const fields of bad) assert.throws(() => equityIntent('BUY', 'base_size', '1', fields), (e) => e instanceof PaperError, JSON.stringify(fields));
    assert.equal(equityIntent('BUY', 'base_size', '1', { price_source: `https://example.com/${'a'.repeat(280)}` }).price_source?.length, 300);
    // A year-old quote still parses: freshness belongs to fill time, not reservation.
    assert.equal(equityIntent('BUY', 'base_size', '1', { price_as_of: '2025-01-02T03:00:00.5Z' }).price_as_of, '2025-01-02T03:00:00.5Z');
  });

  it('applies the 24 h age and 5 min future bounds inclusively', () => {
    assert.equal(checkExternalFresh(QUOTE.price_as_of, QUOTE_MS + 86_400_000), 86_400);
    assert.throws(() => checkExternalFresh(QUOTE.price_as_of, QUOTE_MS + 86_400_001), code('EXTERNAL_QUOTE_STALE'));
    assert.equal(checkExternalFresh(QUOTE.price_as_of, QUOTE_MS - 300_000), -300);
    assert.throws(() => checkExternalFresh(QUOTE.price_as_of, QUOTE_MS - 300_001), code('EXTERNAL_QUOTE_STALE'));
    const stale = (() => { try { checkExternalFresh(QUOTE.price_as_of, QUOTE_MS + 90_000_000); } catch (e) { return e as PaperError; } })();
    assert.match(stale?.hint ?? '', /new client_order_id/);
    assert.match(stale?.hint ?? '', /never reuse an old quote or estimate a price/i);
  });
});

describe('resolveEquityMetadata', () => {
  it('assumes labeled defaults when no listing is consulted or the ticker is absent', () => {
    assert.deepEqual(resolveEquityMetadata(null, 'AAPL-USD'), ASSUMED_EQUITY_METADATA);
    assert.deepEqual(ASSUMED_EQUITY_METADATA, { source: 'assumed', base_increment: '0.00001', quote_increment: '0.01', whole_shares: false });
    assert.equal(resolveEquityMetadata({ products: [listing({}, {}, 'MSFT'), listing({}, {}, 'AAPL', 'USDC')] }, 'AAPL-USD').source, 'assumed');
  });

  it('uses a matched listing and enforces whole shares, halts and disabled flags', () => {
    assert.deepEqual(resolveEquityMetadata({ products: [listing()] }, 'AAPL-USD'), { source: 'coinbase-public-listing', base_increment: '0.0001', quote_increment: '0.01', whole_shares: false });
    assert.deepEqual(resolveEquityMetadata({ products: [listing({}, { fractionable: false })] }, 'AAPL-USD'), { source: 'coinbase-public-listing', base_increment: '1', quote_increment: '0.01', whole_shares: true });
    assert.throws(() => resolveEquityMetadata({ products: [listing({}, { trading_halted: true })] }, 'AAPL-USD'), code('PRODUCT_UNAVAILABLE'));
    assert.throws(() => resolveEquityMetadata({ products: [listing({ trading_disabled: true })] }, 'AAPL-USD'), code('PRODUCT_UNAVAILABLE'));
  });

  it('fails on a malformed matched entry instead of falling back to assumptions', () => {
    for (const bad of [listing({}, { trading_halted: 'no' }), listing({}, { fractionable: undefined }), listing({ base_increment: '0' }), listing({ product_type: 'SPOT' }), listing({ cancel_only: null })]) {
      assert.throws(() => resolveEquityMetadata({ products: [bad] }, 'AAPL-USD'), code('INVALID_PRODUCT'), JSON.stringify(bad));
    }
    assert.throws(() => resolveEquityMetadata({ products: [listing(), listing()] }, 'AAPL-USD'), code('INVALID_PRODUCT'));
    assert.throws(() => resolveEquityMetadata({}, 'AAPL-USD'), code('INVALID_PRODUCT'));
  });
});

describe('simulateExternal', () => {
  const at = QUOTE_MS + 15 * 60_000;

  it('buys base_size at reference x 1.001 rounded up, with exact fee and receipt provenance', () => {
    const fill = simulateExternal(account(), null, equityIntent('BUY', 'base_size', '2'), ASSUMED_EQUITY_METADATA, at);
    const r = fill.receipt;
    // 212.34 x 1.001 = 212.55234 -> 212.56; 2 x 212.56 = 425.12; fee ceil(0.42512) = 0.43.
    assert.deepEqual([r.average_price, r.notional, r.fee, r.total, r.cash, r.base_size], ['212.56', '425.12', '0.43', '425.55', '9574.45', '2.00000']);
    assert.deepEqual(r.fills, [{ price: '212.56', size: '2' }]);
    assert.equal(r.asset_class, 'EQUITY');
    assert.equal(r.price_verification, 'UNVERIFIED_EXTERNAL_QUOTE');
    assert.equal(r.price_age_seconds, 900);
    assert.equal(r.snapshot_time, QUOTE.price_as_of);
    assert.deepEqual(r.source, { provider: 'external', url: QUOTE.price_source, as_of: QUOTE.price_as_of, reference_price: '212.34', slippage_bps: '10', metadata: 'assumed' });
    assert.equal(r.assumptions.model_version, EXTERNAL_QUOTE_MODEL_VERSION);
    assert.match(r.notice, /UNVERIFIED external quote/);
    assert.match(r.notice, /closed-market quote is the last trade/);
    assert.match(r.notice, /ASSUMED/);
    assert.match(r.notice, /halts, fractionability and real increments were not checked/);
    assert.equal('best_bid' in r.source, false, 'no fabricated Coinbase liquidity');
    assert.deepEqual(fill.position, { product_id: 'AAPL-USD', quantity: '2', cost_basis: '425.55', base_increment: '0.00001', quote_increment: '0.01', asset_class: 'EQUITY' });
  });

  it('sizes a quote_size buy to the largest increment whose cost plus fee fits', () => {
    const r = simulateExternal(account(), null, equityIntent('BUY', 'quote_size', '500'), ASSUMED_EQUITY_METADATA, at).receipt;
    // 2.34992 x 212.56 = 499.4989... -> 499.50 + fee 0.50 = 500.00; one more increment costs 500.01.
    assert.deepEqual([r.base_size, r.notional, r.fee, r.total], ['2.34992', '499.50', '0.50', '500.00']);
    const whole = simulateExternal(account(), null, equityIntent('BUY', 'quote_size', '500'), WHOLE, at).receipt;
    assert.deepEqual([whole.base_size, whole.notional, whole.fee, whole.total], ['2', '425.12', '0.43', '425.55']);
    assert.equal(whole.source.metadata, 'coinbase-public-listing');
    assert.throws(() => simulateExternal(account(), null, equityIntent('BUY', 'base_size', '1.5'), WHOLE, at), code('INVALID_INCREMENT'));
    assert.throws(() => simulateExternal(account(), null, equityIntent('BUY', 'quote_size', '100'), WHOLE, at), code('BELOW_MINIMUM'));
  });

  it('sells at reference x 0.999 rounded down with pro-rata basis and full-exit dust', () => {
    const held = equityPosition('2', '425.55');
    const r = simulateExternal(account('9574.45'), held, equityIntent('SELL', 'base_size', '1'), ASSUMED_EQUITY_METADATA, at).receipt;
    // 212.34 x 0.999 = 212.12766 -> 212.12; fee ceil(0.21212) = 0.22; basis half-even(212.775) = 212.78.
    assert.deepEqual([r.average_price, r.notional, r.fee, r.total, r.realized_pnl, r.cash], ['212.12', '212.12', '0.22', '211.90', '-0.88', '9786.35']);
    const dust = equityPosition('1.000001', '212.77');
    const all = simulateExternal(account(), dust, equityIntent('SELL', 'base_size', '1.000001'), ASSUMED_EQUITY_METADATA, at);
    assert.equal(all.position.quantity, '0');
    assert.equal(all.position.cost_basis, '0');
    assert.throws(() => simulateExternal(account(), dust, equityIntent('SELL', 'base_size', '0.000001'), ASSUMED_EQUITY_METADATA, at), code('INVALID_INCREMENT'));
    assert.throws(() => simulateExternal(account(), held, equityIntent('SELL', 'base_size', '3'), ASSUMED_EQUITY_METADATA, at), code('INSUFFICIENT_HOLDINGS'));
    assert.throws(() => simulateExternal(account(), null, equityIntent('SELL', 'base_size', '1'), ASSUMED_EQUITY_METADATA, at), code('INSUFFICIENT_HOLDINGS'));
    const tiny = equityIntent('SELL', 'base_size', '0.00001', { reference_price: '0.01' });
    assert.throws(() => simulateExternal(account(), equityPosition('1', '1'), tiny, ASSUMED_EQUITY_METADATA, at), code('BELOW_MINIMUM'));
  });

  it('rejects stale quotes, wrong currency, class conflicts and missing quotes', () => {
    assert.throws(() => simulateExternal(account(), null, equityIntent('BUY', 'base_size', '1'), ASSUMED_EQUITY_METADATA, QUOTE_MS + 86_400_001), code('EXTERNAL_QUOTE_STALE'));
    assert.throws(() => simulateExternal(account(), null, equityIntent('BUY', 'base_size', '1', { product_id: 'AAPL-USDC' }), ASSUMED_EQUITY_METADATA, at), code('CURRENCY_MISMATCH'));
    assert.throws(() => simulateExternal(account(), position('1', '1', 'AAPL-USD'), equityIntent('BUY', 'base_size', '1'), ASSUMED_EQUITY_METADATA, at), code('PRODUCT_CLASS_CONFLICT'));
    assert.throws(() => simulateExternal(account(), null, intent('BUY', 'base_size', '1', 'AAPL-USD'), ASSUMED_EQUITY_METADATA, at), code('EXTERNAL_QUOTE_REQUIRED'));
    assert.throws(() => simulateExternal(account('100'), null, equityIntent('BUY', 'base_size', '1'), ASSUMED_EQUITY_METADATA, at), code('INSUFFICIENT_CASH'));
    assert.throws(() => simulateExternal(account(), null, equityIntent('BUY', 'base_size', '1'), { ...ASSUMED_EQUITY_METADATA, source: 'guess' } as unknown as EquityMetadata, at), code('INVALID_ARGUMENT'));
  });

  it('crypto fills reject quote fields and equity positions', () => {
    const quoted = normalizeIntent({ request_id: '11111111-1111-4111-8111-111111111111', account_id: ACCOUNT_ID, product_id: 'BTC-USD', side: 'BUY', base_size: '0.001', ...QUOTE });
    assert.throws(() => simulate(account(), null, quoted, BTC, BTC_BOOK, NOW), code('REFERENCE_PRICE_NOT_ALLOWED'));
    const held = { ...position('1', '1'), asset_class: 'EQUITY' as const };
    assert.throws(() => simulate(account(), held, intent('BUY', 'base_size', '0.001'), BTC, BTC_BOOK, NOW), code('PRODUCT_CLASS_CONFLICT'));
    assert.throws(() => simulate(account(), { ...position('1', '1'), asset_class: 'BOND' } as unknown as Position, intent('BUY', 'base_size', '0.001'), BTC, BTC_BOOK, NOW), code('STATE_INVALID'));
  });
});

describe('markPortfolio with equities', () => {
  const btc = position('0.5', '43000');
  const aapl = equityPosition('2', '425.55');

  it('never prices equities; a refresh reports priced_* subtotals and keeps whole-account totals null', () => {
    const report = markPortfolio(account('1000'), [btc, aapl], { 'BTC-USD': BTC_BOOK }, NOW);
    assert.equal(report.priced, false);
    assert.deepEqual([report.equity, report.unrealized_pnl, report.total_pnl], [null, null, null]);
    assert.equal(report.priced_market_value, '43400.00');
    assert.equal(report.priced_unrealized_pnl, '400.00');
    assert.deepEqual(report.unpriced_positions, [{ product_id: 'AAPL-USD', quantity: '2.00000', unpriced_reason: report.positions[0].unpriced_reason }]);
    assert.match(report.positions[0].unpriced_reason ?? '', /refresh does not price equities/);
    assert.deepEqual([report.positions[0].asset_class, report.positions[0].mark, report.positions[0].market_value], ['EQUITY', null, null]);
    assert.match(report.notice, /refresh does not price equities/);
    const ignored = markPortfolio(account('1000'), [aapl], { 'AAPL-USD': book('AAPL-USD', [['1', '1']], [['2', '1']]) }, NOW);
    assert.equal(ignored.positions[0].mark, null, 'a book for an equity id is never used');
  });

  it('offline balances and crypto-only refreshes are unchanged', () => {
    const offline = markPortfolio(account('1000'), [btc, aapl], null, NOW);
    assert.equal('priced_market_value' in offline, false);
    assert.equal('unpriced_positions' in offline, false);
    const crypto = markPortfolio(account('1000'), [btc], { 'BTC-USD': BTC_BOOK }, NOW);
    assert.equal('priced_market_value' in crypto, false);
    assert.equal(crypto.priced, true);
    assert.equal('asset_class' in crypto.positions[0], false);
  });
});
