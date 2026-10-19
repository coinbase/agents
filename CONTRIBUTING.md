# Contributing

## Making changes

1. Fork or create a feature branch. Use a conventional PR title, such as `feat(cursor): update plugin metadata`.
2. Keep the shared `skills/coinbase/SKILL.md` as a product router, not a capability guide. Use one skill per product at `skills/<product>/SKILL.md`, with no additional product container. Coinbase CLI, hosted Coinbase MCP and the local paper trading simulator live under `skills/coinbase-cli/`, `skills/coinbase-mcp/` and `skills/coinbase-paper/`, with skill names matching their directories. Each product skill owns setup, authentication, shared safety, capability routing, and disconnecting. Put detailed capability workflows and their product-specific commands or tool contracts in that skill's `references/<capability>.md`; link them from the product skill and retain links back to its safety/setup and companion guides. Do not split capabilities into independently registered skills or mix CLI/MCP execution in a guide. Keep all approvals, scope checks, precision, and uncertain-outcome safeguards when updating either product.
3. Keep one `skills/` source tree. Add new products to the product tables in the shared router and README, not lists of every capability. The builder always includes the shared router and explicitly selects product skills through `COINBASE_SKILL_PRODUCTS`. It copies complete skill directories unchanged into the package's matching `skills/` layout. Links to unselected skills fail the build. To ship another product, update the product selection and approved client/MCP configuration together and test the generated package. Do not duplicate skill names or maintain client-specific skill copies. Portable source manifests live under `src/plugins/portable/` and target the published Agent Plugins 1.0.0 schemas; use documented client extensions rather than component-path overrides or credentials.
4. Maintain native source metadata under `src/plugins/`. Keep common metadata, package versions, and endpoint configuration consistent. Run `python3 scripts/build-distributions.py dist` and inspect the generated packages rather than treating the repository root as a plugin. Validate native loading where available, and verify OAuth with a portfolio read, never a financial write. Record checks not run.
   ChatGPT directory metadata lives in `src/plugins/chatgpt/plugin.json`, and its MCP configuration in `src/plugins/chatgpt/mcp.json` targets `https://agents.coinbase.com/mcp/chatgpt`. Keep this endpoint, directory-only URLs, subtitle limits, and generated icon sizing isolated from the other distributions, which use `https://agents.coinbase.com/mcp`. Reuse the canonical skills and icon artwork; do not maintain separate skill copies.
5. Use [signed commits](https://docs.github.com/en/authentication/managing-commit-signature-verification/signing-commits), update the README/changelog, and open a PR using the template. Obtain review before merging.

Before release, run `python3 scripts/build-distributions.py dist`. It validates portable identity, schema identifiers, the exact MCP endpoint, extension assets, filesystem containment, skill frontmatter, local links, native metadata, and version parity before creating archives and checksums. CI validates the source manifests against the vendored official schemas. Inspect each generated layout and recheck tool names against current MCP contracts and CLI patterns against installed help/templates.

For the paper simulator, run `npm ci --ignore-scripts`, `npm run typecheck` and `npm run test:paper` on Node.js 22.13+ (CI also runs Node 24). Keep its tests as `*.test.ts` next to the source; the builder excludes them from packages.

Run `python3 -m unittest discover -s tests` for product selection, shared-router inclusion, unchanged source/package links, complete skill copying, flat skill layouts, distribution isolation, and ChatGPT metadata regression checks. The ChatGPT build checks listing URLs, subtitle length, and generated icon dimensions; it does not establish directory policy compliance or approval.

Review these cases explicitly: MCP setup never asks for CLI credentials; CLI setup does not assume OAuth; both available honors user choice and verifies scope; unsupported client/capability stops or asks before changing products; monitoring stays CLI-only and MCP offers no invented subscription; unknown order/payment outcomes never change products or generate fresh retry IDs. Confirm product/session limitations, exact approvals, preview failures, pagination, and state verification. Static checks are not authenticated smoke tests.

## Source material

The skills are maintained Coinbase CLI and MCP guidance, not an automatic upstream sync. Preserve source attribution and have maintainers confirm licensing and required notices for contributed material.

Product workflows are based on the [published Coinbase guide](https://docs.cdp.coinbase.com/coinbase-for-agents/skill.md), current tool contracts, and CLI help/source. Review against the latest schemas and client support before release. All generated distributions use the same source library, with `coinbase` as the shared entry point and one skill each for CLI and MCP, including their capability references. The vendored Agent Plugins schemas retain their upstream Apache 2.0 license; no external telemetry is bundled. The only bundled runtime code is the `coinbase-paper` simulator in `skills/coinbase-paper/scripts/`: dependency-free TypeScript that uses Node.js built-ins, reads only public Coinbase market data, and never reads credentials or places orders.

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
