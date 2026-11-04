# Changelog

## 0.0.2 — Unreleased

- Ship only the shared router and `coinbase-mcp` in the ChatGPT distribution. Omit `coinbase-mcp/references/x402.md`, because `/mcp/chatgpt` does not expose x402 tools, and give ChatGPT its own package README.
- Let a distribution omit selected skill files and drop source lines marked `<!-- omit: <distribution> -->`. Other distributions still copy skills unchanged, and links to unselected skills or omitted files fail the build.
- Remove x402 from the ChatGPT listing copy and keywords, and replace its starter prompt with three prompts for portfolio review, rebalancing, and scaling in with limit orders.
- Describe paid research in the `coinbase-mcp` skill description without naming x402.
- Document Solana in the `wallet-mcp` skill: `get_portfolio`, `get_transaction_history`, `search_tokens`, `chain_rpc_request`, `fund` (Solana Pay), `send` and `swap` accept `chain: solana`, with `fund`, `send` and `swap` gated by server switches; `sign`, `send_calls` and x402 do not, and headless sessions get Solana reads only. Solana sends and swaps are approved in the user's Base Account, which shows the quote and fees; confirm the outcome by matching the transaction in `get_transaction_history` on `chain: solana` after `get_request_status` returns `signed`. Add `solana` to the supported-chains table and note that only sessions approved from a Base auth keys.coinbase.com session carry `baseAccount.solana`, while agent wallets carry their own Solana address.
- Rework the `wallet-mcp` approval flow: in CLI harnesses, auto-open only the Wallet MCP `approvalUrl`, passed as one quoted argument, then poll `get_request_status` on a backoff without waiting for the user. Name the real statuses, keep polling EVM `signed` until `completed` or `failed`, report a signature for `sign`, and add Solana matching and stop rules. Align `tone.md` and the plugins that said to poll only after the user acts.
- Bump every distribution to 0.0.2.

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
