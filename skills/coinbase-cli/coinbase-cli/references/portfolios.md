# Coinbase CLI: portfolios

First follow [Coinbase CLI setup and safety](../SKILL.md). Use only Coinbase CLI for this workflow; do not switch products or credentials to retry an uncertain financial write.

## Read and select

List accessible portfolios, discover real UUIDs, and inspect the intended portfolio and available balances. Distinguish total holdings, available funds, cash, and returned spot/equity/futures positions. Follow pagination. Never derive a portfolio ID from a user ID or silently use the default portfolio when another was requested.

## Manage

- Create or rename only after confirming the exact change.
- Delete only the explicitly selected empty portfolio, after checking its state and obtaining approval. Do not liquidate or transfer holdings to make deletion possible without separate authorization.
- For an internal transfer, confirm source UUID, destination UUID, amount, and currency; verify source access and available funds. This is not an external-address withdrawal workflow.
- If no supported funding operation exists, direct the user to Coinbase's supported funding UI. Do not invent payment-method purchases or deposits through these tools.

Inspect the actual mutation result. A timeout does not prove that a transfer or portfolio change failed. Use available read operations on the Coinbase CLI to reconcile state; if ambiguous, stop and report it rather than repeating the mutation. Do not invent an idempotency field that the current schema does not expose.

## CLI execution

Discover command help/templates and use the intended `-e <environment>` consistently.

| Operation | Command pattern |
| --- | --- |
| Read the intended portfolio's balances | `coinbase balance portfolio_id==<portfolio_id>` |
| List portfolios | `coinbase portfolios list` |
| Inspect a discovered portfolio | `coinbase portfolios get <portfolio_id>` |
| Create after approval | `coinbase portfolios create name=<approved-name>` |
| Rename after approval | `coinbase portfolios edit <portfolio_id> name=<approved-name>` |
| Delete the approved empty portfolio | `coinbase portfolios delete <portfolio_id>` |
| Transfer after approval | `coinbase transfer amount=<amount> currency=<currency> from=<source_id> to=<destination_id>` |

Balance supports `portfolio_id`, `show_zero`, `limit`, and `cursor` as query parameters; e.g. `show_zero==true`. Portfolio list supports `portfolio_type==DEFAULT` or `portfolio_type==CONSUMER`. Returned portfolio identifiers are `uuid`; get/edit/delete take that identifier positionally. Transfer uses `from`/`to` UUIDs and returns source/target portfolio UUIDs, not a separately queryable transfer ID. Do not invent a transfer-status command.

Quote names/values safely; these are patterns, not literal commands. Apply `COINBASE_NO_HISTORY=1`, inspect all actual inputs, and use `--dry-run` only as a supplementary diagnostic, not schema validation. Key scope restricts access; it does not select the intended portfolio for every operation automatically. Discover actual UUIDs and use the source portfolio's authorized environment for transfers. Ask before changing credentials or creating another environment.

Inspect actual results and reconcile uncertain outcomes with authorized reads. Never infer transfer failure from a timeout or retry through remote MCP.
