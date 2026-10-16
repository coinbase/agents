---
name: coinbase-mcp-futures
description: Plan, preview, and manage eligible CFM dated futures orders through Coinbase MCP. Use for current contract discovery, contract sizing, default portfolio requirements, margin, liquidation risk, and futures order outcomes.
---

# Coinbase MCP: dated futures

First follow [Coinbase MCP setup and safety](../coinbase-mcp/SKILL.md). Use only Coinbase MCP for this workflow; do not switch products or credentials to retry an uncertain financial write. Follow the [Coinbase MCP trading workflow](../coinbase-mcp-trading/SKILL.md) before planning these orders.

1. Verify account eligibility and discover the current CFM contract. Dated product IDs roll; do not reuse an expired example or assume a spot ticker identifies a futures contract.
2. Futures require the eligible default portfolio. Discover its actual UUID and confirm access; never derive it from a user UUID or assume an isolated spot portfolio is eligible.
3. Size futures market orders with `base_size` in contracts, not `quote_size`. Inspect contract increments, limits, and exposure; one contract is not necessarily one unit of the underlying asset.
4. Preview the proposed order. Review fees, margin impact, current positions, and `predicted_liquidation_price` when returned. Disclose missing risk information before seeking approval; if a required estimate is unavailable, stop. Do not invent a liquidation price or a configurable leverage field.
5. Obtain approval for the exact contract, size, side, portfolio, order type, limit/expiry, and risk. Retain `client_order_id`, submit on the Coinbase MCP, and inspect actual order state/fills. Acceptance can be followed by asynchronous failure.

Do not substitute an IOC limit for a requested market order, change leverage/sizing/protection, or close a position without approval. Supported `reduce_only` and advanced fields depend on the current schema and venue; do not promise blanket support or silently drop unsupported protection. On ambiguous results, follow the shared trading recovery rules without switching interfaces.

## MCP execution

- Discover contracts with `coinbase_products_list` and its current FUTURE product-type filter; inspect the selected contract using `coinbase_products_get`.
- Discover the eligible default portfolio with `coinbase_portfolios_list`, then inspect positions/funds with `coinbase_portfolios_get` / `coinbase_balance` as exposed.
- Use `coinbase_orders_preview` for supported contract sizing and risk estimates, then `coinbase_orders_create` only after approval. Pass the actual portfolio ID where supported, contract `base_size`, and retained `client_order_id`.
- Inspect `coinbase_orders_get`, `coinbase_orders_list`, and `coinbase_orders_fills`; an accepted ID does not prove execution.

Use discovered schemas and namespaced tools. Do not assume spot sizing, data availability, or advanced order eligibility applies to dated futures. OAuth grant access alone does not establish futures account approval.
