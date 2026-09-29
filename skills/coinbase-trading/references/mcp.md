# Trading with remote MCP

Apply the [shared trading workflow](../SKILL.md) and [MCP connection rules](../../coinbase/references/mcp.md). No CLI or API key is needed. Discover current schemas and the host's actual namespaced tool names.

| Step | Core tools |
| --- | --- |
| Resolve scope, funds, and product | `coinbase_portfolios_list`, `coinbase_portfolios_get`, `coinbase_balance`, `coinbase_products_list`, `coinbase_products_get` |
| Estimate a new order | `coinbase_orders_preview` |
| Submit an approved order | `coinbase_orders_create` |
| Verify order and fills | `coinbase_orders_get`, `coinbase_orders_list`, `coinbase_orders_fills` |
| Estimate/change an existing order | `coinbase_orders_edit_preview`, `coinbase_orders_edit` |
| Cancel selected orders | `coinbase_orders_cancel` |
| Close an explicitly selected position | `coinbase_orders_close_position` |

Pass structured fields from each tool's own schema, including the intended `portfolio_id` where supported. For an approved spot market buy, the order plan maps to `product_id`, `side=BUY`, `type=market`, quote-denominated `quote_size`, and the retained `client_order_id`; these are JSON fields, not shell arguments. Do not infer optional fields, enum values, or preview support from the CLI.

Concrete field differences in the audited core schema:
- Fills filtering is `order_ids` (an array of strings), not singular `order_id`; `product_ids` on fills/list is a comma-separated string.
- Edit-preview requires `order_id` and at least one positive `base_size` or `limit_price`. It does not accept attached-exit fields.
- Close-position requires `client_order_id` and `product_id`; `size` is optional and omission means full close. It exposes no `portfolio_id`, so do not claim arbitrary portfolio targeting or add that field. Stop if intended scope is unresolved.
- Current create and preview both expose `portfolio_id`, `time_in_force`, and `end_time`; older deployments or client adapters may differ. Use discovered schemas, not CLI flag syntax or a stale template.

If a client adapter uses confirmation cards/tokens for order placement, editing, or cancellation, follow that flow. A conversational approval is not a substitute for a required widget confirmation token.

Inspect preview errors/estimates before approval, and JSON-RPC/tool errors and returned order state after submission. A tool being discoverable does not prove that the account can use that product or order type. Do not change product/session/type when rejected. Read each cancellation outcome, not just the enclosing success status.
