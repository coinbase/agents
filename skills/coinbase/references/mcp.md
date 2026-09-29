# Remote MCP execution

Use with the [shared Coinbase workflow](../SKILL.md). This reference requires no CLI, Node.js, CDP API key, shell access, separate wallet, or custom token helper.

## Connect and verify

1. Reuse the harness's approved Coinbase connection to `https://agents.coinbase.com/mcp`. Otherwise use its native Streamable HTTP/OAuth flow, following the [current supported-client guide](https://docs.cdp.coinbase.com/ai-agents/coinbase-for-agents/coinbase-mcp). A plugin manifest is not client approval.
2. Let the harness handle discovery, client registration, PKCE, callbacks, refresh, and secure credential storage. Have the user sign in on Coinbase and approve the intended portfolios and required scopes. Never ask for passwords, one-time codes, authorization codes, keys, or tokens in chat.
3. Discover tools through the harness (`tools/list`, following pagination). Use the exact exposed names and input schemas; hosts may add a namespace to the core `coinbase_` names used in these references.
4. Call `coinbase_portfolios_list` with `{}`. Check JSON-RPC errors and tool `isError`, not just HTTP status. An empty portfolio list is valid. Report verification without dumping account details. Never trade, transfer, convert, pay, or change a portfolio to test setup.

Client registration, Coinbase client approval, user consent, OAuth scopes, and product/account eligibility are separate checks. If authorization fails, stop and request [client support](https://discord.com/invite/cdp). Never impersonate another client, implement replacement OAuth, or bypass the harness with raw authenticated HTTP. An alternative CLI setup requires the user's separate choice and is not a way to bypass a denied permission.

## Calls and errors

- Native structured arguments only. Do not translate CLI flags (`--paginate`, `-e`, query `==`, or raw-JSON `:=`) into tool fields.
- Use the actual discovered portfolio ID and set the intended portfolio wherever the tool supports it. Tool discovery does not prove authorization to invoke it.
- Follow response pagination; use only fields supported by that tool, not those of a similarly named CLI command.
- These references target the core remote tool contract. A client-specific adapter may replace tools with confirmation-card flows. If discovery/server instructions require a signed confirmation token or widget action, use that client flow; do not synthesize tokens or call widget-only financial tools directly.
- Write gates, feature flags, OAuth grants, and product eligibility can reject a discoverable tool. Preserve the denial; it is not a reason to switch credentials or bypass the selected client.
- For 401, use native refresh/reconnect; for missing scopes, request consent. Do not silently use CLI credentials.
- For 429, honor `Retry-After` and use bounded backoff. For unknown write outcomes, use authorized state reads and the original supported idempotency identifier; stop if unresolved.
- Remote MCP can chain multiple calls but does not expose the CLI's WebSocket watch/stream flags. Do not invent a subscription or replace one with tight polling.

Revoke consent at https://accounts.coinbase.com/security/connections. Uninstalling alone does not revoke it.
