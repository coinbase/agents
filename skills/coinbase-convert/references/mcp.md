# Conversions with remote MCP

Apply the [shared workflow](../SKILL.md) and [MCP execution rules](../../coinbase/references/mcp.md).

| Step | Core tool | Required arguments | Result shape |
| --- | --- | --- | --- |
| Quote | `coinbase_convert_quote` | `from`, `to`, source-denominated `amount` | `trade.id`, rate/fee/amount fields under `trade` |
| Execute approved terms | `coinbase_convert_execute` | `quote_id` from `trade.id`, original `from`, original `to` | `trade.id`, `trade.status` |
| Inspect state | `coinbase_convert_get` | `quote_id`, original `from`, original `to` | Flat `id` / `status` and currency/rate fields |

Discover each tool's schema independently. The audited core conversion tools expose no `portfolio_id` and no quote-expiry timestamp; do not invent them or promise arbitrary portfolio targeting or a guaranteed expiry. Confirm scope; if it cannot satisfy the user's request, stop.

Do not pass CLI positional/query syntax or assume quoting implies execution. Inspect JSON-RPC/tool errors and actual state. On a client adapter that requires a quote confirmation card and signed token, only its supported confirmation flow may execute; do not call the core-style execute pattern against that adapter.
