---
name: coinbase-watch
description: Plan bounded Coinbase streaming or conditional monitoring, such as notifying when a price crosses a threshold or an order fills. CLI-only execution where supported; explain remote MCP limitations and require separate authorization for any triggered financial action.
---

# Coinbase conditional monitoring

Follow [Coinbase interface selection and safety](../coinbase/SKILL.md). This capability is **CLI-only** in this package. If remote MCP is selected, read the [MCP limitation reference](references/mcp.md) and do not silently install/switch to CLI. If the user selects supported CLI monitoring, load the [CLI reference](references/cli.md).

## Agree on the monitoring plan

1. Prefer a supported server-side order for a simple resting limit or stop. Monitoring is session-lived, not a durable exchange order, and stops do not guarantee fills or cap losses. Use [trading](../coinbase-trading/SKILL.md) for an approved order.
2. For cross-product, spread/volume, or specific order-state monitoring, identify the exact products/order IDs, predicate, source data, timeout, and notification/action. Resolve relative thresholds from current data and confirm the absolute values.
3. Confirm whether the request is notification-only or includes an explicit conditional financial plan. A request to watch prices is not trading permission. Before arming any financial action, approve product, side, amount, currency, portfolio, price/slippage constraints, expiry, and failure behavior under the shared trading rules.
4. Require a supported monitored process, bounded lifetime, and a way to stop it. If the harness cannot supervise the process, explain that limitation; do not claim persistent monitoring or create a background daemon.
5. On match, verify the exact predicate/identity and freshness. Default to notifying the user. Any follow-up trade must stay within the approved plan and use retained idempotency identifiers and order verification; ask again if terms changed or required preview is unavailable.

Timeout, failure, disconnect, or a lost process must not trade. Do not restart automatically or arm recurring behavior without fresh authorization. Do not implement tight polling as an alternative to unsupported streaming.
