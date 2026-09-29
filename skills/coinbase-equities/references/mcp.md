# Equities with remote MCP

Apply the [shared equity rules](../SKILL.md) and [MCP trading reference](../../coinbase-trading/references/mcp.md).

Discover eligible listings with `coinbase_products_list` and the schema's product-type filter; inspect `coinbase_products_get`. Read the intended portfolio/positions with `coinbase_portfolios_get`. Use current-schema `coinbase_orders_preview`, `coinbase_orders_create`, and order-state tools only where supported.

The core MCP defaults a resolved equity order to `NORMAL`; do not rely on that default when the user selected another session. At the audited source revision, create and preview both expose `equity_trading_session`, `equity_order_date`, `time_in_force`, and `end_time`. Older deployments/client adapters may differ, and account-level equity fields can be disabled. Check each discovered schema; stop if it cannot express the approved plan rather than dropping fields. Schema presence does not guarantee that the backend supports equity previews.

Equity candle availability can differ from CLI. Do not invent quote support or change product IDs to bypass rejected endpoints. The shared preview/approval, retained order ID, state verification, and retry requirements still apply.
