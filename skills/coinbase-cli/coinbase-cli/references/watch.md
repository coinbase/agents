# Coinbase CLI: conditional monitoring

First follow [Coinbase CLI setup and safety](../SKILL.md). Use only Coinbase CLI for this workflow; do not switch products or credentials to retry an uncertain financial write.

## Agree on the monitoring plan

1. Prefer a supported server-side order for a simple resting limit or stop. Monitoring is session-lived, not a durable exchange order, and stops do not guarantee fills or cap losses. Use [trading](trading.md) for an approved order.
2. For cross-product, spread/volume, or specific order-state monitoring, identify the exact products/order IDs, predicate, source data, timeout, and notification/action. Resolve relative thresholds from current data and confirm the absolute values.
3. Confirm whether the request is notification-only or includes an explicit conditional financial plan. A request to watch prices is not trading permission. Before arming any financial action, approve product, side, amount, currency, portfolio, price/slippage constraints, expiry, and failure behavior under the shared trading rules.
4. Require a supported monitored process, bounded lifetime, and a way to stop it. If the harness cannot supervise the process, explain that limitation; do not claim persistent monitoring or create a background daemon.
5. On match, verify the exact predicate/identity and freshness. Default to notifying the user. Any follow-up trade must stay within the approved plan and use retained idempotency identifiers and order verification; ask again if terms changed or required preview is unavailable.

Timeout, failure, disconnect, or a lost process must not trade. Do not restart automatically or arm recurring behavior without fresh authorization. Do not implement tight polling as an alternative to unsupported streaming.

## CLI execution

Inspect installed stream support and valid predicate fields before use:

```sh
coinbase products ticker --help
coinbase products book --help
coinbase orders list --help
```

A read-only example, only after confirming product, threshold, and monitoring duration:

```sh
coinbase products ticker BTC-USDC --until 'price BTC-USDC >= 65000' --until-timeout 3600
```

`--until` blocks until its predicate matches, prints the matched event, and exits. The documented outcomes are match `0`, timeout `124`, permanent failure `2`; verify the installed help. Every nonzero/unknown outcome must block follow-up actions. Always set `--until-timeout`. The process must remain supervised; stopping it removes the trigger.

Require an actual matching event as well as a successful exit; interruption/EOF is not a match. The CLI can reconnect automatically within a bounded disconnect budget, so a temporary disconnect does not necessarily end the watcher. If the approved plan requires aborting on any disconnect, the supervisor must stop it; do not promise that behavior from `--until` alone.

Predicates use supported fields and operators (`==`, `!=`, `>`, `<`, `>=`, `<=`, `&&`, `||`, parentheses); discover stream-specific fields rather than guessing. String comparison values must be quoted, and stream status/side enums are lowercase: for example `"filled"`, `"open"`, `"buy"`, `"sell"`, not REST-style `"FILLED"` or `"BUY"`. For order-fill sequencing, include and verify the exact intended order ID, e.g. `order_id == "<order_id>" && status == "filled"`. A broad `status == "filled"` match could refer to another order and is not a safe trading trigger.

Do not append an order to the example or chain an unreviewed write with `&&`. Default to reporting the match. A separately authorized conditional trade still requires a retained `client_order_id`, current scope/funds checks, applicable preview/risk checks, approved constraints, and actual order-state verification. If those cannot be satisfied by the supported supervised workflow, notify and ask the user rather than arming a trade.
