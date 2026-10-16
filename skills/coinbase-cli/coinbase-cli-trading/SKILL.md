---
name: coinbase-cli-trading
description: Preview, place, verify, edit, cancel, or close Coinbase orders through Coinbase CLI. Use for crypto buy/sell requests, limits, stops, advanced orders, and order management; load the equity or futures companion for those products. These are real financial actions.
---

# Coinbase CLI: trading

First follow [Coinbase CLI setup and safety](../coinbase-cli/SKILL.md). Use only Coinbase CLI for this workflow; do not switch products or credentials to retry an uncertain financial write.

## Plan, preview, authorize, submit, verify

1. Discover the exact product, intended portfolio, available funds/positions, current size/price limits, and supported order fields. Honor the requested quote currency; never substitute BTC-USD for BTC-USDC. Ask if the currency or portfolio is ambiguous.
2. Establish product, side, size and units, portfolio, order type, price/trigger, time in force, expiry, and applicable session. Resolve relative prices from current data and confirm the absolute value.
3. Preview supported orders and disclose estimated fees, price/slippage, and relevant risk. Preview is not authorization. If a required preview is unavailable, stop; never create an order to test it. Load [equities](../coinbase-cli-equities/SKILL.md) or [futures](../coinbase-cli-futures/SKILL.md) before planning those products.
4. Obtain approval for the complete order. Generate and retain a unique `client_order_id` before submission; never reuse it for a different logical order. Keep it available if the response is lost.
5. Submit once using the Coinbase CLI and current schema. For spot market buys use `quote_size`; for spot market sells use `base_size`, not both. Other order types and asset classes have their own sizing rules; preserve decimal precision.
6. Inspect order state and fills. Acceptance/order ID is not a fill. Report open, filled, partially filled, rejected/failed, or canceled only as established by the response. Do not claim a future fill for a resting order or poll indefinitely.

## Order types and changes

Prefer supported server-side limits/stops to session-lived watchers. Stops do not guarantee a fill or cap losses. For bracket, TWAP, scaled, or attached exits, verify product/backend eligibility, child-order plan, schedule, aggregate exposure, and current schema; preview when supported and approve the complete plan.

Read the current order before editing or canceling. An attached-exit update can replace both legs; preserve both according to the schema unless removal is explicitly approved. Edit-preview estimates an existing-order change; it is not a preview for a new order. Confirm edits and inspect individual cancellation results. Closing a position is a financial write, not cleanup.

## Uncertain outcomes

After a timeout or ambiguous submission, inspect authorized order/fill state on the same interface. Preserve the original `client_order_id` for the same logical order; never switch interface/environment or blindly generate another ID. If state cannot be established, stop and explain the uncertainty. Edits/cancellations may not support the same idempotency mechanism; inspect actual state rather than assuming retries are safe.

Recurring trades and conditional automation require separately approved limits, timing, failure behavior, and a supported mechanism. This skill installs no scheduler.

## CLI execution

Discover installed help/templates first:

```sh
coinbase orders create --help
coinbase orders create --template
coinbase orders preview --template
```

Check `coinbase orders --help` before using optional operations. Older installed versions may lack `edit-preview`; do not assume a source-repository feature is available locally. Inspect its template only if the action exists. If a required preview is unavailable, report the limitation and stop rather than executing an edit as a test.

| Step | Command pattern |
| --- | --- |
| Resolve funds/product | `coinbase balance`, `coinbase portfolios get <portfolio_id>`, `coinbase products get <product_id>` |
| Preview a new order | `coinbase orders preview <supported-order-fields>` |
| Inspect the exact proposed request | Parse/read `order.json` locally and validate its fields against current help/template; raw-file `--dry-run` does not display its body |
| Submit after approval, with history disabled | `COINBASE_NO_HISTORY=1 coinbase orders create @order.json` |
| Verify | `coinbase orders get <order_id>`, `coinbase orders fills order_ids==<order_id>` |
| List orders | `coinbase orders list` |
| Preview an edit, if available | `coinbase orders edit-preview order_id=<order_id> <supported-change-fields>` |
| Edit | `coinbase orders edit <order_id> <approved-change-fields>` |
| Cancel selected orders | `coinbase orders cancel order_ids:='["<order_id>"]'` |
| Close an approved position | `coinbase orders close-position client_order_id=<retained-uuid> product_id=<product_id> size=<approved-size>` |

Patterns are not commands to run with literal placeholders. Apply `COINBASE_NO_HISTORY=1` to every invocation and use the selected `-e <environment>` consistently. Build `order.json` only from the approved plan and current template, with the discovered portfolio and a unique `client_order_id` generated and retained before submission. Do not rely on automatic ID generation or generate another UUID inline on every retry.

For spot market buys, `quote_size` is the amount of quote currency to spend; for sells, `base_size` is asset quantity. Limit/stop sizing and price fields depend on the template. Use the same supported plan fields for preview; preview and create can accept different fields. A dry run is not an exchange preview.

Fills filtering uses plural `order_ids`, not `order_id`; a single ID may be supplied as shown, or a comma-separated list according to installed help. Edit-preview requires `order_id` plus at least one positive `base_size` or `limit_price`; it does not preview attached-exit-only changes. Close-position requires `client_order_id` and `product_id`; `size` is optional and omission means full close. It has no `portfolio_id` field in the audited contract—if the intended scope cannot be established, stop instead of inventing a field.

Bracket, TWAP, scaled orders, and attached exits depend on the CLI backend; the legacy Brokerage path may reject them as requiring the Agent API. Report that limitation rather than silently changing backend or order type. Inspect help/template for current eligibility and attached-exit replacement semantics.

After submission, read actual order state. Inspect every cancellation result and resolve uncertain writes without switching environments or interfaces.
