# Coinbase Agents

Coinbase workflows for portable Agent Plugins clients and native harness integrations.

Start with the `coinbase` skill to choose a product, then load that product's entry skill for setup and workflows. This package includes separate Coinbase CLI and Coinbase MCP skills, with execution guidance in each skill rather than separate interface references. Hosted Coinbase MCP uses client-managed OAuth; Coinbase CLI requires a separately installed and configured CLI. Loading CLI guidance does not grant shell access in an MCP-only client.

Installation and authentication do not authorize financial actions. Confirm each trade, transfer, conversion, or x402 budget before execution.

Source and release documentation: https://github.com/coinbase/agents
