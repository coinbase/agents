# Remote MCP limitation: no watch subscription

The [shared monitoring workflow](../SKILL.md) has no remote MCP execution implementation in this package. The hosted server does not turn CLI `--watch` or `--until` into native subscriptions. Do not invent tools, pass those flags as arguments, create tight polling loops, or claim an agent will keep monitoring after the conversation ends.

Offer a one-time supported [market-data read](../../coinbase-market-data/SKILL.md), or explain that a supported server-side limit/stop may meet the user's actual intent and obtain separate [trading approval](../../coinbase-trading/SKILL.md). Neither option is automatically authorized by a watch request.

If CLI monitoring is appropriate, explain its separate installation/credentials, permissions, and session-lived behavior. Ask before switching, then follow the [CLI reference](cli.md). Never switch as a recovery path for an uncertain order or payment.
