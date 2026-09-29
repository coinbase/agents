## Description

What changed and why?

## Change type

- [ ] Harness integration or metadata
- [ ] Skill workflow
- [ ] Bug fix
- [ ] Documentation
- [ ] Breaking change (describe migration)

## Validation

Describe native harness checks performed and explicitly list checks not run. Include screenshots or before/after behavior where useful; omit credentials and account data.

- [ ] Portable root manifest and MCP config validate against the published Agent Plugins schemas
- [ ] Package paths and skill references remain inside the repository/plugin root
- [ ] Marketplace, skills, MCP, and icon paths are valid
- [ ] Exactly one canonical skill library; no per-harness copies
- [ ] Claude compatibility metadata/endpoint and marketplace sources agree with the portable package
- [ ] Tool schemas, authorization, and retry behavior reviewed
- [ ] README and changelog updated; versions consistent
- [ ] No unapproved disclosures or sensitive data
- [ ] Signed commits

## Release considerations

List outstanding approvals, client-support limits, and rollout steps. Validation does not authorize public publication.
