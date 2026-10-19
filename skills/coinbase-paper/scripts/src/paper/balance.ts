// Paper balance view: cash and positions with holds, buying power, fees paid and
// honest valuation status. Pure: no fetching and no storage writes.
import { formatAmount, parseStoredDecimal } from './decimal.ts';
import { markPortfolio, type MarkedPosition } from './engine.ts';
import { PAPER_NOTICE, PaperError, type Account, type Position } from './types.ts';

/**
 * The ledger fields this module reads. Structurally a subset of the store's
 * LedgerSnapshot, so a full snapshot can be passed directly.
 */
export interface LedgerFillView {
  fill_seq: number;
  order_id: string;
  product_id: string;
  product_type: string;
  side: 'BUY' | 'SELL';
  trade_time: string;
  price: string;
  size: string;
  notional: string;
  commission: string;
  cost_basis_removed: string;
  realized_pnl: string | null;
}

export interface LedgerView {
  account: Account & {
    maker_fee_bps: string;
    taker_fee_bps: string;
    revision: number;
    last_reconciled_at: string | null;
  };
  positions: Position[];
  fills: readonly LedgerFillView[];
  holds: { cash: string; positions: Record<string, string> };
}

export type ValuationStatus = 'CASH_ONLY' | 'UNPRICED' | 'PARTIAL' | 'MARKED';

export interface BalancePosition extends MarkedPosition {
  total: string;
  available: string;
  hold: string;
  average_entry_price: string;
}

export interface UnpricedPosition {
  product_id: string;
  quantity: string;
  unpriced_reason: string;
}

export interface BalanceResult {
  mode: 'PAPER';
  ok: true;
  account_id: string;
  currency: string;
  initial_cash: string;
  cash: string;
  cash_balance: { total: string; available: string; hold: string };
  buying_power: string;
  maker_fee_bps: string;
  taker_fee_bps: string;
  fee_bps: string;
  realized_pnl: string;
  fees_paid: string;
  unrealized_pnl: string | null;
  total_pnl: string | null;
  equity: string | null;
  priced: boolean;
  marked_at: string | null;
  valuation_status: ValuationStatus;
  priced_market_value: string | null;
  priced_unrealized_pnl: string | null;
  unpriced_positions: UnpricedPosition[];
  positions: BalancePosition[];
  notice: string;
}

const NOT_REFRESHED = 'not marked: balance marks crypto positions only with --refresh (fresh public order books)';

function stateError(message: string): PaperError {
  return new PaperError('STATE_INVALID', `paper state ${message}`, 'Stop and run coinbase-paper doctor; do not reinitialize or edit the account.');
}

function units(value: string, field: string, allowNegative = false): bigint {
  return parseStoredDecimal(value, field, { allowNegative });
}

/** Sum of every ledger fill commission, counted once. */
export function sumCommissions(fills: readonly LedgerFillView[]): bigint {
  if (!Array.isArray(fills)) throw stateError('fills are not a list');
  let total = 0n;
  for (const fill of fills) total += units(fill.commission, 'fill commission');
  return total;
}

/**
 * Builds the balance view. `books` maps product_id to a raw public order book
 * (pass null when the caller did not refresh); no mark is ever invented.
 */
export function buildBalance(ledger: LedgerView, books: Readonly<Record<string, unknown>> | null, now: number): BalanceResult {
  const { account } = ledger;
  const mark = markPortfolio(account, ledger.positions, books, now);
  const money = account.quote_increment === null ? null : units(account.quote_increment, 'quote_increment');
  const fmt = (value: bigint) => formatAmount(value, money);

  const cash = units(account.cash, 'cash');
  const cashHold = units(ledger.holds?.cash, 'cash hold');
  if (cashHold > cash) throw stateError('cash hold exceeds cash');
  const holdMap = ledger.holds.positions;
  if (holdMap === null || typeof holdMap !== 'object' || Array.isArray(holdMap)) throw stateError('position holds are not a map');
  const held = new Map<string, bigint>();
  for (const [productId, value] of Object.entries(holdMap)) held.set(productId, units(value, 'position hold'));
  const byId = new Map(ledger.positions.map((position) => [position.product_id, position]));
  for (const [productId, value] of held) {
    if (value !== 0n && !byId.has(productId)) throw stateError(`holds ${productId} without a position`);
  }

  let pricedValue = 0n;
  let pricedUnrealized = 0n;
  let marked = 0;
  const unpriced: UnpricedPosition[] = [];
  const positions = mark.positions.map((row): BalancePosition => {
    const position = byId.get(row.product_id) as Position;
    const quantity = units(position.quantity, 'position quantity');
    const hold = held.get(row.product_id) ?? 0n;
    if (hold > quantity) throw stateError(`hold exceeds the ${row.product_id} position`);
    const baseInc = units(position.base_increment, 'position base_increment');
    if (row.mark_status === 'FRESH' && row.market_value !== null && row.unrealized_pnl !== null) {
      marked += 1;
      pricedValue += units(row.market_value, 'market value');
      pricedUnrealized += units(row.unrealized_pnl, 'unrealized pnl', true);
    } else {
      const reason = row.unpriced_reason ?? (books === null ? NOT_REFRESHED : `not marked: order book was ${row.mark_status}`);
      unpriced.push({ product_id: row.product_id, quantity: row.quantity, unpriced_reason: reason });
    }
    return {
      ...row,
      total: row.quantity,
      available: formatAmount(quantity - hold, baseInc),
      hold: formatAmount(hold, baseInc),
      average_entry_price: row.average_cost,
    };
  });

  const realized = units(account.realized_pnl, 'realized_pnl', true);
  const count = positions.length;
  const status: ValuationStatus = count === 0 ? 'CASH_ONLY' : marked === count ? 'MARKED' : marked === 0 ? 'UNPRICED' : 'PARTIAL';
  const whole = status === 'CASH_ONLY' || status === 'MARKED';
  // A refresh reports what it could mark (0 when only equities are held); without one nothing was marked.
  const subtotals = status !== 'UNPRICED' || books !== null;
  const notice = {
    CASH_ONLY: `${PAPER_NOTICE} Cash-only account: equity is known cash; no market mark was taken.`,
    MARKED: PAPER_NOTICE,
    UNPRICED: `${PAPER_NOTICE} Positions are unpriced, so equity and P&L are null. ${books === null ? 'Run with --refresh to mark crypto from fresh order books; ' : ''}equities are priced only at order time, from a supplied quote.`,
    PARTIAL: `${PAPER_NOTICE} Some positions are unpriced, so whole-account equity and P&L are null; priced_* subtotals cover marked positions only.`,
  }[status];
  return {
    mode: 'PAPER',
    ok: true,
    account_id: mark.account_id,
    currency: mark.currency,
    initial_cash: mark.initial_cash,
    cash: mark.cash,
    cash_balance: { total: mark.cash, available: fmt(cash - cashHold), hold: fmt(cashHold) },
    buying_power: fmt(cash - cashHold),
    maker_fee_bps: account.maker_fee_bps,
    taker_fee_bps: account.taker_fee_bps,
    fee_bps: mark.fee_bps,
    realized_pnl: mark.realized_pnl,
    fees_paid: fmt(sumCommissions(ledger.fills)),
    unrealized_pnl: whole ? fmt(pricedUnrealized) : null,
    total_pnl: whole ? fmt(realized + pricedUnrealized) : null,
    equity: whole ? fmt(cash + pricedValue) : null,
    priced: status === 'MARKED',
    marked_at: marked > 0 ? new Date(now).toISOString() : null,
    valuation_status: status,
    priced_market_value: subtotals ? fmt(pricedValue) : null,
    priced_unrealized_pnl: subtotals ? fmt(pricedUnrealized) : null,
    unpriced_positions: unpriced,
    positions,
    notice,
  };
}
