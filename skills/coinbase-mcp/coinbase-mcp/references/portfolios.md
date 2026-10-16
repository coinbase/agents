# Coinbase MCP: portfolios

First follow [Coinbase MCP setup and safety](../SKILL.md). Use only Coinbase MCP for this workflow; do not switch products or credentials to retry an uncertain financial write.

## Read and select

List accessible portfolios, discover real UUIDs, and inspect the intended portfolio and available balances. Distinguish total holdings, available funds, cash, and returned spot/equity/futures positions. Follow pagination. Never derive a portfolio ID from a user ID or silently use the default portfolio when another was requested.

## Manage

- Create or rename only after confirming the exact change.
- Delete only the explicitly selected empty portfolio, after checking its state and obtaining approval. Do not liquidate or transfer holdings to make deletion possible without separate authorization.
- For an internal transfer, confirm source UUID, destination UUID, amount, and currency; verify source access and available funds. This is not an external-address withdrawal workflow.
- If no supported funding operation exists, direct the user to Coinbase's supported funding UI. Do not invent payment-method purchases or deposits through these tools.

Inspect the actual mutation result. A timeout does not prove that a transfer or portfolio change failed. Use available read operations on the Coinbase MCP to reconcile state; if ambiguous, stop and report it rather than repeating the mutation. Do not invent an idempotency field that the current schema does not expose.

## MCP execution

| Operation | Core tool |
| --- | --- |
| List accessible portfolios | `coinbase_portfolios_list` |
| Read a portfolio | `coinbase_portfolios_get` |
| Read balances | `coinbase_balance` |
| Create / rename / delete | `coinbase_portfolios_create`, `coinbase_portfolios_edit`, `coinbase_portfolios_delete` |
| Transfer between portfolios | `coinbase_transfer` |

Use discovered tool names and schemas for identifiers, amount/currency, and source/destination fields. Read operations need the corresponding OAuth grants; discovery alone does not prove them. Request new consent if the selected portfolio or needed permission is missing, not a different client's identity or a CLI key.

Portfolio list returns `portfolios[].uuid` and accepts optional `portfolio_type` (`DEFAULT` or `CONSUMER`). Get/edit/delete require `portfolio_id`; create requires `name`, and edit accepts the new `name`. Balance accepts `portfolio_id`, boolean `show_zero`, `limit`, and `cursor`. Omitting its portfolio selects the default portfolio, not all portfolios. Filtered zero balances may yield an empty account list; a scope error is not proof of an empty account.

Transfer requires `from`, `to`, `amount`, and `currency`; `from`/`to` are discovered portfolio UUIDs. It returns `source_portfolio_uuid` and `target_portfolio_uuid`, not a transfer ID/status endpoint. No idempotency field is exposed for portfolio mutations or transfer. Reconcile uncertain outcomes cautiously and stop if ambiguous.

Confirm writes using the workflow above. Inspect JSON-RPC/tool errors and returned state, not just HTTP success. Setup verification uses `coinbase_portfolios_list` with `{}` and does not require any mutation.
