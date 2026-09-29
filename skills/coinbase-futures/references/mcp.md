# Futures with remote MCP

Apply the [shared futures rules](../SKILL.md) and [MCP trading reference](../../coinbase-trading/references/mcp.md).

- Discover contracts with `coinbase_products_list` and its current FUTURE product-type filter; inspect the selected contract using `coinbase_products_get`.
- Discover the eligible default portfolio with `coinbase_portfolios_list`, then inspect positions/funds with `coinbase_portfolios_get` / `coinbase_balance` as exposed.
- Use `coinbase_orders_preview` for supported contract sizing and risk estimates, then `coinbase_orders_create` only after approval. Pass the actual portfolio ID where supported, contract `base_size`, and retained `client_order_id`.
- Inspect `coinbase_orders_get`, `coinbase_orders_list`, and `coinbase_orders_fills`; an accepted ID does not prove execution.

Use discovered schemas and namespaced tools. Do not assume spot sizing, data availability, or advanced order eligibility applies to dated futures. OAuth grant access alone does not establish futures account approval.
