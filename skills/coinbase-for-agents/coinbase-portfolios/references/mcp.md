# Portfolios with remote MCP

Apply the [shared workflow](../SKILL.md) and [MCP execution rules](../../coinbase/references/mcp.md).

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

Confirm writes using the shared workflow. Inspect JSON-RPC/tool errors and returned state, not just HTTP success. Setup verification uses `coinbase_portfolios_list` with `{}` and does not require any mutation.
