---
title: "Mangrove Plugin"
description: "Guardrails for trading agents: Mangrove's 100+ strategy R&D tools, paid per call in USDC on Base with x402 from Wallet MCP, or used with a free API key."
tags: [trading, ai-agents, agent-commerce, x402-payments]
name: mangrove
version: 0.1.0
integration: hybrid
chains: [base]
requires:
  shell: none
  allowlist: [api.mangrovedeveloper.ai]
  externalMcp:
    name: mangrove
    transport: http
    url: https://api.mangrovedeveloper.ai/mcp/
  cliPackage: null
auth: api-key
risk: [slippage, irreversible]
---

# Mangrove Plugin

> [!IMPORTANT]
> Complete Wallet MCP onboarding first (`SKILL.md`). Paid Mangrove calls are USDC payments on Base approved through Wallet MCP; read the 402 price before every payment and never raise `maxPayment` silently. Contact: tim.darrah@mangrove.ai.

## Overview

Mangrove gives trading agents guardrails. Every order an agent places through Mangrove goes through built-in risk management: circuit breakers, drawdown and daily loss limits, automatic risk-based position sizing, and automatically generated stop-loss and take-profit orders. Behind that sit more than 100 tools for strategy research and development, backtesting and live execution across 12+ exchange venues, over REST (`https://api.mangrovedeveloper.ai`) and MCP (`https://api.mangrovedeveloper.ai/mcp/`). Mangrove runs on Base: the plugin pays for calls in USDC (x402, `eip155:8453`) through Wallet MCP, or uses a free Mangrove API key. Mangrove returns data and runs strategies on its own backend; it does not return unsigned calldata, and Wallet MCP is used only to pay for x402 calls.

Developer site: https://mangrovedeveloper.ai. OpenAPI: https://api.mangrovedeveloper.ai/openapi.json.

## Detection

- If no Mangrove MCP tools (for example `list_signals`, `get_market_regime`, `evaluate_strategy`) are exposed, the Mangrove MCP is not installed. Use the REST path in `## Endpoints`, or follow `## Installation`.
- Routes without an `x-payment-info` entry in the OpenAPI document need an API key unless they declare no security. Signal list, read and search are free and need no key.

## Installation

The Mangrove MCP is a hosted remote server; nothing runs on the user's machine.

- **Claude Code:** `claude mcp add --transport http mangrove https://api.mangrovedeveloper.ai/mcp/ --header "Authorization: Bearer <MANGROVE_API_KEY>"`
- **Cursor / JSON config:**

  ```json
  {
    "mcpServers": {
      "mangrove": {
        "url": "https://api.mangrovedeveloper.ai/mcp/",
        "headers": { "Authorization": "Bearer <MANGROVE_API_KEY>" }
      }
    }
  }
  ```

- **Claude.ai / ChatGPT:** add `https://api.mangrovedeveloper.ai/mcp/` as a custom connector.

The REST path needs no install and no key.

## Auth

- **x402 (no account):** request the route without credentials, read the base64 JSON `PAYMENT-REQUIRED` response header, pay with the Wallet MCP x402 payment tool, and repeat the request with the `PAYMENT-SIGNATURE` header.
- **API key:** send `Authorization: Bearer <MANGROVE_API_KEY>`. A free key is available at https://mangrovedeveloper.ai. The user provisions the key; never ask for it in chat or write it into a file.

## Surface Routing

| Capability | Harness with an HTTP tool or shell | Chat-only surface (Claude.ai, ChatGPT) |
| - | - | - |
| Free reads (signal list, read, search) | Harness HTTP tool, `GET` or `POST` as listed in `## Endpoints` | Mangrove MCP connector if installed; otherwise GET-only user-paste fallback in [custom-plugins.md](../references/custom-plugins.md) |
| Paid reads and evaluation (x402) | Harness HTTP tool, then Wallet MCP x402 payment on the 402 | Mangrove MCP connector with an API key; `api.mangrovedeveloper.ai` is not on the `web_request` allowlist, so tell the user paid x402 calls need a harness with HTTP tools and stop |
| Strategy, backtest, sweep and execution tools | Mangrove MCP tools (API key) | Mangrove MCP connector (API key) |

## Endpoints

Base URL `https://api.mangrovedeveloper.ai`. The live 402 header is authoritative for price: decode the base64 `PAYMENT-REQUIRED` header and read `accepts[0].amount` (atomic USDC, 6 decimals). Full catalog: `GET /openapi.json` (`x-payment-info` on each paid operation).

| Method | Path | Price | Purpose |
| - | - | - | - |
| `GET` | `/api/v1/signals/` | free | List signals |
| `POST` | `/api/v1/signals/search` | free | Search signals |
| `GET` | `/api/v1/crypto-assets/global-market` | 0.005 USDC | Global crypto market snapshot |
| `GET` | `/api/v1/market-data/regime/{asset}` | 0.02 USDC | Direction over 90/180/365 days plus volatility |
| `POST` | `/api/v1/execution/evaluate` | free for the first 30 calls per wallet per UTC day, then 0.05 USDC | Evaluate a strategy against current market data |

Payee for every paid route: `0xDA913CF1D855A40560e39a1a2e0387a5f3117A2e` on Base (`eip155:8453`), USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`. Check `payTo` and `asset` in the 402 before approving.

## Orchestration

1. Run Wallet MCP onboarding (`SKILL.md`); `get_wallets` supplies the paying address.
2. Pick the path: MCP tools present with an API key, else REST with x402.
3. For a free read, call it and return the result.
4. For a paid REST route, call it unpaid, decode `PAYMENT-REQUIRED`, confirm `network` is `eip155:8453`, `payTo` matches the payee above, and `amount` is acceptable to the user.
5. Pay with the Wallet MCP x402 payment tool, `maxPayment` just above the 402 amount, follow [approval-mode.md](../references/approval-mode.md), then repeat the request with `PAYMENT-SIGNATURE`.
6. Report the result and the amount paid. Do not retry a payment whose outcome is unknown; check the response first.

## Submission

`none` for onchain transactions: Mangrove does not return calldata. The only Wallet MCP use is the x402 payment tool for a paid REST call (USDC on Base, approval flow in [approval-mode.md](../references/approval-mode.md)). Live order execution runs inside Mangrove against the user's own Mangrove account and venue connections, with Mangrove's risk controls applied, and is never initiated from Wallet MCP.

## Example Prompts

**"What is the overall crypto market doing right now?"**
1. Detect: no Mangrove MCP; use REST (`## Detection`).
2. `GET /api/v1/crypto-assets/global-market` unpaid; read the 402 (0.005 USDC at the time of writing).
3. Show the price, pay through Wallet MCP x402 after approval, repeat with `PAYMENT-SIGNATURE`.
4. Summarize total market cap, BTC dominance and volume.

**"Which signals does Mangrove have for momentum?"**
1. `POST /api/v1/signals/search` (free), no payment.
2. List the matches with their types (TRIGGER or FILTER).

**"Is BTC trending up or down over the last 90 days?"**
1. `GET /api/v1/market-data/regime/BTC` unpaid; read the 402 (0.02 USDC at the time of writing).
2. Pay after approval and report direction and volatility.

## Risks & Warnings

- **Irreversible:** x402 payments settle onchain and cannot be reversed. Confirm the amount, payee and network with the user before each payment, and never auto-raise `maxPayment`.
- **Slippage:** orders executed through Mangrove's execution tools can fill worse than quoted. Mangrove's risk controls limit order size and add stop-loss and take-profit orders, but they do not remove market risk. Confirm every live order with the user; never place one silently.

## Notes

- Free tier: signal list, read and search; strategy evaluation is free for the first 30 calls per wallet per UTC day.
- Prices change; the live 402 header wins over any figure in this file.
- Support: tim.darrah@mangrove.ai.
