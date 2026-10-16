---
name: coinbase-cli-equities
description: Plan and manage eligible Coinbase stock or ETF orders through Coinbase CLI. Use for equity product selection, regular/extended sessions, whole-share constraints, trade dates, halts, and unavailable previews. These are real orders.
---

# Coinbase CLI: equities

First follow [Coinbase CLI setup and safety](../coinbase-cli/SKILL.md). Use only Coinbase CLI for this workflow; do not switch products or credentials to retry an uncertain financial write. Follow the [Coinbase CLI trading workflow](../coinbase-cli-trading/SKILL.md) before planning these orders.

## Plan the equity-specific terms

- Discover the exact `TICKER-QUOTE` listing, such as AAPL-USD or AAPL-USDC. A bare ticker is not sufficient. Respect the user's funding currency and portfolio; do not silently substitute another listing.
- Product list/get may return a reference price, not an executable or fresh quote. Do not infer ticker, book, bid/ask, candle, or preview availability from successful product lookup.
- Confirm the session explicitly. `NORMAL` is regular-market trading and the only session supporting market orders. `PRE_MARKET`, `AFTER_HOURS`, `OVERNIGHT`, and `MULTI_SESSION` require eligible whole-share limit orders, not fractional `base_size`, `quote_size`, or market orders.
- Check the actual trading calendar, session, product restrictions, and account eligibility. Do not assume weekdays, fixed UTC windows, or that a halted/closed-market order queues for the next open.
- `equity_order_date` is the trade date in `YYYY-MM-DD`, not expiry or an instruction to schedule an agent. Extended-session planning includes the intended session, trade date, whole-share size, limit, `time_in_force=GTD`, and timezone-qualified RFC 3339 `end_time`; verify the selected schema accepts the plan.

## Preview and execute safely

Equity previews can be unavailable. Report the missing estimate; do not repeatedly retry or call create as a test. If the user requires a preview, stop. An explicitly approved order without a preview still needs all session, sizing, portfolio, and risk checks. Do not assume preview validated fields it did not accept.

Retain `client_order_id` before submission, obtain approval for the full plan, and inspect actual order state/fills afterward. Ask before changing timing, session, size, or type after rejection. Inspect each edit/cancel result; create support does not prove edit/cancel eligibility. Unknown outcomes follow the shared trading recovery rules, without switching interfaces.

## CLI execution

Inspect current help/templates and product metadata:

```sh
coinbase products list --help
coinbase orders create --template
coinbase orders preview --template
```

Discover listings with the supported EQUITY filter, then read `coinbase products get <TICKER-QUOTE>` and the intended portfolio. Build the approved request using the current template, including the retained `client_order_id`, intended portfolio where supported, exact product, and equity session/date fields.

For extended sessions, validate whole-share `base_size`, limit price, GTD/expiry, and trade date against the installed version/backend. Current source create and preview expose `time_in_force` / `end_time`, while older installed templates can differ. If a required field is unavailable, stop rather than omit it. Apply `COINBASE_NO_HISTORY=1` and inspect all actual fields locally; `--dry-run` neither validates them nor displays a raw-file body, and does not establish an open session or exchange preview support.

Do not inherit the old assumption that preview failure means "go straight to create." Follow the shared approval rules, then inspect `coinbase orders get <order_id>` and fills after submission. Keep the same environment throughout recovery.
