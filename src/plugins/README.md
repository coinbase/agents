# Coinbase Agents

Coinbase workflows for portable Agent Plugins clients and native harness integrations.

Start with the `coinbase` skill to choose a product, then load `coinbase-cli` or `coinbase-mcp` for setup, shared safety, and capability routing. Read the linked capability guides before planning or executing; keep each skill's `references/` directory intact because those files contain the detailed workflows and execution contracts. Hosted Coinbase MCP uses client-managed OAuth; Coinbase CLI requires a separately installed and configured CLI. Loading CLI guidance does not grant shell access in an MCP-only client.

Installation and authentication do not authorize financial actions. Confirm each trade, transfer, conversion, or x402 budget before execution.

Source and release documentation: https://github.com/coinbase/agents
