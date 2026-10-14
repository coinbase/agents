# Host-neutral installation and account continuity

Read [the requirements](../START-HERE.md#is-this-environment-eligible) and [the paper workflow](../SKILL.md) first. This is installation guidance, not authorization for trades. Stop if a required capability is absent or its availability is unknown. Nothing here changes the Coinbase MCP backend.

## 1. Check the actual host

- Verify an agent-accessible terminal and Python/SQLite, for example `python3 --version` and `python3 -c 'import sqlite3; print(sqlite3.sqlite_version)'`. Python must be 3.11+. Do not install dependencies without permission.
- On macOS, the system `python3` may be too old. Use an already installed Python 3.11+ explicitly (for example `python3.13 /abs/package/bin/coinbase-paper`); the launcher reports `UNSUPPORTED_RUNTIME` otherwise.
- Identify the durable local filesystem or host-documented persistent volume, its retention/deletion rules, and who can access it. On a desktop, an operator-confirmed persistent home directory can qualify. On a hosted VM, do not infer durability from `/workspace`, `/tmp`, a successful write, or the existence of a terminal. Unknown persistence blocks account setup. Do not create a chat-only or session-only substitute account.
- Confirm direct outbound public HTTPS to `api.coinbase.com`, for example with `candles` once installed. The client does not use proxy settings or proxy credentials. No login or Coinbase credential is needed or used. Without direct public HTTPS, the [optional legacy MCP route](mcp.md) needs an approved read-only MCP connection and a complete JSON-to-file handoff; switching routes requires resolving pending orders first.
- If the agent also has live Coinbase tools, verify host-enforced read-only restrictions or mandatory real-financial-action approvals. Prompt instructions alone do not isolate a broadly authorized agent. If neither control is available, block execution of this pilot and report the missing backstop.
- Establish how a new conversation will retrieve the installed skill, launcher path, and data directory. Distinguish skill-catalog sharing, filesystem sharing, and VM retention; they are different properties.

## 2. Install code, not state

Verify the trusted bundle digest and then internal `SHA256SUMS`. Extract with a tool that keeps permissions (`tar -xzf`, or `unzip`); `bin/coinbase-paper` must stay executable, or be run with `python3`. Keep the complete package at a stable code path. Keep the data directory, saved requests, and backups outside code and repositories. Do not overwrite an existing installation blindly. For an upgrade, keep the old bundle until the new one is checked; point the host at the new launcher while keeping the same data directory.

The canonical entry is `SKILL.md`, with `references/`, `bin/coinbase-paper`, and `scripts/` beside it. Call the launcher by absolute path; it is not installed on `PATH`, and a shell variable set in one call need not survive the next. A skill version change does not imply a database migration. Check `doctor`; unsupported schemas stop rather than auto-migrate.

## 3. Bind an account once

Recommended scope is one default paper data directory per OS user on an authorized machine, not one per bot or conversation. Different strategies may use explicitly separate `--data-dir` values. QA uses a separate directory. A second VM with the same pathname does not share this account.

Read any existing installation record before choosing paths. Run `doctor` against the recorded or default data directory; an unbound, missing, or mismatched account means recovery. If the user already has a v1.0/v1.1 database, verify its account ID and adopt it with `bind --state ABS --account-id ID`. A v1.1 profile JSON contains the `state` and `account_id` values needed for that command; preserve the original profile and database. Do not initialize a second default account just because a new bot cannot locate the first.

Before moving a v1.0/v1.1 installation to the companion, resolve any saved-but-unfilled or uncertain request through its original engine/profile/file workflow, or explicitly retire an unexecuted intent after verifying history and stopping its other writers. `bind` does not import old request files into the companion's intent format. Do not copy them blindly into `requests/` or retry the same ID through both interfaces. Once cut over, record one data directory for all bots using that account and retire the old execution route.

For an explicitly new account only, run `init`. If interrupted, inspect with `doctor` and recover with `bind`; never reseed. See [commands and recovery](cli.md). `bind` never changes balances or copies the database.

Record outside chat, using supported host configuration or a private file reachable from the installed entry:

- Absolute skill and launcher paths; package version and trusted digest.
- Absolute data directory; expected account ID from successful setup.
- Account alias/scope and authorized storage-sharing scope.
- Storage lifecycle evidence, including what is **not** retained across VM replacement.
- Discovery method and effective read-only/approval controls; distinguish verified controls from proposed ones.

A missing record is not evidence that no account exists. Records contain local paths/IDs, not Coinbase credentials. Do not publish them in source or the package.

## 4. Register for fresh bots (host requirement)

Installing files is not registration. A fresh bot can discover the capability only through a host mechanism that the host actually supports and refreshes; this package does not perform or prove that step. Use the host's documented skill/plugin mechanism if available, inspecting its current API and scope rather than guessing commands. Register only `coinbase-paper-trading` for this pilot; preserve existing skills, unrelated settings, and approval controls. Make the canonical description visible for “paper,” “practice,” “demo,” and “without real money.”

If the host registers Markdown without bundling helpers, retain the full package at the stable code location. Include the absolute path to the canonical `SKILL.md`, the launcher, and the data directory in the registration body; instruct the agent to read the canonical file before acting. Ensure all referenced files are actually accessible to fresh bots. Do not point relative links into a Markdown-only catalog entry or render an installed badge as proof. Where native installation carries the full skill directory, keep relative references intact.

Optionally merge [the connector routing hint](connector-instructions.md) into the host's supported Coinbase connector instructions after saving the prior instructions. Replace placeholders with verified paths, preserve other instructions, and check for unresolved placeholders. Do not create a machine-global paper/live flag. If this hook is unavailable, explicitly give the guide and paths to the agent; the command still works, but automatic cold discovery is not established.

For hosts exposing tools named `UpdateSkill` or `SetMcpInstructions`, treat those names as hints, not a promised API or permission scope. Inspect supported schemas, read existing configuration first, and verify returned catalog/configuration records. Do not assume user-wide visibility, helper-file persistence, or new-bot refresh from a successful write alone.

## 5. Confirm and test

Report **PAPER configured**, not “live sandbox,” with the account ID, launcher path, data directory, defaults or selected assumptions, and verified storage scope. A capability question alone must never initialize an account or place a smoke trade.

Follow [host acceptance](qa.md) before claiming automatic discovery or cross-bot resume. Keep unsupported or untested hosts unverified; a desktop test is not evidence of a hosted VM's persistence. For rollback, restore only the configuration entries changed during installation and point to the retained old code if needed. Never delete or reset the paper data as part of uninstalling, rollback, or a failed discovery test.
