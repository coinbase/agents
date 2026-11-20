---
title: "Insight Plugin"
description: "Pre-signing decision-input and exact-call checks on Base via Insight and PriorSeal, then user-approved submission through Wallet MCP."
tags: [trading, lending, borrowing, perps, swap]
name: insight
version: 0.1.0
integration: http-api
chains: [base]
requires:
  shell: none
  allowlist: [www.oracleinsight.xyz, priorseal.xyz]
  externalMcp: null
  cliPackage: null
auth: none
risk: [liquidation, slippage, irreversible]
---

> [!IMPORTANT]
> Complete Wallet MCP onboarding in `SKILL.md` before using this plugin. This plugin reviews and binds a user-approved Base call; it never holds keys, signs, broadcasts, or guarantees an outcome.

## Overview

Insight provides decision-input and pre-trade safety checks for Base lending, borrowing, perpetuals, and swaps. PriorSeal binds an approved intent to one exact unsigned call and records the resulting execution evidence. Use a native Wallet MCP protocol plugin to prepare an unsigned call, call the relevant Insight endpoint, complete the exact-call PriorSeal flow, and route the unchanged call to Wallet MCP `send_calls` on Base. This is a pre-signing review and evidence workflow, not protocol-level enforcement and not a Coinbase-audited integration.

## Surface Routing

| Capability | Harness with HTTP access | Chat-only surface with Wallet MCP | No HTTP and no prepared call |
|---|---|---|---|
| Read-only review | Call the Insight or PriorSeal HTTP endpoint directly. | Use `web_request` only for an allowlisted host and only with the method/headers supported by the surface. For a GET-only fallback, ask the user to paste the resulting response. | Stop and explain that the review cannot be completed reliably. |
| Exact Base lending/perp review | Prepare an unsigned call with the named native protocol plugin, then POST the exact transaction to Insight. | Use `web_request` if POST and the required headers are supported; otherwise stop. | Stop; do not infer or reconstruct calldata. |
| Exact authorization and submission | Prepare and sign the PriorSeal typed data with Wallet MCP, then use `send_calls`. | Use the Wallet MCP signing and write tools if exposed; otherwise stop. | Stop; do not ask for a private key or fall back to an unbound send. |
| x402 payment | Read the live `402` response and pay with the Wallet MCP x402 payment tool if exposed. | Same; `web_request` alone is not a payment capability. | Stop if a required payment cannot be completed. |

For chat-only routing, the allowlist is a capability requirement, not a promise that the consumer surface exposes POST, custom headers, or x402 payment. Never bypass a missing capability by silently switching to an unbound wallet write.

## Endpoints

Use the live OpenAPI and discovery documents as the source of truth for schemas, pricing, and response fields. Do not hardcode x402 payment terms, recipient addresses, contract addresses, or protocol calldata.

### Insight general pre-trade review

`GET https://www.oracleinsight.xyz/api/v1/safety/pre-trade`

Required query parameters:

- `asset` — source asset symbol or identifier.
- `chainId=8453` — Base mainnet.
- `action` — one of `swap`, `borrow`, `lend`, `liquidate`, or `repay`.
- `tradeAmountUsd` — intended notional in USD.

Useful optional parameters include `destinationAsset`, `protocolId`, and `schemaVersion` when the user supplies them. The response is an informational pre-trade result such as `PASS`, `CAUTION`, `DANGER`, or `BLOCK`. A generic result is not an authorization and is not sufficient to submit an exact call.

### Insight Base lending and borrowing guard

`GET` and `POST https://www.oracleinsight.xyz/api/v1/safety/base-lending-guard`

The GET form is a parameterized review. Use:

- `protocolId`: `aave-v3-base`, `morpho-blue-base`, `compound-v3-base`, or `moonwell-base`.
- `action`: `supply` or `borrow`.
- `collateralSymbol`, `loanSymbol`, `collateralValueUsd`, and `debtValueUsd`.
- `marketId` when required by the selected protocol, including Morpho markets.

For an exact-call review, POST a body with this shape:

```json
{
  "guard": {
    "protocolId": "<named-supported-protocol>",
    "action": "supply or borrow",
    "collateralSymbol": "<symbol>",
    "loanSymbol": "<symbol>",
    "collateralValueUsd": "<number>",
    "debtValueUsd": "<number>",
    "marketId": "<when required>"
  },
  "transaction": {
    "chainId": 8453,
    "from": "0x<user-wallet>",
    "to": "0x<single-direct-target>",
    "data": "0x<exact-calldata>",
    "nonce": "<nonce>",
    "value": "0x0"
  }
}
```

The `transaction` must be the already-prepared, single direct call. The endpoint validates the supported target and selector and returns a Base guard verdict such as `ALLOW`, `CAUTION`, or `BLOCK`. It creates a decision attestation for PriorSeal; it does not authorize, sign, or broadcast the transaction.

### Insight Base perpetuals guard

`GET` and `POST https://www.oracleinsight.xyz/api/v1/safety/base-perp-guard`

The GET form accepts:

- `protocolId=synthetix-perps-v3-base`.
- `action`: `open_long` or `open_short`.
- `assetSymbol`, `marginAssetSymbol=USDC`, `sizeUsd`, and `marginValueUsd`.

The POST form uses the same `{ "guard": ..., "transaction": ... }` envelope as the lending guard. The exact transaction must be a single direct Base call with `chainId=8453`, the user `from`, the exact `to`, `data`, `nonce`, and optional native `value` (normally `0x0`). The route validates the supported `commitOrder` call and returns `ALLOW`, `CAUTION`, or `BLOCK`; it never signs or broadcasts.

### PriorSeal exact-call authorization and evidence

Use the live API description at `https://priorseal.xyz/openapi/v1.json` for the exact request and response schemas:

1. `POST https://priorseal.xyz/v1/authorizations/prepare` to obtain canonical EIP-712 typed data for the exact intent.
2. Have the user sign that typed data with Wallet MCP `sign` when the tool supports typed-data signing.
3. `POST https://priorseal.xyz/v1/authorizations` with the returned authorization data and signature.
4. After Wallet MCP confirms the onchain write, `POST https://priorseal.xyz/v1/executions/observe` with the authorization identifier and exact execution evidence.

PriorSeal binds the chain, executor/from address, nonce, target/call target, calldata hash, and native value. Do not substitute `personal_sign` for the required EIP-712 authorization, and do not claim execution success before Wallet MCP status and PriorSeal observation both confirm it.

### x402 payment

If an Insight endpoint returns `402 Payment Required`, read the live response, including its `accepts[]` payment requirements. Use the x402 payment tool exposed by Wallet MCP when available, matching the live network, asset, amount, and `payTo` exactly. Never hardcode those values and never pay an x402 invoice by calling `send_calls` yourself. If the current surface does not expose a compatible x402 payment tool, stop and report that the paid review is unavailable on this surface.

## Orchestration

### Exact lending or borrowing call

1. Ask the user to name the Base protocol, action, assets, amounts, and wallet. Do not silently choose a protocol or infer risk parameters. Obtain the wallet address only as needed from Wallet MCP `get_wallets`.
2. Invoke the named native Wallet MCP protocol plugin in prepare/quote mode. It must return an unsigned transaction. Do not ask it to send.
3. Require one direct call with `chain=base`, the correct `from`, `to`, `data`, `nonce`, and `value`. If the native plugin returns an approval plus an action, a batch, a delegated call, or an unknown target, stop for this plugin version. Exact Insight/PriorSeal binding must not be weakened to accommodate it.
4. Run the generic Insight review when useful, then POST the exact call to `base-lending-guard`. Preserve the full transaction object byte-for-byte after this point. Continue only on `ALLOW`; stop by default on `CAUTION` or `BLOCK` and ask the user for an explicit decision if they want an informational explanation.
5. Call PriorSeal `authorizations/prepare` using the same exact envelope and the Insight decision reference where the live schema supports a context commitment. Present the returned typed data for user approval and sign it with Wallet MCP `sign`. Submit the signature to `authorizations`.
6. Call Wallet MCP `send_calls` with exactly one `{to, value, data}` call on `chain: "base"`. Show the approval link, wait for the user to approve, and poll the returned request ID once after confirmation.
7. Call PriorSeal `executions/observe` with the authorization ID and the exact confirmed execution evidence. Return the transaction status and evidence references; do not describe an unconfirmed transaction as complete.

### Exact perpetuals call

Follow the same sequence, using `base-perp-guard` and `protocolId=synthetix-perps-v3-base`. Verify the side, asset, margin asset, size, margin, and the exact `commitOrder` calldata. Treat liquidation and leverage warnings as blocking questions, not as values to optimize away.

### Swap or other Base action

Use the native Wallet MCP swap/protocol plugin to prepare or quote the operation. Use Insight `pre-trade` for decision-input review when its action and parameters apply. This plugin does not claim to be a swap route builder, does not select a venue, and does not turn a generic verdict into an exact-call authorization. If exact-call PriorSeal binding is required, the native plugin must expose a single direct call whose full envelope can be reviewed before submission; otherwise stop.

## Submission

The target Wallet MCP tool is `send_calls`.

Normalize the reviewed transaction as follows:

```json
{
  "chain": "base",
  "calls": [
    {
      "to": "<exact reviewed transaction.to>",
      "value": "<exact reviewed transaction.value or 0x0>",
      "data": "<exact reviewed transaction.data>"
    }
  ]
}
```

For this plugin version, the array contains one call only. Do not change `to`, `value`, `data`, nonce, recipient, slippage, side, amount, or call order between Insight, PriorSeal, and Wallet MCP. Every Wallet MCP write follows approval mode: present the returned link as **Approve Transaction**, wait for explicit user approval, then poll the returned request ID once. See `references/approval-mode.md` and `references/batch-calls.md` for the current Wallet MCP response and batching contract.

## Example Prompts

### “Before I borrow USDC against WETH on Morpho Base, review and prepare but don’t send.”

1. Ask for the Morpho market and amounts, then obtain the wallet address if needed.
2. Prepare an unsigned single direct call with the native Morpho plugin.
3. Run the Insight lending guard and explain the verdict. Do not call PriorSeal submission or `send_calls` because the user asked not to send.

### “Open a Synthetix ETH long on Base with Insight and PriorSeal first.”

1. Confirm side, size, margin, wallet, and acceptable risk parameters.
2. Prepare the unsigned `commitOrder` call, POST it to the Insight Base perps guard, and stop on `CAUTION` or `BLOCK`.
3. Prepare and obtain the PriorSeal exact-call authorization, have the user sign the EIP-712 typed data, then submit the unchanged call through `send_calls` only after approval.
4. Observe the confirmed execution in PriorSeal.

### “Review this existing Base call before I approve it.”

1. Parse the supplied `chainId`, `from`, `to`, `data`, `nonce`, and `value` without rewriting them.
2. Select the matching exact Insight guard only if the protocol/action/profile is supported; otherwise run only the applicable generic review and say that exact binding is unavailable.
3. Report the verdict and stop unless the user separately requests the PriorSeal authorization and Wallet MCP approval flow.

### “Check whether my swap quote is trustworthy before I sign.”

1. Run Insight `pre-trade` with the user-supplied asset, destination asset, Base chain, action, and notional.
2. Explain the returned result and quote assumptions, including slippage where available.
3. Do not choose a route, alter slippage, or submit a transaction from this prompt alone.

## Risks & Warnings

- **Liquidation:** Base borrowing and perpetuals can be liquidated. Check the returned health, collateral, debt, margin, leverage, and liquidation-related fields; never silently increase leverage or reduce safety margins.
- **Slippage:** A quote is not a guarantee. Confirm the user’s slippage tolerance and route; never silently raise slippage, substitute a venue, or treat a generic PASS as proof of execution price.
- **Irreversible writes:** Onchain calls cannot be reliably undone. Show the exact target, value, calldata summary, amount, recipient, and approval link before `send_calls`; require explicit user approval.
- **Trust boundary:** Insight and PriorSeal are external services and this plugin is third-party documentation. Coinbase/Base does not operate or audit this plugin. The plugin is not custody, signing, protocol enforcement, investment advice, or a profit guarantee.
- **Fail-closed boundaries:** Do not auto-select a protocol, repair unknown calldata, continue after a missing x402 payment capability, replace EIP-712 with `personal_sign`, or broadcast a call that was not the exact call reviewed and authorized.

## Notes

- Insight: `https://www.oracleinsight.xyz/`
- Insight OpenAPI: `https://www.oracleinsight.xyz/openapi.json`
- Insight x402 discovery: `https://www.oracleinsight.xyz/.well-known/x402`
- Insight machine-readable capabilities: `https://www.oracleinsight.xyz/.well-known/portfolio-capabilities.json`
- Insight agent discovery: `https://www.oracleinsight.xyz/.well-known/agent8004.json`
- PriorSeal OpenAPI: `https://priorseal.xyz/openapi/v1.json`
- PriorSeal agent discovery: `https://priorseal.xyz/.well-known/priorseal-agent.json`
- The exact Insight Base guard profiles currently cover Aave V3, Morpho Blue, Compound V3, and Moonwell lending/borrowing, plus Synthetix Perps V3. Re-read the live API before relying on a profile or market list.
- For swaps, the general Insight review is a decision-input check. It is not a route builder and it is not an authorization to submit calldata.
- Read live manifests and endpoint responses for x402 terms, protocol addresses, selectors, nonce format, and current schema versions.
