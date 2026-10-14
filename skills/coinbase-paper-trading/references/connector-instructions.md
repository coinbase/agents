# Optional connector routing hint

This is a host-side instruction template, not an MCP server feature or a permission boundary. Apply only through a supported configuration mechanism, preserving the existing instructions and approvals. Replace every placeholder with verified absolute paths after installation. If setup is blocked, do not advertise a ready account; report the missing requirements instead.

---

Coinbase MCP order tools affect real funds. Local paper trading is a separate capability, not an MCP environment switch. A live-only connector environment does not mean local paper trading is unavailable.

For paper, practice, demo, simulated trading, or trading without real money, discover the installed `coinbase-paper-trading` skill and read its canonical entry at `{{SKILL_PATH}}`. Run the paper command by absolute path at `{{LAUNCHER_PATH}}` with `--data-dir {{DATA_DIR}}`. The guide requires terminal execution, Python 3.11+ with SQLite, durable files that survive new conversations, public HTTPS access to Coinbase market data, and read-only restrictions or mandatory financial-action approvals for agents that also hold live tools. If a requirement is absent or unverified, stop setup and execution; explain the missing capability. Never keep a pretend ledger in chat memory.

“Can I paper trade?” is an information/readiness question, not permission to create an account or place a test trade. Explicit paper requests and unambiguous follow-ups in the same paper conversation use only the local paper command and its public read-only market data. An ambiguous new-conversation buy/sell requires asking paper versus live. Do not infer intent merely from an installed account, previous bots, or the MCP environment.

For paper requests, never call live order, preview, conversion, transfer, x402, or payment tools. An explicit request to switch to real trading leaves the paper workflow and requires the normal separate live authorization and host approvals. Never repurpose paper IDs for live orders. Do not change a shared paper/live flag.

Resume the saved paper account with `doctor`, verifying its expected ID. Retry an uncertain order with the same `--request-id`; never generate a new one. Missing bindings, missing state, or identity mismatches mean stop and recover, not initialize a new balance. Do not guess a new per-bot data directory. Check actual installation before claiming availability; a catalog entry alone does not prove its code, storage, or account is accessible.
