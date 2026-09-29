# Coinbase Agents

Skills and plugins for using Coinbase with AI agents. Read market data, manage portfolios, trade, and access paid research through Coinbase MCP or the Coinbase CLI.

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

### Install locally

The repository root is one [Agent Plugins v1.0.0](https://agent-plugins.org/) package, with a Claude Code compatibility manifest. Use the whole package, including tracked dot-directories, but exclude `.git` and local credentials. Plugin-format support does not imply Coinbase OAuth client approval; do not bypass rejected authentication.

#### Claude Code

From the repository root:

```sh
claude --plugin-dir "$PWD"
```

Open `/mcp` to authenticate, then load `/coinbase:coinbase`. See [Claude Code's plugin documentation](https://code.claude.com/docs/en/plugins-reference) for persistent installation.

#### Codex

From the repository root:

```sh
codex plugin marketplace add "$PWD"
```

Install and enable `coinbase` from `coinbase-agents` in the supported plugin UI. Adding the catalog alone does not enable the plugin. See [Codex's plugin documentation](https://developers.openai.com/plugins/build/plugins).

#### Cursor

Copy the package into a new `~/.cursor/plugins/local/coinbase/` directory, then reload **Customize**. Local imports require administrator permission. See [Cursor's plugin documentation](https://cursor.com/docs/reference/plugins).

#### Hermes

Copy the package into a new `~/.hermes/plugins/coinbase/` directory, or your active profile's plugin directory, then run:

```sh
hermes plugins list
hermes plugins enable coinbase
```

Use the plugin key returned by `list` if different. Follow [Hermes's portable-plugin documentation](https://hermes-agent.nousresearch.com/docs/developer-guide/plugins/#portable-agent-plugins-v1-packages) and native OAuth setup. Reuse existing connections rather than adding duplicates.

For standalone skills, use your harness's supported installation method and include the complete `skills/` directory so cross-skill references resolve. Preserve existing installations and settings.

## Safety and support

Keep native approval controls enabled. Trades, transfers, conversions, paid research, and recurring activity require explicit authorization; installation and authentication do not authorize financial actions.

For help, use [CDP Discord](https://discord.com/invite/cdp). Report vulnerabilities privately through [SECURITY.md](SECURITY.md). Remote access can be revoked in [Coinbase Security → Connections](https://accounts.coinbase.com/security/connections); CLI keys are managed separately. Uninstalling does not revoke access.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance, source provenance, and release requirements.

## License

[MIT](LICENSE). Coinbase trademarks are not covered by the software license.
