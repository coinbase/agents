# Coinbase Agents

Skills and plugins for using Coinbase with AI agents. Read market data, manage portfolios, trade, and access paid research through Coinbase MCP or the Coinbase CLI, or practice with a local paper-trading simulator.

## Model Context Protocol (MCP)

Coinbase hosts a remote MCP server at **https://agents.coinbase.com/mcp**. Connect through a Coinbase-approved client's native OAuth flow; no local CLI or API key is required. See the [connection guide](https://docs.cdp.coinbase.com/ai-agents/coinbase-for-agents/coinbase-mcp) for supported clients and setup.

After connecting, try: “List my Coinbase portfolios. Do not trade or spend funds.”

## Coinbase CLI

For agents with shell access, the optional [`@coinbase/coinbase-cli`](https://www.npmjs.com/package/@coinbase/coinbase-cli) provides local command-line access. It requires Node.js 22+ and separately configured CDP credentials. Installing this plugin does not install or authorize the CLI. Follow the [CLI setup reference](skills/coinbase/references/cli.md).

## Agent skills

[Agent Skills](https://agentskills.io/specification) provide reusable workflows and safety instructions. Start with [`coinbase`](skills/coinbase/SKILL.md), which guides setup and selects the appropriate skill. Execution references explain which operations are available through MCP or CLI.

| Skill | Purpose |
| --- | --- |
| [Coinbase](skills/coinbase/SKILL.md) | Setup, interface selection, and safety |
| [Market data](skills/coinbase-market-data/SKILL.md) | Products, prices, order books, candles, and fees |
| [Portfolios](skills/coinbase-portfolios/SKILL.md) | Balances, positions, portfolio management, and internal transfers |
| [Trading](skills/coinbase-trading/SKILL.md) | Preview, place, inspect, edit, and cancel orders |
| [Conversions](skills/coinbase-convert/SKILL.md) | Quote and execute supported currency conversions |
| [Equities](skills/coinbase-equities/SKILL.md) | Stock trading for eligible accounts, with session and sizing rules |
| [Futures](skills/coinbase-futures/SKILL.md) | Eligible CFM dated futures, contract sizing, and risk checks |
| [x402](skills/coinbase-x402/SKILL.md) | Discover and purchase research within an approved budget |
| [Watch](skills/coinbase-watch/SKILL.md) | Bounded streaming and monitoring; CLI only |
| [Paper trading](skills/coinbase-paper-trading/SKILL.md) | Local `coinbase-paper` command for simulated spot market orders with virtual cash; requires Python 3.11+, no credentials, and never places real orders |

## Local paper-trading pilot

Start with the [host-neutral paper-trading guide](skills/coinbase-paper-trading/START-HERE.md). The bundled `coinbase-paper` command fetches public Coinbase market data over HTTPS and simulates spot market orders with virtual cash in a local SQLite account. It needs an agent-accessible terminal, Python 3.11+ with SQLite, durable local storage, and public HTTPS access—no login, API key, live credentials, MCP connection, or other dependencies. Chat-only clients and ephemeral code sandboxes without durable storage cannot run this workflow. Unknown persistence blocks setup; a successful file write does not certify host retention.

Build a self-contained paper-only bundle from this checkout:

```sh
python3 scripts/build-distributions.py dist-paper --paper-only
```

The versioned ZIP/tar and checksums are under `dist-paper/site/downloads/`. The bundle contains one skill, its guide/references, the `bin/coinbase-paper` launcher and its `scripts/` runtime, and the license—not the live-trading skills or any account state. Extract with a tool that keeps file permissions, then run the launcher by absolute path from any directory:

```sh
"/abs/path/coinbase-paper-trading-vX.Y.Z/bin/coinbase-paper" --help
"/abs/path/coinbase-paper-trading-vX.Y.Z/bin/coinbase-paper" doctor
```

If the executable bit is lost, run it as `python3 /abs/path/.../bin/coinbase-paper`. Nothing is added to `PATH`. Account data is kept outside the code in one directory per OS user: `--data-dir ABS`, else `COINBASE_PAPER_HOME`, else `$XDG_DATA_HOME/coinbase-paper`, else `~/.local/share/coinbase-paper`. Record the launcher path and data directory durably so upgrades and fresh conversations resume the same verified account. Retry an uncertain order with the exact same `--request-id`. The low-level offline engine with MCP market-data handoff remains an [optional legacy route](skills/coinbase-paper-trading/references/mcp.md).

The bundle does not install itself into a host, configure authentication, or change the MCP server. Installing files is not registration: making the skill discoverable by fresh bots is a separate host requirement. Use the [host QA checklist](skills/coinbase-paper-trading/references/qa.md) before claiming native discovery or persistence for a client.

## Plugin distributions

This repository is the canonical source for three generated distributions:

- `coinbase-agent-plugin-vX.Y.Z`: portable [Agent Plugins v1.0.0](https://agent-plugins.org/) package for Cursor, Hermes, and other compatible clients.
- `coinbase-claude-vX.Y.Z`: Claude Code native package.
- `coinbase-codex-vX.Y.Z`: Codex marketplace containing the portable package.

Download versioned ZIP or tar archives from [Coinbase Agent Plugin downloads](https://coinbase.github.io/agents/), verify them against `SHA256SUMS`, and extract the package for your client. Plugin-format support does not imply Coinbase OAuth client approval; do not bypass rejected authentication.

For local development, run `python3 scripts/build-distributions.py dist` and use the generated directories under `dist/site/packages/`. The repository root is not an installable plugin.

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

For the full library's standalone skills, use your harness's supported installation method and include the complete `skills/` directory so cross-skill references resolve. The paper-only bundle above is self-contained and needs no live-skill installation. Preserve existing installations and settings.

## Safety and support

Keep native approval controls enabled. Trades, transfers, conversions, paid research, and recurring activity require explicit authorization; installation and authentication do not authorize financial actions.

For help, use [CDP Discord](https://discord.com/invite/cdp). Report vulnerabilities privately through [SECURITY.md](SECURITY.md). Remote access can be revoked in [Coinbase Security → Connections](https://accounts.coinbase.com/security/connections); CLI keys are managed separately. Uninstalling does not revoke access.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance, source provenance, and release requirements.

## License

This project is licensed under the [MIT](LICENSE). This license does not grant any rights to use Coinbase names, logos, or trademarks.

## Legal Notice

This repository provides skills and plugin packaging that let AI agents interact with your Coinbase account on your behalf based on instructions you give and permissions you approve. Instructions your agent sends through these tools are treated as instructions from you.

The software is provided "as is" and "as available," without warranties of any kind, express or implied, including merchantability, fitness for a particular purpose, and non-infringement. It is intended only to help carry out your instructions and is not intended to provide (i) an offer or solicitation to buy or sell any asset or to participate in any investment or trading strategy, or (ii) investment recommendations or investment, legal, tax, or accounting advice.

AI agents can produce inaccurate or unexpected output and can be influenced by text they read, including third-party content. You are responsible for reviewing your agent's actions, keeping approval controls enabled, and securing the environment it runs in. Trading digital assets, equities, and futures involves substantial risk of loss, and you assume all risk of loss from your use of the software.

Your use of this software is subject to the [Coinbase Developer Platform Terms of Service](https://www.coinbase.com/legal/developer-platform/terms-of-service) and your use of Coinbase Services is subject to the applicable agreements that govern access to your Coinbase account. Availability varies by location and account eligibility.
