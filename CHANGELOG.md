# Changelog

## 0.0.1 — Unreleased

- Keep `skills/coinbase/` as a product-neutral router and group product workflows under `skills/coinbase-for-agents/<skill>/`, with `coinbase-for-agents` as the product entry skill. Make the README product-focused. Package the router and explicitly selected products in a flat layout with rebased links; preserve plugin names and invocation commands.

- Add a separate ChatGPT directory distribution with submission listing URLs, a shorter subtitle, and 64×64 SVG dimensions; preserve the existing portable, Claude, and Codex packages.
- Direct Cursor users to install the portable Agent Plugin instead of adding MCP to `~/.cursor/mcp.json`.
- Treat this repository as canonical source instead of an installable plugin root.
- Generate portable, Claude, and Codex distributions from one skill library.
- Isolate OpenAI assets under the portable `com.openai` extension directory.
- Publish versioned archives, checksums, unpacked packages, and release metadata through GitHub Pages.
