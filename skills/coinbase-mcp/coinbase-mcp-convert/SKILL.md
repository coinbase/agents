---
name: coinbase-mcp-convert
description: Quote, approve, execute, and verify supported Coinbase currency conversions through Coinbase MCP, such as USD and USDC. Use for fiat/stablecoin conversion requests, not crypto buy/sell orders.
---

# Coinbase MCP: conversions

First follow [Coinbase MCP setup and safety](../coinbase-mcp/SKILL.md). Use only Coinbase MCP for this workflow; do not switch products or credentials to retry an uncertain financial write.

1. Confirm the source and destination currencies, source-denominated amount, and intended portfolio/account scope. Discover support rather than assuming every currency pair can be converted. Buying BTC with USDC is a [trade](../coinbase-mcp-trading/SKILL.md), not this flow.
2. Request a quote on the Coinbase MCP. Present the returned rate, fees, and amounts. Disclose that no expiry timestamp is available when absent; never invent a TTL or a guaranteed execution window. Retain the returned quote ID and original source/destination currencies.
3. Obtain approval for the quoted terms before execution. Quoting is not conversion approval.
4. Execute using the returned quote ID and fields required by the current schema. If the quote expired or terms changed, obtain a fresh quote and renewed approval instead of silently accepting a new rate.
5. Inspect the result and conversion status. After an uncertain execution, check the existing quote/trade state; do not request and execute a new quote as a retry. If unresolved, stop and explain the uncertainty. Never switch interfaces to retry.

## MCP execution

| Step | Core tool | Required arguments | Result shape |
| --- | --- | --- | --- |
| Quote | `coinbase_convert_quote` | `from`, `to`, source-denominated `amount` | `trade.id`, rate/fee/amount fields under `trade` |
| Execute approved terms | `coinbase_convert_execute` | `quote_id` from `trade.id`, original `from`, original `to` | `trade.id`, `trade.status` |
| Inspect state | `coinbase_convert_get` | `quote_id`, original `from`, original `to` | Flat `id` / `status` and currency/rate fields |

Discover each tool's schema independently. The audited core conversion tools expose no `portfolio_id` and no quote-expiry timestamp; do not invent them or promise arbitrary portfolio targeting or a guaranteed expiry. Confirm scope; if it cannot satisfy the user's request, stop.

Do not pass CLI positional/query syntax or assume quoting implies execution. Inspect JSON-RPC/tool errors and actual state. On a client adapter that requires a quote confirmation card and signed token, only its supported confirmation flow may execute; do not call the core-style execute pattern against that adapter.
