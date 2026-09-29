# x402 with the local CLI

Apply the [shared x402 workflow](../SKILL.md) and [CLI execution rules](../../coinbase/references/cli.md). Use the intended environment/key and discover installed command help/templates:

```sh
coinbase x402 resources --help
coinbase x402 resources q==research
coinbase x402 fetch --template
coinbase x402 pay --template
```

After free discovery and budget approval, prepare a JSON request containing the actual catalog `resource` (substitute documented path parameters), schema-valid `input`, an atomic-unit integer-string `max_amount` within budget, the intended `portfolio_id` where needed, and an `idempotency_key` generated and retained before the call. Read/parse and validate the file locally: `coinbase x402 fetch @request.json --dry-run` does not display or validate that raw body in the audited CLI. Submit `COINBASE_NO_HISTORY=1 coinbase x402 fetch @request.json` only for the approved purchase. Do not commit the request file or regenerate the key on an uncertain retry.

Use body/query syntax from the installed template; shell-quote values or use a validated JSON body file. Inspect both exit status and payment/data fields. A lost response does not mean there was no hold. Keep the original environment and key for recovery; never retry through remote MCP.

The CLI uses the Agent API for all x402 operations, not direct Brokerage. `portfolio_id` selects the eligible consumer portfolio; omission succeeds only when discovery can identify exactly one. `account_id` may select a USDC account within it; the server does not guess when there are zero/multiple candidates.

Fetch returns `data`, `paid`, and optional `payment_id`, `idempotency_key`, `expires_at`, not an exact spent-amount field. A caller-supplied key may not be echoed by fetch, so retain it before calling. Report caps separately from actual spend and reserve budget conservatively as described in the shared workflow.

Low-level pay requires `scheme`, `network`, `asset`, `pay_to`, `amount`, `max_amount`, and integer `max_timeout_seconds`. Production supports `exact`, Base `eip155:8453`, USDC, and a 1–300 second authorization window. Copy challenge version into `x402_version` (default is 1); v2 requires the full compatible `extra` object. Follow definite terminal-rejection versus unknown-outcome recovery instructions; do not retry all errors alike.

Low-level `coinbase x402 pay` returns a sensitive payment artifact, not resource data. If the shell/tool would expose it to model-visible output, prefer fetch. Do not run commands that print tokens/headers or attach them to an unverified provider origin.
