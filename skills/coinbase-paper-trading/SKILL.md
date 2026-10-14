---
name: coinbase-paper-trading
description: Simulate Coinbase crypto spot market orders with virtual cash in a local paper account using the bundled coinbase-paper command. Use for paper trading, practice or demo trades, trading without real money, trying a strategy idea, or checking simulated positions and P&L. Requires a terminal, Python 3.11+ with SQLite, durable local storage, and public HTTPS access to Coinbase market data; unsupported in chat-only or ephemeral execution environments. Needs no login, API key, or MCP connection. Never places real orders, reads balances, or spends funds.
metadata:
  author: Coinbase
  version: 1.2.0
---

# Coinbase paper trading

Every result is **PAPER**: virtual cash, simulated fills, no real order. No API key, login, Coinbase CLI, MCP connection, Node.js, credentials, or portfolio access is needed or used.

## Required capabilities — check before setup or execution

- Agent-accessible terminal execution and Python 3.11+ with standard-library SQLite.
- Authorized durable local files for the paper data directory, outside installed code. Storage must support SQLite locking/hard links and survive terminal exits and new conversations. Verify host retention or an operator-confirmed persistent disk; a successful write is not proof.
- For the default CLI, direct public HTTPS to `api.coinbase.com` for read-only product, order-book, and candle data. No account access is used; the client does not load proxy settings or credentials. A deliberately selected [legacy route](references/mcp.md) instead requires an approved read-only MCP connection and a complete JSON-to-file handoff.
- Host-enforced read-only tools or mandatory real-financial-action approvals if the same agent also has live trading tools.
- A way to retrieve this guide and the installed command path in a fresh conversation; do not rely on chat memory.

If any requirement is missing or unknown, **stop setup and trading** and explain what is needed. Chat-only clients and ephemeral code sandboxes without durable storage are unsupported. Never invent a ledger in the conversation, promise memory-based persistence, or fall back to real money. Check capabilities, not client brand. See [requirements and onboarding](START-HERE.md); filesystem tests cannot certify VM retention.

## Run the command

Use the stable absolute path to the installed `bin/coinbase-paper` launcher, recorded by the host installation:

```sh
/abs/coinbase-paper-trading/bin/coinbase-paper COMMAND
```

Execute it by absolute path; it finds its own runtime from its real location, not from the current directory, and is not placed on `PATH`. If the file lost its executable bit, run `python3 /abs/coinbase-paper-trading/bin/coinbase-paper COMMAND`. [Command reference](references/cli.md) documents every command, its JSON output, and errors.

Account data lives in one data directory per OS user: `--data-dir ABS`, else `COINBASE_PAPER_HOME`, else `$XDG_DATA_HOME/coinbase-paper`, else `~/.local/share/coinbase-paper`. Shell variables do not survive between tool calls, so pass `--data-dir` explicitly when the host recorded a non-default directory. The directory is not a paper/live switch.

The [MCP market-data handoff](references/mcp.md) with the low-level `scripts/paper.py` engine is an optional legacy/advanced route for hosts without public HTTPS. Use it only when deliberately selected; never mix it with a CLI retry of the same order.

## Resolve intent before acting

- “Can I paper trade?” is a capability question: explain the local simulator and check readiness (`doctor`) without creating an account or placing a trade. A live-only MCP environment does not mean local paper trading is unavailable.
- Explicit paper, practice, demo, or simulated trades use this workflow only. An unambiguous follow-up in the same paper conversation stays paper.
- A buy/sell request in a fresh conversation, conflicting instructions, or uncertain paper/live intent requires clarification before acting. Do not infer live intent from the connector environment or paper intent merely from an installed account.
- An explicit switch to real money leaves this workflow and requires separate live authorization and host approval. No global mode flag; one bot must not change another bot's execution context.

## Set up

1. Read the host's saved installation context: absolute launcher path, data directory, account scope, and storage limitations. If these are unavailable, follow [host setup](references/host-setup.md); do not guess a new per-bot directory.
2. Run `doctor`. It never creates state or uses the network. An unbound, missing, or mismatched account is a recovery problem: stop, and never fall back to `init` or silently seed new cash.
3. If the user already has a v1.0/v1.1 paper database, adopt it with `bind --state ABS --account-id ID` using its verified ID. If the user expects an account that cannot be found, ask for recovery information rather than initializing.
   A v1.1 profile stores the `state` and `account_id` for `bind`. Resolve saved-but-unfilled or uncertain legacy requests through the original workflow before switching; `bind` does not migrate their request files. See [upgrade guidance](references/host-setup.md#3-bind-an-account-once).
4. Only for an explicitly new account, run `init` (defaults: 10000 USD and a 10 bps assumed fee, not the user's Coinbase fee tier). `init` refuses an existing profile or database. If setup stopped partway, recover with `bind`, never by reseeding.
5. Report PAPER, account ID, cash/currency, fee assumption, data directory, and verified storage scope. Unknown persistence blocks setup; VM replacement durability is a separate claim. Matching paths on different VMs do not mean shared state.

There is no reset command. An explicitly requested separate account needs a separate `--data-dir`; keep the original.

## Paper trade

1. Use the user's specified product, side, and size; clarify missing terms. A BUY uses exactly one of `--base-size` or `--quote-size`; a SELL uses `--base-size` only. `--quote-size` is the total spend including fees.
2. Generate one new UUID for each new order, for example with `python3 -c 'import uuid; print(uuid.uuid4())'`, and keep it with the order terms. Never reuse an example UUID.
3. Run `buy PRODUCT --base-size N --request-id UUID` or `--quote-size N`, or `sell PRODUCT --base-size N --request-id UUID`. The command saves the intent privately, fetches public product and book data, and fills against that fresh book.
4. Report the receipt as a PAPER fill: size, notional, fee, cash, and snapshot time.

**Retries.** If a result is uncertain or failed before filling, rerun the same command in the same data directory with the same `--request-id` and terms. A completed request returns its original receipt with no new market-data reads. Different terms are rejected for committed IDs and for pending intents in that directory. All bots writing one account must share that directory: changing bindings or using the low-level engine does not share pending intent files. Never create a new ID to retry. Do not change interfaces or data directories to retry; a new order the user asks for gets a new ID.

**Rejections.** Explain the error code. Do not shrink the size, switch product or currency, invent data, or move to live trading.

## Review

- `status` is offline: open positions are unpriced and equity and unrealized P&L are `null`. `status --refresh` fetches current books for open positions.
- `history --limit N` lists recent paper orders.
- `backup --output ABS` writes a consistent copy to a new file. Restore deliberately by binding it into a new data directory; see [recovery](references/cli.md#retries-and-recovery).
- `candles PRODUCT --start UNIX --end UNIX --granularity ENUM` is bounded public research and needs no account. Never use candles as fills or marks.

## Model and limits

- Fills use only the fetched order-book snapshot: asks for buys and bids for sells, best price first, weighted by depth. The full size fills or the trade is rejected. A quote budget buys the largest base increment it can afford after the fee, which is rounded up to the quote increment. Snapshots older than 60 seconds, or more than 5 seconds in the future, are rejected.
- Positions use weighted-average cost. Buy fees add to cost basis and sell fees reduce proceeds. Marks use the best bid and exclude hypothetical exit fees.
- Scope: crypto spot market orders, one quote currency per account, run manually. There are no equities, derivatives, leverage, shorts, limit or resting orders, backtests, scheduling, cloud sync, or live mode. Internet equity quotes may inform separate research, but cannot be used for fills or marks here.
- Results do not predict real returns. The model has no queue position, latency, market impact after the snapshot, or adverse selection. The state files are local and user-editable.

## Safety boundary

This workflow uses only public read-only market data plus local files. It never places real orders. Never call order, preview, conversion, transfer, x402, or payment tools for a paper request. Live trading is a separate authorized workflow, not a fallback. These instructions are not an enforcement boundary for an agent with live permissions: use read-only tool restrictions where supported and keep mandatory financial-action approvals on.
