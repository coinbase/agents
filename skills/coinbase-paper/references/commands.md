# coinbase-paper command reference

Apply the [paper workflow](../SKILL.md). `coinbase-paper` is this skill's local simulator (`scripts/coinbase-paper`, which runs `scripts/src/cli.ts` with Node's built-in TypeScript type stripping). Accounting and fills are computed locally, against public market data only. It never reads credentials, never calls an authenticated API and has no dependencies. The hosted Coinbase MCP does not expose paper tools.

## Runtime

Paper storage uses Node's built-in `node:sqlite` (no extra packages). It needs Node.js >=22.13 on 22.x, >=23.4 on 23.x, or any 24+; Node 24 LTS is recommended. The launcher passes `--experimental-strip-types` (needed on Node 22, accepted later) and `--no-warnings`. `node:sqlite` is not a stable Node API (experimental or release-candidate depending on version). On an unsupported Node, paper commands that need storage return `UNSUPPORTED_RUNTIME` before creating any state.

## Commands

Trading commands take the same `key=value` fields as their live counterparts. Read filters also accept `key==value`. Array fields accept `order_ids=ID1,ID2` or `order_ids:='["ID1","ID2"]'`. Booleans are exactly `true` or `false`. Timestamps are RFC 3339 with a timezone (`2026-01-22T12:30:00Z`).

| Command | Purpose |
| --- | --- |
| `--help`, `<command> --help` | Plain-text usage. No state, no network. |
| `orders create product_id=P side=BUY\|SELL type=market (quote_size=N \| base_size=N) [time_in_force=IOC\|FOK] [client_order_id=UUID]` | Market order; fills fully against the visible book or fails. A market BUY `quote_size` includes the fee. |
| `orders create ... type=limit (base_size=N \| quote_size=N) limit_price=N [time_in_force=GTC\|GTD\|IOC\|FOK] [end_time=T] [post_only=true\|false]` | Limit order. GTC is the default; GTD needs a future `end_time`; `post_only=true` only with GTC/GTD. `quote_size` is converted at the limit price, rounded down. |
| `orders create ... type=stoplimit side=BUY\|SELL base_size=N stop_price=N stop_direction=STOP_DIRECTION_STOP_UP\|STOP_DIRECTION_STOP_DOWN limit_price=N [time_in_force=GTC\|GTD] [end_time=T]` | Stop-limit. `up`/`down` are accepted and stored as the enum. |
| `orders create ... type=bracket side=SELL base_size=N limit_price=TP stop_price=SL [time_in_force=GTC\|GTD] [end_time=T]` | Spot exit for held coins; `stop_price < limit_price`. |
| `orders create ... side=BUY type=market\|limit ... [attached_take_profit_price=N] [attached_stop_loss_price=N]` | Attached exits on a crypto BUY parent; stop below take-profit when both are given. |
| `orders create product_id=TICKER-USD type=market ... reference_price=N price_source=URL price_as_of=UTC` | Paper-only equity market order priced from an external quote (see below). |
| `orders get ID` | Current state of one order plus `status_history`. |
| `orders list [status=S] [product_ids=A,B] [side=BUY\|SELL] [product_type=SPOT\|EQUITY] [start=T] [end=T] [limit=1-1000] [cursor=C]` | Orders newest first (default 50), as `{"orders": [...], "has_next", "cursor"}`. |
| `orders fills [order_ids=...] [product_ids=...] [side=...] [start=T] [end=T] [limit=N] [cursor=C]` | Fill rows newest first. |
| `orders cancel order_ids=ID[,ID...]` | Cancel up to 100 orders; per-ID `results`. |
| `orders edit ID [base_size=N] [limit_price=N] [attached_take_profit_price=N] [attached_stop_loss_price=N] [cancel_attached_order=true]` | Edit an open limit, stop-limit or bracket order. |
| `orders close-position client_order_id=UUID product_id=P [size=N] [reference_price=N price_source=URL price_as_of=UTC]` | Market SELL of a position; full position when `size` is omitted. Quote fields only for equities. |
| `orders preview` | Recognized, not simulated: `PAPER_UNSUPPORTED_OPERATION`. Nothing is placed. |
| `activity [order_ids=...] [product_ids=...] [start=T] [end=T] [limit=N] [cursor=C]` | Order events oldest first. |
| `balance [--refresh]` | Cash total/available/hold, positions, P&L. `--refresh` fetches a book per open crypto position (max 100); all or error. Equities stay unpriced. |
| `performance [--period 1D\|1W\|1M\|ALL] [--chart]` | Reconstructed equity curve, P&L, time-weighted return, max drawdown. Default `ALL`. |
| `doctor` | Read-only: `runtime`, `account` readiness, `host_durability` (always `UNVERIFIED`). No network, no state created, no migration. |
| `init [--cash 10000] [--currency USD] [--fee-bps N \| --maker-fee-bps N --taker-fee-bps N]` | Create and bind a new account. Refuses existing state; never reseeds. Returns a `disclaimer` and `fee_note`. |
| `bind --state ABS --account-id ID` | Adopt an existing paper database (e.g. a backup) into this data directory after verifying its ID. |
| `backup --output ABS` | Consistent private copy (including pending intents and open orders) to a new path. Never overwrites. |
| `reset --confirm` | Archive the account, then bind a fresh one with the same settings (see Reset). |
| `candles PRODUCT --start UNIX --end UNIX --granularity ENUM` | Public research candles, at most 350 intervals. Needs no account. |

Earlier preview names (`buy`, `sell`, `status`, `history`) fail with a hint naming the new command.

Account and trading commands accept `--data-dir ABS`. Successful output accepts `--format json|table`: JSON is the default everywhere; `table` is a human-readable view labelled PAPER. Errors are always JSON. Flags take `--flag value` or `--flag=value`. Unknown or duplicate fields and flags fail closed, as do `--env`/`-e`, `--paper`, `--live`, `--dry-run`, `--watch`, `--until` and `--paginate`. Granularities: `ONE_MINUTE`, `FIVE_MINUTE`, `FIFTEEN_MINUTE`, `THIRTY_MINUTE`, `ONE_HOUR`, `TWO_HOUR`, `FOUR_HOUR`, `SIX_HOUR`, `ONE_DAY`.

Not simulated (`PAPER_UNSUPPORTED_ORDER_TYPE` or `PAPER_UNSUPPORTED_FIELD`): `twap`, `scaled`, stop-market, trailing stops, `order_class` OCO/OTO, `preview_id`, `portfolio_id`, `reduce_only`, equity session/date fields, futures.

## Lazy reconciliation

No process runs between commands. Every paper command that reads or changes an account (create, edit, cancel, close-position, get, list, fills, activity, balance, performance, backup, reset) first runs exactly one reconciliation pass over the account's open orders, then executes. `help`, `doctor`, `init`, `bind`, `candles` and the lock commands do not. Replaying an accepted create/close with the same `client_order_id` returns the stored original receipt with **zero** market reads.

- Candles: public Coinbase candles since each order was last checked: `ONE_MINUTE` for gaps up to 6 h, `FIVE_MINUTE` to 24 h, `ONE_HOUR` to 30 days, else `ONE_DAY`; paged at 350 candles per request.
- Only **completed** candles are used. A candle is used for an order only if it starts at or after the order's creation, activation, trigger or last edit (the straddling candle is excluded), and, for GTD, ends at or before `end_time`. After a granularity change, a bucket straddling the previous check is excluded.
- Missing candles are a data gap, never zero-volume candles.
- Output includes `reconciliation: {status, attempted_at, reconciled_at, reason, orders_checked, orders_filled, orders_expired, windows}`. `NOT_NEEDED`: no open orders and no requests. `OK`: applied; `windows` lists product, range, granularity, count and provider. `STALE`: a candle request failed, returned invalid data, or would exceed the request budget; **nothing** from that pass was applied (no fills, triggers, expiries), holds are unchanged, `reconciled_at` is the previous successful time, and `reason` explains why.
- While STALE: reads, cancel, backup and reset still work; new create, close-position and real edits fail with `PAPER_RECONCILIATION_STALE` (retry the same command later with the same `client_order_id`).
- Two commands racing on one account cannot double-apply: the loser reports STALE with reason `STATE_CHANGED`.
- `source.requests` counts logical public reads (product, book, candles, cache hits, HTTP attempts) for the command; `source.budget` gives the per-command work bounds (1 product, 100 books, 32 candle pages, 133 total). These are simulator resource bounds, not trading limits.

## Fill model

Deterministic; the same candles always give the same result.

- **Immediate execution** (placement or a real edit): BUY limits take asks at or below the limit, SELL limits bids at or above, walking visible depth in price order without interpolation; TAKER fee. Partial executable quantity rounds down to the base increment. IOC cancels any remainder; FOK either fills completely or ends `CANCELLED` with `terminal_reason: FOK_NOT_FILLED`; GTC/GTD remainder stays `OPEN`. `post_only=true` rejects any crossing price (`PAPER_POST_ONLY_WOULD_CROSS`). Market orders stay all-or-nothing.
- **Resting limit:** BUY fills when a candle's `low < limit_price` (equality is not a fill), at `min(limit_price, open)` rounded up to the quote increment; SELL when `high > limit_price`, at `max(limit_price, open)` rounded down. MAKER fee. Whole remainder or nothing: the candle's base volume must cover it, shared across orders in the same candle by priority (eligible time, then order ID). No partial fills from candles; no queue position; volume is not proof of executable liquidity.
- **Stop-limit:** STOP_UP triggers on `high >= stop_price`, STOP_DOWN on `low <= stop_price`; the trigger is recorded even if nothing fills and never resets. The limit is evaluated from the next candle, except when the trigger candle opens beyond the stop at a marketable price, which fills at the open as TAKER. At placement, a stop already met by the book (best ask for STOP_UP, best bid for STOP_DOWN) triggers immediately and the limit is checked against the book.
- **Bracket and attached exits:** one composite SELL order with a take-profit leg (`limit_price`) and a STOP_DOWN stop leg whose aggressive limit is `floor(stop_price × 0.95)` to the quote increment (`stop_limit_buffer_bps: "500"`, a paper assumption; exposed as `stop_limit_price`). One base hold covers both legs. On the trigger candle: an open at or below the stop fills at the open as TAKER if it is at or above the floor, else the stop limit rests; an open above the stop that trades down to it fills at the stop as TAKER. Later candles use the resting-SELL rule at the floor, MAKER. If one candle crosses both legs the stop wins and an `AMBIGUOUS_OCO` event is recorded. A trigger or fill on one leg cancels the other. Attached exits activate per parent fill, for that fill's size, as their own GTC orders (`attached_order_ids`); they never fill in the candle that filled the parent and survive cancellation or expiry of the parent's unfilled remainder.
- **Expiry:** after all eligible pre-expiry candles, a GTD order becomes `EXPIRED` exactly at `end_time` and releases its remaining hold. FILLED is never overwritten.
- **Accounting per execution batch:** exact `price × size` sum; BUY notional rounds up and SELL down to the quote increment; the fee rounds up. BUY fees add to cost basis; SELL realized P&L = net proceeds − removed basis. Fill rows split the batch notional and fee exactly (rows sum to the batch). Candle fills are timestamped at the candle end and record the candle start and granularity in `source`.

## Holds and balance

- Open BUY remainder holds `ceil(limit × remaining) + ceil(fee at max(maker, taker))`; open SELL, bracket and exit orders hold coins (once per bracket). Pending reservations and terminal orders hold nothing.
- `balance`: `cash` (unchanged scalar), `cash_balance: {total, available, hold}`, `buying_power` (= available cash; no margin), `maker_fee_bps`, `taker_fee_bps`, `fee_bps` (deprecated alias of taker), `realized_pnl`, `fees_paid`, `unrealized_pnl`, `total_pnl`, `equity`, `priced`, `marked_at`, `valuation_status` (`CASH_ONLY`, `UNPRICED`, `PARTIAL`, `MARKED`), `priced_market_value`, `priced_unrealized_pnl`, `unpriced_positions`, and positions with `total`, `available`, `hold`, `average_entry_price` (includes buy fees).
- Totals include held amounts; holds do not reduce equity. Without `--refresh`, nothing is marked: `priced: false`, `marked_at: null`. A cash-only account reports its cash as equity with `valuation_status: CASH_ONLY`. With unpriced positions, aggregate equity and P&L are `null`.
- `INSUFFICIENT_CASH` / `INSUFFICIENT_HOLDINGS` messages and `error.details` give `available`, `required`, `shortfall` and `hold` as decimal strings.

## Performance

`performance --period 1D|1W|1M|ALL` (1D = trailing 24 h, 1W = 7 days, 1M = 30 days; hourly samples for 1D/1W, daily for 1M/ALL). Each sample applies the fills up to that time and marks crypto at the close of the last fully completed candle; there is no interpolation, forward-filling or lookahead. Stock holdings make a sample unpriced. Output: `start`, `end`, `granularity`, `status` (`COMPLETE`/`PARTIAL`), `baseline_equity`, `ending_equity`, `profit_loss`, `profit_loss_pct`, `time_weighted_return_pct`, `max_drawdown_pct`, `realized_pnl`, `fees_paid`, `points[]` and `gaps[]` (`product_id`, range, `code`, `message`). Whole-period ratios are `null` when any required sample is unpriced. `--chart` adds an ASCII chart labelled "PAPER — reconstructed candle-close equity". This is a local reconstruction, not broker-recorded history.

## Reset

`reset --confirm`: checks `--confirm` before touching anything (`PAPER_RESET_CONFIRMATION_REQUIRED` otherwise); reconciles; writes a private archive under `<data-dir>/archives/`; creates a new account (new ID, same initial cash, currency and fees, no history) under `<data-dir>/resets/`; and atomically switches the binding only if the old account did not change meanwhile (`STATE_CHANGED` otherwise). The old database and the archive are kept. After a reset the bound account file lives under `resets/<uuid>/`, not the top-level `account.sqlite3` (that is the old account); use `doctor` to see which file is bound and never bind the old file back by hand. Output: `previous_account_id`, `previous_state` (the old account file, kept but no longer bound), `account_id`, `archive`, `state`, `initial_cash`, `currency`, `maker_fee_bps`, `taker_fee_bps`, `schema_version: 4`. `PAPER_RESET_FAILED` names the failed stage: run `doctor`, keep every file, do not reinitialize.

## Equities (external quotes)

- Classification: the simulator asks the public crypto product endpoint first. A listed product is crypto and any of `reference_price`, `price_source`, `price_as_of` fails with `REFERENCE_PRICE_NOT_ALLOWED`. Only a definitive not-found (HTTP 404 `NOT_FOUND`) leads to the equity path; timeouts, rate limits, server errors and malformed responses fail as for crypto. Dotted tickers (`BRK.B-USD`) cannot be crypto ids and skip the lookup.
- **Market orders only.** Limit, stop-limit, bracket and attached exits on an equity return `PAPER_UNSUPPORTED_ORDER_TYPE`; there is no keyless stock price feed to reconcile resting orders against.
- Equity orders need all three quote fields, else `EXTERNAL_QUOTE_REQUIRED`. `product_id` is `TICKER-USD` or `TICKER-USDC` (ticker `[A-Z][A-Z0-9.]{0,9}`) in the account currency. `reference_price` is a positive decimal; `price_source` an https URL of at most 300 characters (stored as provenance; the simulator never fetches it); `price_as_of` the quote's own ISO-8601 UTC time (`Z`). SELL requires `base_size`.
- Freshness: at fill time the quote must be at most 24 h old and at most 5 min in the future, else `EXTERNAL_QUOTE_STALE`. No market-hours calendar: a closed-market quote is the last trade.
- Fill: BUY at reference × 1.001 rounded up to the quote increment, SELL at reference × 0.999 rounded down; then the same fee, rounding, cash and basis rules as crypto. Instrument details are assumed (base increment 0.00001, quote increment 0.01) because the public listing is not searchable by ticker; halts and fractionability are not checked.
- Receipts add `asset_class: "EQUITY"`, `price_verification: "UNVERIFIED_EXTERNAL_QUOTE"`, `price_age_seconds` (at fill) and `source: {provider: "external", url, as_of, reference_price, slippage_bps, metadata: "assumed"}`. `snapshot_time` is the quote time. There are no Coinbase bid/ask fields.
- The quote is part of the order terms: the same `client_order_id` with any changed quote field is `IDEMPOTENCY_CONFLICT`, and a completed order replays its stored receipt without checking freshness again.
- `balance --refresh` with equities: `priced: false`; `equity`, `unrealized_pnl` and `total_pnl` are `null`; `priced_market_value`, `priced_unrealized_pnl` (crypto only) and `unpriced_positions` are added. Refresh does not price equities. A failed crypto book still fails the whole refresh.
- A held product cannot switch between crypto and equity (`PRODUCT_CLASS_CONFLICT`).

## Fees

`--maker-fee-bps` and `--taker-fee-bps` are assumed rates (default 10 each); `--fee-bps N` sets both and cannot be combined with them. Each is 0–1000 bps with at most four decimals. For the user's real rates, with consent run the read-only, authenticated `coinbase fees` from the [Coinbase CLI](../../coinbase-cli/SKILL.md) and pass `fee_tier.maker_fee_rate × 10000` and `fee_tier.taker_fee_rate × 10000` (0.006 → 60) to `init` for a new account. Paper never reads the API key itself. Accounts created before separate rates use their single rate for both.

## Output

- Success: JSON on stdout with `"mode": "PAPER"`, `"ok": true`, exit `0`. Account commands add `reconciliation` and `source`.
- Error: JSON on stderr, exit `1`:
  ```json
  {"mode": "PAPER", "ok": false, "error": {"code": "...", "message": "...", "hint": "...", "details": {}}}
  ```
  `details` is optional. A batch cancel with some per-ID failures still exits `0`; failures are in `results`.
- Order views include `order_id` and `client_order_id` (both the client order ID), `status` (`PENDING`, `OPEN`, `FILLED`, `CANCELLED`, `EXPIRED`; a partially filled open order stays `OPEN`), `order_configuration`, `attached_order_configuration`, `attached_order_id(s)`, `parent_order_id`, `filled_size`, `remaining_size`, `average_filled_price`, `total_fees`, `number_of_fills`, `completion_percentage`, `hold`, `triggered_at` and `terminal_reason`. When the ID was generated, `client_order_id_generated: true` and a `retry_hint`.
- A create retry returns the original receipt as accepted (historical provenance, no new requests); `orders get` shows the current state.
- Fill rows: `trade_id`, `order_id`, `trade_time`, `price`, `size`, `commission`, `product_id`, `side`, `liquidity_indicator` (`MAKER`/`TAKER`), `notional`, `realized_pnl`, `source`.
- Activity rows: `event_id`, `order_id`, `product_id`, `event_time`, `event_type` (`ACCEPTED`, `OPENED`, `TRIGGERED`, `FILL`, `EDITED`, `CANCELLED`, `EXPIRED`, `ATTACHED_ACTIVATED`, `AMBIGUOUS_OCO`), `status`, `details`.
- `doctor` with a broken configured account or unsupported runtime returns `ok: false` on stderr with exit `1`. `ok: true, ready: false` means nothing is broken but no account is bound yet.
- Amounts are decimal strings; do not convert them to floats.
- Error codes are local to the simulator; they are not Agent API errors. Paper-specific codes include `PAPER_UNSUPPORTED_OPERATION`, `PAPER_UNSUPPORTED_ORDER_TYPE`, `PAPER_UNSUPPORTED_FIELD`, `PAPER_POST_ONLY_WOULD_CROSS`, `PAPER_ORDER_NOT_OPEN`, `PAPER_INVALID_ORDER_EDIT`, `PAPER_NO_POSITION`, `PAPER_RECONCILIATION_STALE`, `PAPER_REQUEST_BUDGET_EXCEEDED`, `PAPER_RESET_CONFIRMATION_REQUIRED`, `PAPER_RESET_FAILED` and `PAPER_INVALID_CURSOR`.

## State

One account per data directory: `--data-dir ABS`, else `COINBASE_PAPER_HOME`, else absolute `$XDG_DATA_HOME/coinbase-paper`, else `~/.local/share/coinbase-paper`. The directory holds `profile.json` (which database and account ID to expect) and the SQLite database, plus `archives/` and `resets/` after a reset. Directories are private (0700) and files 0600. The CLI does not certify that the host keeps this directory across sessions or machines.

Schema: accounts are schema 4 (orders, fills, events and holds). Schema 2 (crypto) and schema 3 (equities) accounts migrate to 4 in one transaction on their next normal account command; history, receipts and balances are preserved, and pending intents never become resting orders. `doctor` and `bind` inspect without migrating. Older CLIs refuse schema 4 files instead of overlooking holds.

Databases from earlier, unreleased paper prototypes are not guaranteed compatible. The simulator refuses state it cannot verify rather than loading, resetting, or migrating it. Keep the old files; do not delete them to make `init` succeed.

## Retries and recovery

- Input and the account binding are validated before any network request. The intent (client order ID, account, product, side, type, prices, normalized size, and any equity quote) is recorded in the database before market data is fetched.
- Retry an uncertain, interrupted, or network-failed order with the **exact same command and `client_order_id`**. An accepted order returns its original receipt without fetching data, even offline. Concurrent runs of the same order are accepted once.
- The same ID with different terms is rejected, whether or not it filled. Two different IDs are two orders.
- An attempt that failed for a temporary reason (market data unavailable, stale book) keeps its terms: retry it later with the same terms and ID only if the user still wants the order. An attempt rejected for a reason no retry can fix (for example `EXTERNAL_QUOTE_REQUIRED`, `EXTERNAL_QUOTE_STALE`, `REFERENCE_PRICE_NOT_ALLOWED`, `PRODUCT_NOT_FOUND`) leaves no order behind; place the corrected order with a new `client_order_id`.
- A cancelled pending reservation stays cancelled: replaying its create returns the cancellation, not a new order.
- `STATE_RECOVERY_PENDING` (from `doctor` or `bind`) means an earlier write was interrupted, not that the account is corrupt. Run `coinbase-paper balance` on the data directory bound to that file; opening the account rolls back the unfinished write. Then rerun the original command. Do not `init` or `reset`, and do not restore or bind a backup as a guess.
- Missing, corrupt, or mismatched state means stop and recover with `bind`. Never `init` or `reset` to work around it, and never fall back to a live command.
- To restore a backup, keep a separate untouched copy of the backup file, then `bind` the file into a **new** data directory and update the host's recorded directory. The bound file becomes the live account: later trades change it. Never keep using two bindings of the same account ID (for example the original directory and a restored one); their histories diverge, and a same-ID retry against each copy could fill twice. An older backup cannot prove that a later fill never happened.
