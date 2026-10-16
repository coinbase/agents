---
name: coinbase-cli-convert
description: Quote, approve, execute, and verify supported Coinbase currency conversions through Coinbase CLI, such as USD and USDC. Use for fiat/stablecoin conversion requests, not crypto buy/sell orders.
---

# Coinbase CLI: conversions

First follow [Coinbase CLI setup and safety](../coinbase-cli/SKILL.md). Use only Coinbase CLI for this workflow; do not switch products or credentials to retry an uncertain financial write.

1. Confirm the source and destination currencies, source-denominated amount, and intended portfolio/account scope. Discover support rather than assuming every currency pair can be converted. Buying BTC with USDC is a [trade](../coinbase-cli-trading/SKILL.md), not this flow.
2. Request a quote on the Coinbase CLI. Present the returned rate, fees, and amounts. Disclose that no expiry timestamp is available when absent; never invent a TTL or a guaranteed execution window. Retain the returned quote ID and original source/destination currencies.
3. Obtain approval for the quoted terms before execution. Quoting is not conversion approval.
4. Execute using the returned quote ID and fields required by the current schema. If the quote expired or terms changed, obtain a fresh quote and renewed approval instead of silently accepting a new rate.
5. Inspect the result and conversion status. After an uncertain execution, check the existing quote/trade state; do not request and execute a new quote as a retry. If unresolved, stop and explain the uncertainty. Never switch interfaces to retry.

## CLI execution

Discover help and templates first. Patterns:

```text
coinbase convert quote from=<source-currency> to=<destination-currency> amount=<source-amount>
coinbase convert execute <returned-quote-id> from=<source-currency> to=<destination-currency> --dry-run
coinbase convert execute <returned-quote-id> from=<source-currency> to=<destination-currency>
coinbase convert get <returned-quote-id> from==<source-currency> to==<destination-currency>
```

These are separate steps, not a batch to run without review. Apply `COINBASE_NO_HISTORY=1` and use the selected environment consistently. `quote` returns the identifier at `trade.id`; execute returns `trade.id` / `trade.status`, while get returns a flat status object. Both execute and get require the original `from` and `to`; on get they are query parameters.

The audited conversion contract has no `portfolio_id` field. Do not invent one or imply that changing a CLI environment independently selects an arbitrary conversion portfolio; confirm the accessible account scope and stop if the intended scope cannot be expressed safely.

Wait for quote approval before execution. Preserve decimal precision. Quote output exposes rate/fee/amount fields but no explicit expiry timestamp; do not invent an expiry or guarantee its validity. Execute promptly after approval, and obtain a new quote plus renewed approval on expiry or changed terms. A dry run does not validate the request or renew a quote. On unknown execution outcomes, inspect the existing quote/trade with its currencies before considering recovery; never create another conversion blindly.
