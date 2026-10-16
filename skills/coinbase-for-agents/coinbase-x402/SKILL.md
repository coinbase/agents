---
name: coinbase-x402
description: Discover and pay for curated x402 research or data using Coinbase remote MCP or local CLI and an explicit USDC budget. Use for resource discovery, paid fetching, payment outcomes, and safe retries. Discovery is free; fetch/pay can spend real funds.
---

# Coinbase x402 research

Follow [Coinbase interface selection and safety](../coinbase/SKILL.md), then load only the [MCP reference](references/mcp.md) or [CLI reference](references/cli.md). The hosted path uses OAuth; CLI uses its separately configured API key. Support varies by client/account.

## Discover, authorize, fetch, report

1. Search the curated resource catalog without spending. Use its actual resource URL, provider, advisory price, and input schema; never invent endpoints or fields.
2. Establish an explicit research budget and approved resources before payment. General research, connection approval, or a trading request is not unlimited research spending authority.
3. Generate and retain an `idempotency_key` UUID before each logical payment. Prefer the fetch operation with the discovered URL, flat resource parameters inside `input`, and a `max_amount` within the remaining budget. Do not replace the resource inputs with a hand-built HTTP request.
4. Inspect `paid`, payment identifiers/expiry, and `data` separately. Report the resource/provider only as identified by returned information. The audited fetch response does not expose an exact debited amount or settlement receipt: report the approved cap separately, do not label it actual spend, and do not treat `paid=true` as proof of settlement. Conservatively reserve the authorized per-request cap against the remaining research budget until reliable payment evidence reconciles it; keep an unknown-outcome reservation rather than freeing it for another purchase.

## Limits and retry safety

- The production configuration uses USDC on Base with a **5 USDC per-payment cap**; verify current controls, which may be stricter. Other environments can differ. Settled payments are irreversible.
- `max_amount` uses atomic USDC units: **1000000 = 1 USDC**. It can tighten the catalog ceiling, not raise it, and is not a server-enforced session/daily budget. Never split payments to evade controls.
- The live challenge sets the actual price within request/server limits; catalog prices are advisory. Stop if the remaining authorized budget is insufficient.
- Fetch supports curated catalog resources and x402 v2, not arbitrary web fetching or unrestricted discovery.
- A timeout is not proof that payment failed. Inspect available state/recovery instructions, retain the original `idempotency_key` for the same logical payment, and never blindly create a new hold or switch interfaces. Stop if the outcome cannot be established safely.
- A definite terminal rejection is different from an unknown outcome. Follow the returned recovery instructions: only a new, authorized attempt after a terminal no-payment rejection may use a new key. Some pre-payment transient failures explicitly request the original key. Never treat every error as the same retry case.
- Payment success does not guarantee usable data. Report empty data, rejected paid requests, and delivery failures separately; do not repeatedly purchase access to resolve a provider problem.

## Low-level pay

Use pay only when an explicitly supported request mechanism can deliver the payment artifact securely to the intended provider. Copy the actual challenge/version and fields from the current schema; pay authorizes funds but does not fetch the resource.

Treat `payment_header` as sensitive. Never show it in chat/logs or forward it across origins. Use `X-PAYMENT` for v1 and `PAYMENT-SIGNATURE` for v2; do not pay again just to try another header. If the harness cannot keep the artifact out of model-visible output, use fetch instead.

Do not claim native SIWX signing, invent an external signer, or repeatedly pay around unsupported authentication. Verify required signing/asynchronous retrieval support before spending. For a trade informed by research, load [trading](../coinbase-trading/SKILL.md) and obtain separate order approval.
