# Futures with the local CLI

Apply the [shared futures rules](../SKILL.md) and [CLI trading reference](../../coinbase-trading/references/cli.md).

Discover help/templates first. Use the current product-type filter to list FUTURE products and select a live CFM contract; never paste a date-coded example as the actual product. Inspect `coinbase portfolios list` and `coinbase portfolios get <discovered-default-portfolio-id>` for scope and positions. The selected API key must cover the eligible default portfolio.

Preview with `coinbase orders preview <supported-plan-fields>`, using contract `base_size` rather than `quote_size`. Inspect returned margin/liquidation estimates. With `COINBASE_NO_HISTORY=1`, build and inspect the complete approved create body using the current template and a retained `client_order_id`, then submit only after approval. `--dry-run` is not validation and does not display raw-file bodies. Inspect `coinbase orders get <order_id>` and fills for asynchronous failures.

CFM margin/leverage is not a generic user-selectable order knob. Check current fields and backend restrictions instead of copying spot examples or adding invented leverage parameters. Do not change a market order to IOC limit as an automatic recovery strategy.
