# Monitoring with the local CLI

Apply the [shared monitoring plan](../SKILL.md) and [CLI execution rules](../../coinbase/references/cli.md). Inspect installed stream support and valid predicate fields before use:

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
