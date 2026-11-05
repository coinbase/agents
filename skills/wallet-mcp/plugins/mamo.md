---
title: "Mamo Plugin"
description: "Tokenized stocks portfolio and Mamo Accounts on Base via the hosted Mamo MCP → unsigned calls submitted with send_calls; one sign-in (sign) to open an Account."
tags: [tokenized-stocks, yield, lending]
name: mamo
version: 0.1.0
integration: external-mcp
chains: [base]
requires:
  shell: none
  allowlist: []
  externalMcp:
    name: mamo
    transport: http
    url: https://mcp.mamo.bot/mcp
  cliPackage: null
auth: none
risk: [slippage, irreversible]
---

# Mamo Plugin

> [!IMPORTANT]
> Run Wallet MCP onboarding first (see `SKILL.md`). This plugin needs the Mamo MCP connected (see `## Detection`). Mamo is a third-party protocol, not operated by Coinbase Wallet. Tokenized stocks are offered only to eligible persons outside the US, and Mamo's Terms of Service apply, including section 7 (Tokenized Securities): https://docs.mamo.bot/legal/terms-of-service.

## Overview

[Mamo](https://mamo.bot) runs Accounts on Base: a stocks portfolio (tokenized stocks plus a USDC share, rebalanced toward targets the owner sets), USDC, Bitcoin and Ethereum Accounts that lend on Moonwell and Morpho, and a MAMO staking Account. The hosted Mamo MCP (`https://mcp.mamo.bot/mcp`, no auth) reads Accounts, previews every move, and returns **unsigned** calls. The agent submits them with Wallet MCP `send_calls`. Opening a USDC, Bitcoin, Ethereum or MAMO Account also takes one sign-in signature via Wallet MCP `sign`. Docs: https://docs.mamo.bot/technical/mamo-mcp

## Detection

If tools such as `get_mamo_guide`, `preview_stock_basket` and `prepare_sign_in` are available (possibly prefixed, e.g. `mcp__mamo__…`), the Mamo MCP is connected. If not, offer `## Installation` and stop. Never call Mamo's contracts or backend directly, and never build or edit calldata.

## Installation

Remote server, no account or API key. Add it under the name `mamo`:

- Claude Code: `claude mcp add --transport http mamo https://mcp.mamo.bot/mcp`
- Codex: `codex mcp add mamo --url https://mcp.mamo.bot/mcp`
- Cursor or any `mcpServers` JSON config:

  ```json
  { "mcpServers": { "mamo": { "url": "https://mcp.mamo.bot/mcp" } } }
  ```

- Claude.ai and ChatGPT: add a custom connector with URL `https://mcp.mamo.bot/mcp` and no authentication.

Install buttons and per-client steps: https://docs.mamo.bot/technical/mamo-mcp

## Surface Routing

| Capability | Any surface with the Mamo MCP connected (Claude Code, Codex, Cursor, Claude.ai, ChatGPT) |
|---|---|
| Reads | Mamo MCP read tools |
| Deposit, withdraw, claim, stocks portfolio | `preview_*` → `prepare_*` → Wallet MCP `send_calls` |
| Open a USDC, Bitcoin, Ethereum or MAMO Account | `prepare_sign_in` → Wallet MCP `sign` → `create_account` |

No shell or `web_request` is needed. If the user can't add the Mamo connector (for example on a chat-only surface), stop and link https://mamo.bot. Don't route Mamo calls through `web_request` or the user-paste path.

## Orchestration

- Get the address from `get_wallets`. `get_started` returns Mamo's tool map; the Mamo tool descriptions are the source of truth for parameters.
- `account` is `rwa-basket` (stocks portfolio), `usdc_stablecoin`, `cbbtc_lending`, `eth_lending` or `mamo_staking`. Amounts are decimal strings (`"100"`).
- Warnings: `error` blocks (stop and explain), `warning` must be read to the user before they approve, `info` is context. A `null` figure is unknown; never fill one in.
- If `prepare_*` answers `PREVIEW_EXPIRED`, preview again. If nothing changed, continue; otherwise confirm again.

### Read

`get_user_accounts({address})` for everything the wallet holds, `get_accounts()` for APY and status, `get_account_details({account})` and `get_mamo_guide({topic})` for how an Account works, fees and safety. Present options neutrally; never recommend an Account, a stock or a weight.

### Open or change a stocks portfolio

1. State the eligibility and terms notice above.
2. `get_account_details({account: "rwa-basket"})` → show the listed tokens and limits. Ask which stocks, what weights, and what USDC share.
3. `preview_stock_basket({address, entries: [{token, targetBps}], cashTargetBps})` (entries + cash = 10000) → read the warnings → confirm → `prepare_stock_basket({previewId})` → `## Submission`, all calls in one batch.
4. Fund it with the deposit flow (`account: "rwa-basket"`). Mamo rebalances it toward the targets; never promise a trade, a price or a time.

### Deposit or withdraw

1. `preview_deposit({address, account, amount})` or `preview_withdraw({address, account, amount | all: true})`. For a stocks withdrawal, the user chooses cash (sold on Aerodrome within `maxSlippageBps`) or `inKind: true`.
2. Read every warning and get explicit confirmation → `prepare_deposit` / `prepare_withdraw({previewId})` → `## Submission`. A stocks cash withdrawal carries an onchain deadline (`expiresAt`), so send it right away.
3. MAMO Account rewards: `prepare_claim_rewards({address})` → `## Submission` (no preview).

Set `allowThirdParty: true` only after the user confirms they mean to fund someone else's Account.

### Open a USDC, Bitcoin, Ethereum or MAMO Account

1. `prepare_sign_in({address, account})` → `message`.
2. Wallet MCP `sign` with `type: "personal_sign"` and `data: { message }`, exactly as returned → approval → `get_request_status` → `signature`.
3. `create_account({address, account, message, signature})` → `pending`, then poll `get_account_creation_status` until `ready`. If the signature is rejected, stop and link https://mamo.bot.

The signature moves no funds, but it does not expire and cannot be revoked. Pass it only to `create_account`.

## Submission

Target tools: `send_calls` for every `prepare_*` result, and `sign` for the sign-in above.

Each `prepare_*` returns `chainId: 8453` and an ordered `data.calls` array of `{to, data, value, gas, label}`. Map it to one batch, keeping the order:

```json
{ "chain": "base", "calls": [{ "to": "<to>", "value": "<value>", "data": "<data>" }] }
```

Copy `to`, `data` and `value` unchanged (`value` is already hex wei). Drop `gas` and `label`. Never split the batch: a new stocks portfolio's later calls run on the Account its first call creates.

Before sending, check:

1. `calls` is not empty and `chainId` is 8453.
2. Every `to` is `data.accountAddress`, the token being approved or deposited, WETH (Ethereum Account wrap or unwrap), or the stocks portfolio factory `0x54fa54F8bDE08A5718022ec878044EdcF97eD144` (first call of a `mode: "create"` batch only).
3. Approvals are `approve` (`0x095ea7b3`) with the Account as spender, or `approveCowRelayer` (`0x92cc1862`) on the Account itself. `value` is `0x0` except on the Ethereum Account's WETH wrap.

If a check fails, stop and link https://mamo.bot. Otherwise follow [../references/approval-mode.md](../references/approval-mode.md). After it confirms, pass the transaction hash to `get_transaction_status`, then re-read with `fresh: true`.

## Example Prompts

**"What do I have on Mamo?"**
1. `get_wallets` → address → `get_user_accounts({address})`.
2. List each Account, and the stocks portfolio's value, holdings and targets. Report any `null` figure as unknown.

**"Open a Mamo stocks portfolio with NVIDIA and Apple and put 100 USDC in it."**
1. State the eligibility and terms notice. `get_account_details({account: "rwa-basket"})` → confirm the weights and USDC share.
2. `preview_stock_basket` → confirm → `prepare_stock_basket` → `send_calls` (one batch) → approve.
3. `preview_deposit({address, account: "rwa-basket", amount: "100"})` → confirm → `prepare_deposit` → `send_calls` → approve → `get_transaction_status`.

**"Withdraw everything from my Mamo stocks portfolio."**
1. `preview_withdraw({address, account: "rwa-basket", all: true})` → ask whether the user wants cash or the stocks themselves (`inKind: true`).
2. Read the warnings → confirm → `prepare_withdraw({previewId})` → `send_calls` before `expiresAt` → approve.

## Risks & Warnings

- **`slippage`:** a stocks cash withdrawal sells on Aerodrome inside the transaction, bounded by `maxSlippageBps` (default 100). A worse fill reverts rather than filling. Never raise slippage or retry without the user's consent; offer an in-kind withdrawal instead.
- **`irreversible`:** sent calls can't be undone. Funding another owner's Account (`allowThirdParty`) gives them the money, and the sign-in signature can't be revoked. Confirm the Account, amount and warnings before the approval link.
- **Stocks:** offered to eligible persons outside the US only, under Mamo's Terms of Service (section 7). A portfolio's value moves with the stocks it holds; it has no APY.

## Notes

- Docs: https://docs.mamo.bot/technical/mamo-mcp · Help: https://help.mamo.bot · Contracts: https://docs.mamo.bot/technical/contract-addresses
- MCP Registry: `bot.mamo/mcp`. Server card: https://mcp.mamo.bot/
- Approvals are exact-amount. Rate limits are per IP; over a limit the server answers HTTP 429 with `Retry-After`.
