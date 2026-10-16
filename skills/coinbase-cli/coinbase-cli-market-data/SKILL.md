---
name: coinbase-cli-market-data
description: Read Coinbase products, prices, recent trades, order books, best bid/ask, candles, and fees through Coinbase CLI. Use for price lookups, charts, spreads, and product discovery. Read-only; data availability varies by asset class.
---

# Coinbase CLI: market data

First follow [Coinbase CLI setup and safety](../coinbase-cli/SKILL.md). Use only Coinbase CLI for this workflow; do not switch products or credentials to retry an uncertain financial write.

1. Identify the requested product, quote currency, metric, and time range. Discover exact product IDs and eligibility; do not substitute a different pair or an expired futures contract.
2. Use the Coinbase CLI's supported product/data operation. Filter and paginate deliberately rather than assuming the first page is complete.
3. Preserve units and precision. Report source timestamps, missing/stale values, time zones, and whether a price is a reference, last trade, bid, or ask. None guarantees execution at that price.
4. Equity product lookup does not imply ticker, order-book, bid/ask, candle, or preview support. Check the current surface; do not assume CLI/MCP parity for equity candles. If a usable quote is unavailable, explain the limitation rather than substituting crypto data or automatically purchasing research.

A price lookup authorizes no trade, payment, or monitoring process. For an order, load [trading](../coinbase-cli-trading/SKILL.md) and the applicable asset-class skill. For an explicit monitoring request, load [watch](../coinbase-cli-watch/SKILL.md); monitoring needs a separately agreed plan.

## CLI execution

Check `coinbase products --help` and the chosen command's help first; command spelling and granularity enums can differ by version.

Read-only examples, after confirming the requested product:

```sh
coinbase products list
coinbase products get BTC-USD
coinbase products ticker BTC-USD
coinbase products book BTC-USD
coinbase products candles BTC-USD
coinbase fees
```

Use discovered filters/time bounds and supported `--paginate` for complete results; `--jq` can reduce output but must not hide errors. Discover the installed best-bid/ask command rather than assuming an underscore or hyphen spelling.

The audited CLI names the command `coinbase products best-bid-ask product_ids==BTC-USD`. `product_ids` here is an array-valued query filter; comma-separated values are coerced to an array. On products-list it is instead a comma-separated string. Use `product_type==SPOT`, `product_type==EQUITY`, or `product_type==FUTURE` when filtering product classes.

Candles accept RFC 3339 `start`/`end` and granularity tokens `1m`, `5m`, `15m`, `30m`, `1h`, `2h`, `4h`, `6h`, `1d` (default `1h`), not upstream enum names such as `ONE_HOUR`. Inspect `truncated` if returned and disclose a shortened range. `symbol` filtering bypasses normal pagination; `limit` can truncate the filtered set. Do not claim a complete catalog from that response or loop on a repeated cursor.

Use the intended credential environment consistently. No `--watch` or `--until` flag is needed for a one-time price lookup. Equity candles/quotes may be unsupported even when product lookup succeeds; do not assume support from the remote MCP tool list.
