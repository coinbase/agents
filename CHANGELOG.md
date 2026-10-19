# Changelog

## 0.0.1 — Unreleased

- Add the `coinbase-paper` product skill: a local paper trading simulator for bash-capable hosts (Node.js 22.13+), shipped as dependency-free TypeScript under `skills/coinbase-paper/scripts/` with a `coinbase-paper` launcher. It supports market, limit (GTC/GTD/IOC/FOK, post-only), stop-limit and bracket orders, attached take-profit/stop-loss exits, cancel/edit/close-position, fills and activity, holds and buying power, maker/taker fees, performance, backup/bind and confirmed reset, plus stock market orders priced from a user-supplied quote. Resting orders reconcile against completed public candles on the next command; there is no daemon. It never reads credentials or places real orders. The builder ships it in every distribution, excludes `*.test.ts`, and keeps the launcher executable in zip and tar archives. CI adds a Node.js typecheck and test job.

- Keep `skills/coinbase/` as a product-neutral router and consolidate each product into one skill at `skills/coinbase-cli/` or `skills/coinbase-mcp/`. Move capability workflows and product-specific execution guidance into each skill's linked `references/` directory. Make the README product-focused. Copy the three skills and their references unchanged into matching package paths; reject links to unselected skills and preserve plugin names and invocation commands. Replace older combined-product, unqualified capability, and product-prefixed capability skill installs rather than keeping stale copies.

- Route the ChatGPT distribution to `/mcp/chatgpt`; keep portable, Claude, and Codex on `/mcp` and validate each distribution's endpoint.
- Add a separate ChatGPT directory distribution with submission listing URLs, a shorter subtitle, and 64×64 SVG dimensions; preserve the existing portable, Claude, and Codex packages.
- Direct Cursor users to install the portable Agent Plugin instead of adding MCP to `~/.cursor/mcp.json`.
- Treat this repository as canonical source instead of an installable plugin root.
- Generate portable, Claude, and Codex distributions from one skill library.
- Isolate OpenAI assets under the portable `com.openai` extension directory.
- Publish versioned archives, checksums, unpacked packages, and release metadata through GitHub Pages.
