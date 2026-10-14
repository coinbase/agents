# Changelog

## Paper-trading skill 1.2.0 — Unreleased

- Add the `coinbase-paper` launcher (`bin/coinbase-paper`) to the `coinbase-paper-trading` skill. It fetches public Coinbase product, order-book, and candle data over HTTPS and runs `doctor`, `init`, `bind`, `buy`, `sell`, `status [--refresh]`, `history`, `backup`, and `candles` as JSON commands. Python 3.11+ standard library only; no login, API key, MCP connection, or live credentials.
- One account per data directory (`--data-dir`, `COINBASE_PAPER_HOME`, or the XDG data default), outside installed code. Existing v1.0/v1.1 databases are adopted with `bind`; the engine database schema and fill model are unchanged.
- Orders require a caller-supplied `--request-id`; retries reuse the exact ID and data directory. Completed requests replay the original receipt offline. Changed pending terms are rejected within the data directory; committed IDs are protected by the database across bindings.
- Documentation and discovery text are CLI-first. The MCP market-data handoff to `scripts/paper.py` is kept as an optional legacy/advanced route.
- Paper-only and full-plugin distributions include the launcher and new runtime modules, keep the launcher executable in ZIP and tar archives, and reject unexpected files in the paper skill. CI runs the tests on Python 3.11, 3.13, and 3.14 with `ResourceWarning` as an error.
- Public reads use direct HTTPS without proxy/credential discovery; candle research is bounded to validated numeric OHLCV records. Document diagnostic readiness, legacy pending-request cutover, and the limits of filesystem/host certification.
- Plugin package versions are unchanged; this entry is not a plugin release.

## 0.0.1 — Unreleased

- Direct Cursor users to install the portable Agent Plugin instead of adding MCP to `~/.cursor/mcp.json`.
- Treat this repository as canonical source instead of an installable plugin root.
- Generate portable, Claude, and Codex distributions from one skill library.
- Isolate OpenAI assets under the portable `com.openai` extension directory.
- Publish versioned archives, checksums, unpacked packages, and release metadata through GitHub Pages.
- Add `coinbase-paper-trading`: a local, stdlib-only Python simulator for crypto spot market orders that uses read-only MCP product and order-book data. Distributions include the bundled script without Python caches.
- Add a host-neutral paper-only bundle with mandatory terminal, Python/SQLite, durable-storage, data-handoff, and approval requirements. Native skill/connector registration remains optional; unsupported chat-only environments stop instead of keeping a ledger in memory.
- Add saved paper-account locators (`bind` / `--profile`) with identity checks and no automatic reseeding, plus explicit paper/live intent routing and host acceptance tests. Paper skill version 1.1.0 retains the existing fill model and database schema.
