---
name: coinbase-paper
description: Simulates Coinbase crypto spot trading with virtual cash in a local paper account using `coinbase-paper` — market, limit, stop-limit and bracket orders, attached take-profit/stop-loss exits, cancels, edits, fills, performance and reset — plus stock market orders priced from a quote you supply. Uses the same order fields as live Coinbase CLI trading. Use for paper trading, practice or demo trades, trading without real money, trying a strategy idea going forward, or checking simulated orders, positions and P&L. Needs no login, API key, or credentials. Never places real orders, reads balances, or spends funds.
requires: a bash-capable terminal with Node.js >=22.13 (22.x), >=23.4 (23.x), or 24+; durable local storage; public HTTPS access to Coinbase market data
---

# Coinbase paper trading

Every result is **PAPER**: virtual cash, simulated fills, no real order. `coinbase-paper` never reads credentials or balances and never calls an authenticated API. It has no live mode, and nothing falls back to real funds. Paper trading is a preview feature: fills are simulated locally and real orders can execute differently.

This skill ships its own simulator: `scripts/coinbase-paper` in this skill directory (a launcher for `node --experimental-strip-types --no-warnings scripts/src/cli.ts`). It has no dependencies and needs no install or build. Below, `coinbase-paper` means that launcher's absolute path, for example `"$HOME/.claude/skills/coinbase-paper/scripts/coinbase-paper"`. Use the path where the host installed this skill; if the launcher is not executable, run the `node` command directly.

Paper commands use the same fields as live [Coinbase CLI](../coinbase-cli/SKILL.md) orders:

| Live (real funds) | Paper (virtual funds) |
| --- | --- |
| `coinbase orders create product_id=BTC-USD side=BUY type=market quote_size=100` | `coinbase-paper orders create product_id=BTC-USD side=BUY type=market quote_size=100 client_order_id=<UUID>` |
| `coinbase orders create ... type=limit limit_price=49000` | `coinbase-paper orders create ... type=limit limit_price=49000 client_order_id=<UUID>` |
| `coinbase orders cancel` / `edit` / `close-position` / `fills` | `coinbase-paper orders cancel` / `edit` / `close-position` / `fills` |
| `coinbase orders list` / `orders get ID` | `coinbase-paper orders list` / `orders get ID` |
| `coinbase balance` | `coinbase-paper balance [--refresh]` |

It runs locally in a terminal. The hosted [Coinbase MCP](../coinbase-mcp/SKILL.md) has no paper tools, and paper never needs the Coinbase CLI or MCP to be installed or authenticated.

## Check capabilities first

- Terminal execution of `node`, on a Node.js with the built-in `node:sqlite` module: >=22.13 on 22.x, >=23.4 on 23.x, or any 24+ (Node 24 LTS recommended). `node:sqlite` is not a stable Node API; Node labels it experimental or release-candidate depending on the version.
- Durable local files for the paper data directory that survive terminal exits and new conversations. A successful write does not prove the host keeps the directory.
- Public HTTPS to Coinbase market data for trades, reconciling open orders, `balance --refresh`, `performance`, and `candles`.

If a requirement is missing or unknown, stop and explain what is needed. Never keep a ledger in the conversation, promise memory-based persistence, or switch to real money.

## Stay in the user's chosen mode

Users usually practice for a while, then move to real trading. Don't make them repeat "paper" on every request.

- **Paper is established** once the user asks for practice/paper/demo/simulated trading, or the host recorded that preference. Follow-ups like "buy more", "sell half" or "how am I doing" stay paper without asking again. Label every result as paper.
- **Live is established** the same way for real-money requests, which use a separate Coinbase product (see the [router](../coinbase/SKILL.md)); this simulator never trades real funds.
- **Switching needs the user's explicit words** ("do this for real", "back to practice"). Before the first real-money order after paper, confirm once in plain words that real funds will be used. Never switch because a command failed.
- **No established mode and a buy/sell request:** ask once ("Real order or practice?"). Do not infer paper from an existing paper account or live from configured credentials. Read-only questions (prices, candles) need no mode.
- "Can I paper trade?" is a capability question: run `coinbase-paper doctor` and explain. Do not create an account or trade.

**No live guard.** This simulator cannot block real-money tools. If the agent can also reach a live Coinbase product, keep that product's approvals on and never use it for a paper request.

## Set up

1. `coinbase-paper doctor` — read-only, no network. It reports `runtime`, `account` (bound and readable; `ready: true`) and `host_durability` (always `UNVERIFIED`).
2. If the account is missing, unbound, or mismatched and the user expects an existing one, stop and recover with `bind`. Never `init` or `reset` to work around it. `STATE_RECOVERY_PENDING` means an interrupted write: run `coinbase-paper balance` to roll it back, then retry; do not init or restore a backup.
3. **Fees.** The defaults (10 bps maker, 10 bps taker) are assumptions, not the user's Coinbase fee tier, and may be lower than what they pay. If the user has the Coinbase CLI configured and agrees, run its read-only `coinbase fees` and pass `--maker-fee-bps` / `--taker-fee-bps` as `fee_tier.maker_fee_rate × 10000` / `fee_tier.taker_fee_rate × 10000` (0.006 → 60). `--fee-bps N` sets both. Otherwise keep the defaults and call them assumptions. Paper itself never reads credentials.
4. Only for an explicitly new account: `coinbase-paper init [--cash 10000] [--maker-fee-bps N --taker-fee-bps N | --fee-bps N]`. `init` refuses existing state. The default is 10,000 in the account currency.
5. Report PAPER, account ID, cash/currency, the fee assumptions, data directory, the `disclaimer`, and that host durability is unverified.

Data directory: `--data-dir ABS`, else `COINBASE_PAPER_HOME`, else `$XDG_DATA_HOME/coinbase-paper`, else `~/.local/share/coinbase-paper`. One account per directory; there is no account switcher. Shell variables may not persist between tool calls; pass `--data-dir` when the host recorded a non-default directory.

## Paper trade

1. Use the user's product, side, type, size and prices; ask for missing terms. Never pick a limit, stop or expiry yourself.
2. Generate one new UUID per new order (`node -e "console.log(crypto.randomUUID())"`) and pass it as `client_order_id`. Never reuse an example UUID.
3. Use the type the user asked for (crypto spot):
   ```sh
   coinbase-paper orders create product_id=BTC-USD side=BUY type=market quote_size=100 client_order_id=<UUID>
   coinbase-paper orders create product_id=BTC-USD side=BUY type=limit base_size=0.01 limit_price=49000 time_in_force=GTC client_order_id=<UUID>
   coinbase-paper orders create product_id=BTC-USD side=BUY type=limit base_size=0.01 limit_price=49000 post_only=true client_order_id=<UUID>
   coinbase-paper orders create product_id=BTC-USD side=BUY type=limit base_size=2 limit_price=50005 time_in_force=IOC client_order_id=<UUID>
   coinbase-paper orders create product_id=BTC-USD side=SELL type=stoplimit base_size=0.02 stop_price=48000 stop_direction=STOP_DIRECTION_STOP_DOWN limit_price=47900 client_order_id=<UUID>
   coinbase-paper orders create product_id=BTC-USD side=SELL type=bracket base_size=0.01 limit_price=52000 stop_price=48000 client_order_id=<UUID>
   coinbase-paper orders create product_id=BTC-USD side=BUY type=market base_size=0.01 attached_take_profit_price=52000 attached_stop_loss_price=48000 client_order_id=<UUID>
   ```
   - `type=market`: BUY takes `base_size` or `quote_size` (paper treats a market BUY `quote_size` as the total spend **including** the fee); SELL takes `base_size` (or `quote_size`, converted at the best bid). Fills fully against the visible book or is rejected.
   - `type=limit`: `limit_price`; `time_in_force` GTC (default), GTD with a future `end_time` (RFC 3339 with a timezone, e.g. `2026-01-22T12:30:00Z`), IOC or FOK. `post_only=true` (GTC/GTD only) is rejected with `PAPER_POST_ONLY_WOULD_CROSS` if it would take liquidity. A limit `quote_size` is a notional target converted at the limit price, not a fee-inclusive budget.
   - `type=stoplimit`: `base_size`, `stop_price`, `stop_direction` (`STOP_DIRECTION_STOP_UP` triggers on a rise to the stop, `STOP_DIRECTION_STOP_DOWN` on a fall; `up`/`down` also work), `limit_price`; GTC or GTD.
   - `type=bracket`: spot SELL exit for coins already held: take-profit `limit_price` above `stop_price`.
   - Attached exits on a market or limit BUY: `attached_take_profit_price` and/or `attached_stop_loss_price` (stop below take-profit). Each parent fill activates its own exit order for the bought quantity; the two legs are one-cancels-other.
4. Report the result from the output, never from the request: `status`, `filled_size`, `remaining_size`, `average_filled_price`, `total_fees`, `hold`, and any `attached_order_ids`.
   - `FILLED` or a partial: report the executed size and price from `fills` (a resting BUY can fill below its limit).
   - `OPEN`: say it is **resting, not filled**, how much cash or coin is on hold, and that it will be checked the next time a paper command runs (see below).
   - IOC/FOK: report what filled and that the rest was cancelled (`terminal_reason`, e.g. `FOK_NOT_FILLED`).

**Retries.** If a result is uncertain or failed before acceptance, rerun the exact same command with the same `client_order_id` and data directory. An accepted order returns its **original** receipt with no new market reads, even if the order has filled or been cancelled since: use `coinbase-paper orders get <client_order_id>` for its current state. The same ID with different terms is rejected. Never mint a new ID to retry (the only exceptions are the equity quote errors below, which need corrected terms). If `client_order_id` is omitted the simulator generates one (like live orders), but then a lost result cannot be retried safely; check `orders get`/`orders list` first.
Generate the UUID once and retain its literal value. Do not embed a UUID generator inside a command or loop that may be retried: executing that generator again creates a different order.

## Resting orders: how they fill, and what to tell the user

There is no exchange, daemon or background process. **A resting paper order is only evaluated when a later `coinbase-paper` command for that account runs** (create, cancel, edit, close-position, get, list, fills, activity, balance, performance, backup or reset). That command first reconciles every open order against completed public Coinbase candles since the last check, then answers. Nothing happens between commands.

Honesty rules:

- **Never** say a paper order fills "in real time", "automatically", "as soon as the price hits", or that you are monitoring it. Say it will be checked against public candles the next time a paper command runs, and offer to check later.
- To answer "did it fill?", run a paper read (`orders get ID`, `orders list status=OPEN`, `orders fills`, or `balance`) and report what it returns. Never infer a fill from a price you saw, and never report one the output does not show.
- Report the reconciliation the output gives: `reconciliation.status` is `OK` (orders checked; `windows` lists the candle data used), `NOT_NEEDED` (no open orders), or `STALE`.
- `STALE` means candle data was unavailable or incomplete, so open orders could **not** be brought up to date: no fills, triggers or expiries were applied and holds stay in place. Tell the user the status is not current; do not say the order filled or did not fill. Reads and cancels still work. New orders, edits and close-position fail with `PAPER_RECONCILIATION_STALE`: retry the same command with the same `client_order_id` later. If `reconciliation.reason.code` is `PAPER_REQUEST_BUDGET_EXCEEDED` (open orders need more candle data than one command may fetch), retrying will not clear it: tell the user, show the open orders, and cancel specific orders only if the user names them.
- Candle fills are timestamped at the end of the candle that triggered them: the true intrabar time is unknown.

Fill model (deterministic and conservative; spell out what matters to the user):

- **Placement.** A limit that crosses the book fills immediately as taker by walking visible depth up to the limit; GTC/GTD remainder rests as maker. IOC cancels the rest; FOK fills completely or not at all.
- **Resting limits.** A BUY fills on the first later completed candle whose **low trades below** the limit (touching the limit is not enough: queue position is not modelled), at the lower of the limit and the candle open; SELL is symmetric (high above the limit, at the higher of the limit and open). Maker fee. The whole remainder fills or nothing: the candle's volume must cover it (volume is a simulation assumption, not proof of executable liquidity). The candle in which the order was placed or edited is never used.
- **Stop-limit.** Triggers on the first candle that reaches the stop in `stop_direction`; the limit is then evaluated from the **next** candle, except that a candle opening beyond the stop and at a marketable price fills at that open as taker. A triggered order may never fill.
- **Brackets and attached exits.** The stop leg becomes an aggressive SELL limit at 95% of the stop price (a paper assumption, reported as `stop_limit_buffer_bps`); a gap below that floor does not fill, so losses are not capped. If one candle crosses both legs, the stop is assumed to fill first and an `AMBIGUOUS_OCO` event is recorded. When one leg fills or the stop triggers, the other leg is cancelled.
- **GTD** orders expire at `end_time` and release their hold; nothing fills after expiry.
- **Fees** round up to the quote increment; buy notional rounds up and sell notional rounds down. Candle fills use the maker rate; immediate book fills use taker.

Holds: an open BUY holds `limit × remaining size` plus the fee at the higher of the two rates; an open SELL, bracket or exit holds the coins. `balance` shows `cash_balance` `total` / `available` / `hold` (`buying_power` = available cash; there is no margin) and per-position `available` / `hold`. New orders can only use available amounts. On `INSUFFICIENT_CASH` / `INSUFFICIENT_HOLDINGS`, report the available, required and shortfall figures from `error.details`; do not shrink the order, cancel another order, or reseed unless the user explicitly chooses that.

## Manage orders

- `coinbase-paper orders cancel order_ids=ID1,ID2` (up to 100) — per-order `results`; cancelling releases the remainder's hold. Already-filled orders cannot be undone (`PAPER_ORDER_NOT_OPEN`).
- `coinbase-paper orders edit ID [limit_price=N] [base_size=N] [attached_take_profit_price=N] [attached_stop_loss_price=N] [cancel_attached_order=true]` — open limit, stop-limit or bracket orders only. `base_size` is the new **total** size. Supplying one attached price replaces both legs; send both to keep both. An edit restarts candle eligibility from the edit time. Activated exits are managed by their own order IDs.
- `coinbase-paper orders close-position client_order_id=<UUID> product_id=BTC-USD [size=N]` — a market SELL of the position (all of it when `size` is omitted). It refuses if part of the position is held by open exits; cancel those first only if the user asks.
- `coinbase-paper orders list [status=OPEN|FILLED|CANCELLED|EXPIRED|PENDING] [product_ids=...] [side=...] [start=... end=...] [limit=N] [cursor=...]`; `orders get ID` adds `status_history`.
- `coinbase-paper orders fills [order_ids=...] [product_ids=...]` — one row per fill with `price`, `size`, `commission` and `liquidity_indicator` (MAKER/TAKER).
- `coinbase-paper activity` — fills, triggers, edits, cancels, expiries and attached-exit activations in time order. There are no deposits, transfers or dividends.
- `coinbase-paper orders preview` is not simulated (`PAPER_UNSUPPORTED_OPERATION`); never place an order as a "preview".

## Paper equities (stocks and ETFs)

Coinbase's public API publishes no stock prices, so a paper equity order carries a quote **you** found. Results are less reliable than crypto paper fills. **Paper equities are market orders only**: limit, stop-limit, bracket and attached exits on stocks return `PAPER_UNSUPPORTED_ORDER_TYPE`. Tell the user; do not substitute a market order without asking, and never use crypto candles for a stock.

1. Get a **current** quote from a reputable source: an exchange, a broker, or a major finance site. You need the price, the page URL (https) and the **quote's own timestamp** (not when you read the page). A quote the user pasted with its source and time also works.
2. **Show the user the price, source and time before trading**, and say it is an unverified external quote. Closed-market quotes are the last trade, not a live price; say so outside market hours.
3. Never invent, estimate, round, or remember a price. If you cannot find a current quote with a source and time, **do not trade**; tell the user and ask for one.
4. Place it with the same fields plus the quote (convert the time to UTC):
   ```sh
   coinbase-paper orders create product_id=AAPL-USD side=BUY type=market base_size=3 client_order_id=<UUID> \
     reference_price=212.34 price_source=https://www.nasdaq.com/market-activity/stocks/aapl price_as_of=2026-01-15T15:30:00Z
   ```
   Use the ticker plus the account currency (`AAPL-USD`; dots allowed, `BRK.B-USD`). A ticker that is also a Coinbase crypto product always routes to the crypto asset and cannot be paper-traded as a stock. The quote must be at most 24 h old and at most 5 min in the future.
5. Report the fill with `price_verification: UNVERIFIED_EXTERNAL_QUOTE`, the source URL and time, and the modeled fill price: reference ± 10 bps assumed slippage, plus the assumed fee.

Instrument details are **assumed** (fractional to 0.00001 share, 0.01 price increment): Coinbase's public listing is not searchable by ticker, so trading halts, market hours, whole-share-only stocks and real increments are not checked. Tell the user when it matters.

- `EXTERNAL_QUOTE_REQUIRED`: the product is not a Coinbase crypto product and no quote was passed. Find one (steps 1–3), then place it with a new `client_order_id`; otherwise stop.
- `EXTERNAL_QUOTE_STALE`: the quote is too old or future-dated. Nothing was placed and no order is kept. Show the user a fresh quote and place a **new** order with a new `client_order_id`.
- `REFERENCE_PRICE_NOT_ALLOWED`: crypto never uses an external price; drop the quote fields and use a new `client_order_id`. If the user meant a stock whose ticker matches a Coinbase crypto product (for example `COMP-USD`), that stock cannot be paper-traded; tell the user instead of trading the crypto asset.
- Quote fields are only for stocks and ETFs. Never use them for a crypto asset, even one Coinbase does not list.
- `balance --refresh` never prices equities: `equity` and P&L totals stay `null`, `priced_*` subtotals cover crypto only, and `unpriced_positions` lists the stocks. To value a stock, give the user a current sourced quote yourself; never use cost basis or the last fill price as a current value.

The mode rules above apply unchanged to equities.

**Rejections.** Explain the error code and hint. Do not shrink the size, switch product, type or currency, drop `post_only`, invent data, or move to live trading. `PAPER_UNSUPPORTED_FIELD` / `PAPER_UNSUPPORTED_ORDER_TYPE` mean the live feature is not simulated (for example `twap`, `scaled`, trailing stops, `portfolio_id`, `preview_id`, or any non-market stock order).

## Review

- `coinbase-paper balance` — cash `total`/`available`/`hold`, positions with holds, realized P&L and `fees_paid`. It fetches no prices: positions are unpriced (`priced: false`, `marked_at: null`; a cash-only account reports `valuation_status: CASH_ONLY`). It may still fetch public candles to reconcile open orders.
- `coinbase-paper balance --refresh` — marks every open crypto position (max 100) at the best bid from a fresh public book, or fails as a whole. Equity positions stay unpriced (see Paper equities).
- `coinbase-paper performance [--period 1D|1W|1M|ALL] [--chart]` — equity curve **reconstructed** from local fills and public candle closes: profit/loss, time-weighted return and max drawdown, with `gaps` and `status: PARTIAL` when data is missing or a stock is held. Present it as a paper reconstruction, not broker-recorded history; when it is partial, say which numbers are unknown instead of estimating them.
- `coinbase-paper backup --output ABS` — consistent private copy to a new file. To restore, keep a separate untouched copy, then `bind` the file into a new data directory; the bound file becomes the live account. Never use the original and the restored binding side by side.
- `coinbase-paper candles PRODUCT --start UNIX --end UNIX --granularity ENUM` — public research data. Reconciliation fetches its own candles; this command never fills orders.

## Reset

`coinbase-paper reset --confirm` archives the current account (a backup under the data directory), then binds a **new** empty account with the same starting cash, currency and fees.

- Reset only when the user explicitly asks to start over in this conversation ("reset it", "yes, wipe it and start fresh"). Musing about starting over is not consent: ask, and wait.
- Never reset to get around insufficient cash, a rejected order, a stale reconciliation, or a broken binding, and never without `--confirm` typed for that request. Without `--confirm` it refuses and changes nothing (`PAPER_RESET_CONFIRMATION_REQUIRED`).
- Report the previous and new account IDs and the `archive` path; the old account is kept, not deleted. On `PAPER_RESET_FAILED`, run `doctor` and keep every file.

## Model and limits

- Crypto: market, limit (GTC/GTD/IOC/FOK, post-only), stop-limit, spot SELL bracket and attached exits on BUYs, as described above. Equities: market orders with a supplied quote only. One quote currency per account.
- Market fills walk the fetched order-book snapshot and fill fully or are rejected; stale or future-dated snapshots are rejected. Resting orders use completed public candles at 1-minute to 1-day granularity depending on how long ago they were last checked.
- Weighted-average cost basis; buy fees add to cost, sell fees reduce proceeds.
- Not simulated: stop-market and trailing stops, TWAP/scaled, previews, streaming or `--watch`, futures, margin, leverage, shorting, dividends and deposits, scheduling, and backtests. No random partial fills, queue position, latency, market impact, or adverse selection. Results are not predictive. State is local and user-editable.

[Command reference](references/commands.md) covers fields, output, state, and recovery.

## Safety boundary

Never call live order, preview, convert, transfer, or x402 commands or tools for a paper request. These instructions are not an enforcement boundary for an agent that also has live permissions: allow-list only this skill's `coinbase-paper` launcher where possible and keep financial-action approvals on.
