---
name: coinbase-convert
description: Quote, approve, execute, and verify supported Coinbase currency conversions through remote MCP or local CLI, such as USD and USDC. Use for fiat/stablecoin conversion requests, not crypto buy/sell orders.
---

# Coinbase conversions

Follow [Coinbase interface selection and safety](../coinbase/SKILL.md), then load only the [MCP reference](references/mcp.md) or [CLI reference](references/cli.md).

1. Confirm the source and destination currencies, source-denominated amount, and intended portfolio/account scope. Discover support rather than assuming every currency pair can be converted. Buying BTC with USDC is a [trade](../coinbase-trading/SKILL.md), not this flow.
2. Request a quote on the selected interface. Present the returned rate, fees, and amounts. Disclose that no expiry timestamp is available when absent; never invent a TTL or a guaranteed execution window. Retain the returned quote ID and original source/destination currencies.
3. Obtain approval for the quoted terms before execution. Quoting is not conversion approval.
4. Execute using the returned quote ID and fields required by the current schema. If the quote expired or terms changed, obtain a fresh quote and renewed approval instead of silently accepting a new rate.
5. Inspect the result and conversion status. After an uncertain execution, check the existing quote/trade state; do not request and execute a new quote as a retry. If unresolved, stop and explain the uncertainty. Never switch interfaces to retry.
