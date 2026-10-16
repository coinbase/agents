---
name: coinbase-equities
description: Plan and manage eligible Coinbase stock or ETF orders through remote MCP or local CLI. Use for equity product selection, regular/extended sessions, whole-share constraints, trade dates, halts, and unavailable previews. These are real orders.
---

# Coinbase equities

Follow [Coinbase interface selection](../coinbase/SKILL.md) and the [shared trading workflow](../coinbase-trading/SKILL.md). Load only the [MCP reference](references/mcp.md) or [CLI reference](references/cli.md). Equity support is account-, product-, and interface-dependent.

## Plan the equity-specific terms

- Discover the exact `TICKER-QUOTE` listing, such as AAPL-USD or AAPL-USDC. A bare ticker is not sufficient. Respect the user's funding currency and portfolio; do not silently substitute another listing.
- Product list/get may return a reference price, not an executable or fresh quote. Do not infer ticker, book, bid/ask, candle, or preview availability from successful product lookup.
- Confirm the session explicitly. `NORMAL` is regular-market trading and the only session supporting market orders. `PRE_MARKET`, `AFTER_HOURS`, `OVERNIGHT`, and `MULTI_SESSION` require eligible whole-share limit orders, not fractional `base_size`, `quote_size`, or market orders.
- Check the actual trading calendar, session, product restrictions, and account eligibility. Do not assume weekdays, fixed UTC windows, or that a halted/closed-market order queues for the next open.
- `equity_order_date` is the trade date in `YYYY-MM-DD`, not expiry or an instruction to schedule an agent. Extended-session planning includes the intended session, trade date, whole-share size, limit, `time_in_force=GTD`, and timezone-qualified RFC 3339 `end_time`; verify the selected schema accepts the plan.

## Preview and execute safely

Equity previews can be unavailable. Report the missing estimate; do not repeatedly retry or call create as a test. If the user requires a preview, stop. An explicitly approved order without a preview still needs all session, sizing, portfolio, and risk checks. Do not assume preview validated fields it did not accept.

Retain `client_order_id` before submission, obtain approval for the full plan, and inspect actual order state/fills afterward. Ask before changing timing, session, size, or type after rejection. Inspect each edit/cancel result; create support does not prove edit/cancel eligibility. Unknown outcomes follow the shared trading recovery rules, without switching interfaces.
