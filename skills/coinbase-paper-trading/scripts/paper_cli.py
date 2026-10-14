#!/usr/bin/env python3
"""coinbase-paper: PAPER-only trading controller (virtual funds, never live orders).

Resolves one local account per data directory, fetches public Coinbase market
data through ``public_data.PublicData`` and fills with the offline ``paper.py``
engine. Persisted per data directory: ``account.sqlite3`` (engine state and
authoritative receipts), ``profile.json`` (account binding) and
``requests/<request_id>.json`` (immutable normalized order intent).
"""

import argparse
import decimal
import json
import os
import sqlite3
import sys
import uuid
from pathlib import Path

sys.dont_write_bytecode = True  # keep the installed skill tree free of caches
SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import paper  # noqa: E402  (sibling engine; shared PaperError and accounting)

PaperError = paper.PaperError
VERSION = "1.2.0"
PROG = "coinbase-paper"
APP_DIR = "coinbase-paper"
STATE_FILE = "account.sqlite3"
PROFILE_FILE = "profile.json"
REQUESTS_DIR = "requests"
INTENT_VERSION = 1
INTENT_KEYS = ("request_id", "account_id", "product_id", "side", "size_type", "size")
GRANULARITIES = (
    "ONE_MINUTE",
    "FIVE_MINUTE",
    "FIFTEEN_MINUTE",
    "THIRTY_MINUTE",
    "ONE_HOUR",
    "TWO_HOUR",
    "FOUR_HOUR",
    "SIX_HOUR",
    "ONE_DAY",
)
PERSISTENCE_NOTE = (
    "UNVERIFIED: this CLI cannot certify that the host keeps this directory across "
    "sessions or machines; confirm durable storage with the host"
)
CANDLE_NOTICE = (
    "PAPER research data: public Coinbase candles. Never used as fills; trades "
    "fill only against a fresh order-book snapshot."
)


def default_client():
    try:
        from public_data import PublicData
    except ImportError:
        raise PaperError(
            "PUBLIC_DATA_UNAVAILABLE",
            "public market-data adapter is missing; reinstall the paper skill bundle",
        ) from None
    return PublicData()


# ------------------------------------------------------------------ paths


def resolve_root(data_dir=None, environ=None):
    """Return (root, source). One stable default per OS user, never cwd-based."""
    environ = os.environ if environ is None else environ
    if data_dir is not None:
        value, source = data_dir, "--data-dir"
    elif environ.get("COINBASE_PAPER_HOME"):
        value, source = environ["COINBASE_PAPER_HOME"], "COINBASE_PAPER_HOME"
    else:
        xdg = environ.get("XDG_DATA_HOME")
        if xdg and os.path.isabs(xdg):
            return Path(xdg) / APP_DIR, "XDG_DATA_HOME"
        try:
            home = Path.home()
        except (RuntimeError, KeyError):
            home = None
        if home is None or not home.is_absolute():
            raise PaperError(
                "HOME_UNAVAILABLE",
                "cannot determine the home directory; pass --data-dir ABS",
            )
        return home / ".local" / "share" / APP_DIR, "default"
    if not os.path.isabs(value):
        raise PaperError("INVALID_PATH", f"{source} must be an absolute path")
    return Path(os.path.normpath(value)), source


class Home:
    def __init__(self, root, source):
        self.root = root
        self.source = source
        self.state = paper.check_location(str(root / STATE_FILE), "data directory")
        self.profile = root / PROFILE_FILE
        self.requests = root / REQUESTS_DIR

    def binding(self):
        """Saved (state, account_id); never initializes or guesses an account."""
        if not self.profile.exists() and not self.profile.is_symlink():
            hint = (
                f"an account exists at {self.state} but is not bound; recover with: "
                f"bind --state {self.state} --account-id ID (doctor shows the ID)"
                if self.state.exists()
                else "no paper account here; run init only for an explicitly new "
                "account, or bind an existing one"
            )
            raise PaperError("PROFILE_NOT_FOUND", hint)
        profile = paper.read_profile(str(self.profile))
        return profile["state"], profile["account_id"]


# ----------------------------------------------------------------- intents


def _write_new(target, text):
    """Create target with private permissions; never overwrite. True if created."""
    temp = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
    try:
        paper.make_private_dirs(target.parent)
        with os.fdopen(
            os.open(temp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), "w"
        ) as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.link(temp, target)
        except FileExistsError:
            return False
        return True
    except OSError as exc:
        raise PaperError(
            "REQUEST_PATH_UNAVAILABLE",
            "cannot save the order intent; use a writable local filesystem with "
            f"hard-link support: {exc.strerror or type(exc).__name__}",
        ) from None
    finally:
        try:
            temp.unlink(missing_ok=True)
        except OSError:
            pass


def read_intent(path):
    if path.is_symlink() or not path.is_file():
        raise PaperError("REQUEST_INVALID", "saved order intent is not a regular file")
    try:
        saved = paper.read_json_file(str(path), "saved order intent")
    except PaperError:
        raise PaperError(
            "REQUEST_INVALID", "saved order intent is unreadable; do not reuse this ID"
        ) from None
    if not isinstance(saved, dict) or saved.get("version") != INTENT_VERSION:
        raise PaperError("REQUEST_INVALID", "saved order intent has an unknown format")
    return saved


def persist_intent(home, intent):
    """Save immutable terms before the first execution attempt; reject changes."""
    record = {"version": INTENT_VERSION, **{key: intent[key] for key in INTENT_KEYS}}
    path = home.requests / f"{intent['request_id']}.json"
    if not path.exists() and not path.is_symlink():
        if _write_new(path, json.dumps(record, indent=2, sort_keys=True) + "\n"):
            return path
    if read_intent(path) != record:
        raise PaperError(
            "IDEMPOTENCY_CONFLICT",
            "request_id was already used for different terms; keep the original "
            "terms or use a new request_id for a new order",
        )
    return path


# ---------------------------------------------------------------- commands


def _account_home(args, environ):
    return Home(*resolve_root(getattr(args, "data_dir", None), environ))


def cmd_init(home, args):
    for path in (home.profile, home.state):
        if path.exists() or path.is_symlink():
            raise PaperError(
                "ACCOUNT_EXISTS",
                f"{path} already exists; init never reseeds. Use status, or bind an "
                "existing account to an empty data directory",
            )
    created = paper.init_state(str(home.state), args.cash, args.currency, args.fee_bps)
    try:
        paper.bind_profile(str(home.state), str(home.profile), created["account_id"])
    except PaperError as exc:
        raise PaperError(
            "INIT_INCOMPLETE",
            f"account {created['account_id']} was created at {home.state} but not "
            f"bound ({exc.message}); recover with: bind --state {home.state} "
            f"--account-id {created['account_id']}",
        ) from None
    return {**created, "data_dir": str(home.root), "profile": str(home.profile)}


def cmd_bind(home, args):
    account_id = args.account_id
    if not account_id.startswith("paper-") or not paper.UUID_RE.fullmatch(
        account_id[6:]
    ):
        raise PaperError("INVALID_ARGUMENT", "--account-id must be a paper account ID")
    result = paper.bind_profile(args.state, str(home.profile), account_id)
    return {**result, "data_dir": str(home.root)}


def cmd_trade(home, args, side, client_factory):
    request = {
        "request_id": args.request_id,
        "product_id": args.product,
        "side": side,
    }
    if args.base_size is not None:
        request["base_size"] = args.base_size
    if getattr(args, "quote_size", None) is not None:
        request["quote_size"] = args.quote_size
    paper.normalize_intent({**request, "account_id": "unbound"})  # terms first
    state, account_id = home.binding()
    request["account_id"] = account_id
    intent = paper.normalize_intent(request)
    request.update(
        request_id=intent["request_id"], **{intent["size_type"]: intent["size"]}
    )
    receipt = paper.find_receipt(state, intent, account_id)
    if receipt is not None:
        return receipt  # exact committed receipt; no market data needed
    persist_intent(home, intent)
    client = client_factory()
    request["product"] = client.product(intent["product_id"])
    request["book"] = client.book(intent["product_id"])
    return paper.trade(state, request, expected_account_id=account_id)


def cmd_status(home, args, client_factory):
    state, account_id = home.binding()
    report = paper.status(state, None, expected_account_id=account_id)
    if not args.refresh or not report["positions"]:
        return report
    if len(report["positions"]) > paper.MAX_BOOKS:
        raise PaperError(
            "INVALID_BOOKS",
            f"refresh supports at most {paper.MAX_BOOKS} positions; use offline status",
        )
    client = client_factory()
    books = [client.book(row["product_id"]) for row in report["positions"]]
    return paper.status(state, books, expected_account_id=account_id)


def cmd_candles(args, client_factory):
    if not paper.PRODUCT_RE.fullmatch(args.product):
        raise PaperError("INVALID_ARGUMENT", "PRODUCT must look like BTC-USD")
    if args.start < 0 or args.end <= args.start:
        raise PaperError(
            "INVALID_ARGUMENT",
            "--start and --end must be UNIX seconds with start < end",
        )
    raw = client_factory().candles(args.product, args.start, args.end, args.granularity)
    candles = raw.get("candles") if isinstance(raw, dict) else None
    if not isinstance(candles, list):
        raise PaperError("INVALID_CANDLES", "public candle response has no candle list")
    return {
        "mode": "PAPER",
        "ok": True,
        "product_id": args.product,
        "start": args.start,
        "end": args.end,
        "granularity": args.granularity,
        "candles": candles,
        "notice": CANDLE_NOTICE,
    }


def cmd_doctor(args, environ):
    """Read-only diagnostics: no init, no directory creation, no network."""
    report = {
        "mode": "PAPER",
        "ok": True,
        "ready": False,
        "version": VERSION,
        "python": sys.version.split()[0],
        "sqlite": sqlite3.sqlite_version,
        "network": "not used by doctor",
        "persistence": PERSISTENCE_NOTE,
    }
    root, source = resolve_root(getattr(args, "data_dir", None), environ)
    home = Home(root, source)
    report.update(
        data_dir=str(root),
        data_dir_source=source,
        data_dir_exists=root.is_dir(),
        profile=str(home.profile),
    )
    try:
        state, account_id = home.binding()
    except PaperError as exc:
        report["profile_status"] = (
            "MISSING" if exc.code == "PROFILE_NOT_FOUND" else "INVALID"
        )
        report["state"] = str(home.state)
        if exc.code != "PROFILE_NOT_FOUND":
            report.update(ok=False, error={"code": exc.code, "message": exc.message})
            return report
        report["hint"] = exc.message
        if home.state.exists() or home.state.is_symlink():
            try:
                found = paper.doctor(str(home.state))
                report.update(state_status="UNBOUND", account_id=found["account_id"])
            except PaperError as inner:
                report.update(
                    ok=False,
                    state_status="INVALID",
                    error={"code": inner.code, "message": inner.message},
                )
        else:
            report["state_status"] = "MISSING"
        return report
    report.update(profile_status="OK", state=state, account_id=account_id)
    try:
        found = paper.doctor(state, account_id)
    except PaperError as exc:
        missing = exc.code == "STATE_NOT_FOUND"
        report.update(
            ok=False,
            state_status="MISSING" if missing else "INVALID",
            error={"code": exc.code, "message": exc.message},
        )
        return report
    report.update(
        ready=True,
        state_status="OK",
        currency=found["currency"],
        order_count=found["order_count"],
        schema_version=found["schema_version"],
        model_version=found["model_version"],
    )
    return report


# --------------------------------------------------------------------- CLI


def build_parser():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument(
        "--data-dir",
        default=argparse.SUPPRESS,
        help="absolute account directory (overrides COINBASE_PAPER_HOME)",
    )
    parser = paper.Parser(
        prog=PROG,
        description=(
            "PAPER-only Coinbase trading simulator: virtual funds, public market "
            "data, never real orders, no login or API keys."
        ),
        parents=[common],
    )
    parser.add_argument("--version", action="version", version=f"{PROG} {VERSION}")
    commands = parser.add_subparsers(
        dest="command", required=True, parser_class=paper.Parser
    )
    commands.add_parser("doctor", parents=[common], help="read-only diagnostics")
    init = commands.add_parser(
        "init", parents=[common], help="create a new paper account (explicit only)"
    )
    init.add_argument("--cash", default="10000")
    init.add_argument("--currency", default="USD")
    init.add_argument("--fee-bps", default="10", help="assumed taker fee (bps)")
    bind = commands.add_parser(
        "bind", parents=[common], help="adopt an existing paper account database"
    )
    bind.add_argument("--state", required=True, help="absolute SQLite path")
    bind.add_argument("--account-id", required=True, help="expected paper account ID")
    buy = commands.add_parser("buy", parents=[common], help="virtual market buy")
    buy.add_argument("product", metavar="PRODUCT")
    size = buy.add_mutually_exclusive_group(required=True)
    size.add_argument("--base-size", metavar="DECIMAL")
    size.add_argument("--quote-size", metavar="DECIMAL", help="budget incl. fees")
    buy.add_argument("--request-id", required=True, metavar="UUID")
    sell = commands.add_parser("sell", parents=[common], help="virtual market sell")
    sell.add_argument("product", metavar="PRODUCT")
    sell.add_argument("--base-size", required=True, metavar="DECIMAL")
    sell.add_argument("--request-id", required=True, metavar="UUID")
    status = commands.add_parser("status", parents=[common], help="balances and P&L")
    status.add_argument(
        "--refresh", action="store_true", help="fetch public books to mark positions"
    )
    history = commands.add_parser("history", parents=[common], help="recent orders")
    history.add_argument("--limit", type=int, default=50)
    backup = commands.add_parser("backup", parents=[common], help="copy account")
    backup.add_argument("--output", required=True, help="absolute new file path")
    candles = commands.add_parser(
        "candles", parents=[common], help="public candles for research (not fills)"
    )
    candles.add_argument("product", metavar="PRODUCT")
    candles.add_argument("--start", type=int, required=True, metavar="UNIX")
    candles.add_argument("--end", type=int, required=True, metavar="UNIX")
    candles.add_argument("--granularity", required=True, choices=GRANULARITIES)
    return parser


def run(argv, client_factory=default_client, environ=None):
    args = build_parser().parse_args(argv)
    if args.command == "doctor":
        return cmd_doctor(args, environ)
    if args.command == "candles":
        return cmd_candles(args, client_factory)
    home = _account_home(args, environ)
    if args.command == "init":
        return cmd_init(home, args)
    if args.command == "bind":
        return cmd_bind(home, args)
    if args.command in ("buy", "sell"):
        return cmd_trade(home, args, args.command.upper(), client_factory)
    if args.command == "status":
        return cmd_status(home, args, client_factory)
    state, account_id = home.binding()
    if args.command == "history":
        return paper.history(state, args.limit, account_id)
    return paper.backup(state, args.output, account_id)


def _json_default(value):
    if isinstance(value, decimal.Decimal):
        return str(value)
    raise TypeError(type(value).__name__)


def main(argv=None, client_factory=default_client, environ=None):
    try:
        if sys.version_info < (3, 11):
            raise PaperError("UNSUPPORTED_RUNTIME", "Python 3.11 or newer is required")
        result = run(sys.argv[1:] if argv is None else argv, client_factory, environ)
    except PaperError as exc:
        result = {
            "mode": "PAPER",
            "ok": False,
            "error": {"code": exc.code, "message": exc.message},
        }
    except Exception as exc:  # fail closed without echoing raw input or bodies
        result = {
            "mode": "PAPER",
            "ok": False,
            "error": {"code": "INTERNAL_ERROR", "message": type(exc).__name__},
        }
    print(json.dumps(result, indent=2, default=_json_default))
    return 0 if result.get("ok") is True else 1


if __name__ == "__main__":
    sys.exit(main())
