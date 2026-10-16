---
name: coinbase-market-data
description: Read Coinbase products, prices, recent trades, order books, best bid/ask, candles, and fees through remote MCP or local CLI. Use for price lookups, charts, spreads, and product discovery. Read-only; data availability varies by asset class.
---

# Coinbase market data

Follow [Coinbase interface selection and safety](../coinbase/SKILL.md), then load only the [MCP reference](references/mcp.md) or [CLI reference](references/cli.md).

1. Identify the requested product, quote currency, metric, and time range. Discover exact product IDs and eligibility; do not substitute a different pair or an expired futures contract.
2. Use the selected interface's supported product/data operation. Filter and paginate deliberately rather than assuming the first page is complete.
3. Preserve units and precision. Report source timestamps, missing/stale values, time zones, and whether a price is a reference, last trade, bid, or ask. None guarantees execution at that price.
4. Equity product lookup does not imply ticker, order-book, bid/ask, candle, or preview support. Check the current surface; do not assume CLI/MCP parity for equity candles. If a usable quote is unavailable, explain the limitation rather than substituting crypto data or automatically purchasing research.

A price lookup authorizes no trade, payment, or monitoring process. For an order, load [trading](../coinbase-trading/SKILL.md) and the applicable asset-class skill. For an explicit monitoring request, load [watch](../coinbase-watch/SKILL.md); remote MCP has no bundled streaming workflow, and CLI monitoring needs a separately agreed plan.
