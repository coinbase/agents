---
name: coinbase-portfolios
description: Read Coinbase balances and positions, list or manage portfolios, and transfer funds between portfolios through remote MCP or local CLI. Use for portfolio selection, account scope, portfolio creation/renaming/deletion, and internal transfers.
---

# Coinbase portfolios

Follow [Coinbase interface selection and safety](../coinbase/SKILL.md), then load only the [MCP reference](references/mcp.md) or [CLI reference](references/cli.md). OAuth portfolio grants and CLI key scopes are separate; never assume they cover the same funds.

## Read and select

List accessible portfolios, discover real UUIDs, and inspect the intended portfolio and available balances. Distinguish total holdings, available funds, cash, and returned spot/equity/futures positions. Follow pagination. Never derive a portfolio ID from a user ID or silently use the default portfolio when another was requested.

## Manage

- Create or rename only after confirming the exact change.
- Delete only the explicitly selected empty portfolio, after checking its state and obtaining approval. Do not liquidate or transfer holdings to make deletion possible without separate authorization.
- For an internal transfer, confirm source UUID, destination UUID, amount, and currency; verify source access and available funds. This is not an external-address withdrawal workflow.
- If no supported funding operation exists, direct the user to Coinbase's supported funding UI. Do not invent payment-method purchases or deposits through these tools.

Inspect the actual mutation result. A timeout does not prove that a transfer or portfolio change failed. Use available read operations on the selected interface to reconcile state; if ambiguous, stop and report it rather than repeating the mutation. Do not invent an idempotency field that the current schema does not expose.
