---
name: coinbase-mcp-trading
description: Preview, place, verify, edit, cancel, or close Coinbase orders through Coinbase MCP. Use for crypto buy/sell requests, limits, stops, advanced orders, and order management; load the equity or futures companion for those products. These are real financial actions.
---

# Coinbase MCP: trading

First follow [Coinbase MCP setup and safety](../coinbase-mcp/SKILL.md). Use only Coinbase MCP for this workflow; do not switch products or credentials to retry an uncertain financial write.

## Plan, preview, authorize, submit, verify

1. Discover the exact product, intended portfolio, available funds/positions, current size/price limits, and supported order fields. Honor the requested quote currency; never substitute BTC-USD for BTC-USDC. Ask if the currency or portfolio is ambiguous.
2. Establish product, side, size and units, portfolio, order type, price/trigger, time in force, expiry, and applicable session. Resolve relative prices from current data and confirm the absolute value.
3. Preview supported orders and disclose estimated fees, price/slippage, and relevant risk. Preview is not authorization. If a required preview is unavailable, stop; never create an order to test it. Load [equities](../coinbase-mcp-equities/SKILL.md) or [futures](../coinbase-mcp-futures/SKILL.md) before planning those products.
4. Obtain approval for the complete order. Generate and retain a unique `client_order_id` before submission; never reuse it for a different logical order. Keep it available if the response is lost.
5. Submit once using the Coinbase MCP and current schema. For spot market buys use `quote_size`; for spot market sells use `base_size`, not both. Other order types and asset classes have their own sizing rules; preserve decimal precision.
6. Inspect order state and fills. Acceptance/order ID is not a fill. Report open, filled, partially filled, rejected/failed, or canceled only as established by the response. Do not claim a future fill for a resting order or poll indefinitely.

## Order types and changes

Prefer supported server-side limits/stops to session-lived watchers. Stops do not guarantee a fill or cap losses. For bracket, TWAP, scaled, or attached exits, verify product/backend eligibility, child-order plan, schedule, aggregate exposure, and current schema; preview when supported and approve the complete plan.

Read the current order before editing or canceling. An attached-exit update can replace both legs; preserve both according to the schema unless removal is explicitly approved. Edit-preview estimates an existing-order change; it is not a preview for a new order. Confirm edits and inspect individual cancellation results. Closing a position is a financial write, not cleanup.

## Uncertain outcomes

After a timeout or ambiguous submission, inspect authorized order/fill state on the same interface. Preserve the original `client_order_id` for the same logical order; never switch interface/environment or blindly generate another ID. If state cannot be established, stop and explain the uncertainty. Edits/cancellations may not support the same idempotency mechanism; inspect actual state rather than assuming retries are safe.

Recurring trades and conditional automation require separately approved limits, timing, failure behavior, and a supported mechanism. This skill installs no scheduler.

## MCP execution

No CLI or API key is needed. Discover current schemas and the host's actual namespaced tool names.

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
