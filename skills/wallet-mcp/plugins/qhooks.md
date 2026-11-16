---
title: "QHooks Plugin"
description: "Read QHooks markets and stored token safety checks; prepare wallet-approved calls through QHooks MCP and Wallet MCP send_calls."
tags: [trading, token-launches, discovery, perps, agent-commerce]
name: qhooks
version: 0.1.1
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

Extract the selected QHooks tool result from `structuredContent`; stop if the MCP result has `isError`. Retain `{tool, arguments}` from the original preparation call as `intent`; do not reconstruct it from the response. The example below accepts the spot/OTC `transactions` shape and agreement `txs` shape. It preserves order, discards transaction-envelope fields, checks actor/chain consistency, derives a missing envelope chain only from consistent explicit transaction chain IDs, and converts only exact integer strings or safe integers to hex wei. Spot plans must carry the new per-transaction chain IDs and `qhooks.trade-plan.v1` integrity metadata; older responses fail closed until the corresponding QHooks server release. The unsigned SHA-256 digest detects modification and is not a server signature or trusted price source. The independent decoder checks the requested token, side, amount, quote-derived minimum/slippage, account, manager, fee, referrer, expiry and native value; exact approvals target only the pinned fee router. The supported route is a single-hop swap with empty hook data, optionally preceded by one exact-amount approval. Unknown selectors, Permit2 execution and extra wallet-operation fields stop. Output is paid to `msg.sender`, so there is no invented trader ABI argument. The OTC/agreement branch retains its prior staged review and simulation rules; this spot validator does not replace their contract-specific review. It does not execute anything. Inspect the tool's current result before using it; an unfamiliar shape stops rather than guessing.

```javascript
const qhooksCalls = (() => {
const policies = {
  "1": {manager:"0x000000000004444c5dc75cb358380d2e3de08a90"},
  "8453": {manager:"0x498581ff718922c3f8e6a244956af099b2652b2b"},
  "42161": {manager:"0x360e68faccca8ca495c1b759fd9eee466db9fb32"},
  "56": {manager:"0x28e2ea090877bf75740558f6bfb36a5ffee9e9df"},
  "4663": {manager:"0x8366a39cc670b4001a1121b8f6a443a643e40951"}
};
for (const policy of Object.values(policies)) Object.assign(policy, {
  feeRouter:"0x79d211f5137d22b0fe3bfda81fbb8b7f53248bff",
  permit2:"0x000000000022d473030f116ddee9f6b43ac78ba3"
});
const ZERO = '0x' + '0'.repeat(40);
const ADDRESS = /^0x[0-9a-f]{40}$/i, HEX = /^0x(?:[0-9a-f]{2})*$/i;
const UINT = /^(0|[1-9][0-9]*)$/, U128 = 1n << 128n;
const fail = () => { throw new Error('QHooks unsigned plan does not match the request.'); };
const addr = value => typeof value === 'string' && ADDRESS.test(value) ? value.toLowerCase() : fail();
function uint(value, limit = 1n << 256n) {
  if (typeof value !== 'string' || !UINT.test(value) || value.length > 78) fail();
  const n = BigInt(value); if (n >= limit) fail(); return n;
}
function valueOf(value) {
  if (typeof value !== 'string' || !/^(?:0x[0-9a-f]+|0|[1-9][0-9]*)$/i.test(value) || value.length > 78) fail();
  const n = BigInt(value); if (n >= 1n << 256n) fail(); return n;
}
function words(data, selector, count) {
  if (typeof data !== 'string' || !HEX.test(data) || data.slice(0, 10).toLowerCase() !== selector || data.length !== 10 + count * 64) fail();
  return Array.from({ length: count }, (_, i) => data.slice(10 + i * 64, 74 + i * 64).toLowerCase());
}
const wordAddress = word => /^0{24}[0-9a-f]{40}$/.test(word) ? '0x' + word.slice(24) : fail();
const number = word => BigInt('0x' + word);
function signed24(word) {
  let n = number(word); if (n >= 1n << 255n) n -= 1n << 256n;
  if (n < -(1n << 23n) || n >= 1n << 23n) fail(); return n;
}

// Shared server format. A digest detects accidental modification; it is NOT a
// server signature or a substitute for the independent request/ABI checks below.
async function qhooksTradeHash(plan) {
  const tuple = ['qhooks.trade-plan.v1', String(plan.chainId), addr(plan.trader),
    plan.transactions.map(tx => [String(tx.chainId), addr(tx.to), tx.data.toLowerCase(), valueOf(tx.value).toString(), tx.from === undefined ? null : addr(tx.from)])];
  if (!globalThis.crypto?.subtle) fail();
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(tuple)));
  return '0x' + Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

async function qhooksValidateTrade(plan, input, walletAddress, nowSeconds) {
  const chain = String(input.chain), policy = policies[chain]; if (!policy) fail();
  const now = nowSeconds * 1000, trader = addr(input.trader), token = addr(input.token);
  if (trader !== addr(walletAddress)) fail();
  const amount = uint(input.amountIn, U128), slippage = input.slippageBps ?? 100;
  if (amount === 0n || !['buy', 'sell'].includes(input.side) || !Number.isInteger(slippage) || slippage < 0 || slippage > 9999) fail();
  if (!plan || String(plan.chainId) !== chain || String(plan.chain) !== chain || addr(plan.trader) !== trader || addr(plan.token) !== token || plan.side !== input.side || plan.amountIn !== input.amountIn || plan.slippageBps !== slippage) fail();
  const minimum = uint(plan.minOut, U128), inputCurrency = addr(plan.inputCurrency), feeOnInput = input.side === 'buy';
  const q = plan.quote;
  if (!q || String(q.chainId) !== chain || addr(q.trader) !== trader || typeof q.zeroForOne !== 'boolean' || q.routerFeeBps !== 100 || q.source !== 'V4Quoter') fail();
  const gross = uint(q.grossAmountOut, U128), net = uint(q.netAmountOut, U128);
  if (minimum === 0n || gross === 0n || net !== gross - (feeOnInput ? 0n : gross * 100n / 10000n) || minimum !== net * BigInt(10000 - slippage) / 10000n || uint(q.amountOut, U128) !== gross || uint(q.amountIn, U128) !== amount - (feeOnInput ? amount * 100n / 10000n : 0n)) fail();
  if (!Number.isSafeInteger(plan.deadline) || !Number.isFinite(now) || plan.deadline <= Math.floor(now / 1000) || plan.deadline > Math.floor(now / 1000) + 660) fail();
  const txs = plan.transactions;
  if (!Array.isArray(txs) || txs.length < 1 || txs.length > 2) fail();
  const allowed = new Set([inputCurrency, policy.feeRouter, policy.permit2]);
  for (const tx of txs) {
    if (!tx || Object.keys(tx).some(k => !['chainId', 'to', 'data', 'value', 'from'].includes(k)) || String(tx.chainId) !== chain || !allowed.has(addr(tx.to)) || tx.from !== undefined && addr(tx.from) !== trader || typeof tx.data !== 'string' || !HEX.test(tx.data)) fail();
    valueOf(tx.value);
  }
  if (txs.length === 2) {
    const approve = txs[0], w = words(approve.data, '0x095ea7b3', 2);
    if (inputCurrency === ZERO || addr(approve.to) !== inputCurrency || wordAddress(w[0]) !== policy.feeRouter || number(w[1]) !== amount || valueOf(approve.value) !== 0n) fail();
  }
  const swap = txs.at(-1), w = words(swap.data, '0xf5ec7c4b', 19);
  // Fixed canonical layout: nine top-level words, one dynamic hop, empty hookData.
  if (addr(swap.to) !== policy.feeRouter || wordAddress(w[0]) !== policy.manager || number(w[1]) !== 288n || number(w[2]) !== amount || number(w[3]) !== minimum || wordAddress(w[4]) !== ZERO || number(w[5]) !== (feeOnInput ? 1n : 0n) || number(w[6]) !== 100n || number(w[7]) !== BigInt(plan.deadline) || wordAddress(w[8]) !== addr(input.referrer ?? ZERO) || number(w[9]) !== 1n || number(w[10]) !== 32n || number(w[13]) >= 1n << 24n || signed24(w[14]) <= 0n || number(w[16]) !== (q.zeroForOne ? 1n : 0n) || number(w[17]) !== 224n || number(w[18]) !== 0n) fail();
  const currency0 = wordAddress(w[11]), currency1 = wordAddress(w[12]); wordAddress(w[15]);
  const [currencyIn, currencyOut] = q.zeroForOne ? [currency0, currency1] : [currency1, currency0];
  if (BigInt(currency0) >= BigInt(currency1) || currencyIn !== inputCurrency || (feeOnInput ? currencyOut !== token : currencyIn !== token) || valueOf(swap.value) !== (inputCurrency === ZERO ? amount : 0n)) fail();
  // swap() returns output to msg.sender; it has no trader/recipient calldata field.
  // plan.trader, quote.trader and any tx.from are bound to the actual Oak account.
  if (plan.integrity?.schema !== 'qhooks.trade-plan.v1' || plan.integrity.algorithm !== 'sha256' || !/^0x[0-9a-f]{64}$/.test(plan.integrity.hash || '') || (await qhooksTradeHash(plan)) !== plan.integrity.hash) fail();
  return plan;
}

async function qhooksCalls(plan, intent, walletAddress, nowSeconds = Math.floor(Date.now() / 1000)) {
  const supported = new Set(["prepare_trade", "otc_create", "otc_accept", "deal_status", "agreement_create", "agreement_fund", "agreement_attest", "agreement_release", "agreement_refund", "agreement_status", "agreement_from_template"]);
  if (!intent || !supported.has(intent.tool) || !intent.arguments || typeof intent.arguments !== "object" || Array.isArray(intent.arguments)) throw Error("Keep the original tool name and arguments before preparing.");
  const requested = intent.arguments;
  const chains = {"1":"ethereum", "8453":"base", "42161":"arbitrum", "56":"bsc", "4663":"robinhood-chain"};
  const address = v => typeof v === "string" && /^0x[0-9a-f]{40}$/i.test(v) && !/^0x0{40}$/i.test(v);
  const fail = () => { throw Error("Unsupported or inconsistent QHooks plan; re-read and review."); };
  if (!plan || plan.ok === false || plan.isError || plan.unsigned === false || !address(walletAddress)) fail();
  if (plan.status !== undefined && !["prepared", "approval_required", "unfunded_creation_prepared"].includes(plan.status)) fail();
  for (const actor of [plan.trader, plan.payer, plan.actor]) if (actor !== undefined && (!address(actor) || actor.toLowerCase() !== walletAddress.toLowerCase())) fail();
  if (plan.deadline !== undefined && (!Number.isSafeInteger(plan.deadline) || plan.deadline <= nowSeconds)) fail();
  if (plan.transactions !== undefined && plan.txs !== undefined) fail();
  const txs = plan.transactions ?? plan.txs;
  if (!Array.isArray(txs) || !txs.length || txs.length > 16) fail();
  if (intent.tool === "prepare_trade") await qhooksValidateTrade(plan, requested, walletAddress, nowSeconds);
  // OTC/agreements retain their existing staged review/simulation flow on RH.
  // A remote response cannot select this branch in place of a requested trade.
  else if (String(requested.chain ?? "4663") !== "4663") fail();
  const envelopeChain = plan.chainId ?? plan.chain;
  const id = String(envelopeChain ?? txs[0]?.chainId), chain = chains[id];
  if (id !== String(requested.chain ?? "4663")) fail();
  if (!chain || plan.chain !== undefined && plan.chainId !== undefined && String(plan.chain) !== id) fail();
  if (envelopeChain === undefined && txs.some(tx => String(tx?.chainId) !== id)) fail();
  const calls = txs.map(tx => {
    if (!tx || !address(tx.to) || tx.simulation?.ok === false || tx.chainId !== undefined && String(tx.chainId) !== id) fail();
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
return qhooksCalls;
})();
```

Call `await qhooksCalls(plan, intent, walletAddress)`. Pass the returned `{chain,calls}` as the input to `send_calls` only after step 4's review and explicit user confirmation. Use the currently connected wallet on that chain; a matching address alone does not establish chain support. Preserve approvals before actions, including a complete simulated batch when the server actually supplies one. A partially staged approval remains staged. `unfunded_creation_prepared` creates an OTC deal without a deposit; never report it as funded or settled. A status read can return `nextActions`: only after the user selects a specific action, use its non-null `transaction` with `simulation.ok: true`, wrapped as `{status:"prepared", unsigned:true, transactions:[selected.transaction]}`. Never auto-pick an action or infer a missing chain. Perps typed data and launch links have no transaction array and are not convertible by this helper.

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
