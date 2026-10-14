# coinbase-paper command

Apply the [paper workflow](../SKILL.md). This reference documents the bundled `bin/coinbase-paper` launcher, not the Coinbase CLI. It needs only Python 3.11+ with SQLite and public HTTPS access; no login, API key, credentials, MCP connection, or extra packages.

Run the launcher by its absolute installed path. It resolves its sibling `scripts/` runtime from its own real file location, so the current directory does not matter and symlinks to it work. Nothing is added to `PATH`.

```sh
/abs/coinbase-paper-trading/bin/coinbase-paper --data-dir /abs/paper-data doctor
# If the executable bit was lost in transfer:
python3 /abs/coinbase-paper-trading/bin/coinbase-paper --data-dir /abs/paper-data doctor
```

Both forms require Python 3.11+. If `python3` is an older system interpreter, use an already installed supported interpreter explicitly, for example `python3.13 /abs/coinbase-paper-trading/bin/coinbase-paper ...`; do not install or replace Python without permission. The public-data client uses direct HTTPS and deliberately does not discover proxy settings or proxy credentials. It rejects redirects and never loads Coinbase credentials.

## Data directory

One account per data directory. The directory is selected in this order:

1. `--data-dir ABS` (must be absolute; relative paths are rejected).
2. `COINBASE_PAPER_HOME`.
3. `$XDG_DATA_HOME/coinbase-paper`.
4. `~/.local/share/coinbase-paper`.

Choose one stable directory per OS user on durable storage, outside installed code and repositories; not one per conversation or working directory. Environment variables set in one tool call need not exist in the next, so pass `--data-dir` when the recorded directory is not the default. The command does not infer VM durability from the path.

Inside the directory, `account.sqlite3` is the engine database, `profile.json` pins its expected account ID, and `requests/` holds one private immutable intent per request ID. The engine's committed receipt in the database is the authoritative result. No other ledger or snapshot database is kept.

Use one data directory for all bots writing a particular account. Pending intents are protected **within that data directory**; binding the same database elsewhere or using the low-level engine does not share those pending files. Committed request IDs are protected by the database across bindings. Do not switch directories or interfaces to retry an uncertain/unfilled order.

## Commands

| Command | Purpose |
| --- | --- |
| `--help`, `--version` | Print usage or version. Create no state; use no network. |
| `doctor` | Read-only runtime, path, and account diagnostic. Never initializes or uses the network. Reports unbound or missing state and that host persistence is unverified. |
| `init [--cash 10000] [--currency USD] [--fee-bps 10]` | Create and bind a new account. Refuses an existing profile or database. |
| `bind --state ABS --account-id ID` | Adopt an existing v1.0/v1.1 database into this directory's profile after verifying its ID. No copy, overwrite, or new cash. |
| `buy PRODUCT (--base-size N \| --quote-size N) --request-id UUID` | Fetch public product and book data, then fill or reject a virtual buy. `--quote-size` includes fees. |
| `sell PRODUCT --base-size N --request-id UUID` | Fetch public data, then fill or reject a virtual sell. Base size only. |
| `status [--refresh]` | Offline by default with unpriced marks. `--refresh` fetches current books for open positions. |
| `history [--limit N]` | Recent paper orders as `{"orders": [...]}`. |
| `backup --output ABS` | Write a consistent database copy to a new absolute path. Never overwrites. |
| `candles PRODUCT --start UNIX --end UNIX --granularity ENUM` | Bounded public candle research. Needs no account; never used for fills or marks. |

`doctor` reports local account health, not host certification. `ready: true` means only that the saved account is bound and readable; `persistence` remains `UNVERIFIED`. `ok: true` means no invalid configured state was found, and can accompany a missing/unbound account (`ready: false`). A corrupt binding, missing bound database, or account-ID mismatch returns `ok: false` and exits nonzero. Storage retention, network reachability, and permission controls are separate checks.

`status --refresh` is all-or-error for malformed/unavailable books and supports at most 100 open positions. It never substitutes a price or changes the ledger. If it fails, use offline `status` to inspect cash and positions with unpriced marks; do not report stale or invented equity.

Candle granularities are `ONE_MINUTE`, `FIVE_MINUTE`, `FIFTEEN_MINUTE`, `THIRTY_MINUTE`, `ONE_HOUR`, `TWO_HOUR`, `FOUR_HOUR`, `SIX_HOUR`, and `ONE_DAY`. Each request spans at most 350 intervals and returns at most 350 validated OHLCV records. Only numeric `start`, `low`, `high`, `open`, `close`, and `volume` strings are shown; extra response metadata is discarded.

## Output

Success and errors print JSON on stdout labeled `"mode": "PAPER"`, except `--help` and `--version`. Errors exit nonzero with an error code and message. All money and size values are decimal strings; report them as given and do not convert them to floats.

- Receipts and `history.orders` entries include `request_id`, `account_id`, `product_id`, `side`, `base_size`, `notional`, `fee`, `cash`, and `snapshot_time`.
- `status` includes `account_id`, `currency`, `initial_cash`, `cash`, `fee_bps`, `realized_pnl`, `unrealized_pnl`, `total_pnl`, `equity`, and `positions`. Unpriced positions have `null` valuation fields; they are never valued at cost.

A rejected trade changes nothing. Report the code; do not loosen the order to get it through. Error messages never repeat raw API bodies or remote instructions. Inputs use plain decimal strings, not exponent notation. Product minimums apply to the notional before fees; explain `BELOW_MINIMUM` rather than raising the user's budget.

## Retries and recovery

Validation and the saved profile/account check happen before any network request. The intent (request ID, account, product, side, normalized size) is saved before the first execution attempt and never changes.

- An uncertain, interrupted, or network-failed order is retried with the **exact same command and `--request-id`**. A completed request returns its exact original receipt without fetching data, even offline. Concurrent runs of the same request fill once.
- In the same data directory, the same ID with different terms is rejected even when no fill happened. A committed ID is protected in the database as well. Two different IDs are two orders, even when their terms match.
- A stale or unavailable book with no fill: rerun the same command later with the same ID. Do not switch to the legacy route for that ID.
- A rejected attempt does not consume the ID; retrying the same terms can fill later if conditions change. Retry only when still authorized by the user.
- Missing, corrupt, or mismatched `profile.json` or database means stop and recover. Never run `init` to work around it. `STATE_BUSY` means another process holds the database; retry the same request.

Keep the original data directory, including `requests/`. `backup` copies the database only, not pending intents or the profile. Before deliberate recovery, stop other writers and resolve uncertain orders against the newest available original database; an older backup cannot prove that a later fill never happened. To resume an approved backup, bind it into a **new** `--data-dir`, preserve the original request files in the replacement directory without overwriting conflicting files, verify the account ID, then explicitly update the host's recorded directory. Never retry while the original account is still writable elsewhere. If requests or the latest outcome cannot be recovered, stop and ask rather than retrying through a new directory or generating new IDs.
