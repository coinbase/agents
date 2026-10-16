---
name: coinbase-trading
description: Preview, place, verify, edit, cancel, or close Coinbase orders through remote MCP or local CLI. Use for crypto buy/sell requests, limits, stops, advanced orders, and order management; load the equity or futures companion for those products. These are real financial actions.
---

# Coinbase trading

First follow [Coinbase interface selection and safety](../coinbase/SKILL.md). Load only the selected [MCP reference](references/mcp.md) or [CLI reference](references/cli.md). Both implement the workflow below; do not mix credentials mid-operation.

## Plan, preview, authorize, submit, verify

1. Discover the exact product, intended portfolio, available funds/positions, current size/price limits, and supported order fields. Honor the requested quote currency; never substitute BTC-USD for BTC-USDC. Ask if the currency or portfolio is ambiguous.
2. Establish product, side, size and units, portfolio, order type, price/trigger, time in force, expiry, and applicable session. Resolve relative prices from current data and confirm the absolute value.
3. Preview supported orders and disclose estimated fees, price/slippage, and relevant risk. Preview is not authorization. If a required preview is unavailable, stop; never create an order to test it. Load [equities](../coinbase-equities/SKILL.md) or [futures](../coinbase-futures/SKILL.md) before planning those products.
4. Obtain approval for the complete order. Generate and retain a unique `client_order_id` before submission; never reuse it for a different logical order. Keep it available if the response is lost.
5. Submit once using the selected interface and current schema. For spot market buys use `quote_size`; for spot market sells use `base_size`, not both. Other order types and asset classes have their own sizing rules; preserve decimal precision.
6. Inspect order state and fills. Acceptance/order ID is not a fill. Report open, filled, partially filled, rejected/failed, or canceled only as established by the response. Do not claim a future fill for a resting order or poll indefinitely.

## Order types and changes

Prefer supported server-side limits/stops to session-lived watchers. Stops do not guarantee a fill or cap losses. For bracket, TWAP, scaled, or attached exits, verify product/backend eligibility, child-order plan, schedule, aggregate exposure, and current schema; preview when supported and approve the complete plan.

Read the current order before editing or canceling. An attached-exit update can replace both legs; preserve both according to the schema unless removal is explicitly approved. Edit-preview estimates an existing-order change; it is not a preview for a new order. Confirm edits and inspect individual cancellation results. Closing a position is a financial write, not cleanup.

## Uncertain outcomes

After a timeout or ambiguous submission, inspect authorized order/fill state on the same interface. Preserve the original `client_order_id` for the same logical order; never switch interface/environment or blindly generate another ID. If state cannot be established, stop and explain the uncertainty. Edits/cancellations may not support the same idempotency mechanism; inspect actual state rather than assuming retries are safe.

Recurring trades and conditional automation require separately approved limits, timing, failure behavior, and a supported mechanism. This skill installs no scheduler.
