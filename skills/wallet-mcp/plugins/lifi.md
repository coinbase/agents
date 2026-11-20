---
title: "LI.FI Plugin"
description: "Cross-chain bridging and swaps via the LI.FI HTTP API → send_calls, with destination status tracking through /v1/status."
tags: [bridge, cross-chain, swap]
name: lifi
version: 0.1.0
integration: http-api
chains: [arbitrum, avalanche, base, bsc, ethereum, optimism, polygon]
requires:
  shell: none
  allowlist: [li.quest]
  externalMcp: null
  cliPackage: null
auth: none
risk: [slippage, irreversible]
---

# LI.FI Plugin

> [!IMPORTANT]
> Complete the short Wallet MCP onboarding flow defined in `SKILL.md` before calling any LI.FI endpoint. The user's wallet address is fetched lazily with `get_wallets` when a quote is needed.

## Overview

LI.FI is a bridge and DEX aggregator. One quote request picks a route across bridges (Across, Relay, Stargate, CCTP and others) and DEXs, so a user can move a token from one chain to another, or swap and bridge in a single step. The plugin calls `GET https://li.quest/v1/quote`, which returns **unsigned calldata** for the source chain. The plugin submits that calldata, with an ERC-20 approval when needed, through Wallet MCP's `send_calls`. After the source transaction confirms, `GET https://li.quest/v1/status` reports whether the funds arrived on the destination chain. Use this plugin when the source chain and the destination chain differ. For a same-chain swap, Wallet MCP's own `swap` tool is simpler.

## Surface Routing

| Capability | Harness surface (Claude Code, Codex, Cursor) | Chat-only surface (Claude.ai, ChatGPT) |
|---|---|---|
| `GET /v1/quote` (route + calldata) | Harness HTTP tool — no allowlist needed | `web_request` if `li.quest` is allowlisted; otherwise user-paste fallback (GET-only, see below) |
| `GET /v1/status` (destination tracking) | Harness HTTP tool | `web_request` if allowlisted; otherwise user-paste fallback |
| `GET /v1/token` (token lookup) | Harness HTTP tool | `web_request` if allowlisted; otherwise user-paste fallback |
| Submit bridge | `send_calls` — all surfaces | `send_calls` — all surfaces |

Every LI.FI call in this plugin is a GET with all inputs in the query string, so the user-paste fallback in [../references/custom-plugins.md](../references/custom-plugins.md) works when `li.quest` is not allowlisted: build the full quote URL, ask the user to paste it into the chat, then fetch and parse it. If the surface cannot fetch the pasted URL either, stop and link the user to [jumper.exchange](https://jumper.exchange). Do **not** improvise any other workaround.

## Endpoints

Base URL: `https://li.quest`. All endpoints are public GETs. An `x-lifi-api-key` header is optional and only raises rate limits; never ask the user for one, and never put one in a URL that the user must paste.

### GET /v1/quote

Returns the best route plus a ready-to-sign source-chain transaction.

```
GET https://li.quest/v1/quote
  ?fromChain={chainId}
  &toChain={chainId}
  &fromToken={address}
  &toToken={address}
  &fromAmount={amountInBaseUnits}
  &fromAddress={walletAddress}
  &toAddress={walletAddress}
  &slippage={decimal}
  &integrator=wallet-mcp
```

| Param | Required | Notes |
|---|---|---|
| `fromChain` / `toChain` | ✅ | Numeric chain IDs (see `## Notes`), not Wallet MCP chain strings. |
| `fromToken` / `toToken` | ✅ | Token address. Native token: `0x0000000000000000000000000000000000000000`. |
| `fromAmount` | ✅ | Integer string in base units. 10 USDC = `10000000`; 0.005 ETH = `5000000000000000`. |
| `fromAddress` | ✅ | The Wallet MCP address from `get_wallets`. |
| `toAddress` | recommended | Destination recipient. Defaults to `fromAddress`. Set it explicitly (see `## Risks & Warnings`). |
| `slippage` | recommended | Decimal fraction: `0.005` = 0.5%. |
| `integrator` | recommended | Attribution string. Pass `wallet-mcp`. |
| `order` | optional | `FASTEST` or `CHEAPEST`. A preference, not a guarantee. |

Response fields the plugin uses:

```json
{
  "tool": "across",
  "action": { "fromChainId": 1, "toChainId": 8453, "fromAmount": "20000000",
              "fromToken": { "address": "0xdAC1...1ec7", "symbol": "USDT", "decimals": 6 },
              "toToken":   { "address": "0x8335...2913", "symbol": "USDC", "decimals": 6 },
              "fromAddress": "0x...", "toAddress": "0x...", "slippage": 0.005 },
  "estimate": { "approvalAddress": "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",
                "toAmount": "19926526", "toAmountMin": "19926526",
                "executionDuration": 2, "feeCosts": [ ... ], "gasCosts": [ ... ] },
  "includedSteps": [ { "type": "protocol", "tool": "feeCollection" }, { "type": "cross", "tool": "across" } ],
  "transactionRequest": { "chainId": 1, "from": "0x...", "to": "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",
                          "value": "0x0", "data": "0x...", "gasLimit": "0x...", "gasPrice": "0x..." }
}
```

`transactionRequest.value` is already **hex**. Pass `data` byte-for-byte; never truncate or re-encode it.

### GET /v1/status

Tracks the transfer after the source transaction lands.

```
GET https://li.quest/v1/status?txHash={sourceTxHash}&fromChain={chainId}
```

Response fields: `status` (`NOT_FOUND`, `INVALID`, `PENDING`, `DONE`, `FAILED`), `substatus` (for `DONE`: `COMPLETED`, `PARTIAL` or `REFUNDED`), `sending.txHash`, `receiving.txHash`, `receiving.chainId`, `receiving.amount`, `receiving.token`, `lifiExplorerLink`.

`PARTIAL` means only part of the transfer completed, so the user can hold an intermediate token instead of the requested one. `REFUNDED` means the tokens were refunded. Report both plainly with `receiving.amount` and `receiving.token`; neither is a full delivery. `DONE` and `FAILED` are terminal.

An unknown hash can also come back as **HTTP 404** with error code `1003`. Treat it like `NOT_FOUND`.

### GET /v1/token (token resolution)

```
GET https://li.quest/v1/token?chain={chainId}&token={symbolOrAddress}
```

Returns `address`, `symbol`, `decimals`, `priceUSD`. Use it when a token is not in the `## Notes` table. Confirm the resolved address with the user when the symbol is ambiguous.

## Orchestration

### Bridge or swap-and-bridge

1. `get_wallets` → `walletAddress`.
2. Resolve the source and destination chains to chain IDs and Wallet MCP chain strings (`## Notes`). If either chain is not in this plugin's `chains`, stop and say so.
3. Resolve both tokens (`## Notes` table, then `GET /v1/token`). Convert the human amount to base units with the token's `decimals`.
4. `GET /v1/quote` with `fromAddress = toAddress = walletAddress` unless the user named another recipient.
5. Validate before showing anything:
   - `transactionRequest.chainId == action.fromChainId == fromChain`.
   - `transactionRequest.from` equals `walletAddress` (case-insensitive).
   - `transactionRequest.to` equals `estimate.approvalAddress` and equals the LI.FI Diamond `0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE`. Abort and warn if not.
   - `transactionRequest.value` equals the expected native amount: `fromAmount` for native input (`0` for ERC-20 input), plus the sum of every `estimate.feeCosts` entry whose `token.address` is the native token and whose `included` is `false`. Some bridges (for example Stargate's LayerZero fee) charge such a native fee on top of the transfer, so an ERC-20 transfer can carry a non-zero `value`.
6. Show the user: route (`tool`), amount sent, `estimate.toAmount` and `estimate.toAmountMin` on the destination chain, fees (`feeCosts`, calling out any native fee paid on top of the amount sent), estimated time (`executionDuration`), and the recipient. Ask for confirmation.
7. Build the `send_calls` batch (`## Submission`) and call `send_calls(chain, calls)` → approval URL + request ID.
8. Present the approval link and wait for the user, per [../references/approval-mode.md](../references/approval-mode.md).
9. `get_request_status(requestId)` once the user says they approved. Take the source-chain transaction hash from the result.
10. `GET /v1/status?txHash=…&fromChain=…`. If `PENDING`, tell the user the bridge is in flight with the expected time and offer to check again. Do not poll in a tight loop.
11. Report success only when `status == DONE` and `substatus == COMPLETED`, with `receiving.txHash` and `lifiExplorerLink`.

### Check a previous transfer

1. Ask for (or reuse) the source transaction hash and source chain.
2. `GET /v1/status` and report `status`, `substatus`, received amount and destination hash.

## Submission

Target tool: **`send_calls`**

The chain string is the Wallet MCP name of the **source** chain (`transactionRequest.chainId` mapped through `## Notes`). Drop `gasLimit`, `gasPrice` and `from`; Wallet MCP sets gas.

**ERC-20 input — approval + bridge in one batch (approval first):**

```json
{
  "chain": "base",
  "calls": [
    {
      "to": "<action.fromToken.address>",
      "value": "0x0",
      "data": "<approve(estimate.approvalAddress, action.fromAmount)>"
    },
    {
      "to": "<transactionRequest.to>",
      "value": "<transactionRequest.value>",
      "data": "<transactionRequest.data>"
    }
  ]
}
```

**Native input — bridge only:**

```json
{
  "chain": "base",
  "calls": [
    { "to": "<transactionRequest.to>", "value": "<transactionRequest.value>", "data": "<transactionRequest.data>" }
  ]
}
```

**ERC-20 approval calldata:**

```
Function: approve(address spender, uint256 amount)
Selector: 0x095ea7b3
spender:  000000000000000000000000{estimate.approvalAddress without 0x, lowercase}
amount:   {action.fromAmount as 32-byte hex, left-padded}

Example — approve 10 USDC (10000000 = 0x989680) to the LI.FI Diamond:
0x095ea7b3
  0000000000000000000000001231deb6f5749ef6ce6943a275a1d3e7486f4eae
  0000000000000000000000000000000000000000000000000000000000989680
```

Approve the exact `fromAmount`, never an unlimited amount. **USDT on Ethereum:** prepend `approve(spender, 0)` before the real approval, because USDT reverts when changing a non-zero allowance.

After `send_calls` returns, follow [../references/approval-mode.md](../references/approval-mode.md). A quote is short-lived: if more than about a minute passes before submission, or the user changes any input, fetch a new quote.

## Example Prompts

**"Bridge 10 USDC from Base to Arbitrum"**

1. `get_wallets` → address.
2. `GET /v1/quote` — fromChain=`8453`, toChain=`42161`, fromToken=`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, toToken=`0xaf88d065e77c8cC2239327C5EDb3A432268e5831`, fromAmount=`10000000`, slippage=`0.005`.
3. Run the validation checks; show route, `toAmountMin`, fees and ETA; confirm.
4. `send_calls("base", [approve(Diamond, 10000000), bridge_call])`.
5. After approval: `get_request_status` → source hash → `GET /v1/status?txHash=…&fromChain=8453` until `DONE`.

**"Move 0.005 ETH from Base to Arbitrum"**

1. `get_wallets` → address.
2. `GET /v1/quote` — fromChain=`8453`, toChain=`42161`, fromToken and toToken = `0x0000000000000000000000000000000000000000`, fromAmount=`5000000000000000`.
3. Check `transactionRequest.value` = `0x11c37937e08000` (= fromAmount, for a route with no extra native fee); confirm with the user.
4. `send_calls("base", [bridge_call])` — no approval for native input.

**"Swap 20 USDT on Ethereum into USDC on Base"**

1. `GET /v1/quote` — fromChain=`1`, toChain=`8453`, fromToken=`0xdAC17F958D2ee523a2206206994597C13D831ec7`, toToken=`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, fromAmount=`20000000`.
2. `send_calls("ethereum", [approve(Diamond, 0), approve(Diamond, 20000000), bridge_call])`.

**"Did my bridge from Base arrive?"** *(read-only)*

1. Take the source hash from the earlier `get_request_status` result or ask the user.
2. `GET /v1/status?txHash=…&fromChain=8453` → report `status`/`substatus`, `receiving.amount`, `receiving.txHash`, `lifiExplorerLink`.

## Risks & Warnings

- **Slippage** — The destination amount can be lower than `toAmount` when prices or bridge liquidity move. `toAmountMin` is the floor the route enforces. Default `slippage` to `0.005` for stablecoins and native-to-native bridges and `0.01` for routes that include a swap. Above `0.01`, state the value and ask the user to confirm. Above `0.05`, warn that the transfer can fill far below the quote and require the user to repeat the exact number. Never raise slippage silently after a failed quote.
- **Irreversible** — A submitted bridge cannot be cancelled. Before `send_calls`, confirm the destination chain, the destination token and the recipient address. If the user names a recipient other than their own wallet, read the address back to them in full. If `GET /v1/status` returns `FAILED` or `REFUNDED`, report it and link `lifiExplorerLink`; do not resubmit automatically.
- **Recipient on the destination chain** — Set `toAddress` explicitly. If the Wallet MCP account is a smart-contract account, the same address may not be deployed or controlled by the user on the destination chain. Unless the user confirms they control that address on the destination chain, ask them for the recipient.
- **Fees** — Show every entry in `estimate.feeCosts` before confirmation, including the LI.FI fee. Entries with `included: false` are paid on top of the amount sent (in `transactionRequest.value` for a native fee), so the wallet needs enough native token for them plus gas.

## Notes

**LI.FI Diamond (approval spender and `to`, same on all chains above):** `0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE`

**Native token:** `0x0000000000000000000000000000000000000000`

**Chain mapping (Wallet MCP string ↔ LI.FI chain ID):**

| Wallet MCP `chain` | LI.FI chain ID |
|---|---|
| `ethereum` | `1` |
| `optimism` | `10` |
| `bsc` | `56` |
| `polygon` | `137` |
| `base` | `8453` |
| `arbitrum` | `42161` |
| `avalanche` | `43114` |

`base-sepolia` is excluded because it is a testnet (LI.FI's `/v1/chains` lists it with `mainnet: false`). `robinhood-chain` is excluded until the Wallet MCP chain ID is confirmed against the LI.FI chain list.

**Common token addresses:**

| Token | Chain | Address |
|---|---|---|
| USDC | Base | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| USDC | Arbitrum | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` |
| USDC | Ethereum | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |
| USDC | Optimism | `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85` |
| USDC | Polygon | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` |
| USDT | Ethereum | `0xdAC17F958D2ee523a2206206994597C13D831ec7` |

**Gotchas:**

- LI.FI takes numeric chain IDs; `send_calls` takes chain strings. Map both ways with the table above.
- `transactionRequest.value` is hex already; do not hex-encode it again. It can be non-zero for ERC-20 input when the bridge charges a native fee (see the validation step in `## Orchestration`).
- `estimate.executionDuration` is in seconds and is an estimate. Some routes take minutes; tell the user before they approve.
- `GET /v1/status` may return `NOT_FOUND` for a short time after the source transaction confirms. Wait and check again; it is not a failure.
