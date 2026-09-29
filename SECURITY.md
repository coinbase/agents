# Security Policy

The Coinbase team takes security seriously. Please do not file a public ticket discussing a potential vulnerability. Report findings through our [HackerOne program](https://hackerone.com/coinbase).

Never include API keys, OAuth tokens, private keys, customer data, or account identifiers in issues, PRs, fixtures, or logs. Revoke exposed credentials; deleting a committed secret is not sufficient.

Plugins delegate OAuth and token storage to the harness. Installation and authentication do not authorize financial actions. Keep native approval controls enabled; never add blanket write approval or impersonate another OAuth client.

Revoke Coinbase access at https://accounts.coinbase.com/security/connections. Removing a plugin or local credential file alone does not revoke consent.

Release review and validation requirements are described in [CONTRIBUTING.md](CONTRIBUTING.md).
