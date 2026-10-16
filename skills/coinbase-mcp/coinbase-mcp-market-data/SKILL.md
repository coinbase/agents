---
name: coinbase-mcp-market-data
description: Read Coinbase products, prices, recent trades, order books, best bid/ask, candles, and fees through Coinbase MCP. Use for price lookups, charts, spreads, and product discovery. Read-only; data availability varies by asset class.
---

# Coinbase MCP: market data

First follow [Coinbase MCP setup and safety](../coinbase-mcp/SKILL.md). Use only Coinbase MCP for this workflow; do not switch products or credentials to retry an uncertain financial write.

1. Identify the requested product, quote currency, metric, and time range. Discover exact product IDs and eligibility; do not substitute a different pair or an expired futures contract.
2. Use the Coinbase MCP's supported product/data operation. Filter and paginate deliberately rather than assuming the first page is complete.
3. Preserve units and precision. Report source timestamps, missing/stale values, time zones, and whether a price is a reference, last trade, bid, or ask. None guarantees execution at that price.
4. Equity product lookup does not imply ticker, order-book, bid/ask, candle, or preview support. Check the current surface; do not assume CLI/MCP parity for equity candles. If a usable quote is unavailable, explain the limitation rather than substituting crypto data or automatically purchasing research.

A price lookup authorizes no trade, payment, or monitoring process. For an order, load [trading](../coinbase-mcp-trading/SKILL.md) and the applicable asset-class skill. Hosted Coinbase MCP has no streaming workflow. Offer a one-time read or separately authorized server-side order instead; do not invent subscriptions or replace streaming with tight polling.

## MCP execution

Discover schemas and host namespaces first.

| Need | Core tool |
| --- | --- |
| Product discovery | `coinbase_products_list` |
| Product metadata/reference price | `coinbase_products_get` |
| Recent trades/ticker | `coinbase_products_ticker` |
| Order book | `coinbase_products_book` |
| Best bid/ask | `coinbase_products_best_bid_ask` |
| Historical candles | `coinbase_products_candles` |
| Account fee tier | `coinbase_fees` |

Use the current schema for product identifiers, time bounds, granularity enums, and pagination. CLI query syntax and `--jq` are not MCP arguments. Follow response cursors where present and do not invent missing timestamps or values.

In the audited core schema, best-bid/ask accepts `product_ids` as an array, while products-list accepts it as a comma-separated string. `product_type` is `SPOT`, `FUTURE`, or `EQUITY`. Candles accept RFC 3339 `start`/`end` and `granularity` tokens `1m`, `5m`, `15m`, `30m`, `1h`, `2h`, `4h`, `6h`, `1d`; default is `1h`. Inspect the returned `truncated` flag because the handler can shorten the requested window.

Products-list `symbol` filtering ignores pagination and may be limited. Do not assume a provided cursor guarantees forward progress or full catalog coverage; detect repeats/non-progress and report partial data instead of looping.

For equities, start with product list/get reference prices. Do not repeatedly call rejected quote endpoints. Equity candles may have an MCP path without guaranteed data availability or CLI parity. Report unsupported data and stop; paid research is a separate authorized workflow.
