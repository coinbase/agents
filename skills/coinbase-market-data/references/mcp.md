# Market data with remote MCP

Apply the [shared workflow](../SKILL.md) and [MCP execution rules](../../coinbase/references/mcp.md). Discover schemas and host namespaces first.

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
