# Conversions with the local CLI

Apply the [shared workflow](../SKILL.md) and [CLI execution rules](../../coinbase/references/cli.md). Discover help and templates first. Patterns:

```text
coinbase convert quote from=<source-currency> to=<destination-currency> amount=<source-amount>
coinbase convert execute <returned-quote-id> from=<source-currency> to=<destination-currency> --dry-run
coinbase convert execute <returned-quote-id> from=<source-currency> to=<destination-currency>
coinbase convert get <returned-quote-id> from==<source-currency> to==<destination-currency>
```

These are separate steps, not a batch to run without review. Apply `COINBASE_NO_HISTORY=1` and use the selected environment consistently. `quote` returns the identifier at `trade.id`; execute returns `trade.id` / `trade.status`, while get returns a flat status object. Both execute and get require the original `from` and `to`; on get they are query parameters.

The audited conversion contract has no `portfolio_id` field. Do not invent one or imply that changing a CLI environment independently selects an arbitrary conversion portfolio; confirm the accessible account scope and stop if the intended scope cannot be expressed safely.

Wait for quote approval before execution. Preserve decimal precision. Quote output exposes rate/fee/amount fields but no explicit expiry timestamp; do not invent an expiry or guarantee its validity. Execute promptly after approval, and obtain a new quote plus renewed approval on expiry or changed terms. A dry run does not validate the request or renew a quote. On unknown execution outcomes, inspect the existing quote/trade with its currencies before considering recovery; never create another conversion blindly.
