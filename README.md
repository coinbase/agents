# Coinbase Agents

Skills and plugins for using Coinbase products with AI agents. Start with the [`coinbase` skill](skills/coinbase/SKILL.md), which selects the right product and loads its workflows.

## Products

[Agent Skills](https://agentskills.io/specification) provide reusable workflows and safety instructions. Each product has one skill for setup, authentication, safety, and capability routing, with detailed workflows in linked reference guides.

| Product | Purpose | Entry skill |
| --- | --- | --- |
| Coinbase CLI | Local command-line workflows with CDP API-key credentials and approved shell access, including monitoring | [coinbase-cli](skills/coinbase-cli/SKILL.md) |
| Coinbase MCP | Hosted tools through native OAuth, without CLI installation or shell access | [coinbase-mcp](skills/coinbase-mcp/SKILL.md) |
| Wallet MCP | Wallet account tools (balances, send, swap, signing, x402, batched calls) and third-party plugins through the hosted Wallet MCP server. Source only: not yet in the shared router or generated distributions | [wallet-mcp](skills/wallet-mcp/SKILL.md) |

The shared router stays at `skills/coinbase/`. Each product has one skill at `skills/<product>/SKILL.md`, with capability guides under `skills/<product>/references/`. Add a product entry here and in the router when introducing a new product; keep individual capability lists inside that product.

## Plugin distributions

This repository is the canonical source for four generated distributions:

- `coinbase-agent-plugin-vX.Y.Z`: portable [Agent Plugins v1.0.0](https://agent-plugins.org/) package for Cursor, Hermes, and other compatible clients.
- `coinbase-claude-vX.Y.Z`: Claude Code native package.
- `coinbase-codex-vX.Y.Z`: Codex marketplace containing the portable package.
- `coinbase-chatgpt-vX.Y.Z`: dedicated OpenAI public-directory submission package with ChatGPT listing metadata and a 64×64 SVG icon.

Download versioned ZIP or tar archives from [Coinbase Agent Plugin downloads](https://coinbase.github.io/agents/), verify them against `SHA256SUMS`, and extract the package for your client. Plugin-format support does not imply Coinbase OAuth client approval; do not bypass rejected authentication.

For local development, run `python3 scripts/build-distributions.py dist` and use the generated directories under `dist/site/packages/`. The repository root is not an installable plugin.

The existing distributions include three skills: the shared `coinbase` router, `coinbase-cli`, and `coinbase-mcp`. The builder copies the selected skill directories, including their `references/`, unchanged into the package's `skills/` directory and rejects links to unselected skills. Source and installed skill layouts match. Plugin names, `/coinbase:coinbase`, and installation paths are unchanged. Adding another product directory does not automatically ship it or configure its MCP server.

### ChatGPT directory submission

Use `coinbase-chatgpt-vX.Y.Z.zip` for the [OpenAI submission flow](https://developers.openai.com/plugins/deploy/submission). Its manifest and MCP configuration live under `src/plugins/chatgpt/`; it reuses the canonical skills and icon artwork without changing the portable, Claude Code, or Codex distributions. ChatGPT connects to `https://agents.coinbase.com/mcp/chatgpt` using OAuth; the other distributions retain `https://agents.coinbase.com/mcp`.

This package is not a published or approved listing. Publisher/domain verification, approved OAuth access, scans, reviewer access, test cases, and a demo recording must be completed separately. OpenAI's directory covers ChatGPT and Codex; its [plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines) prohibit execution of money/crypto transfers and investment trades, and currently restrict commerce to physical goods. The shared skills still describe trading, transfers, and paid research; resolve those capability and policy conflicts before submission. A separate manifest does not restrict the tools exposed by the MCP server.

### Install locally

#### Claude Code

From the extracted `coinbase-claude-vX.Y.Z` directory:

```sh
claude --plugin-dir "$PWD"
```

Open `/mcp` to authenticate, then load `/coinbase:coinbase`. See [Claude Code's plugin documentation](https://code.claude.com/docs/en/plugins-reference) for persistent installation.

#### Codex

From the extracted `coinbase-codex-vX.Y.Z` directory:

```sh
codex plugin marketplace add "$PWD"
```

Install and enable `coinbase` from `coinbase-agents` in the supported plugin UI. Adding the catalog alone does not enable the plugin. See [Codex's plugin documentation](https://developers.openai.com/plugins/build/plugins).

#### Cursor

Extract `coinbase-agent-plugin-vX.Y.Z` into a new `~/.cursor/plugins/local/coinbase/` directory, then restart Cursor or run Developer: Reload Window.

Open Customize, confirm the Coinbase plugin, then connect and approve the native OAuth prompt. See [Cursor's plugin documentation](https://cursor.com/docs/plugins). Reuse existing connections rather than adding duplicates.

#### Hermes

Extract `coinbase-agent-plugin-vX.Y.Z` into a new `~/.hermes/plugins/coinbase/` directory, or your active profile's plugin directory, then run:

```sh
hermes plugins list
hermes plugins enable coinbase
```

Use the plugin key returned by `list` if different. Follow [Hermes's portable-plugin documentation](https://hermes-agent.nousresearch.com/docs/developer-guide/plugins/#portable-agent-plugins-v1-packages) and native OAuth setup. Reuse existing connections rather than adding duplicates.

For standalone skills, build or download a generated package and install its complete `skills/` directory using your harness's supported method. Keep each product skill's `references/` directory intact; those guides contain the capability workflows and execution contracts. Source and generated packages both use `skills/coinbase/`, `skills/coinbase-cli/`, and `skills/coinbase-mcp/`, with one `SKILL.md` per directory. Replace old combined-product, unqualified capability, or product-prefixed capability skill installs through your harness's supported update/removal flow rather than leaving stale skills alongside `coinbase`, `coinbase-cli`, and `coinbase-mcp`. Preserve unrelated installations and settings.

## Safety and support

Keep native approval controls enabled. Trades, transfers, conversions, paid research, and recurring activity require explicit authorization; installation and authentication do not authorize financial actions.

For help, use [CDP Discord](https://discord.com/invite/cdp). Report vulnerabilities privately through [SECURITY.md](SECURITY.md). Follow the selected product's entry skill for connection and revocation instructions; uninstalling does not itself revoke access.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance, source provenance, and release requirements.

## License

This project is licensed under the [MIT](LICENSE). This license does not grant any rights to use Coinbase names, logos, or trademarks.

## Legal Notice

This repository provides skills and plugin packaging that let AI agents interact with your Coinbase account on your behalf based on instructions you give and permissions you approve. Instructions your agent sends through these tools are treated as instructions from you.

The software is provided "as is" and "as available," without warranties of any kind, express or implied, including merchantability, fitness for a particular purpose, and non-infringement. It is intended only to help carry out your instructions and is not intended to provide (i) an offer or solicitation to buy or sell any asset or to participate in any investment or trading strategy, or (ii) investment recommendations or investment, legal, tax, or accounting advice.

AI agents can produce inaccurate or unexpected output and can be influenced by text they read, including third-party content. You are responsible for reviewing your agent's actions, keeping approval controls enabled, and securing the environment it runs in. Trading digital assets, equities, and futures involves substantial risk of loss, and you assume all risk of loss from your use of the software.

Your use of this software is subject to the [Coinbase Developer Platform Terms of Service](https://www.coinbase.com/legal/developer-platform/terms-of-service) and your use of Coinbase Services is subject to the applicable agreements that govern access to your Coinbase account. Availability varies by location and account eligibility.
