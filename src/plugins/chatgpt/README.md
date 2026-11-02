# Coinbase for ChatGPT

Coinbase workflows for ChatGPT through the hosted Coinbase MCP server.

Start with the `coinbase` skill, then load `coinbase-mcp` for setup, shared safety, and capability routing. Read the linked capability guides before planning or executing; keep the skill's `references/` directory intact because those files contain the detailed workflows and execution contracts. Hosted Coinbase MCP uses client-managed OAuth.

Installation and authentication do not authorize financial actions. Each trade or conversion is confirmed in a Coinbase confirmation card before it executes.

Source and release documentation: https://github.com/coinbase/agents
