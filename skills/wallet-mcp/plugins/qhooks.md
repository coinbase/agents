---
title: "QHooks Plugin"
description: "Read QHooks markets and stored token safety checks; prepare wallet-approved calls through QHooks MCP and Wallet MCP send_calls."
tags: [trading, token-launches, discovery, perps, agent-commerce]
name: qhooks
version: 0.1.0
integration: external-mcp
chains: [base, ethereum, arbitrum, bsc, robinhood-chain]
requires:
  shell: none
  allowlist: []
  externalMcp:
    name: qhooks
    transport: http
    url: https://qhooks.com/mcp
  cliPackage: null
auth: none
risk: [slippage, low-liquidity, irreversible]
---

# QHooks Plugin

> [!IMPORTANT]
> Complete Wallet MCP onboarding in `SKILL.md` before any plugin call. Use this plugin when the user names QHooks; keep per-action wallet approval enabled.

## Overview

QHooks provides token discovery, stored QProof safety checks, market and portfolio reads, and unsigned transaction preparation. This plugin connects the public QHooks MCP to Wallet MCP: reads stay read-only; supported EVM transaction plans map to `send_calls`, where the user approves in Coinbase Wallet. Its transaction chains are Base, Ethereum, Arbitrum, BNB (`bsc`) and Robinhood Chain (`robinhood-chain`), subject to a listed route and current tool availability. OTC escrow and conditional pay-when-done agreements are Robinhood Chain only. Launch preparation returns a QHooks review link. Perps market reads are available; perps order plans use a separate venue signing flow and must not be mapped into EVM calls.

## Detection

Confirm Wallet MCP is connected and discover its wallet, `send_calls` and request-status tools from its current catalog. Separately confirm the QHooks connector at `https://qhooks.com/mcp` is present. Read QHooks `tools/list` and the selected tool's exact schema at runtime; do not invent a tool or register every remote tool automatically. The live catalog is authoritative for feature availability. Do not send feedback, post content or enable a paid service as part of reading or preparing a transaction.

If either connector is missing, follow Installation. Do not impersonate an installed connector by sending ad hoc POSTs through a browser or Wallet MCP `web_request`.

## Installation

QHooks needs no API key, private key, seed phrase or login. Reuse an existing QHooks connection instead of adding duplicates. Wallet MCP has its own onboarding and approval flow.

For JSON-config clients such as Cursor, add this remote server entry:

```json
{
  "mcpServers": {
    "qhooks": {"type": "http", "url": "https://qhooks.com/mcp"}
  }
}
```

Claude Code: `claude mcp add --transport http qhooks https://qhooks.com/mcp`.

Codex: `codex mcp add qhooks --url https://qhooks.com/mcp`.

On Claude.ai, ChatGPT or a desktop client with remote MCP support, add a custom remote connection named QHooks with server URL `https://qhooks.com/mcp`, authentication none. Availability depends on that client's connection settings. If the client cannot add a remote connection, use the QHooks website or a supported harness; do not ask for keys or disable client controls.

## Surface Routing

| Capability and surface | Route |
|---|---|
| Reads or preparation, QHooks connector present | Call the selected QHooks tool using its advertised schema. No shell or HTTP host allowlist is required for this external-MCP path. |
| Chat-only surface, connector absent | Add the remote connector if supported; otherwise stop this tool flow and link the user to `https://qhooks.com`. |
| Raw EVM plan on an intersecting supported chain | Validate and map only the returned transaction array to Wallet MCP `send_calls`; show its approval link. |
| Launch link, perps order plan, or nonintersecting chain | Use the returned QHooks review link or appropriate site flow; do not invent calldata or silently switch chains. |

This plugin uses the external-MCP path, not the HTTP fallback. See [custom-plugins.md](../references/custom-plugins.md) for the separate harness HTTP / allowlisted `web_request` / GET-only user-paste rules. A denied POST cannot be repaired by changing it into a GET or asking the user to paste a POST URL.

## Orchestration

1. Confirm that the user selected QHooks and identify read, launch-link, or EVM-prepare intent. Read the chosen QHooks tool's schema. Obtain an address from Wallet MCP `get_wallets` only when the operation needs one; verify the requested chain is present in that wallet's supported capabilities.
2. Read token/market data and the stored QProof result when relevant. Preserve unavailable, stale, partial and unknown findings; a stored safety verdict is not a new scan or an audit. Resolve token addresses, decimal units, amounts, recipient/counterparty, fees, slippage and agreement conditions with the user. Do not change the referrer or add a reward claim.
3. Call the available preparation tool with that wallet as the actor. Amount fields use the units in the selected schema: spot trade input is a raw integer string; OTC/agreement amounts are exact decimal strings. Keep the original result. Re-read/re-prepare after wallet, chain, quote, balance, terms or approval state changes.
4. Inspect the returned chain, actor, targets, values, calldata, allowance, fees, deadlines and simulation results. For `approval_required`, submit only the approval returned now, wait for confirmation, then re-prepare the original action. Do not append a guessed dependent action. Never infer an OTC deal or agreement ID; read the confirmed creation receipt.
5. For a valid raw EVM plan, use Submission below. For a launch `link`, present the QHooks review page; no `send_calls` is needed. Perps order objects, typed-data payloads, site-only flows, unavailable builders and unsupported chains stop this EVM submission path.
6. After user confirmation, call Wallet MCP `send_calls` once, present its approval URL, and follow [approval-mode.md](../references/approval-mode.md). Wait for approval, then check the original request ID. Report completion only after confirmed success. Unknown outcomes retain the original ID for reconciliation; do not submit a new batch.

## Submission

Target: **Wallet MCP `send_calls`**, using its advertised parameter schema and the EIP-5792 mapping in [batch-calls.md](../references/batch-calls.md). No QHooks tool signs or broadcasts. Do not replace this route with Wallet MCP's semantic `swap`, which would lose the original QHooks plan and fee/referral terms.

Extract the selected QHooks tool result from `structuredContent`; stop if the MCP result has `isError`. The example below accepts the spot/OTC `transactions` shape and agreement `txs` shape. It preserves order, discards transaction-envelope fields, checks actor/chain consistency, and converts only exact integer strings or safe integers to hex wei. It does not execute anything. Inspect the tool's current result before using it; an unfamiliar shape stops rather than guessing.

```javascript
function qhooksCalls(plan, walletAddress, nowSeconds = Math.floor(Date.now() / 1000)) {
  const chains = {"1":"ethereum", "8453":"base", "42161":"arbitrum", "56":"bsc", "4663":"robinhood-chain"};
  const address = v => typeof v === "string" && /^0x[0-9a-f]{40}$/i.test(v) && !/^0x0{40}$/i.test(v);
  const fail = () => { throw Error("Unsupported or inconsistent QHooks plan; re-read and review."); };
  if (!plan || plan.ok === false || plan.isError || plan.unsigned === false || !address(walletAddress)) fail();
  if (plan.status !== undefined && !["prepared", "approval_required"].includes(plan.status)) fail();
  for (const actor of [plan.trader, plan.payer, plan.actor]) if (actor !== undefined && (!address(actor) || actor.toLowerCase() !== walletAddress.toLowerCase())) fail();
  const id = String(plan.chainId ?? plan.chain), chain = chains[id];
  if (!chain || plan.chain !== undefined && plan.chainId !== undefined && String(plan.chain) !== id) fail();
  if (plan.deadline !== undefined && (!Number.isSafeInteger(plan.deadline) || plan.deadline <= nowSeconds)) fail();
  if (plan.transactions !== undefined && plan.txs !== undefined) fail();
  const txs = plan.transactions ?? plan.txs;
  if (!Array.isArray(txs) || !txs.length || txs.length > 16) fail();
  const calls = txs.map(tx => {
    if (!tx || !address(tx.to) || tx.chainId !== undefined && String(tx.chainId) !== id) fail();
    const from = tx.from ?? plan.trader ?? plan.payer ?? plan.actor;
    if (!address(from) || from.toLowerCase() !== walletAddress.toLowerCase()) fail();
    if (typeof tx.data !== "string" || !/^0x(?:[0-9a-f]{2})*$/i.test(tx.data)) fail();
    const raw = tx.value ?? "0x0";
    if (!(typeof raw === "string" && /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(raw)) && !(Number.isSafeInteger(raw) && raw >= 0)) fail();
    const value = BigInt(raw);
    if (value < 0n || value >= 1n << 256n) fail();
    return {to:tx.to, value:"0x" + value.toString(16), data:tx.data};
  });
  return {chain, calls};
}
```

Pass the returned `{chain,calls}` as the input to `send_calls` only after step 4's review and explicit user confirmation. Use the currently connected wallet on that chain; a matching address alone does not establish chain support. Preserve approvals before actions, including a complete simulated batch when the server actually supplies one. A partially staged approval remains staged. Perps typed data and launch links have no transaction array and are not convertible by this helper.

## Example Prompts

- **“Use QHooks to check this Base token's stored safety verdict.”** 1. Select the advertised stored-proof read and exact token. 2. Return its existing verdict, age and unknown fields. 3. Do not prepare or submit a transaction.
- **“Prepare a QHooks buy on Base for 0.001 ETH; let me approve it.”** 1. Get the Base wallet and listed pool/quote. 2. Convert ETH input to the raw units required by the schema and prepare with the user's chosen slippage. 3. Review and map the actual returned calls. 4. Submit once through `send_calls`, then follow the user's approval and original request ID.
- **“Use QHooks to pay this contractor on Robinhood Chain when I attest delivery.”** 1. Confirm payer, payee, asset, exact amount, attestor, expiry and condition. 2. Prepare only a currently advertised agreement flow. 3. If approval is staged, approve that transaction, confirm, and re-prepare. 4. Create/fund through `send_calls`; later attestation and release each need their own explicit user request, current state check and wallet approval.
- **“Launch a token on QHooks from this chat.”** 1. Confirm metadata and chain. 2. Use the advertised launch preparation. 3. Show its review link for the site/wallet flow. 4. If the connector is unavailable, use the site; do not turn a rejected MCP POST into a pasted URL workaround.

## Risks & Warnings

- **Slippage:** review minimum output, fee and deadline against the user's chosen limits. Stop on an expired or failed quote; never increase slippage or change a target silently.
- **Low liquidity:** show available liquidity and stored QProof findings, including missing/stale evidence. Ask the user to confirm the token and amount before preparation; never call a token safe or auto-buy because it is listed.
- **Irreversible:** confirm chain, signer, spender, counterparties, amount, fees and agreement conditions before every wallet action. No keys belong in chat or QHooks. Do not auto-attest, auto-release, auto-refund or resubmit an uncertain request.

## Notes

QHooks service flags, rate limits and tool schemas remain authoritative. A 429 means honor Retry-After; unavailable data is not zero. Current usage limits and fee terms are documented at `https://qhooks.com/skill.md`. Market reads can cover more networks than this Wallet MCP transaction intersection: Monad, Elysium and Solana do not become supported `send_calls` chains merely because QHooks lists them. This spec requires no paid API, subscription or facilitator. Onchain gas and the fee disclosed in a user-approved plan still apply.
