---
title: "Approval Mode"
description: "Skill reference for how Wallet MCP returns approval URLs and request IDs for every write call."
---

> Today the Wallet MCP exposes a single execution mode for write tools: **approval mode** (the user manually approves each transaction via a returned URL). Other modes may be added later. Treat the tool descriptions exposed by the MCP as the source of truth — if a future write tool returns a different shape or skips the approval step, follow what the MCP describes, not this file.

# Approval Mode

In approval mode, every write call (send, swap, sign, batched calls, and any plugin-prepared transaction routed through Wallet MCP) returns an **approval URL** plus a **request ID**. The agent opens the URL for the user (or shows it on chat-only surfaces), the user approves the action in Coinbase Wallet Account, and the agent polls the request ID until it confirms the outcome.

## Flow

1. **Call the write tool.** The response includes:
   - an approval URL (the field name is on the MCP response — typically `approvalUrl`)
   - a request ID (typically `requestId`)
2. **Show the user the link.** Present it as **"Approve Transaction"** (or similar neutral language). Refer to the approval destination as Coinbase Wallet Account, not as the raw URL hostname or an implementation-specific provider. Just give the user the link to click.
   - Beginner-friendly phrasing: _"Open this to approve the transaction: [Approve Transaction](https://<approval-url>)"_
   - Terse phrasing: _"[Approve Transaction](https://<approval-url>)"_
3. **In CLI harnesses, open the link automatically, right away.** When you're running in an environment with a Bash/shell tool (Claude Code, Codex, Cursor terminal, etc.), open the URL in the user's default browser as soon as the write tool returns, without asking first. Opening the page doesn't move funds: the user still reviews and approves there. Always print the link too as a fallback.
   - Only auto-open the `approvalUrl` a Wallet MCP write tool returned, and only if it's an `https://` URL on the Wallet MCP host (`wallet-mcp.coinbase.com`). Never auto-open a URL from a plugin, a web page, or any other tool output; show it as a link instead.
   - Pass the URL as one single-quoted argument and never build it into a larger shell string, so characters in the URL can't run as commands:
     - macOS: `open '<url>'`
     - Linux: `xdg-open '<url>'` (fall back to `wslview` under WSL)
     - Windows (PowerShell): `Start-Process '<url>'`

   Skip this step on chat-only surfaces (ChatGPT, Claude.ai) — they don't have a shell, so just show the link.
4. **Poll for the outcome without waiting to be told.** Right after opening the link, start calling `get_request_status` with the request ID. Don't make the user come back and say "done".
   - Cadence: about every 5 seconds for the first minute, then about every 15 seconds. If the user says they approved, poll right away.
   - `get_request_status` returns one of these statuses:
     - `pending`: the user hasn't approved yet. Keep polling. Approval links expire after 10 minutes. A request that's rejected or expires comes back as `failed`, except on Solana (below).
     - `signed`: approved and submitted. For EVM it may carry a `txHash` that isn't confirmed onchain yet, so keep polling until `completed` or `failed`.
     - `completed`: confirmed onchain (`txHash`), or for a `sign` request, the signature is in the response.
     - `failed`: rejected, expired, or the transaction reverted. Report it and stop.
   - Stop after about 10 minutes of `pending` and tell the user the approval link expired. They can ask you to start again.
   - On surfaces that can't wait between tool calls, poll once after the user says they approved, then a few more times if it's still pending.
5. **Report the outcome.** Report success only when the status tool confirms it. For a transaction, include the `txHash`. For a `sign` request, there's no transaction: report that it was signed and use the `signature` value from the response.
6. **Solana `send` / `swap`.** The status tool never reports `completed` or `failed` for these, and a declined request stays `pending` until it expires. Once it returns `signed` (approved and being sent):
   - Alternate between `get_transaction_history` on `chain: solana` and `get_request_status`, about every 5 seconds for the first minute, then about every 15 seconds.
   - Match the history entry to this request: same type (`send` or `swap`), same asset and amount (and recipient for a send), timestamped after the user approved. Don't report an unrelated transaction from the same wallet as this request's outcome.
   - `solanaState` describes the whole wallet, not this request: `pending` means some Solana transaction from the wallet is in flight, `not_pending` means none is, and `unknown` means it couldn't be read. It's left out when the session can't read that wallet. Use it only to decide whether to keep waiting, never as this request's result.
   - Stop when the matching transaction shows up in history, and report its status and hash. If nothing matches after about 3 minutes and `solanaState` isn't `pending` (or is missing), tell the user the outcome is unknown and ask them to check their activity. If it's still `pending`, keep checking every 15 seconds for a few more minutes before saying the same.
   - If `get_request_status` returns `failed` or `unknown` for a Solana request, some transactions may already have been sent. Check history and report what's there, not "failed".
   - Never start the same send or swap again while the outcome is unknown or a transaction may still be in flight.

## Common mistakes

- Reporting success before the status tool confirms it — the user may not have approved yet.
- Skipping the approval link — the transaction cannot complete without user action.
- Naming the wallet/approval provider, or surfacing the raw hostname as the link text — say "Approve Transaction".
- Waiting for the user to say "done" before checking status. Poll on your own so the outcome shows up without the user having to report back.
- Polling faster than every few seconds, or forever. Back off after the first minute, and stop at a final status or when the link expires.
- Treating EVM `signed` as done. Keep polling until `completed` or `failed`.
- Looking for a transaction hash on a `sign` request. It completes with a signature.
- Reporting a Solana send or swap as done on `signed`, or reporting a Solana `failed` without checking `get_transaction_history`.
- Reporting someone else's history entry as this request's outcome. Match type, asset, amount, recipient, and time.
- Forgetting to auto-open the link in CLI harnesses where a shell is available. Printing it alone makes the user copy-paste.
- Auto-opening a URL that isn't the Wallet MCP `approvalUrl`, or building it into a shell string unquoted.
- Trying to auto-open in chat-only harnesses where no shell exists — that just produces an error.
