# Coinbase paper trading — start here

**A guide and local command, not a hosted paper exchange.** Use real public Coinbase market data with virtual cash. Nothing in this package places a real order. Read [SKILL.md](SKILL.md) for the workflow; [host setup](references/host-setup.md) covers installation and requirements.

## Is this environment eligible?

All of these are required before setup or execution:

1. **Terminal execution:** the agent can run a shell command and read its result. Python 3.11+ with the standard-library `sqlite3` module must be available. Merely displaying code is not execution.
2. **Durable local storage:** an authorized, stable writable directory for the paper data directory, outside the installed code. It must support SQLite locking and hard links, and survive terminal exits and new conversations on the same host. A chat transcript, model memory, downloadable attachment, or ephemeral code-interpreter sandbox is not this storage. If persistence is unknown, stop setup; do not just warn and proceed.
3. **Public market data:** direct outbound HTTPS to `api.coinbase.com` for public product, order-book, and candle reads. No login, API key, or MCP connection is needed; proxy settings/credentials are not loaded. Hosts without direct public HTTPS may deliberately use the [optional legacy MCP route](references/mcp.md) after resolving any pending requests on the original interface.
4. **Safe execution:** paper/live intent is resolved before acting. The paper command needs no financial credentials or approvals to simulate. An agent that also has live tools still needs host-enforced read-only restrictions or mandatory approval for real financial actions. Never broaden credentials or disable approvals to install this package.
5. **A resume path:** the agent can retrieve this guide, the absolute launcher path, and the data directory in a new conversation, through durable host configuration, a native skill, or an explicit user-provided locator. Do not rely on one bot remembering the setup.

Check capabilities, not brand names. A desktop terminal or a hosted agent VM may qualify, but only with appropriate storage and controls. A web chat with only MCP access does not qualify. A hosted terminal alone is insufficient. Local filesystem checks cannot prove host retention: record the host's documented storage lifecycle or the operator's confirmed durable local-disk location, then test a fresh conversation. VM deletion/replacement is a separate durability claim, never implied by a successful restart or file write.

**If a requirement is absent or unknown, do not initialize or trade.** Explain what is missing and offer to help set up a capable environment. Do not improvise a ledger in chat, claim to save it in memory, switch to live orders, or suggest real money as a substitute for paper trading. You may still explain the simulation or help design a strategy without claiming it ran.

Example response:

> This chat can explain Coinbase paper trading, but it cannot run and retain a paper account here. The setup needs a terminal with Python 3.11+, persistent files, and public HTTPS access to Coinbase market data. Use a capable local terminal or persistent agent VM; I won't simulate an account by remembering balances in this chat.

## What to give an eligible agent

> Read START-HERE.md and SKILL.md in this bundle. Check every environment requirement first and report anything missing or unverified. Set up local PAPER trading only if the requirements pass. Run `bin/coinbase-paper doctor` by absolute path. Find and resume my existing paper account. If none is found, ask me before creating a new account; missing expected state requires recovery, not new cash. Do not place a test trade unless I explicitly ask. Never call live order, preview, transfer, conversion, or payment tools. Record the absolute launcher path and data directory so a fresh conversation can resume.

Extract the complete verified bundle, not just the Markdown file, with an extractor that keeps file permissions. The command is `bin/coinbase-paper`; its runtime is in `scripts/`, and the only dependencies are Python and SQLite. If the launcher lost its executable bit, run it as `python3 /abs/.../bin/coinbase-paper`. Verify the archive digest against the trusted handoff/release, then its internal `SHA256SUMS`. An internal checksum list detects corruption, not authenticity by itself. No download, package installation, `PATH` change, OAuth change, or native registration happens automatically.

For an existing account, setup binds its verified database and ID into the data directory; it does not seed or reset balances. For a genuinely new account requested by the user, defaults are 10000 virtual USD and a 10 bps assumed fee. [Command reference](references/cli.md) explains every command, retries, and recovery.

## Discovery and scope

This package is host-neutral. A native skill catalog is an optional convenience, not a runtime dependency. Merely extracting the ZIP does not register a skill, and installing it does not make it visible to fresh bots. Registration that fresh conversations can discover is a separate host requirement; without it, a new agent must be given this guide explicitly.

No MCP server change is included in this package. A future read-only MCP guide tool could advertise the capability and return this guide plus a versioned bundle reference. That is discovery only: it does not make an unsupported chat client eligible, create a hosted account, toggle live order behavior, or supply shared storage.

Scope: manual crypto spot market simulation using fetched book depth. No equities, leverage, shorts, resting orders, background scheduler, cloud synchronization, or live mode. Results are approximate and do not predict real returns.

## Verify before calling the pilot ready

Use [the QA checklist](references/qa.md) with a separate disposable QA data directory. Runtime tests and static instruction checks do not prove an agent will route correctly. Native discovery, cross-conversation continuity, and approval enforcement require tests in the actual host. Keep untested properties explicitly unverified.
