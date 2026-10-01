# Contributing

## Making changes

1. Fork or create a feature branch. Use a conventional PR title, such as `feat(cursor): update plugin metadata`.
2. Edit shared workflows in root `skills/` first. Keep `SKILL.md` capability-oriented; put execution details in `references/cli.md` and `references/mcp.md`. Load only the selected interface reference. Watch remains CLI-only; its MCP reference explains the limitation rather than inventing a tool.
3. Keep one `skills/` source tree. Portable source manifests live under `src/plugins/portable/` and target the published Agent Plugins 1.0.0 schemas. Use documented client extensions for metadata; do not add portable component-path overrides, credentials, or hand-maintained skill copies.
4. Maintain native source metadata under `src/plugins/`. Keep common metadata, package versions, and endpoint configuration consistent. Run `python3 scripts/build-distributions.py dist` and inspect the generated packages rather than treating the repository root as a plugin. Validate native loading where available, and verify OAuth with a portfolio read, never a financial write. Record checks not run.
5. Use [signed commits](https://docs.github.com/en/authentication/managing-commit-signature-verification/signing-commits), update the README/changelog, and open a PR using the template. Obtain review before merging.

Before release, run `python3 scripts/build-distributions.py dist`. It validates portable identity, schema identifiers, the exact MCP endpoint, extension assets, filesystem containment, skill frontmatter, local links, native metadata, and version parity before creating archives and checksums. CI validates the source manifests against the vendored official schemas. Inspect each generated layout and recheck tool names against current MCP contracts and CLI patterns against installed help/templates.

Review these cases explicitly: MCP-only setup never asks for CLI credentials; CLI-only setup does not assume OAuth; both available honors user choice and verifies scope; unsupported client/capability stops or asks before switching; watch is not a remote subscription; unknown order/payment outcomes never switch interfaces or generate fresh retry IDs. Confirm product/session limitations, exact approvals, preview failures, pagination, and state verification. Static checks are not authenticated smoke tests.

## Source material

The skills are maintained Coinbase CLI and MCP guidance, not an automatic upstream sync. Preserve source attribution and have maintainers confirm licensing and required notices for contributed material.

Shared guidance and interface references are based on the [published Coinbase guide](https://docs.cdp.coinbase.com/coinbase-for-agents/skill.md), current tool contracts, and CLI help/source. Review against the latest schemas and client support before release. All generated distributions use the same source library, with `coinbase` as the entry point. The vendored Agent Plugins schemas retain their upstream Apache 2.0 license; no external telemetry or runtime is bundled.

The single `assets/coinbase.svg` mark is extracted from the published CDP documentation wordmark; its source URL is recorded in the asset. Confirm branding approval before public marketplace submission. OpenAI icon/presentation fields belong in `extensions.com.openai`; do not invent fields or namespaces for another client or add a top-level portable `logo` field.

## Release review

- Maintainers must complete the required licensing, branding, security, and release approvals before publication.
- Review changes for secrets, personal data, private infrastructure references, and unsupported compatibility claims.
- Protect release branches with required reviews, signed commits, and applicable status checks.
- Keep Actions pinned to full commit SHAs. Do not use repository or organization secrets; use restricted Environment secrets only when necessary.
- Test every advertised harness with its approved OAuth client, update versions and changelog, and obtain explicit authorization before changing visibility or submitting marketplace listings. Access approval is not launch approval.

Do not include private review records or approval evidence in public source files.

## Help

Open an issue for non-security bugs with the harness/version and sanitized reproduction steps. Use [CDP Discord](https://discord.com/invite/cdp) for Coinbase client support. Report vulnerabilities privately through [SECURITY.md](SECURITY.md).
