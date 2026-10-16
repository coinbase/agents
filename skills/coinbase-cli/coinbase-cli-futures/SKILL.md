---
name: coinbase-cli-futures
description: Plan, preview, and manage eligible CFM dated futures orders through Coinbase CLI. Use for current contract discovery, contract sizing, default portfolio requirements, margin, liquidation risk, and futures order outcomes.
---

# Coinbase CLI: dated futures

First follow [Coinbase CLI setup and safety](../coinbase-cli/SKILL.md). Use only Coinbase CLI for this workflow; do not switch products or credentials to retry an uncertain financial write. Follow the [Coinbase CLI trading workflow](../coinbase-cli-trading/SKILL.md) before planning these orders.

1. Verify account eligibility and discover the current CFM contract. Dated product IDs roll; do not reuse an expired example or assume a spot ticker identifies a futures contract.
2. Futures require the eligible default portfolio. Discover its actual UUID and confirm access; never derive it from a user UUID or assume an isolated spot portfolio is eligible.
3. Size futures market orders with `base_size` in contracts, not `quote_size`. Inspect contract increments, limits, and exposure; one contract is not necessarily one unit of the underlying asset.
4. Preview the proposed order. Review fees, margin impact, current positions, and `predicted_liquidation_price` when returned. Disclose missing risk information before seeking approval; if a required estimate is unavailable, stop. Do not invent a liquidation price or a configurable leverage field.
5. Obtain approval for the exact contract, size, side, portfolio, order type, limit/expiry, and risk. Retain `client_order_id`, submit on the Coinbase CLI, and inspect actual order state/fills. Acceptance can be followed by asynchronous failure.

Do not substitute an IOC limit for a requested market order, change leverage/sizing/protection, or close a position without approval. Supported `reduce_only` and advanced fields depend on the current schema and venue; do not promise blanket support or silently drop unsupported protection. On ambiguous results, follow the shared trading recovery rules without switching interfaces.

## CLI execution

Discover help/templates first. Use the current product-type filter to list FUTURE products and select a live CFM contract; never paste a date-coded example as the actual product. Inspect `coinbase portfolios list` and `coinbase portfolios get <discovered-default-portfolio-id>` for scope and positions. The selected API key must cover the eligible default portfolio.

Preview with `coinbase orders preview <supported-plan-fields>`, using contract `base_size` rather than `quote_size`. Inspect returned margin/liquidation estimates. With `COINBASE_NO_HISTORY=1`, build and inspect the complete approved create body using the current template and a retained `client_order_id`, then submit only after approval. `--dry-run` is not validation and does not display raw-file bodies. Inspect `coinbase orders get <order_id>` and fills for asynchronous failures.

CFM margin/leverage is not a generic user-selectable order knob. Check current fields and backend restrictions instead of copying spot examples or adding invented leverage parameters. Do not change a market order to IOC limit as an automatic recovery strategy.
