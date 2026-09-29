# x402 with remote MCP

Apply the [shared x402 workflow](../SKILL.md) and [MCP execution rules](../../coinbase/references/mcp.md). No CLI, CDP key, or separate wallet is needed for the hosted flow.

| Step | Core tool |
| --- | --- |
| Free catalog discovery | `coinbase_x402_resources` |
| Pay and fetch a curated v2 resource | `coinbase_x402_fetch` |
| Low-level authorization/header only | `coinbase_x402_pay` |

Discover current names and schemas; not every client/account exposes x402. For fetch, supply the catalog resource URL (with documented path parameters substituted), schema-valid flat parameters inside `input`, atomic-unit integer-string `max_amount`, and retained UUID `idempotency_key`. Select the intended eligible consumer `portfolio_id`; omission requires exactly one discoverable candidate. Optional `account_id` selects a USDC account in it; ambiguity is an error, not an invitation to guess. CLI syntax such as `input:=` is not a tool argument.

Inspect JSON-RPC/tool errors as well as `paid`, payment metadata, and `data`. Neither successful discovery nor OAuth consent authorizes spending. Use low-level pay only under the shared secure-delivery constraints; do not call it as a connection test.

The audited fetch response exposes `data`, `paid`, and optional `payment_id`, `idempotency_key`, `expires_at`. It does not expose an exact debited-amount or settlement field. Fetch need not echo a caller-supplied key. Retain the key beforehand and report known outcomes/approved caps without fabricating actual spend; reserve budget conservatively under the shared workflow.

Low-level pay requires `scheme`, `network`, `asset`, `pay_to`, `amount`, `max_amount`, and integer `max_timeout_seconds`. Production uses `exact`, Base `eip155:8453`, USDC, and a 1–300 second window. `x402_version` defaults to 1; pass the challenge's actual version, and the full compatible `extra` object for v2. Pay returns a payment header/identifiers/expiry, not data or an exact-debit receipt. Distinguish definite terminal rejection (new authorized attempt/new key when instructed) from unknown outcomes (retain the original key).
