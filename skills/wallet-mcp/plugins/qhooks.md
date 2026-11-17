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

Extract the selected QHooks tool result from `structuredContent`; stop if the MCP result has `isError`. Retain `{tool, arguments}` from the original preparation call as `intent`; do not reconstruct it from the response. The example below accepts the spot/OTC `transactions` shape and agreement `txs` shape. It preserves order, discards transaction-envelope fields, checks actor/chain consistency, derives a missing envelope chain only from consistent explicit transaction chain IDs, and converts only exact integer strings or safe integers to hex wei. Spot plans must carry the new per-transaction chain IDs and `qhooks.trade-plan.v1` integrity metadata; older responses fail closed until the corresponding QHooks server release. The unsigned SHA-256 digest detects modification and is not a server signature or trusted price source. The independent decoder checks the requested token, side, amount, quote-derived minimum/slippage, account, manager, fee, referrer, expiry and native value; exact approvals target only the pinned fee router. The supported route is a single-hop swap with empty hook data, optionally preceded by one exact-amount approval. Unknown selectors, Permit2 execution and extra wallet-operation fields stop. Output is paid to `msg.sender`, so there is no invented trader ABI argument. The RH OTC/agreement branch pins the escrow/agreement target, actor, exact approval token/spender/amount, native value and supported selectors. It retains staged review and simulation; conditions and counterparty consent still require wallet review. The final `readQHooks` argument must be a trusted host function that invokes the already-connected QHooks MCP read tool and returns its decoded result. The mapper itself supplies the read arguments. It fetches token_info and then an independent quote from the original input; never substitute plan.quote or a model-supplied evidence object. OTC accept independently reads deal_status; custom agreement assets need independently returned decimals. Missing/refused/unknown reads stop the flow. This is not an HTTP fallback and adds no signer. It does not execute anything. Inspect the tool's current result before using it; an unfamiliar shape stops rather than guessing.

```javascript
const qhooksCalls = (() => {
const QHOOKS_SECURITY = (() => {
    const Z = `0x${"0".repeat(40)}`;
    const OTC = "0xbea24499f82f1e018a4dff5607b7c54141cbfbf8";
    const AGREEMENT = "0x9b6e579dd876c364bf232d2958d7cc45937809bf";
    const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
    const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
    const U128 = 1n << 128n;
    const fail = () => {
        throw Error("Independent QHooks plan validation failed.");
    };
    const row = (v) => v !== null && typeof v === "object" && !Array.isArray(v)
        ? v
        : fail();
    const addr = (v) => typeof v === "string" && /^0x[0-9a-f]{40}$/i.test(v)
        ? v.toLowerCase()
        : fail();
    const integer = (v, limit = U128) => {
        if (typeof v !== "string" || !/^(0|[1-9][0-9]*)$/.test(v) || v.length > 78)
            fail();
        const n = BigInt(v);
        return n < limit ? n : fail();
    };
    const val = (v) => {
        if (typeof v !== "string" ||
            !/^(?:0x[0-9a-f]+|0|[1-9][0-9]*)$/i.test(v) ||
            v.length > 78)
            fail();
        const n = BigInt(v);
        return n < 1n << 256n ? n : fail();
    };
    const array = (v, max) => Array.isArray(v) && v.length > 0 && v.length <= max ? v : fail();
    const asset = (v) => v === "ETH" ? Z : v === "WETH" ? WETH : v === "USDG" ? USDG : addr(v);
    const word = (data, i) => data.slice(10 + i * 64, 74 + i * 64);
    const wa = (v) => /^0{24}[0-9a-f]{40}$/.test(v) ? `0x${v.slice(24)}` : fail();
    const wn = (v) => /^[0-9a-f]{64}$/.test(v) ? BigInt(`0x${v}`) : fail();
    /**
     * Select the same listed pool as prepare_trade using a separate token_info response.
     *
     * @param input - Original caller arguments.
     * @param value - Independent token metadata.
     * @returns Canonical pool key and exact quote arguments.
     */
    function marketFor(input, value) {
        const meta = row(row(value).meta);
        const token = addr(input.token);
        const chain = String(input.chain);
        if (String(meta.chainId) !== chain || addr(meta.token) !== token)
            fail();
        const pools = array(meta.pools, 100).map(row);
        const p = pools.find((p) => p.label === "launch") ?? pools[0];
        const k = row(p.key);
        const id = p.id ?? p.poolId;
        if (typeof id !== "string" ||
            !/^0x[0-9a-f]{64}$/i.test(id) ||
            !Number.isSafeInteger(k.fee) ||
            Number(k.fee) < 0 ||
            Number(k.fee) >= 2 ** 24 ||
            !Number.isSafeInteger(k.tickSpacing) ||
            Number(k.tickSpacing) <= 0 ||
            Number(k.tickSpacing) >= 2 ** 23)
            fail();
        const c0 = addr(k.currency0);
        const c1 = addr(k.currency1);
        const hooks = addr(k.hooks);
        if (BigInt(c0) >= BigInt(c1) ||
            ![c0, c1].includes(token) ||
            !["buy", "sell"].includes(String(input.side)))
            fail();
        const direction = input.side === "buy" ? c1 === token : c0 === token;
        const amount = integer(input.amountIn);
        const quoted = amount - (input.side === "buy" ? (amount * 100n) / 10000n : 0n);
        if (amount === 0n || quoted === 0n)
            fail();
        return {
            chainId: chain,
            poolId: id.toLowerCase(),
            currency0: c0,
            currency1: c1,
            hooks,
            fee: Number(k.fee),
            tickSpacing: Number(k.tickSpacing),
            zeroForOne: direction,
            amountIn: quoted.toString(),
            trader: addr(input.trader),
        };
    }
    /**
     * Read pool identity and quote independently of the transaction plan.
     *
     * @param original - Original caller arguments.
     * @param read - Trusted client transport for read-only tools.
     * @returns Independent market identity and raw pool quote.
     */
    async function readTrade(original, read) {
        const input = row(original);
        const market = await read("token_info", {
            chain: input.chain,
            token: input.token,
        });
        const key = marketFor(input, market);
        const quote = await read("quote", {
            chain: key.chainId,
            pool: key.poolId,
            zeroForOne: key.zeroForOne,
            amountIn: key.amountIn,
            trader: key.trader,
        });
        return { key, quote };
    }
    /**
     * Bind decoded calldata and its minimum to independent market evidence.
     *
     * @param planValue - Returned unsigned plan.
     * @param inputValue - Original caller arguments.
     * @param decoded - Pool key decoded from swap calldata.
     * @param evidenceValue - Result of the separate client reads.
     * Throws before a plan can reach the wallet on any mismatch.
     */
    function checkTrade(planValue, inputValue, decoded, evidenceValue) {
        const p = row(planValue);
        const input = row(inputValue);
        const d = row(decoded);
        const e = row(evidenceValue);
        const k = row(e.key);
        const q = row(e.quote);
        const pq = row(p.quote);
        if (String(k.chainId) !== String(input.chain) ||
            addr(k.trader) !== addr(input.trader) ||
            String(q.chainId) !== String(input.chain) ||
            q.poolId !== k.poolId ||
            pq.poolId !== k.poolId ||
            q.zeroForOne !== k.zeroForOne ||
            pq.zeroForOne !== k.zeroForOne ||
            q.amountIn !== k.amountIn ||
            addr(q.trader) !== addr(input.trader))
            fail();
        for (const name of ["currency0", "currency1", "hooks"])
            if (addr(d[name]) !== addr(k[name]))
                fail();
        if (d.fee !== k.fee || d.tickSpacing !== k.tickSpacing)
            fail();
        if (q.stale === true ||
            q.refreshing === true ||
            q.state === "not_checked" ||
            q.partial === true)
            fail();
        const gross = integer(q.amountOut);
        const net = gross - (input.side === "sell" ? (gross * 100n) / 10000n : 0n);
        const s = input.slippageBps ?? 100;
        if (typeof s !== "number" ||
            !Number.isInteger(s) ||
            s < 0 ||
            s > 9999 ||
            gross === 0n ||
            integer(p.minOut) < (net * BigInt(10000 - s)) / 10000n)
            fail();
    }
    /**
     * Convert an original human amount without floating point or guessed precision.
     *
     * @param value - Original decimal string.
     * @param decimals - Verified asset precision.
     * @returns Positive exact raw amount.
     */
    function decimal(value, decimals) {
        if (typeof value !== "string" ||
            value.length > 80 ||
            !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value))
            fail();
        const [a, b = ""] = value.split(".");
        if (b.length > decimals)
            fail();
        const n = BigInt(a) * 10n ** BigInt(decimals) +
            BigInt((b + "0".repeat(decimals)).slice(0, decimals) || "0");
        return n > 0n && n < U128 ? n : fail();
    }
    /**
     * Derive RH contract targets and funding amounts from original intent.
     *
     * @param tool - Requested preparation or selected status action.
     * @param original - Original caller arguments.
     * @param read - Trusted client transport for deal or asset metadata.
     * @returns Locally bounded contract intent, never values taken from plan transactions.
     */
    async function contractIntent(tool, original, read) {
        const input = row(original);
        if (String(input.chain ?? "4663") !== "4663")
            fail();
        const otc = tool.startsWith("otc_") || tool === "deal_status";
        const contract = otc ? OTC : AGREEMENT;
        const create = [
            "agreement_create",
            "agreement_fund",
            "agreement_from_template",
        ].includes(tool);
        const actor = addr(create ? input.payer : input.actor);
        if (actor === Z)
            fail();
        let selectedAsset = null;
        let amount = 0n;
        let native = 0n;
        let source = {};
        let selectors = [];
        if (tool === "otc_create" || tool === "otc_accept") {
            if (tool === "otc_create")
                source = row(input.quote);
            else {
                const state = row(await read("deal_status", {
                    chain: "4663",
                    dealId: input.dealId,
                    actor,
                }));
                if (state.termsHash !== input.expectedTermsHash ||
                    String(state.dealId) !== String(input.dealId))
                    fail();
                source = row(state.deal);
            }
            const buyer = addr(source.buyer);
            const seller = addr(source.seller);
            if (![buyer, seller].includes(actor) ||
                (tool === "otc_create" && actor !== buyer))
                fail();
            const funding = tool === "otc_accept" || input.fundNow === true;
            selectedAsset = addr(actor === buyer ? source.payAsset : source.sellToken);
            amount = funding
                ? integer(actor === buyer ? source.payAmount : source.sellAmount)
                : 0n;
            if (![Z, WETH, USDG].includes(addr(source.payAsset)))
                fail();
            native = selectedAsset === Z ? amount : 0n;
            selectors =
                tool === "otc_create"
                    ? ["0xc4e30b79"]
                    : [actor === buyer ? "0x8b11a927" : "0x3c9a5e94"];
        }
        else if (create) {
            selectedAsset = asset(input.asset);
            let dec = selectedAsset === USDG ? 6 : 18;
            if (![Z, WETH, USDG].includes(selectedAsset)) {
                const meta = row(row(await read("token_info", { chain: "4663", token: selectedAsset }))
                    .meta);
                if (String(meta.chainId) !== "4663" ||
                    addr(meta.token) !== selectedAsset ||
                    !Number.isSafeInteger(meta.decimals) ||
                    Number(meta.decimals) < 0 ||
                    Number(meta.decimals) > 36)
                    fail();
                dec = Number(meta.decimals);
            }
            let amounts = [];
            if (tool !== "agreement_from_template")
                amounts = array(input.tranches, 10).map((x) => row(x).amount);
            else {
                const params = row(input.params);
                if (input.template === "milestones")
                    amounts = array(params.milestones, 10).map((x) => row(x).amount);
                else if (input.template === "time_release" &&
                    params.schedule !== undefined)
                    amounts = array(params.schedule, 10).map((x) => row(x).amount);
                else if (["arbiter_escrow", "time_release", "optimistic", "panel"].includes(String(input.template)))
                    amounts = [params.amount];
                else
                    fail();
            }
            amount = amounts.reduce((n, v) => n + decimal(v, dec), 0n);
            if (amount >= U128)
                fail();
            native = selectedAsset === Z ? amount : 0n;
            source = input;
            selectors = ["0xbd18467a"];
        }
        else if (tool === "agreement_attest")
            selectors = ["0xa3bb24cc"];
        else if (tool === "agreement_release")
            selectors = ["0x366a4120"];
        else if (tool === "agreement_refund")
            selectors = ["0x278ecde1"];
        else if (tool === "agreement_status")
            selectors = [
                "0x40e58ee5",
                "0x6581e3ea",
                "0x15ca8746",
                "0xac30e880",
                "0x366a4120",
                "0x278ecde1",
                "0xa3bb24cc",
                "0x51cff8d9",
            ];
        else if (tool === "deal_status")
            selectors = [
                "0x40e58ee5",
                "0x68d0cf17",
                "0x1402b17a",
                "0xe60e1301",
                "0x51cff8d9",
            ];
        else
            fail();
        return {
            tool,
            contract,
            actor,
            asset: selectedAsset,
            amount,
            native,
            source,
            selectors,
        };
    }
    /**
     * Reject unpinned contract calls, approvals and native value before wallet review.
     *
     * @param value - Returned unsigned transaction plan.
     * @param original - Original caller arguments.
     * @param c - Independently derived local contract intent.
     * Throws on unexpected targets, amounts, actions or chain. See README for semantic review limits.
     */
    function checkContract(value, original, c) {
        const p = row(value);
        const input = row(original);
        const txs = array(p.transactions ?? p.txs, 2).map(row);
        if (!["prepared", "approval_required", "unfunded_creation_prepared"].includes(String(p.status)) ||
            p.unsigned !== true ||
            (p.escrow !== undefined && addr(p.escrow) !== c.contract) ||
            (p.chainId === undefined &&
                p.chain === undefined &&
                txs.some((t) => String(t.chainId) !== "4663")) ||
            (p.transactions !== undefined && p.txs !== undefined) ||
            String(input.chain ?? "4663") !== "4663" ||
            (p.chainId !== undefined && String(p.chainId) !== "4663") ||
            (p.chain !== undefined && String(p.chain) !== "4663") ||
            p.ok === false ||
            p.error)
            fail();
        for (const a of [p.actor, p.payer, p.trader])
            if (a !== undefined && addr(a) !== c.actor)
                fail();
        let approvals = 0;
        let actions = 0;
        for (const [i, t] of txs.entries()) {
            if (Object.keys(t).some((k) => ![
                "chainId",
                "to",
                "from",
                "data",
                "value",
                "label",
                "simulation",
            ].includes(k)) ||
                (t.chainId !== undefined && String(t.chainId) !== "4663") ||
                addr(t.from ?? p.actor ?? p.payer ?? p.trader) !== c.actor ||
                typeof t.data !== "string" ||
                !/^0x(?:[0-9a-f]{2})+$/i.test(t.data) ||
                row(t.simulation ?? {}).ok === false)
                fail();
            const to = addr(t.to);
            const data = t.data.toLowerCase();
            const sel = data.slice(0, 10);
            const v = val(t.value ?? "0");
            if (sel === "0x095ea7b3") {
                if (i !== 0 ||
                    ++approvals !== 1 ||
                    c.amount === 0n ||
                    c.asset === null ||
                    c.asset === Z ||
                    to !== c.asset ||
                    data.length !== 138 ||
                    wa(word(data, 0)) !== c.contract ||
                    wn(word(data, 1)) !== c.amount ||
                    v !== 0n)
                    fail();
            }
            else {
                if (++actions !== 1 ||
                    i !== txs.length - 1 ||
                    to !== c.contract ||
                    !c.selectors.includes(sel) ||
                    v !== c.native)
                    fail();
                if (sel === "0xc4e30b79") {
                    const q = c.source;
                    if (data.length !== 522 ||
                        wa(word(data, 0)) !== addr(q.seller) ||
                        wa(word(data, 1)) !== addr(q.sellToken) ||
                        wn(word(data, 2)) !== integer(q.sellAmount) ||
                        wa(word(data, 3)) !== addr(q.payAsset) ||
                        wn(word(data, 4)) !== integer(q.payAmount) ||
                        wn(word(data, 5)) !== integer(String(q.expiry)) ||
                        wn(word(data, 6)) !== integer(String(q.feeBps)) ||
                        wn(word(data, 7)) !== (input.fundNow === true ? 1n : 0n))
                        fail();
                }
                else if (sel === "0xbd18467a") {
                    if (data.length < 394 ||
                        wa(word(data, 0)) !== addr(input.payee) ||
                        wa(word(data, 1)) !== c.asset ||
                        wn(word(data, 2)) !== c.amount ||
                        (input.expiry !== undefined &&
                            wn(word(data, 3)) !== BigInt(String(input.expiry))))
                        fail();
                }
                else if (sel !== "0x51cff8d9") {
                    const id = input.dealId ?? input.id;
                    if (wn(word(data, 0)) !== integer(id))
                        fail();
                    if (["0xa3bb24cc", "0x366a4120"].includes(sel) &&
                        wn(word(data, 1)) !== BigInt(String(input.tranche ?? 0)))
                        fail();
                    if (sel === "0x3c9a5e94" &&
                        wa(word(data, 1)) !== addr(input.payout ?? c.source.payout))
                        fail();
                }
            }
        }
        if (p.status === "approval_required"
            ? approvals !== 1 || actions !== 0
            : actions !== 1)
            fail();
    }
    return { readTrade, checkTrade, contractIntent, checkContract };
})();

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

async function qhooksValidateTrade(plan, input, walletAddress, nowSeconds, evidence) {
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
  QHOOKS_SECURITY.checkTrade(plan,input,{currency0,currency1,fee:Number(number(w[13])),tickSpacing:Number(signed24(w[14])),hooks:wordAddress(w[15])},evidence);
  // swap() returns output to msg.sender; it has no trader/recipient calldata field.
  // plan.trader, quote.trader and any tx.from are bound to the actual Oak account.
  if (plan.integrity?.schema !== 'qhooks.trade-plan.v1' || plan.integrity.algorithm !== 'sha256' || !/^0x[0-9a-f]{64}$/.test(plan.integrity.hash || '') || (await qhooksTradeHash(plan)) !== plan.integrity.hash) fail();
  return plan;
}

async function qhooksCalls(plan, intent, walletAddress, nowSeconds = Math.floor(Date.now() / 1000), readQHooks) {
  const supported = new Set(["prepare_trade", "otc_create", "otc_accept", "deal_status", "agreement_create", "agreement_fund", "agreement_attest", "agreement_release", "agreement_refund", "agreement_status", "agreement_from_template"]);
  if (!intent || !supported.has(intent.tool) || !intent.arguments || typeof intent.arguments !== "object" || Array.isArray(intent.arguments)) throw Error("Keep the original tool name and arguments before preparing.");
  const requested = {...intent.arguments,chain:String(intent.arguments.chain??"4663")};
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
  if (typeof readQHooks !== "function") fail();
  if (intent.tool === "prepare_trade") {
    const evidence=await QHOOKS_SECURITY.readTrade(requested,readQHooks);
    await qhooksValidateTrade(plan, requested, walletAddress, nowSeconds,evidence);
  }
  // OTC/agreements retain their existing staged review/simulation flow on RH.
  // A remote response cannot select this branch in place of a requested trade.
  else {
    const contractInput={...requested,actor:requested.actor??walletAddress};
    const expected=await QHOOKS_SECURITY.contractIntent(intent.tool,contractInput,readQHooks);
    QHOOKS_SECURITY.checkContract(plan,contractInput,expected);
  }
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

Call `await qhooksCalls(plan, intent, walletAddress, undefined, readQHooks)`, passing the trusted host connector function described above as the fifth argument. Pass the returned `{chain,calls}` as the input to `send_calls` only after step 4's review and explicit user confirmation. Use the currently connected wallet on that chain; a matching address alone does not establish chain support. Preserve approvals before actions, including a complete simulated batch when the server actually supplies one. A partially staged approval remains staged. `unfunded_creation_prepared` creates an OTC deal without a deposit; never report it as funded or settled. A status read can return `nextActions`: only after the user selects a specific action, use its non-null `transaction` with `simulation.ok: true`, wrapped as `{status:"prepared", unsigned:true, transactions:[selected.transaction]}`. Never auto-pick an action or infer a missing chain. Perps typed data and launch links have no transaction array and are not convertible by this helper.

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

## Independent plan checks

Before a spot plan is returned, the adapter separately reads `token_info` and `quote` through the same configured public transport. It selects the listed launch pool (otherwise the first listed pool), binds the decoded currencies, hook, fee and tick spacing to that independent metadata, and computes the minimum from the independent raw quote, the original slippage and the router fee. Changing both the returned plan quote and its minimum, even with a recomputed digest, is refused. Missing or stale independent quote evidence stops preparation; there is no wallet call or automatic retry. This adds two bounded read calls per spot preparation.

The SHA-256 integrity value detects inconsistency; it is not a server signature or a price guarantee. Independent reads must come from the adapter's own transport, never model-supplied evidence or fields copied from the plan. Wallet review and signing remain outside the adapter.

OTC and agreement transaction plans are limited to Robinhood Chain (4663). Their only contract destinations are QOtcEscrow `0xbea24499f82f1e018a4dff5607b7c54141cbfbf8` and QAgreements `0x9b6e579dd876c364bf232d2958d7cc45937809bf`, respectively. A separate approval can target only the original funding token, with the exact original amount and the relevant contract as spender; unlimited approvals, other spenders, extra native value and extra wallet-operation fields are refused. OTC acceptance reads the selected deal and its terms hash independently. Agreement amounts use known asset decimals or independently returned token metadata, never guessed precision.

These checks bound destinations, funding amounts and supported action selectors. They do not authenticate a server or replace review of agreement conditions, expiry and counterparty terms. Unavailable/non-plan records are data, not executable calls.
