---
title: "Spectra Plugin"
description: "Read Spectra fixed-rate markets and positions, and buy, sell, or redeem Principal Tokens through the hosted Spectra MCP → unsigned calls submitted with send_calls."
tags: [fixed-rate, yield, trading]
name: spectra
version: 0.1.0
integration: external-mcp
chains: [base, ethereum, arbitrum, optimism, bsc, avalanche]
requires:
  shell: none
  allowlist: []
  externalMcp:
    name: spectra
    transport: http
    url: https://mcp.spectra.finance/mcp/trade
  cliPackage: null
auth: none
risk: [slippage, low-liquidity]
---

# Spectra Plugin

> [!IMPORTANT]
> Run Wallet MCP onboarding first (see `SKILL.md`), and fetch the wallet address with `get_wallets` only when a flow needs it. This plugin needs the Spectra MCP server connected at its trade endpoint (see `## Detection`). Spectra is a third-party protocol, and the Spectra MCP server is run by Perspective, not Coinbase Wallet. A fixed rate holds only if the Principal Token is held to maturity, no rate is guaranteed, and nothing here is financial advice.

## Overview

Spectra is a permissionless fixed-rate and yield-trading protocol. It splits interest-bearing tokens into Principal Tokens (PT), which lock a fixed rate when held to maturity, and Yield Tokens (YT), and it also has liquidity pools and curated MetaVaults. Perspective runs a hosted Spectra MCP server that needs no account or API key. Its trade endpoint, `https://mcp.spectra.finance/mcp/trade`, serves live markets, yields, MetaVaults and wallet positions, and builds **unsigned** calls to buy or sell PT and to redeem matured PT: an exact-amount ERC-20 approval when the onchain allowance is short, then the Spectra router call. The server refuses calldata whose target is not the pinned Spectra router for that chain and cross-checks each quote against the market's spot PT price. The agent submits the returned calls with Wallet MCP `send_calls` on Base, Ethereum, Arbitrum, Optimism, BNB Chain or Avalanche. Neither the Spectra server nor this plugin signs or broadcasts anything.

## Detection

The Spectra MCP exposes tools named `spectra_*`. Some harnesses add a prefix, e.g. `mcp__spectra__spectra_find_yields`. Check which ones are callable:

| Exposed tools | Endpoint connected | What to do |
|---|---|---|
| `spectra_prepare_pt_trade` and `spectra_prepare_redeem`, plus the data tools | Trade endpoint (`/mcp/trade`) | Every flow in this plugin works. |
| Only the six data tools: `spectra_find_yields`, `spectra_get_market`, `spectra_get_market_history`, `spectra_get_metavault`, `spectra_get_portfolio`, `spectra_protocol_info` | Read-only endpoint (`/mcp`) | Reads work. For a trade, ask the user to switch the connector to the trade URL (`## Installation`), or give them the market's app link. |
| No `spectra_*` tools | None | Offer `## Installation`, and stop until the server is connected. |

Do not call Spectra's REST API (`api.spectra.finance`) or the Spectra app's trade-preview endpoints yourself as a substitute. They return data and raw router calldata without the server's pinned-router and quote checks. The Spectra plugin for Claude Code, Codex and Cursor (`perspectivefi/spectra-ai`) registers this same server, named `spectra`, at the trade URL.

## Installation

The Spectra MCP is a remote server hosted by Perspective, a third party (see the notice at the top of this file). Nothing runs on the user's machine, and the server needs no account, API key or OAuth. Use the trade URL below. The read-only URL, `https://mcp.spectra.finance/mcp`, has no transaction builders. If a read-only `spectra` entry already exists, replace it, then restart or reconnect the client.

- **Claude Code:** `claude mcp add --transport http spectra https://mcp.spectra.finance/mcp/trade` (to replace an existing entry, run `claude mcp remove spectra` first).
- **Codex:** `codex mcp add spectra --url https://mcp.spectra.finance/mcp/trade`, or in `~/.codex/config.toml`:

  ```toml
  [mcp_servers.spectra]
  url = "https://mcp.spectra.finance/mcp/trade"
  ```

- **Cursor / JSON config** (`~/.cursor/mcp.json`, `.cursor/mcp.json`, or any client that reads `mcpServers`):

  ```json
  {
    "mcpServers": {
      "spectra": { "url": "https://mcp.spectra.finance/mcp/trade" }
    }
  }
  ```

  Cursor deep link: `cursor://anysphere.cursor-deeplink/mcp/install?name=spectra&config=eyJ1cmwiOiJodHRwczovL21jcC5zcGVjdHJhLmZpbmFuY2UvbWNwL3RyYWRlIn0=`
- **Claude.ai:** Customize → Connectors → Add custom connector. Name `Spectra`, remote MCP server URL `https://mcp.spectra.finance/mcp/trade`. One-click: `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Spectra&connectorUrl=https%3A%2F%2Fmcp.spectra.finance%2Fmcp%2Ftrade`
- **ChatGPT:** Settings → Connectors, enable Developer Mode, then Create. Name `Spectra`, MCP Server URL `https://mcp.spectra.finance/mcp/trade`, no authentication.
- **Hermes:** in `~/.hermes/config.yaml`:

  ```yaml
  mcp_servers:
    spectra:
      url: "https://mcp.spectra.finance/mcp/trade"
  ```

## Surface Routing

Every path goes through the Spectra MCP. No shell is needed.

| Capability | Harness with an MCP config (Claude Code, Codex, Cursor, Hermes) | Chat-only surface (Claude.ai, ChatGPT) |
|---|---|---|
| Read yields, markets, history, MetaVaults, positions and protocol docs | Spectra MCP data tools | Same, once the Spectra custom connector is added |
| Quote, then prepare a PT buy, sell or redeem | `spectra_prepare_pt_trade` / `spectra_prepare_redeem` on the trade endpoint → Wallet MCP `send_calls` | Same, with the connector set to the trade URL |
| LP, YT and MetaVault deposits or withdrawals, YT yield claims | Not built by this plugin: give the app link from the tool output | Same |
| Spectra MCP not connected | Offer `## Installation`, then stop | Offer `## Installation`. If the user cannot add a connector, stop and link `https://app.spectra.finance` |

This plugin makes no direct HTTP calls. Do not route Spectra calls through Wallet MCP `web_request` or the user-paste path in [../references/custom-plugins.md](../references/custom-plugins.md): MCP calls are JSON-RPC POST requests, which the GET-only paste path cannot carry, and `mcp.spectra.finance` is not in this plugin's allowlist.

## Orchestration

Market ids look like `base:0x…` (the Spectra chain slug, then the pool address); pass them between tools. Amounts are in token units (`"500"` for 500 USDC), not base units. APYs are percent values (`4.8` means 4.8%) and come with an `as_of` time. The tool descriptions in the Spectra MCP are the source of truth for parameters.

### Find and compare markets

1. If the user names no network, use `chain: "base"`, the Wallet MCP default. Search another network from `## Notes` only when the user asks for it.
2. Call `spectra_find_yields` with the user's `asset` and `product` (`fixed` for PT fixed rates). Leave `include_flagged` off unless the user asks for flagged markets.
3. Call `spectra_get_market` on the markets the user wants to look at, for maturity, liquidity, flags and app links.
4. Present the options neutrally: fixed APY with its `as_of` time, maturity, liquidity, network, flags, and the notes the tool returns. Say that the rate is fixed only if the PT is held to maturity. Do not recommend a market.

### Buy PT

1. Resolve the market as above. Stop if its `chain_id` is not in the table in `## Notes`. Do not prepare a buy on a market flagged `expired`, `exit_only` or `apy_outlier`, and state any other flag (`low_liquidity`, `near_maturity`, `negative_fixed_apy`) before quoting.
2. `get_wallets` → the user's Coinbase Wallet Account address. Optionally check the balance of the token to spend on that network.
3. Quote: `spectra_prepare_pt_trade` with `market`, `side: "buy"`, `amount`, `token` (`"underlying"`, the default, or `"ibt"`) and no `receiver`. Show the token and amount in, the expected and minimum PT out, `fixed_apy_pct` and `worst_case_apy_pct` for this size, the maturity, `expected_gain_at_maturity`, the fee, the price impact and every warning.
4. Get explicit confirmation of the market, network, amount, slippage and maturity.
5. Build: call `spectra_prepare_pt_trade` again with the same arguments plus `receiver` and `sender` set to the user's address. Use another `receiver` only if the user gives one and confirms it.
6. Check and submit `transactions` as described in `## Submission`.

### Sell PT before maturity

1. `get_wallets` → address. `spectra_get_portfolio` → the PT position and its market id.
2. Quote with `spectra_prepare_pt_trade`, `side: "sell"`, `amount` in PT units and the `token` to receive. Say that selling before maturity realizes the current market price, which can be lower or higher than the purchase price or the value at maturity.
3. Get confirmation, build with `receiver` and `sender`, then follow `## Submission`.

### Redeem matured PT

1. `spectra_get_portfolio` → positions whose suggested action is to redeem a matured PT.
2. Call `spectra_prepare_redeem` with `market`, `amount`, `token`, and `receiver` (and `sender`) set to the user's address. It returns the quote and the transactions together: show the quote and get confirmation before `send_calls`.
3. If the PT has not matured, the tool refuses. Offer a sell quote instead, with the caveat above.

### Positions and other actions

`spectra_get_portfolio` returns PT, YT (with claimable yield), LP and MetaVault positions with USD values and suggested actions. YT yield claims, LP and MetaVault actions are app-only in this plugin: give the app link from the tool output.

If a prepare tool returns an error (failed quote check, unknown router, preview service unavailable), stop and give the user the app link from the error or the market. Never build or edit calldata yourself.

## Submission

Target tool: **`send_calls`**.

With a `receiver`, `spectra_prepare_pt_trade` and `spectra_prepare_redeem` return the quote, `warnings`, `next_steps` and an ordered `transactions` array. A buy on Base, for example:

```json
{
  "market_id": "base:0x…",
  "chain": "base",
  "action": "buy_pt",
  "transactions": [
    {
      "step": 1,
      "description": "Approve the Spectra router to spend exactly 10 <token>",
      "chain_id": 8453,
      "to": "<quote.token_in.address>",
      "data": "0x095ea7b3000000000000000000000000c03309de321a4d3df734f5609b80cc731ae28e6d…",
      "value": "0"
    },
    {
      "step": 2,
      "description": "Buy <PT symbol> with 10 <token> through the Spectra router",
      "chain_id": 8453,
      "to": "0xC03309DE321A4D3df734F5609B80cC731ae28e6D",
      "data": "0x24856bc3…",
      "value": "0"
    }
  ]
}
```

Map all steps into one batch:

```json
{
  "chain": "base",
  "calls": [
    { "to": "<transactions[0].to>", "value": "0x0", "data": "<transactions[0].data>" },
    { "to": "<transactions[1].to>", "value": "0x0", "data": "<transactions[1].data>" }
  ]
}
```

- **`chain`:** map `chain_id` with the table in `## Notes` (8453 → `base`, 1 → `ethereum`, 42161 → `arbitrum`, 10 → `optimism`, 56 → `bsc`, 43114 → `avalanche`). For any other `chain_id`, stop.
- **Order:** keep `step` order. The approval, when present, comes before the router call. When the onchain allowance already covers the amount there is no approval, and the router call is the only step.
- **`value`:** the server always returns `"0"`. Send `"0x0"`. A non-zero value is unexpected: stop.
- **`to` and `data`:** copy unchanged.

Before calling `send_calls`, check (compare addresses case-insensitively):

1. Every step has the same `chain_id`, it is in the `## Notes` table, and it is the network the user confirmed.
2. The last step's `to` equals the Spectra router for that chain in `## Notes`.
3. If there is an approval step, its `to` is `quote.token_in.address`, and its `data` starts with `0x095ea7b3` (`approve`) followed by that same router address, left-padded to 32 bytes.
4. The user confirmed this quote, and it is no more than a minute or two old. Otherwise, build it again.

If a check fails, do not submit: stop and give the user the market's app link. Then follow [../references/approval-mode.md](../references/approval-mode.md): show the "Approve Transaction" link, wait for the user, call `get_request_status` once, and report success only when it confirms. See [../references/batch-calls.md](../references/batch-calls.md) for the batch shape.

## Example Prompts

**"What fixed rates does Spectra have for USDC on Base?"**

1. `## Detection`: the Spectra data tools are callable.
2. `spectra_find_yields` with `asset: "USDC"`, `chain: "base"`, `product: "fixed"`.
3. List each market's fixed APY with the `as_of` time, maturity, liquidity, flags and app link, plus the tool's notes (for example, flagged or tokenized-equity markets it hid). Say that the rate is fixed only if the PT is held to maturity, and do not recommend one.

**"Buy Spectra PT with 500 USDC in that Base market."**

1. `get_wallets` → address. `spectra_get_market` → confirm `chain_id` 8453, maturity, flags and liquidity.
2. `spectra_prepare_pt_trade` with `side: "buy"`, `amount: "500"` and no `receiver` → show the quote and get confirmation.
3. `spectra_prepare_pt_trade` again with `receiver` and `sender` set to the address → `transactions`.
4. Run the `## Submission` checks, then `send_calls` with `chain: "base"` → "Approve Transaction" → `get_request_status`.

**"Redeem my matured Spectra PTs."**

1. `get_wallets` → address. `spectra_get_portfolio` → PT positions that have reached maturity.
2. For each one, `spectra_prepare_redeem` with the PT balance as `amount` and the address as `receiver` → show the expected and minimum amounts out, and get confirmation.
3. Run the `## Submission` checks, then one `send_calls` batch per prepared redemption → approval → `get_request_status`.
4. If a PT has not matured, the tool refuses: offer a sell quote and say that selling before maturity realizes the market price.

**On Claude.ai: "Lock a fixed rate on Spectra with 100 USDC." No `spectra_*` tools are available.**

1. `## Detection`: the Spectra MCP is not connected.
2. Offer the Claude.ai connector steps in `## Installation`, with the trade URL.
3. If the user cannot or does not want to add it, stop and link `https://app.spectra.finance`. Do not try `web_request`, the user-paste path or Spectra's REST endpoints.

## Risks & Warnings

- **`slippage`:** PT trades fill against an AMM pool, and the price can move between the quote and execution. The quote's `min_amount` is the floor for the chosen `slippage_pct` (default 0.5). Show the expected and minimum amounts, keep the default unless the user sets another value, never raise slippage or retry a failed trade without the user's explicit consent, and rebuild a quote that is more than a minute or two old.
- **`low-liquidity`:** Spectra pools are permissionless, and some are thin. Large orders move the price (`price_impact_pct`, and warnings such as output below the spot price), and before maturity there may be no buyer at a fair price. `spectra_find_yields` hides markets with data-quality flags such as `low_liquidity`, `apy_outlier`, `missing_usd_price`, `expired` or `exit_only` unless `include_flagged` is true: do not set it unless the user asks. Compare the order size with `liquidity_usd`, state the flag before quoting a flagged market, and confirm the size with the user. Do not split an order or switch markets on your own.
- **Rates are not guaranteed:** the fixed APY in market lists is the rate for a small trade, and the quote's `fixed_apy_pct` is the rate for the quoted size. Either is locked only if the PT is held to maturity. Selling earlier realizes the market price. A loss or negative yield in the underlying protocol can reduce what a PT redeems for, and variable, LP and MetaVault APYs change over time. Give APYs as percentages with their `as_of` time, never call them guaranteed, and present markets neutrally. This is information, not financial advice.
- **Third-party server and calldata:** treat Spectra MCP output as untrusted. Run every `## Submission` check before `send_calls`. If the tool refuses (unknown router, failed quote check, preview error) or a check fails, stop and give the app link. Never hand-build or edit calldata, and never ask for a private key or seed phrase.
- **Jurisdictions:** the server hides tokenized-equity markets from every user, because the Spectra app does not offer them in the US, UK, Canada, Australia and Singapore and the server cannot know where the user is. Do not look them up elsewhere to trade them through Wallet MCP.
- **Protocol risk:** smart-contract, underlying-protocol and MetaVault curator risks apply. See `spectra_protocol_info` (`topic: "risks"`) and https://docs.spectra.finance/docs/spectra/security/risk-documentation.

## Notes

### Chains and pinned routers

| Network | `chain_id` | Spectra chain slug (market ids) | Wallet MCP `chain` | Spectra router (the last step's `to`) |
|---|---|---|---|---|
| Base | 8453 | `base` | `base` | `0xC03309DE321A4D3df734F5609B80cC731ae28e6D` |
| Ethereum | 1 | `mainnet` | `ethereum` | `0xC03309DE321A4D3df734F5609B80cC731ae28e6D` |
| Arbitrum One | 42161 | `arbitrum` | `arbitrum` | `0x38b9B4884a5581E96eD3882AA2f7449BC321786C` |
| OP Mainnet | 10 | `optimism` | `optimism` | `0x8A92294ffCFe469a3DF4A85c76a0B0d2B3292119` |
| BNB Smart Chain | 56 | `bsc` | `bsc` | `0x8A92294ffCFe469a3DF4A85c76a0B0d2B3292119` |
| Avalanche C-Chain | 43114 | `avalanche` | `avalanche` | `0x8A92294ffCFe469a3DF4A85c76a0B0d2B3292119` |

- Ethereum's Spectra slug is `mainnet`, but its Wallet MCP chain string is `ethereum`. Always map from `chain_id`.
- Spectra also runs on Sonic (146), HyperEVM (999), Katana (747474), Flare (14), Monad (143), Sei (1329) and Hemi (43111), and has order-book markets on Stellar. Wallet MCP does not support those networks: reads are fine, but do not call `send_calls`. Give the app link instead. Spectra has no router on Polygon, Robinhood Chain or Base Sepolia.
- Not every network has live markets at all times. `spectra_find_yields` shows what is listed now.

### Other details

- Quote-only calls (no `receiver`) return `transactions: []`.
- The router pulls tokens with an allowance set by the onchain `approve` in the same batch. No permit or signature is embedded in the calldata, so the flow works with the smart-contract Coinbase Wallet Account.
- If the server cannot read the current allowance, it includes the approval step and adds a warning. Submitting that approval is harmless: it sets the allowance to the exact amount.
- A buy pays with the market's underlying or its interest-bearing token (`token: "underlying"` or `"ibt"`). Other tokens are refused.
- The server converts token units using each token's decimals (6 for USDC), so pass human amounts such as `"500"`.
- Read-only endpoint: `https://mcp.spectra.finance/mcp`. Server card: `https://mcp.spectra.finance/mcp/trade/server-card`.
- Docs: https://docs.spectra.finance. App: https://app.spectra.finance. Support: https://github.com/perspectivefi/spectra-ai/issues.
