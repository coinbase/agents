---
name: coinbase-futures
description: Plan, preview, and manage eligible CFM dated futures orders through Coinbase remote MCP or local CLI. Use for current contract discovery, contract sizing, default portfolio requirements, margin, liquidation risk, and futures order outcomes.
---

# Coinbase dated futures

Follow [Coinbase interface selection](../coinbase/SKILL.md) and the [shared trading workflow](../coinbase-trading/SKILL.md). Load only the [MCP reference](references/mcp.md) or [CLI reference](references/cli.md). These are real leveraged products; losses and liquidation are possible.

1. Verify account eligibility and discover the current CFM contract. Dated product IDs roll; do not reuse an expired example or assume a spot ticker identifies a futures contract.
2. Futures require the eligible default portfolio. Discover its actual UUID and confirm access; never derive it from a user UUID or assume an isolated spot portfolio is eligible.
3. Size futures market orders with `base_size` in contracts, not `quote_size`. Inspect contract increments, limits, and exposure; one contract is not necessarily one unit of the underlying asset.
4. Preview the proposed order. Review fees, margin impact, current positions, and `predicted_liquidation_price` when returned. Disclose missing risk information before seeking approval; if a required estimate is unavailable, stop. Do not invent a liquidation price or a configurable leverage field.
5. Obtain approval for the exact contract, size, side, portfolio, order type, limit/expiry, and risk. Retain `client_order_id`, submit on the selected interface, and inspect actual order state/fills. Acceptance can be followed by asynchronous failure.

Do not substitute an IOC limit for a requested market order, change leverage/sizing/protection, or close a position without approval. Supported `reduce_only` and advanced fields depend on the current schema and venue; do not promise blanket support or silently drop unsupported protection. On ambiguous results, follow the shared trading recovery rules without switching interfaces.
