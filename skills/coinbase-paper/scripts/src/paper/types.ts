// Local simulation contracts. These are not remote trading API operations.
export const PAPER_MODE = 'PAPER' as const;
export const PAPER_NOTICE = 'PAPER simulation: virtual funds and snapshot fills, not live orders. No queue, latency or market-impact model; not predictive of live results.';
export const PAPER_MODEL_VERSION = 'snapshot-market-v1';
/** Fill model for equity orders priced from a caller-supplied external quote. */
export const EXTERNAL_QUOTE_MODEL_VERSION = 'external-quote-v1';
export const EXTERNAL_QUOTE_NOTICE = 'PAPER simulation priced from an UNVERIFIED external quote supplied with the order, not Coinbase market data. The price, source and time were not checked; a closed-market quote is the last trade, not a live price. Less reliable than crypto paper fills; not predictive of live results.';

export class PaperError extends Error {
  readonly code: string;
  readonly hint: string;
  /** Structured decimal-string figures (amounts, order state) for agents; never credentials. */
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, hint = 'Run coinbase-paper --help. Do not fall back to a live trading command.', details?: Record<string, unknown>) {
    super(message);
    this.name = 'PaperError';
    this.code = code;
    this.hint = hint;
    if (details !== undefined) this.details = details;
  }
}

export interface InitialAccount {
  cash: string;
  currency: string;
  fee_bps: string;
  maker_fee_bps: string;
  taker_fee_bps: string;
}

export interface Account {
  account_id: string;
  currency: string;
  initial_cash: string;
  cash: string;
  realized_pnl: string;
  /** Deprecated alias of taker_fee_bps. */
  fee_bps: string;
  quote_increment: string | null;
  created_at: string;
  /** Optional only for legacy fixtures passed to pure functions; ledger accounts always set them. */
  maker_fee_bps?: string;
  taker_fee_bps?: string;
  revision?: number;
  last_reconciled_at?: string | null;
}

export interface Position {
  product_id: string;
  quantity: string;
  cost_basis: string;
  base_increment: string;
  quote_increment: string;
  /** Absent for crypto (and every legacy position). */
  asset_class?: 'EQUITY';
}

/** Caller-supplied equity quote; part of the order terms. */
export interface ExternalQuote {
  reference_price: string;
  price_source: string;
  price_as_of: string;
}

export interface TradeInput {
  request_id: string;
  account_id: string;
  product_id: string;
  side: 'BUY' | 'SELL';
  base_size?: string;
  quote_size?: string;
  reference_price?: string;
  price_source?: string;
  price_as_of?: string;
}

export interface Intent {
  request_id: string;
  account_id: string;
  product_id: string;
  side: 'BUY' | 'SELL';
  size_type: 'base_size' | 'quote_size';
  size: string;
  /** All three are present for an external-quote order, otherwise all absent. */
  reference_price?: string;
  price_source?: string;
  price_as_of?: string;
}

/** Instrument details for an external-quote equity order. */
export interface EquityMetadata {
  source: 'coinbase-public-listing' | 'assumed';
  base_increment: string;
  quote_increment: string;
  whole_shares: boolean;
}

export interface Receipt {
  mode: 'PAPER';
  ok: true;
  status: 'FILLED';
  request_id: string;
  account_id: string;
  product_id: string;
  side: 'BUY' | 'SELL';
  order_type: 'MARKET';
  requested: { base_size?: string; quote_size?: string };
  base_size: string;
  notional: string;
  fee: string;
  total: string;
  average_price: string;
  realized_pnl: string | null;
  cash: string;
  position: { quantity: string; cost_basis: string };
  currency: string;
  snapshot_time: string;
  filled_at: string;
  fills: Array<{ price: string; size: string }>;
  source: Record<string, unknown>;
  assumptions: Record<string, unknown>;
  notice: string;
  /** Present only on external-quote equity receipts. */
  asset_class?: 'EQUITY';
  price_verification?: 'UNVERIFIED_EXTERNAL_QUOTE';
  price_age_seconds?: number;
}

export interface FillResult {
  receipt: Receipt;
  cash: string;
  realized_pnl: string;
  position: Position;
}

export interface PaperPaths {
  dataDir: string;
  profile: string;
  state: string;
}

export interface AccountSnapshot {
  account: Account;
  positions: Position[];
}

export interface MarketData {
  product(productId: string): Promise<unknown>;
  book(productId: string): Promise<unknown>;
  candles(productId: string, start: string, end: string, granularity: string): Promise<unknown>;
}

export interface PaperOptions {
  marketData?: MarketData;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  home?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

// ------------------------------------------------------------ order model (schema 4)

/** Model version of schema-4 accounts and of receipts produced by the order model. */
export const ORDER_MODEL_VERSION = 'paper-orders-v2';

export type OrderType = 'market' | 'limit' | 'stoplimit' | 'bracket';
export type StoredOrderType = 'MARKET' | 'LIMIT' | 'STOPLIMIT' | 'BRACKET';
export type OrderStatus = 'PENDING' | 'OPEN' | 'FILLED' | 'CANCELLED' | 'EXPIRED';
export type TimeInForce = 'GTC' | 'GTD' | 'IOC' | 'FOK';
export type LiquidityIndicator = 'MAKER' | 'TAKER';
export type StopDirection = 'STOP_DIRECTION_STOP_UP' | 'STOP_DIRECTION_STOP_DOWN';
export type ProductType = 'SPOT' | 'EQUITY';

export interface OrderInput extends TradeInput {
  type: OrderType;
  limit_price?: string;
  stop_price?: string;
  stop_direction?: string;
  time_in_force?: TimeInForce;
  end_time?: string;
  post_only?: boolean;
  attached_take_profit_price?: string;
  attached_stop_loss_price?: string;
}

export interface ClosePositionInput {
  request_id: string;
  account_id: string;
  product_id: string;
  size?: string;
  reference_price?: string;
  price_source?: string;
  price_as_of?: string;
}

export interface EditOrderInput {
  base_size?: string;
  limit_price?: string;
  attached_take_profit_price?: string;
  attached_stop_loss_price?: string;
  cancel_attached_order?: boolean;
}

/** Validated, canonical, immutable create/close terms. Never holds a book-derived quantity. */
export interface OrderIntent {
  operation: 'create' | 'close-position';
  request_id: string;
  account_id: string;
  product_id: string;
  side: 'BUY' | 'SELL';
  type: OrderType;
  /** null only for a close-position that omitted size (the full position). */
  size_type: 'base_size' | 'quote_size' | null;
  size: string | null;
  limit_price?: string;
  stop_price?: string;
  stop_direction?: StopDirection;
  time_in_force?: TimeInForce;
  end_time?: string;
  post_only?: boolean;
  attached_take_profit_price?: string;
  attached_stop_loss_price?: string;
  reference_price?: string;
  price_source?: string;
  price_as_of?: string;
}

/** Admitted product rules saved with an order; reconciliation never refetches metadata. */
export interface ProductRules {
  product_type: ProductType;
  base_currency_id: string;
  quote_currency_id: string;
  base_increment: string;
  quote_increment: string;
  /** null for equities, whose listing bounds are not modelled. */
  base_min_size: string | null;
  base_max_size: string | null;
  quote_min_size: string | null;
  quote_max_size: string | null;
}

export interface OrderState {
  order_id: string;
  order_seq: number;
  product_id: string;
  side: 'BUY' | 'SELL';
  order_type: StoredOrderType;
  status: OrderStatus;
  product_type: ProductType;
  created_at: string;
  updated_at: string;
  priority_at: string;
  time_in_force: TimeInForce | null;
  end_time: string | null;
  base_size: string | null;
  filled_size: string;
  remaining_size: string;
  limit_price: string | null;
  stop_price: string | null;
  stop_direction: StopDirection | null;
  post_only: boolean;
  triggered_at: string | null;
  evaluate_after: string;
  cash_hold: string;
  base_hold: string;
  parent_order_id: string | null;
  attached_take_profit_price: string | null;
  attached_stop_loss_price: string | null;
  take_profit_status: 'OPEN' | 'CANCELLED' | 'FILLED' | null;
  stop_loss_status: 'OPEN' | 'TRIGGERED' | 'CANCELLED' | 'FILLED' | null;
  stop_limit_price: string | null;
  product_rules: ProductRules | null;
  terminal_reason: string | null;
  current_receipt: OrderReceipt | null;
}

export interface PaperFill {
  fill_seq: number;
  trade_id: string;
  order_id: string;
  batch_id: string;
  batch_index: number;
  product_id: string;
  product_type: ProductType;
  side: 'BUY' | 'SELL';
  trade_time: string;
  price: string;
  size: string;
  notional: string;
  commission: string;
  liquidity_indicator: LiquidityIndicator;
  cost_basis_removed: string;
  realized_pnl: string | null;
  source: Record<string, unknown>;
}

export type OrderEventType =
  | 'ACCEPTED' | 'OPENED' | 'TRIGGERED' | 'FILL' | 'EDITED'
  | 'CANCELLED' | 'EXPIRED' | 'ATTACHED_ACTIVATED' | 'AMBIGUOUS_OCO';

export interface OrderEvent {
  event_seq: number;
  event_id: string;
  order_id: string;
  product_id: string;
  event_time: string;
  event_type: OrderEventType;
  status: OrderStatus;
  details: Record<string, unknown>;
}

export interface HoldSummary {
  cash: string;
  positions: Record<string, string>;
}

export interface LedgerAccount extends Account {
  maker_fee_bps: string;
  taker_fee_bps: string;
  revision: number;
  last_reconciled_at: string | null;
}

export interface LedgerSnapshot {
  account: LedgerAccount;
  positions: Position[];
  orders: OrderState[];
  fills: PaperFill[];
  events: OrderEvent[];
  holds: HoldSummary;
}

export interface OrderFillRow {
  price: string;
  size: string;
  trade_id: string;
  trade_time: string;
  commission: string;
  notional: string;
  liquidity_indicator: LiquidityIndicator;
}

/**
 * Create receipt and current order view. Keeps every legacy market receipt field
 * and meaning (base_size/notional/fee/total are cumulative executed amounts) and adds
 * order state.
 */
export interface OrderReceipt {
  mode: 'PAPER';
  ok: true;
  request_id: string;
  order_id: string;
  client_order_id: string;
  account_id: string;
  product_id: string;
  side: 'BUY' | 'SELL';
  order_type: StoredOrderType;
  status: OrderStatus;
  requested: { base_size?: string; quote_size?: string; size?: string };
  base_size: string;
  notional: string;
  fee: string;
  total: string;
  average_price: string | null;
  realized_pnl: string | null;
  cash: string;
  position: { quantity: string; cost_basis: string };
  currency: string;
  snapshot_time: string | null;
  filled_at: string | null;
  fills: Array<{ price: string; size: string } & Partial<OrderFillRow>>;
  source: Record<string, unknown>;
  assumptions: Record<string, unknown>;
  notice: string;
  created_time: string;
  updated_time: string;
  time_in_force: TimeInForce | null;
  end_time: string | null;
  order_configuration: {
    type: OrderType;
    base_size: string | null;
    limit_price: string | null;
    stop_price: string | null;
    stop_direction: StopDirection | null;
    time_in_force: TimeInForce | null;
    end_time: string | null;
    post_only: boolean;
    stop_limit_price: string | null;
  };
  attached_order_configuration: { attached_take_profit_price: string | null; attached_stop_loss_price: string | null } | null;
  attached_order_id: string | null;
  attached_order_ids: string[];
  parent_order_id: string | null;
  filled_size: string;
  remaining_size: string;
  average_filled_price: string | null;
  total_fees: string;
  number_of_fills: number;
  last_fill_time: string | null;
  completion_percentage: string;
  hold: { currency: string; cash: string; base: string };
  triggered_at: string | null;
  terminal_reason: string | null;
  asset_class?: 'EQUITY';
  price_verification?: 'UNVERIFIED_EXTERNAL_QUOTE';
  price_age_seconds?: number;
  /** close-position receipts only. */
  success?: true;
  /** edit results only. */
  edited?: boolean;
  /** Provenance of the command that produced a stored receipt (supplied by the caller). */
  reconciliation?: ReconciliationReport;
}

export interface OrderView extends OrderReceipt {
  status_history: OrderEvent[];
}

export interface CancelResult {
  order_id: string;
  success: boolean;
  status?: OrderStatus;
  error?: { code: string; message: string; hint: string; details?: Record<string, unknown> };
}

/** Rows a planner asks the store to write; the store assigns fill/event sequences. */
export interface LedgerMutation {
  account: { cash: string; realized_pnl: string; quote_increment: string | null; last_reconciled_at?: string };
  positions: Array<Position | { product_id: string; deleted: true }>;
  orders: OrderState[];
  fills: Array<Omit<PaperFill, 'fill_seq'>>;
  events: Array<Omit<OrderEvent, 'event_seq'>>;
  /** New or completed rows of the immutable orders table (terms + first receipt). */
  acceptances: Array<{ request_id: string; terms: string; receipt: string }>;
}

export interface OrderMutation extends LedgerMutation {
  receipt: OrderReceipt;
}

export interface CancelMutation extends LedgerMutation {
  results: CancelResult[];
}

export interface ReconcileMutation extends LedgerMutation {
  orders_checked: number;
  orders_filled: number;
  orders_expired: number;
  reconciled_at: string;
}

export type PlacementMarket =
  | { kind: 'crypto'; product: unknown; book: unknown }
  | { kind: 'equity'; metadata: EquityMetadata };

export interface Page<T> {
  items: T[];
  has_next: boolean;
  cursor: string | null;
}

export interface OrderFilter {
  status?: OrderStatus;
  product_ids?: string[];
  side?: 'BUY' | 'SELL';
  product_type?: ProductType | 'FUTURE';
  start?: string;
  end?: string;
  limit?: number;
  cursor?: string;
}

export interface FillFilter {
  order_ids?: string[];
  product_ids?: string[];
  side?: 'BUY' | 'SELL';
  start?: string;
  end?: string;
  limit?: number;
  cursor?: string;
}

export interface ActivityFilter {
  order_ids?: string[];
  product_ids?: string[];
  start?: string;
  end?: string;
  limit?: number;
  cursor?: string;
}

// ------------------------------------------------------------ market data session

export type CandleGranularity = 'ONE_MINUTE' | 'FIVE_MINUTE' | 'ONE_HOUR' | 'ONE_DAY';

export interface Candle {
  start: string;
  low: string;
  high: string;
  open: string;
  close: string;
  volume: string;
}

export interface CandleWindowRequest {
  product_id: string;
  /** Aligned UNIX seconds, inclusive. */
  start: number;
  /** Aligned UNIX seconds, exclusive. */
  end: number;
  granularity: CandleGranularity;
}

export interface CandleWindow {
  request: CandleWindowRequest;
  candles: Candle[];
  provider: string;
  fetched_at: string;
}

export interface RequestStats {
  product: number;
  book: number;
  candles: number;
  total: number;
  cache_hits: number;
  http_attempts: number | null;
}

export interface CommandMarketData extends MarketData {
  provider: string;
  candleWindow(request: CandleWindowRequest): Promise<CandleWindow>;
  stats(): RequestStats;
}

// ------------------------------------------------------------ reconciliation

export interface ReconcileReason {
  code: string;
  message: string;
  hint: string;
}

export interface CandleWindowSource {
  product_id: string;
  start: string;
  end: string;
  granularity: CandleGranularity;
  count: number;
  provider: string;
  completed_only: true;
  used: boolean;
}

export interface ReconciliationReport {
  status: 'OK' | 'STALE' | 'NOT_NEEDED';
  attempted_at: string;
  reconciled_at: string | null;
  reason: ReconcileReason | null;
  orders_checked: number;
  orders_filled: number;
  orders_expired: number;
  windows: CandleWindowSource[];
}

/** Optional provenance persisted inside a first create/close receipt so replays return it unchanged. */
export interface PlacementProvenance {
  reconciliation: ReconciliationReport;
  requests: RequestStats;
  /** Market-data provider of the placing command; named in the receipt source unless it already has one. */
  provider?: string;
}
