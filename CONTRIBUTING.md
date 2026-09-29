# Contributing

## Making changes

1. Fork or create a feature branch. Use a conventional PR title, such as `feat(cursor): update plugin metadata`.
2. Edit shared workflows in root `skills/` first. Keep `SKILL.md` capability-oriented; put execution details in `references/cli.md` and `references/mcp.md`. Load only the selected interface reference. Watch remains CLI-only; its MCP reference explains the limitation rather than inventing a tool.
3. Keep one repository-root plugin and one `skills/` tree. Root `plugin.json` and `mcp.json` target the published Agent Plugins 1.0.0 schemas. Use documented client extensions for metadata; do not add portable component-path overrides, credentials, or per-harness skill copies. Keep all package paths inside the repository root.
4. Maintain the thin `.claude-plugin/plugin.json` compatibility layer: it discovers the same root skills and declares the same remote endpoint using Claude's native HTTP type. Keep common metadata, package versions, and root marketplace sources consistent. Do not add a root `.mcp.json` or competing native Cursor/Codex manifest. Validate native loading where available (for example, `claude plugin validate . --strict`), and verify OAuth with a portfolio read, never a financial write. Record checks not run.
5. Use [signed commits](https://docs.github.com/en/authentication/managing-commit-signature-verification/signing-commits), update the README/changelog, and open a PR using the template. Obtain review before merging.

Before release, validate `plugin.json` and `mcp.json` with the [official versioned JSON Schemas](https://github.com/agentplugins/agent-plugins-spec/tree/main/schemas/1.0.0), then check semantic rules not expressed by the schemas: HTTPS URL/no credentials, fixed discovery locations, filesystem containment, and skill frontmatter. Verify exactly nine skills and their CLI/MCP references, all local links, asset paths, marketplace sources (`./`), and Claude endpoint/metadata parity. Recheck tool names against current MCP contracts and CLI patterns against installed help/templates. Run checks with temporary tooling if needed; no checked-in exporter, validator, tests directory, or CI framework is required.

Review these cases explicitly: MCP-only setup never asks for CLI credentials; CLI-only setup does not assume OAuth; both available honors user choice and verifies scope; unsupported client/capability stops or asks before switching; watch is not a remote subscription; unknown order/payment outcomes never switch interfaces or generate fresh retry IDs. Confirm product/session limitations, exact approvals, preview failures, pagination, and state verification. Static checks are not authenticated smoke tests.

## Source material

The skills are maintained Coinbase CLI and MCP guidance, not an automatic upstream sync. Preserve source attribution and have maintainers confirm licensing and required notices for contributed material.

Shared guidance and interface references are based on the [published Coinbase guide](https://docs.cdp.coinbase.com/coinbase-for-agents/skill.md), current tool contracts, and CLI help/source. Review against the latest schemas and client support before release. All harnesses use the same root library, with `coinbase` as the entry point. No external reference repository's code, telemetry, or runtime is bundled.

The single `assets/coinbase.svg` mark is extracted from the published CDP documentation wordmark; its source URL is recorded in the asset. Confirm branding approval before public marketplace submission. OpenAI icon/presentation fields belong in `extensions.com.openai`; do not invent fields or namespaces for another client or add a top-level portable `logo` field.

## Release review

- Maintainers must complete the required licensing, branding, security, and release approvals before publication.
- Review changes for secrets, personal data, private infrastructure references, and unsupported compatibility claims.
- Protect release branches with required reviews, signed commits, and applicable status checks.
- If Actions are added later, pin them to full commit SHAs. Do not use repository or organization secrets; use restricted Environment secrets only when necessary.
- Test every advertised harness with its approved OAuth client, update versions and changelog, and obtain explicit authorization before changing visibility or submitting marketplace listings. Access approval is not launch approval.

Do not include private review records or approval evidence in public source files.

## Help

Open an issue for non-security bugs with the harness/version and sanitized reproduction steps. Use [CDP Discord](https://discord.com/invite/cdp) for Coinbase client support. Report vulnerabilities privately through [SECURITY.md](SECURITY.md).
