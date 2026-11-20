---
title: "Tereno Plugin"
description: "Pre-action onchain contract, token launch, and holder concentration checks on Base over HTTP x402 before Wallet MCP swaps or batched calls."
tags: [ai-agents, agent-commerce, token-launches, trading, dex]
name: tereno
version: 0.2.0
integration: http-api
chains: [base]
requires:
  shell: none
  allowlist: [www.tereno.xyz]
  externalMcp: null
  cliPackage: null
auth: none
risk: [low-liquidity, irreversible]
---

# Tereno Plugin

> [!IMPORTANT]
> Run Wallet MCP onboarding first (see `SKILL.md`). Tereno is a third-party read-only verification and cache service on Base; Base does not operate, endorse, or audit it. Verdicts report point-in-time onchain observations and simulations, not a guarantee of contract or token behavior.

## Overview

[Tereno](https://www.tereno.xyz) provides point-in-time onchain verification and shared-cache artifacts on Base mainnet (`chainId: 8453`). Before an agent executes a Wallet MCP `swap` or `send_calls` against an unfamiliar Base contract or newly launched token, this plugin queries Tereno over HTTP for bytecode and EIP-1967 proxy inspection, simulated buy/sell exit checks, top-holder concentration and funding-origin clusters, token metadata, or Base block and gas snapshots. Free discovery and artifact verification endpoints require no payment; paid capability invocations settle in Base USDC through Wallet MCP's `initiate_x402_request` and `complete_x402_request` tools. Tereno is read-only and never constructs or submits transaction calldata.

## Surface Routing

Follow the standard HTTP routing priority in [../references/custom-plugins.md](../references/custom-plugins.md).

| Capability | Harness with HTTP tool (Claude Code, Codex, Cursor) | Chat-only surface (Claude.ai, ChatGPT) |
|---|---|---|
| Free discovery (`GET /api/v1/capabilities/price`, `GET /api/v1/evidence/{artifactId}`, `GET /api/v1/bounties`) | Use the harness HTTP tool directly (`GET` to `https://www.tereno.xyz`). | Use Wallet MCP `web_request` `GET` if `www.tereno.xyz` is allowlisted; otherwise provide the full `GET` URL for the user to paste back into chat. |
| Probe live `402` challenge on a capability endpoint | Call the capability `GET` endpoint with the harness HTTP tool to read the live `402` challenge before paying. | Pass the capability `GET` URL to Wallet MCP `initiate_x402_request` (or use `web_request` if allowlisted). If x402 tools are unavailable on the surface, stop and explain that paid verification requires Wallet MCP x402 support. |
| Paid capability execution (x402 v2 on Base) | Approve and complete payment via Wallet MCP `initiate_x402_request` → [../references/approval-mode.md](../references/approval-mode.md) → `complete_x402_request`. | Approve and complete payment via Wallet MCP `initiate_x402_request` → [../references/approval-mode.md](../references/approval-mode.md) → `complete_x402_request`. Stop if Wallet MCP x402 tools are not exposed. |
| Downstream token swap or contract call (if user proceeds) | Wallet MCP `swap` or `send_calls` after user confirmation. | Wallet MCP `swap` or `send_calls` after user confirmation. |

## Endpoints

Base URL: `https://www.tereno.xyz`

Treat live `402` challenges and `/api/v1/capabilities/price` as the source of truth for current pricing and recipient parameters. Do not hardcode `payTo` addresses.

### `GET /api/v1/capabilities/price`

Free quote endpoint. Returns the current Base USDC price for a capability and target, including whether a fresh content-addressed artifact is already cached.

Query parameters:

- `capability` (required) — one of `token.launch.guard`, `token.holders.guard`, `contract.guard`, `token.metadata`, or `chain.snapshot`.
- `address` (optional) — target `0x` contract or token address on Base when checking cache status for an address-scoped capability.
- `via=wallet-mcp` (optional) — attribution query tag.

Example request:

```text
GET https://www.tereno.xyz/api/v1/capabilities/price?capability=token.launch.guard&address=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&via=wallet-mcp
```

### `GET /api/v1/capabilities/{capabilityId}/invoke`

Paid x402 v2 verification endpoints on Base (`eip155:8453`). An unauthenticated request returns `402 Payment Required` with the x402 challenge (`PAYMENT-REQUIRED` header and JSON challenge body). A completed x402 request returns `200 OK` with a bounded verdict envelope.

Supported read-only Base capabilities:

| `capabilityId` | Query parameters | What it inspects on Base |
|---|---|---|
| `token.launch.guard` | `address=0x...&via=wallet-mcp` | Simulated buy/sell exit via `eth_call`, DEX liquidity reserve depth, LP lock/burn status, and owner privileges. |
| `token.holders.guard` | `address=0x...&via=wallet-mcp` | Top-10 holder concentration, ETH funding-origin graph, and deployer-funded holder clusters. |
| `contract.guard` | `address=0x...&via=wallet-mcp` | Executable runtime bytecode presence, EIP-1967 proxy implementation slots, pause state, and static selector flags (blacklist, mint, trading lock selectors). |
| `token.metadata` | `address=0x...&via=wallet-mcp` | ERC-20 `name`, `symbol`, `decimals`, and block-fresh `totalSupply`. |
| `chain.snapshot` | `via=wallet-mcp` | Latest Base block number, timestamp, base fee, and suggested gas parameters. |

Response shape (`200 OK` after x402 completion):

```json
{
  "verdict": "allow | review | block",
  "reasonCodes": ["..."],
  "evidence": {
    "chainId": 8453,
    "address": "0x..."
  },
  "limitations": ["..."],
  "validUntilBlock": 12345678,
  "artifactId": "sha256:...",
  "receipt": {
    "invocationId": "...",
    "receiptUrl": "https://www.tereno.xyz/api/v1/receipts/..."
  }
}
```

Field notes:

- `verdict` — `"allow"` (no blocking flags observed in the checked scope), `"review"` (elevated risk or upgradable/privileged parameters that require explicit user review), or `"block"` (critical hazard observed, such as simulated sell failure or unverified bytecode trap).
- `reasonCodes` and `limitations` — machine-readable codes and scope boundaries explaining what was and was not checked. Always surface both to the user.
- `validUntilBlock` — Base block number after which the cached observation is stale.
- `artifactId` — content-addressed identifier (`sha256:...`) that can be verified for free via `GET /api/v1/evidence/{artifactId}`.

### `GET /api/v1/evidence/{artifactId}`

Free verification endpoint. Resolves a previously issued `sha256:...` artifact identifier and returns its verdict metadata, validity window, and provenance without charging USDC.

```text
GET https://www.tereno.xyz/api/v1/evidence/sha256:0123456789abcdef...
```

## Orchestration

### Pre-trade token or contract check (paid x402 flow)

1. Identify the target Base contract or ERC-20 address (`0x` + 40 hex characters) and select the matching capability (`token.launch.guard` for launch/exit simulation, `token.holders.guard` for holder concentration, `contract.guard` for general contract inspection, `token.metadata` for ERC-20 identity, or `chain.snapshot` for Base block/gas state).
2. Query `GET https://www.tereno.xyz/api/v1/capabilities/price?capability=<capabilityId>&address=<address>&via=wallet-mcp` (or read the live `402` challenge from the invoke URL) and present the quoted Base USDC price to the user.
3. Ask the user to confirm the paid check before initiating payment. Stop if the price exceeds the user's stated budget.
4. Call Wallet MCP `get_wallets` if needed to confirm a Base account with sufficient USDC.
5. Call Wallet MCP `initiate_x402_request` with `method: "GET"` and `url: "https://www.tereno.xyz/api/v1/capabilities/<capabilityId>/invoke?address=<address>&via=wallet-mcp"`.
6. Follow [../references/approval-mode.md](../references/approval-mode.md): present the `approvalUrl` neutrally ("Approve Transaction"), wait for the user to confirm approval, and call `get_request_status` once with `requestId`.
7. Once approved, call Wallet MCP `complete_x402_request` to receive the verdict JSON.
8. Report `verdict`, `reasonCodes`, key `evidence` fields, `limitations`, `validUntilBlock`, and `artifactId` neutrally to the user:
   - If `verdict` is `"block"`, stop and do not proceed to `swap` or `send_calls`.
   - If `verdict` is `"review"`, highlight the specific `reasonCodes` and `limitations` and require explicit user confirmation before any follow-up action.
   - If `verdict` is `"allow"`, present the findings and `limitations`, then ask the user whether to proceed with the separate `swap` or `send_calls` step.

### Free artifact lookup

1. When given an existing `artifactId` (`sha256:...`), call `GET https://www.tereno.xyz/api/v1/evidence/{artifactId}` via the harness HTTP tool or `web_request`.
2. Report the stored `verdict`, `validUntilBlock`, and whether the artifact is still within its validity window.

## Submission

Target tools: **`initiate_x402_request`** and **`complete_x402_request`** for paid verification; **`none`** for free discovery reads.

- Pass the exact capability invoke URL (`https://www.tereno.xyz/api/v1/capabilities/<capabilityId>/invoke?address=<0xAddress>&via=wallet-mcp`) and `method: "GET"` to `initiate_x402_request`.
- Do not use `send_calls` to send a raw ERC-20 USDC transfer to `payTo`: a standalone token transfer is not bound to an x402 challenge and will not return a verification response.
- Tereno never returns transaction calldata. If the user decides to buy a token or call a contract after reviewing a verdict, route that separate action through Wallet MCP `swap` or another plugin's `send_calls` flow with its own approval step per [../references/approval-mode.md](../references/approval-mode.md).

## Example Prompts

**"Before I swap ETH for token `0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed` on Base, check its launch liquidity and exit simulation with Tereno."**
1. Call `GET https://www.tereno.xyz/api/v1/capabilities/price?capability=token.launch.guard&address=0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed&via=wallet-mcp` and show the user the quoted USDC cost.
2. After the user confirms the check, call `initiate_x402_request` on `GET https://www.tereno.xyz/api/v1/capabilities/token.launch.guard/invoke?address=0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed&via=wallet-mcp`.
3. Present the `approvalUrl` ("Approve Transaction"), wait for user confirmation, check `get_request_status`, and call `complete_x402_request`.
4. Report `verdict`, `reasonCodes`, simulated buy/sell results, LP status, and `limitations`. Do not call `swap` unless the user explicitly asks to proceed and specifies an amount.

**"Check top holder concentration and deployer funding clusters on Base for `0x532f27101965dd16442E59d40670FaF5eBB142E4` using Tereno, then swap 10 USDC for it if I approve."**
1. Fetch the live quote for `token.holders.guard` on `0x532f27101965dd16442E59d40670FaF5eBB142E4` and confirm the USDC price with the user.
2. Run `initiate_x402_request` → approval flow → `complete_x402_request` for `GET https://www.tereno.xyz/api/v1/capabilities/token.holders.guard/invoke?address=0x532f27101965dd16442E59d40670FaF5eBB142E4&via=wallet-mcp`.
3. Summarize top-10 concentration, cluster findings, `reasonCodes`, and `limitations`.
4. If `verdict` is `"block"`, stop. Otherwise, ask the user to confirm executing the 10 USDC swap on Base before calling Wallet MCP `swap`.

**"Inspect contract `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` on Base with Tereno `contract.guard`."**
1. Quote `contract.guard` for `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` and confirm the price with the user.
2. Execute the paid `GET` request through `initiate_x402_request` and `complete_x402_request`.
3. Report proxy implementation details, pause status, selector flags, `verdict`, and `artifactId`.

**"Verify Tereno artifact `sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08`."** (free read, works on chat-only surfaces)
1. Call `GET https://www.tereno.xyz/api/v1/evidence/sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08` via the harness HTTP tool, `web_request`, or user-paste fallback.
2. Report the artifact's `verdict`, `capabilityId`, `validUntilBlock`, and receipt metadata without initiating any payment.

## Risks & Warnings

- **Irreversible x402 payments.** Settled x402 USDC payments on Base cannot be reversed. Always confirm the capability and quoted USDC amount with the user before calling `initiate_x402_request`. If a request times out after approval, check `get_request_status` first and never sign a new payment authorization automatically to retry an ambiguous outcome.
- **Low-liquidity and point-in-time limits.** Newly launched tokens on Base can lose liquidity, change proxy implementations, or activate owner controls in subsequent blocks. A `"allow"` or `"review"` verdict reflects state up to `validUntilBlock` and does not guarantee that a subsequent `swap` will succeed or fill near the quoted price. Always surface `limitations` and `validUntilBlock` alongside the verdict.
- **SSRF and input validation.** Validate that `address` parameters are 42-character hexadecimal EVM addresses (`^0x[a-fA-F0-9]{40}$`) and `artifactId` matches `^sha256:[a-f0-9]{64}$` before constructing request URLs. Only send requests to `https://www.tereno.xyz`.

## Notes

- **Chain:** Base mainnet (`chain: "base"`, `eip155:8453`, `chainId: 8453`).
- **Settlement asset:** USDC on Base (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, 6 decimals; `10000` atomic units = `$0.01`).
- **Pricing tiers:** Cache hits are quoted lower than cold cache misses because Tereno serves content-addressed artifacts within their `validUntilBlock` window. Always read the live quote from `/api/v1/capabilities/price` or the `402` challenge rather than assuming a static price; quoted offers are held for 90 seconds (`X-Tereno-Price-Valid-Until`).
- **OpenAPI & discovery:** `https://www.tereno.xyz/openapi.json` and `https://www.tereno.xyz/.well-known/x402`.
