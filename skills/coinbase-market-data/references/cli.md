# Market data with the local CLI

Apply the [shared workflow](../SKILL.md) and [CLI execution rules](../../coinbase/references/cli.md). Check `coinbase products --help` and the chosen command's help first; command spelling and granularity enums can differ by version.

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
