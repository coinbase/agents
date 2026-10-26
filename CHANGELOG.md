# Changelog

## 0.0.1 — Unreleased

- Add the `wallet-mcp` skill (moved from `base/skills`, with `Base MCP` renamed to `Wallet MCP` and the install command pointed at `coinbase/agents`) as source only at `skills/wallet-mcp/`. It is not added to the shared router, `COINBASE_SKILL_PRODUCTS`, or any generated distribution, and no MCP configuration changes.

- Keep `skills/coinbase/` as a product-neutral router and consolidate each product into one skill at `skills/coinbase-cli/` or `skills/coinbase-mcp/`. Move capability workflows and product-specific execution guidance into each skill's linked `references/` directory. Make the README product-focused. Copy the three skills and their references unchanged into matching package paths; reject links to unselected skills and preserve plugin names and invocation commands. Replace older combined-product, unqualified capability, and product-prefixed capability skill installs rather than keeping stale copies.

- Route the ChatGPT distribution to `/mcp/chatgpt`; keep portable, Claude, and Codex on `/mcp` and validate each distribution's endpoint.
- Add a separate ChatGPT directory distribution with submission listing URLs, a shorter subtitle, and 64×64 SVG dimensions; preserve the existing portable, Claude, and Codex packages.
- Direct Cursor users to install the portable Agent Plugin instead of adding MCP to `~/.cursor/mcp.json`.
- Treat this repository as canonical source instead of an installable plugin root.
- Generate portable, Claude, and Codex distributions from one skill library.
- Isolate OpenAI assets under the portable `com.openai` extension directory.
- Publish versioned archives, checksums, unpacked packages, and release metadata through GitHub Pages.
