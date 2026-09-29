# Equities with the local CLI

Apply the [shared equity rules](../SKILL.md) and [CLI trading reference](../../coinbase-trading/references/cli.md).

Inspect current help/templates and product metadata:

```sh
coinbase products list --help
coinbase orders create --template
coinbase orders preview --template
```

Discover listings with the supported EQUITY filter, then read `coinbase products get <TICKER-QUOTE>` and the intended portfolio. Build the approved request using the current template, including the retained `client_order_id`, intended portfolio where supported, exact product, and equity session/date fields.

For extended sessions, validate whole-share `base_size`, limit price, GTD/expiry, and trade date against the installed version/backend. Current source create and preview expose `time_in_force` / `end_time`, while older installed templates can differ. If a required field is unavailable, stop rather than omit it. Apply `COINBASE_NO_HISTORY=1` and inspect all actual fields locally; `--dry-run` neither validates them nor displays a raw-file body, and does not establish an open session or exchange preview support.

Do not inherit the old assumption that preview failure means "go straight to create." Follow the shared approval rules, then inspect `coinbase orders get <order_id>` and fills after submission. Keep the same environment throughout recovery.
