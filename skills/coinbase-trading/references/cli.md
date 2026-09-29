# Trading with the local CLI

Apply the [shared trading workflow](../SKILL.md) and [CLI execution rules](../../coinbase/references/cli.md). Discover installed help/templates first:

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
