---
title: "BlindOracle Plugin"
description: "Pay-per-call agent trust checks, due diligence and research from BlindOracle's HTTP API, paid with USDC on Base through Wallet MCP x402 approval."
tags: [ai-agents, agent-commerce, agent-trust, research]
name: blindoracle
version: 0.1.0
integration: http-api
chains: [base]
requires:
  shell: none
  allowlist: [api.craigmbrown.com]
  externalMcp: null
  cliPackage: null
auth: none
risk: [irreversible]
---

# BlindOracle Plugin

> [!IMPORTANT]
> Run Wallet MCP onboarding first (see `SKILL.md`). Agree on a spending budget with the user before any paid call. The catalog is free; every service call charges USDC on Base through Wallet MCP x402 approval.

## Overview

[BlindOracle](https://craigmbrown.com/blindoracle/) sells per-call services an agent can buy before it transacts with another agent or vendor: reputation lookups, trust badges, pre-hire checks, receipt verification, due-diligence scans, and topic research. Each service is one HTTP endpoint on `https://api.craigmbrown.com`, priced in USDC on Base (`eip155:8453`) over x402 v2. The plugin reads the free catalog over HTTP. For a paid call, the agent sends the request through Wallet MCP `initiate_x402_request`, the user approves the quoted amount, and `complete_x402_request` returns the JSON deliverable. No calldata is built and nothing is submitted with `send_calls`.

## Surface Routing

| Capability | HTTP-capable harness (Claude Code, Codex, Cursor) | Chat-only surface (Claude.ai, ChatGPT) |
| - | - | - |
| Browse the catalog (`GET /v1/services`) | Use the harness HTTP tool. | Use Wallet MCP `web_request` if `api.craigmbrown.com` is allowlisted. Otherwise give the user the URL to open. |
| Read one service's price and input schema (`GET /v1/services/{sku_id}`) | Harness HTTP tool. The response is the `402` with `accepts[]` and the input schema. | Same, through `web_request` when allowlisted. |
| Paid service call | Wallet MCP `initiate_x402_request` → user approval → `complete_x402_request`. | Same Wallet MCP x402 tools. If no x402 tool is exposed, stop and tell the user. Do not build the payment by hand. |

For the HTTP decision tree (harness tool, then `web_request`, then user paste) see [custom-plugins.md](../references/custom-plugins.md).

## Endpoints

Base URL: `https://api.craigmbrown.com`

`GET /v1/services`
Free. Returns `{ count, services: [...] }`. Each service has `sku_id`, `name`, `description`, `price_usd`, `url`, `status`, `mode` and `input_schema`. Only call services with `status: "live"` and `mode: "x402"`.

`GET /v1/services/{sku_id}`
Free. Returns HTTP `402` with an x402 v2 body (also in the `PAYMENT-REQUIRED` header): `accepts[]` holds one entry `{ scheme: "exact", network: "eip155:8453", asset: <USDC on Base>, amount: <atomic units>, payTo, maxTimeoutSeconds }`. `extensions.bazaar` describes the input and an example output.

`POST /v1/services/{sku_id}`
Paid. JSON body that matches the service's `input_schema` (for example `{ "task": "..." }`, `{ "agent_name": "..." }` or `{ "prompt": "..." }`). Without payment it returns the same `402`. With a valid payment it returns `200` and `{ status, deliverable, ... }`.

Services that fit a wallet-holding agent (call `GET /v1/services` for live prices; do not hardcode them):

| `sku_id` | What it answers | Body fields (`input_schema`) |
| - | - | - |
| `reputation.lookup` | What is this agent's BlindOracle reputation score, level and run history? | `task`: agent id or name |
| `agent.trust-badge` | Trust badge for a passported agent: AUDITED when an in-date BlindOracle audit is on record, otherwise identity only | `agent_name` and/or `wallet` |
| `agent.prehire-check` | Pre-hire check before delegating spend: settlement history, dispute rate, flagged incidents | `agent_name` and/or `wallet` |
| `trust.receipt-verify` | Is a BlindOracle receipt's proof really on the proof rail, and does its payload still hash to the stored row? | `prompt`: `proof_id`, `tx` and/or `content_sha256` |
| `ops.due-diligence-scan` | Due-diligence scan of a vendor or counterparty | `prompt`: vendor name or domain |
| `research.topic-news-scanner` | Recent news on a topic | `prompt`: topic |

## Orchestration

### Pick a service
1. Call `GET /v1/services` and match the user's request to a service by `name` and `description`.
2. Call `GET /v1/services/{sku_id}`, read `accepts[0].amount` (USDC, 6 decimals), and show the user the service name and price in dollars.
3. Confirm the price fits the agreed budget. Stop and ask if it does not.

### Paid call
1. Call Wallet MCP `get_wallets` to confirm a Base wallet with enough USDC.
2. Call Wallet MCP `initiate_x402_request` with `POST https://api.craigmbrown.com/v1/services/{sku_id}` and a JSON body built from that service's `input_schema`.
3. Follow [approval-mode.md](../references/approval-mode.md): give the user the approval URL, then poll `get_request_status` until it is approved.
4. Call `complete_x402_request`. Read the returned JSON `deliverable` and summarize it for the user. Quote fields; do not invent scores.

## Submission

Submission is through the Wallet MCP x402 tools: `initiate_x402_request`, `get_request_status`, and `complete_x402_request`. Pass the endpoint URL, method `POST`, and the JSON body unchanged. The payment must match the `402`'s `accepts` entry exactly (network `eip155:8453`, the returned `asset`, `amount` and `payTo`). Do not use `send_calls` to transfer USDC to `payTo` directly: a raw transfer is not linked to a request and returns nothing. Do not ask for or use a private key.

## Example Prompts

**"Before I pay agent `budget-tracker-agent`, check its reputation. Spend no more than $0.05."**
1. `GET /v1/services/reputation.lookup` and show the price.
2. Paid call with `{ "task": "budget-tracker-agent" }`, approved through Wallet MCP.
3. Report the score, level and run counts. If `found` is false, say the agent has no recorded history.

**"Before I give the agent at 0xABC… spend authority, run a pre-hire check."**
1. `GET /v1/services/agent.prehire-check` and show the price.
2. After approval, paid call with `{ "wallet": "0xABC…" }`.
3. Report the settlement history, dispute rate and any flagged incidents. Do not send funds as part of this plugin. A transfer is a separate Wallet MCP `send` that the user approves on its own.

**"What can BlindOracle check for me?"** (chat-only, no payment)
1. `GET /v1/services` through `web_request` if allowlisted, otherwise give the user the URL.
2. List the live services with prices. Make no paid call until the user picks one and sets a budget.

## Risks & Warnings

- **Irreversible payment.** Settled x402 payments on Base cannot be undone. Confirm the service and price with the user before every paid call, and never retry a paid call automatically after an ambiguous result. Check `get_request_status` first.
- **Budget.** A spending instruction in the prompt is not a server-enforced limit. Track the running total yourself and stop when the next call would exceed the budget.
- **Scope of a verdict.** A reputation score or pre-hire verdict reports BlindOracle's records and checks. It does not guarantee the other party's behavior. Present it as one input to the user's decision.

## Notes

- USDC on Base: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, 6 decimals (`10000` atomic = $0.01).
- x402 version 2. The retry header is `PAYMENT-SIGNATURE`; the gateway also accepts `X-PAYMENT`.
- The `payTo` address can change. Always use the value from the latest `402`.
- Machine-readable catalog for agents: `https://craigmbrown.com/llms.txt`.
