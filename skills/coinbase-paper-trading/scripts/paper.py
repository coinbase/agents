#!/usr/bin/env python3
"""Local Coinbase paper-trading simulator (PAPER only, no network access).

Deterministic Decimal accounting stored in one SQLite file per account. Market
orders fill against a saved order-book snapshot supplied by the caller; this is
a conservative snapshot model, not an exchange matching engine.
"""

import argparse
import datetime as dt
import decimal
import json
import os
import re
import sqlite3
import sys
import uuid
from decimal import ROUND_CEILING, ROUND_FLOOR, ROUND_HALF_EVEN, Decimal
from pathlib import Path

SCHEMA_VERSION = 1
MODEL_VERSION = "snapshot-market-v1"
APP_ID = 0x50415052  # "PAPR"
MAX_BOOK_AGE_SECONDS = 60
MAX_FUTURE_SKEW_SECONDS = 5
BUSY_TIMEOUT_SECONDS = 5
MAX_FEE_BPS = Decimal("1000")
MAX_INPUT_BYTES = 2_000_000
MAX_BOOK_LEVELS = 1000
MAX_BOOKS = 100
MAX_HISTORY = 1000
SKILL_DIR = Path(__file__).resolve().parent.parent
NOTICE = (
    "PAPER simulation: virtual funds, filled against a saved order-book snapshot. "
    "No queue, latency or market-impact model; not predictive of live results."
)

decimal.getcontext().prec = 100
DECIMAL_RE = re.compile(r"^(0|[1-9][0-9]{0,14})(\.[0-9]{1,18})?$")
CURRENCY_RE = re.compile(r"^[A-Z0-9]{2,10}$")
PRODUCT_RE = re.compile(r"^[A-Z0-9]{1,15}-[A-Z0-9]{1,10}$")
UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$")
TIME_RE = re.compile(
    r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$"
)
REQUEST_KEYS = {
    "request_id",
    "account_id",
    "product_id",
    "side",
    "base_size",
    "quote_size",
    "product",
    "book",
}
BLOCKING_FLAGS = (
    "is_disabled",
    "trading_disabled",
    "cancel_only",
    "limit_only",
    "post_only",
    "view_only",
    "auction_mode",
)


class PaperError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def utcnow():
    return dt.datetime.now(dt.timezone.utc)


# ---------------------------------------------------------------- decimals


def parse_decimal(value, field, allow_zero=False):
    if not isinstance(value, str) or not DECIMAL_RE.fullmatch(value):
        raise PaperError(
            "INVALID_DECIMAL",
            f"{field} must be a plain decimal string (max 15 integer and 18 fraction digits)",
        )
    number = Decimal(value)
    if number < 0 or (number == 0 and not allow_zero):
        raise PaperError("INVALID_DECIMAL", f"{field} must be positive")
    return number


def places(increment):
    return max(0, -increment.normalize().as_tuple().exponent)


def fmt(value, increment=None):
    """Format a Decimal as a string, at least at the increment's precision."""
    if increment is not None:
        shown = places(increment)
        exact = max(0, -value.normalize().as_tuple().exponent)
        if exact <= shown:
            return f"{value:.{shown}f}"
    value = value.quantize(Decimal(1).scaleb(-18), rounding=ROUND_HALF_EVEN)
    text = format(value.normalize(), "f")
    return "0" if text in ("-0", "") else text


def to_increment(value, increment, rounding):
    steps = (value / increment).to_integral_value(rounding=rounding)
    return steps * increment


def is_multiple(value, increment):
    return value % increment == 0


def canonical(value):
    return format(value.normalize(), "f")


# ------------------------------------------------------------------ inputs


def _reject_constant(name):
    raise ValueError(f"non-finite number {name}")


def _unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate key {key!r}")
        result[key] = value
    return result


def loads(text, what):
    try:
        return json.loads(
            text,
            parse_float=Decimal,
            parse_constant=_reject_constant,
            object_pairs_hook=_unique_pairs,
        )
    except (ValueError, RecursionError):
        raise PaperError("INVALID_JSON", f"{what} is not valid JSON") from None


def read_json_file(name, what):
    try:
        if name == "-":
            data = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        else:
            with open(name, "rb") as handle:
                data = handle.read(MAX_INPUT_BYTES + 1)
    except OSError as exc:
        raise PaperError(
            "INPUT_NOT_READABLE", f"cannot read {what}: {exc.strerror}"
        ) from None
    if len(data) > MAX_INPUT_BYTES:
        raise PaperError("INPUT_TOO_LARGE", f"{what} exceeds {MAX_INPUT_BYTES} bytes")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        raise PaperError("INVALID_JSON", f"{what} is not UTF-8") from None
    return loads(text, what)


def unwrap(value, what):
    """Accept a raw response object, an MCP result with structuredContent, or an
    MCP result with exactly one JSON text block. Never executes tool text."""
    if not isinstance(value, dict):
        raise PaperError("INVALID_ENVELOPE", f"{what} must be a JSON object")
    if "error" in value or value.get("isError", False) is not False:
        raise PaperError("INVALID_ENVELOPE", f"{what} is an error response")
    if value.get("truncated", False) is not False:
        raise PaperError("INVALID_ENVELOPE", f"{what} is marked truncated")
    if "structuredContent" not in value and "content" not in value:
        return value
    if "structuredContent" in value:
        inner = value["structuredContent"]
    else:
        content = value["content"]
        if (
            not isinstance(content, list)
            or len(content) != 1
            or not isinstance(content[0], dict)
            or content[0].get("type") != "text"
            or not isinstance(content[0].get("text"), str)
        ):
            raise PaperError(
                "INVALID_ENVELOPE", f"{what} must contain exactly one JSON text block"
            )
        inner = loads(content[0]["text"], f"{what} text content")
    if not isinstance(inner, dict):
        raise PaperError("INVALID_ENVELOPE", f"{what} content must be a JSON object")
    if "error" in inner or inner.get("isError", False) is not False:
        raise PaperError("INVALID_ENVELOPE", f"{what} content is an error response")
    if inner.get("truncated", False) is not False:
        raise PaperError("INVALID_ENVELOPE", f"{what} content is marked truncated")
    return inner


def parse_time(value, what):
    match = TIME_RE.fullmatch(value) if isinstance(value, str) else None
    if not match:
        raise PaperError(
            "INVALID_BOOK", f"{what} time must be an ISO-8601 timestamp with zone"
        )
    fraction = (match.group(2) or "")[:7]
    zone = "+00:00" if match.group(3) == "Z" else match.group(3)
    try:
        return dt.datetime.fromisoformat(match.group(1) + fraction + zone)
    except ValueError:
        raise PaperError("INVALID_BOOK", f"{what} time is not a valid date") from None


def check_fresh(snapshot_time, now, what="book"):
    age = (now - snapshot_time).total_seconds()
    if age > MAX_BOOK_AGE_SECONDS:
        raise PaperError(
            "STALE_BOOK",
            f"{what} is {age:.1f}s old; maximum is {MAX_BOOK_AGE_SECONDS}s",
        )
    if age < -MAX_FUTURE_SKEW_SECONDS:
        raise PaperError(
            "FUTURE_BOOK",
            f"{what} time is {-age:.1f}s in the future; maximum skew is "
            f"{MAX_FUTURE_SKEW_SECONDS}s",
        )


def parse_levels(levels, side, product_id):
    if not isinstance(levels, list) or not levels:
        raise PaperError(
            "INVALID_BOOK", f"{product_id} book {side} must be a non-empty list"
        )
    if len(levels) > MAX_BOOK_LEVELS:
        raise PaperError(
            "INVALID_BOOK", f"{product_id} book {side} exceeds {MAX_BOOK_LEVELS}"
        )
    parsed = []
    for level in levels:
        if not isinstance(level, dict):
            raise PaperError(
                "INVALID_BOOK", f"{product_id} book {side} level must be an object"
            )
        price = parse_decimal(level.get("price"), f"{side} price")
        size = parse_decimal(level.get("size"), f"{side} size")
        parsed.append((price, size))
    for (previous, _), (current, _) in zip(parsed, parsed[1:]):
        ordered = current < previous if side == "bids" else current > previous
        if not ordered:
            raise PaperError(
                "INVALID_BOOK", f"{product_id} book {side} are not strictly ordered"
            )
    return parsed


def parse_book(raw, product_id=None):
    book = unwrap(raw, "book")
    pricebook = book.get("pricebook")
    if not isinstance(pricebook, dict):
        raise PaperError("INVALID_BOOK", "book must contain a pricebook object")
    book_product = pricebook.get("product_id")
    if not isinstance(book_product, str) or not PRODUCT_RE.fullmatch(book_product):
        raise PaperError("INVALID_BOOK", "pricebook.product_id is missing or invalid")
    if product_id is not None and book_product != product_id:
        raise PaperError(
            "PRODUCT_MISMATCH", "book product_id does not match the request"
        )
    time = parse_time(pricebook.get("time"), "pricebook")
    bids = parse_levels(pricebook.get("bids"), "bids", book_product)
    asks = parse_levels(pricebook.get("asks"), "asks", book_product)
    if bids[0][0] >= asks[0][0]:
        raise PaperError("INVALID_BOOK", f"{book_product} book is crossed or locked")
    return {
        "product_id": book_product,
        "time": time,
        "time_text": pricebook["time"],
        "bids": bids,
        "asks": asks,
    }


def parse_product(raw, product_id, currency):
    product = unwrap(raw, "product")
    if product.get("product_id") != product_id:
        raise PaperError(
            "PRODUCT_MISMATCH", "product metadata does not match product_id"
        )
    if product.get("product_type") != "SPOT":
        raise PaperError("UNSUPPORTED_PRODUCT", "only SPOT products are supported")
    base = product.get("base_currency_id")
    quote = product.get("quote_currency_id")
    if (
        not isinstance(base, str)
        or not isinstance(quote, str)
        or f"{base}-{quote}" != product_id
    ):
        raise PaperError(
            "PRODUCT_MISMATCH", "product base/quote currencies do not match"
        )
    if quote != currency:
        raise PaperError(
            "CURRENCY_MISMATCH", f"product quote {quote} is not account {currency}"
        )
    for flag in BLOCKING_FLAGS:
        if flag in product:
            if not isinstance(product[flag], bool):
                raise PaperError("INVALID_PRODUCT", f"product {flag} must be a boolean")
            if product[flag]:
                raise PaperError("PRODUCT_UNAVAILABLE", f"product is {flag}")
    status = product.get("status")
    if status is not None and (
        not isinstance(status, str) or status.lower() != "online"
    ):
        raise PaperError("PRODUCT_UNAVAILABLE", "product status is not online")
    limits = {}
    for key in ("base_increment", "quote_increment"):
        limits[key] = parse_decimal(product.get(key), f"product {key}")
    for key in ("base_min_size", "base_max_size", "quote_min_size", "quote_max_size"):
        if product.get(key) is not None:
            limits[key] = parse_decimal(product[key], f"product {key}")
    return limits


def parse_intent(request):
    intent = normalize_intent(request)
    for key in ("product", "book"):
        if key not in request:
            raise PaperError("INVALID_REQUEST", f"{key} response is required")
    return intent


def normalize_intent(request):
    """Validate and canonicalize trade terms; market data is not required here."""
    if not isinstance(request, dict):
        raise PaperError("INVALID_REQUEST", "trade request must be a JSON object")
    unknown = sorted(set(request) - REQUEST_KEYS)
    if unknown:
        raise PaperError(
            "INVALID_REQUEST", "unknown request fields; use only the documented terms"
        )
    request_id = request.get("request_id")
    if not isinstance(request_id, str) or not UUID_RE.fullmatch(request_id):
        raise PaperError("INVALID_REQUEST", "request_id must be a UUID string")
    account_id = request.get("account_id")
    if not isinstance(account_id, str) or not account_id:
        raise PaperError("INVALID_REQUEST", "account_id is required")
    product_id = request.get("product_id")
    if not isinstance(product_id, str) or not PRODUCT_RE.fullmatch(product_id):
        raise PaperError("INVALID_REQUEST", "product_id must look like BTC-USD")
    side = request.get("side")
    if side not in ("BUY", "SELL"):
        raise PaperError("INVALID_REQUEST", "side must be BUY or SELL")
    sizes = [key for key in ("base_size", "quote_size") if key in request]
    if len(sizes) != 1:
        raise PaperError(
            "INVALID_REQUEST", "use exactly one of base_size or quote_size"
        )
    size_type = sizes[0]
    if side == "SELL" and size_type != "base_size":
        raise PaperError("INVALID_REQUEST", "SELL requires base_size")
    size = parse_decimal(request[size_type], size_type)
    return {
        "request_id": str(uuid.UUID(request_id)),
        "account_id": account_id,
        "product_id": product_id,
        "side": side,
        "size_type": size_type,
        "size": canonical(size),
    }


# ------------------------------------------------------------------- state


def check_location(name, what):
    path = Path(name)
    if not path.is_absolute():
        raise PaperError("INVALID_PATH", f"{what} must be an absolute path")
    if path.is_symlink():
        raise PaperError("INVALID_PATH", f"{what} must name a file, not a symlink")
    resolved = path.parent.resolve() / path.name
    if resolved == SKILL_DIR or SKILL_DIR in resolved.parents:
        raise PaperError(
            "INVALID_PATH", f"{what} must be outside the installed skill directory"
        )
    return resolved


def make_private_dirs(directory):
    missing = []
    while not directory.exists():
        missing.append(directory)
        directory = directory.parent
    for item in reversed(missing):
        item.mkdir(mode=0o700, exist_ok=True)


def connect(path):
    conn = sqlite3.connect(
        path.as_uri() + "?mode=rw",
        uri=True,
        timeout=BUSY_TIMEOUT_SECONDS,
        isolation_level=None,
    )
    try:
        conn.execute(f"PRAGMA busy_timeout = {BUSY_TIMEOUT_SECONDS * 1000}")
        conn.execute("PRAGMA synchronous = FULL")
    except BaseException:
        conn.close()
        raise
    return conn


def create_new_file(target, build):
    """Build a database in a private temp file, then hard-link it into place so an
    existing file is never overwritten, even by a concurrent creator."""
    temp = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
    try:
        make_private_dirs(target.parent)
        if target.exists():
            raise PaperError(
                "STATE_EXISTS", f"{target} already exists; refusing to overwrite"
            )
        os.close(os.open(temp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600))
        conn = connect(temp)
        try:
            build(conn)
        finally:
            conn.close()
        try:
            os.link(temp, target)
        except FileExistsError:
            raise PaperError(
                "STATE_EXISTS", f"{target} already exists; refusing to overwrite"
            ) from None
    except OSError as exc:
        raise PaperError(
            "STATE_PATH_UNAVAILABLE",
            "Cannot create paper state or backup here. Use a writable local filesystem "
            f"with hard-link support: {exc.strerror or type(exc).__name__}",
        ) from None
    finally:
        for leftover in (temp, Path(f"{temp}-journal")):
            try:
                os.unlink(leftover)
            except FileNotFoundError:
                pass


SCHEMA = """
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE account (id INTEGER PRIMARY KEY CHECK (id = 1), cash TEXT NOT NULL,
    realized_pnl TEXT NOT NULL, quote_increment TEXT NOT NULL);
CREATE TABLE positions (product_id TEXT PRIMARY KEY, quantity TEXT NOT NULL,
    cost_basis TEXT NOT NULL, base_increment TEXT NOT NULL, quote_increment TEXT NOT NULL);
CREATE TABLE orders (seq INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL UNIQUE,
    intent TEXT NOT NULL, receipt TEXT NOT NULL, created_at TEXT NOT NULL);
"""


def init_state(state, cash, currency, fee_bps, now=utcnow):
    target = check_location(state, "--state")
    cash_value = parse_decimal(cash, "--cash")
    fee_value = parse_decimal(fee_bps, "--fee-bps", allow_zero=True)
    if fee_value > MAX_FEE_BPS or fee_value.as_tuple().exponent < -4:
        raise PaperError(
            "INVALID_ARGUMENT", "--fee-bps must be 0-1000 with at most 4 decimals"
        )
    if not isinstance(currency, str) or not CURRENCY_RE.fullmatch(currency):
        raise PaperError(
            "INVALID_ARGUMENT", "--currency must be an uppercase code such as USD"
        )
    account_id = f"paper-{uuid.uuid4()}"
    created = now().isoformat()
    meta = {
        "app": "coinbase-paper-trading",
        "schema_version": str(SCHEMA_VERSION),
        "model_version": MODEL_VERSION,
        "account_id": account_id,
        "currency": currency,
        "initial_cash": canonical(cash_value),
        "fee_bps": canonical(fee_value),
        "created_at": created,
    }

    def build(conn):
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(f"PRAGMA application_id = {APP_ID}")
        conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
        for statement in SCHEMA.split(";"):
            if statement.strip():
                conn.execute(statement)
        conn.executemany("INSERT INTO meta VALUES (?, ?)", meta.items())
        conn.execute(
            "INSERT INTO account VALUES (1, ?, '0', '')", (meta["initial_cash"],)
        )
        conn.execute("COMMIT")

    create_new_file(target, build)
    return {
        "mode": "PAPER",
        "ok": True,
        "account_id": account_id,
        "state": str(target),
        "currency": currency,
        "initial_cash": meta["initial_cash"],
        "cash": meta["initial_cash"],
        "fee_bps": meta["fee_bps"],
        "fee_note": "Assumed taker fee for simulation, not your Coinbase fee tier.",
        "schema_version": SCHEMA_VERSION,
        "model_version": MODEL_VERSION,
        "notice": NOTICE,
    }


def open_state(state, expected_account_id=None):
    path = check_location(state, "--state")
    if not path.is_file():
        raise PaperError(
            "STATE_NOT_FOUND",
            f"no paper account at {path}; recover it if previously configured",
        )
    try:
        conn = connect(path)
        try:
            account = load_account(conn, expected_account_id)
        except BaseException:
            conn.close()
            raise
        return conn, account
    except sqlite3.OperationalError as exc:
        if "locked" in str(exc) or "busy" in str(exc):
            raise PaperError(
                "STATE_BUSY", "paper state is busy; retry the same command"
            ) from None
        raise PaperError(
            "STATE_INVALID", f"{path} is not a usable paper state"
        ) from None
    except sqlite3.DatabaseError:
        raise PaperError(
            "STATE_INVALID", f"{path} is not a valid paper state"
        ) from None


def load_account(conn, expected_account_id=None):
    if conn.execute("PRAGMA application_id").fetchone()[0] != APP_ID:
        raise PaperError("STATE_INVALID", "file is not a paper-trading state")
    if conn.execute("PRAGMA user_version").fetchone()[0] != SCHEMA_VERSION:
        raise PaperError("STATE_UNSUPPORTED", "unsupported paper state schema version")
    meta = dict(conn.execute("SELECT key, value FROM meta"))
    if meta.get("schema_version") != str(SCHEMA_VERSION):
        raise PaperError("STATE_UNSUPPORTED", "unsupported paper state schema version")
    if meta.get("model_version") != MODEL_VERSION:
        raise PaperError("STATE_UNSUPPORTED", "unsupported paper fill model version")
    row = conn.execute(
        "SELECT cash, realized_pnl, quote_increment FROM account WHERE id = 1"
    ).fetchone()
    if row is None or not meta.get("account_id") or not meta.get("currency"):
        raise PaperError("STATE_INVALID", "paper state is missing account data")
    try:
        account = {
            "account_id": meta["account_id"],
            "currency": meta["currency"],
            "initial_cash": Decimal(meta["initial_cash"]),
            "fee_bps": Decimal(meta["fee_bps"]),
            "cash": Decimal(row[0]),
            "realized_pnl": Decimal(row[1]),
            "quote_increment": Decimal(row[2]) if row[2] else None,
        }
    except (KeyError, decimal.InvalidOperation):
        raise PaperError(
            "STATE_INVALID", "paper state contains invalid values"
        ) from None
    if not account["cash"].is_finite() or account["cash"] < 0:
        raise PaperError("STATE_INVALID", "paper state cash is invalid")
    if expected_account_id is not None and account["account_id"] != expected_account_id:
        raise PaperError(
            "ACCOUNT_MISMATCH",
            "paper account ID does not match the expected ID; stop and verify account selection",
        )
    return account


def load_positions(conn):
    positions = {}
    rows = conn.execute(
        "SELECT product_id, quantity, cost_basis, base_increment, quote_increment FROM positions"
    )
    for product_id, *values in rows:
        try:
            quantity, basis, base_inc, quote_inc = (Decimal(item) for item in values)
        except decimal.InvalidOperation:
            raise PaperError(
                "STATE_INVALID", "paper state position is invalid"
            ) from None
        positions[product_id] = {
            "quantity": quantity,
            "cost_basis": basis,
            "base_increment": base_inc,
            "quote_increment": quote_inc,
        }
    return positions


# --------------------------------------------------------- account locator


def read_profile(name):
    path = check_location(name, "--profile")
    if not path.exists():
        raise PaperError(
            "PROFILE_NOT_FOUND",
            f"no account binding at {path}; locate the existing binding or complete explicit setup",
        )
    if not path.is_file():
        raise PaperError(
            "PROFILE_INVALID", "account binding must be a regular JSON file"
        )
    try:
        profile = read_json_file(str(path), "account binding")
    except PaperError:
        raise PaperError(
            "PROFILE_INVALID",
            "cannot read a valid saved account binding; locate or restore it, do not initialize",
        ) from None
    if (
        not isinstance(profile, dict)
        or set(profile) != {"version", "state", "account_id"}
        or type(profile["version"]) is not int
        or profile["version"] != 1
        or not isinstance(profile["state"], str)
        or not isinstance(profile["account_id"], str)
        or not profile["account_id"].startswith("paper-")
        or not UUID_RE.fullmatch(profile["account_id"][6:])
    ):
        raise PaperError("PROFILE_INVALID", "invalid or unsupported account binding")
    profile["state"] = str(check_location(profile["state"], "bound state"))
    return profile


def bind_profile(state, profile_path, account_id):
    """Pin an existing account, never create cash or replace a different binding."""
    target = check_location(profile_path, "--profile")
    report = doctor(state, account_id)
    binding = {"version": 1, "state": report["state"], "account_id": account_id}
    temp = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
    created = False
    try:
        make_private_dirs(target.parent)
        with os.fdopen(
            os.open(temp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), "w"
        ) as handle:
            handle.write(json.dumps(binding, indent=2) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.link(temp, target)
            created = True
        except FileExistsError:
            if read_profile(str(target)) != binding:
                raise PaperError(
                    "PROFILE_EXISTS",
                    "a different account is already bound here; do not replace it during setup",
                ) from None
    except OSError as exc:
        raise PaperError(
            "PROFILE_PATH_UNAVAILABLE",
            f"cannot save account binding on this filesystem: {exc.strerror}",
        ) from None
    finally:
        try:
            temp.unlink(missing_ok=True)
        except NotADirectoryError:
            pass  # Creation failed because a parent is a file; nothing to remove.
    return {
        "mode": "PAPER",
        "ok": True,
        "profile": str(target),
        "state": binding["state"],
        "account_id": account_id,
        "created": created,
    }


# ------------------------------------------------------------------- fills


def walk(levels, quantity):
    remaining = quantity
    notional = Decimal(0)
    fills = []
    for price, size in levels:
        if remaining <= 0:
            break
        take = min(size, remaining)
        notional += price * take
        remaining -= take
        fills.append({"price": fmt(price), "size": fmt(take)})
    if remaining > 0:
        raise PaperError(
            "INSUFFICIENT_LIQUIDITY", "book snapshot depth cannot fill the order"
        )
    return notional, fills


def fee_for(notional, fee_bps, quote_inc):
    return to_increment(notional * fee_bps / Decimal(10000), quote_inc, ROUND_CEILING)


def buy_cost(asks, quantity, fee_bps, quote_inc):
    raw, fills = walk(asks, quantity)
    notional = to_increment(raw, quote_inc, ROUND_CEILING)
    fee = fee_for(notional, fee_bps, quote_inc)
    return notional, fee, fills


def size_quote_buy(asks, budget, fee_bps, base_inc, quote_inc):
    """Largest base-increment quantity whose rounded notional plus fee fits the budget."""
    depth = sum(size for _, size in asks)
    top = int(to_increment(depth, base_inc, ROUND_FLOOR) / base_inc)

    def total(steps):
        notional, fee, _ = buy_cost(asks, base_inc * steps, fee_bps, quote_inc)
        return notional + fee

    if top < 1 or total(top) < budget:
        raise PaperError(
            "INSUFFICIENT_LIQUIDITY", "book snapshot depth cannot cover quote_size"
        )
    low, high = 0, top
    while low < high:
        middle = (low + high + 1) // 2
        if total(middle) <= budget:
            low = middle
        else:
            high = middle - 1
    if low < 1:
        raise PaperError(
            "BELOW_MINIMUM", "quote_size cannot buy one base increment with fees"
        )
    return base_inc * low


def check_limits(limits, base, notional):
    for key, value, name in (
        ("base", base, "base size"),
        ("quote", notional, "notional"),
    ):
        minimum = limits.get(f"{key}_min_size")
        maximum = limits.get(f"{key}_max_size")
        if minimum is not None and value < minimum:
            raise PaperError("BELOW_MINIMUM", f"{name} is below product {key}_min_size")
        if maximum is not None and value > maximum:
            raise PaperError("ABOVE_MAXIMUM", f"{name} exceeds product {key}_max_size")


def execute(account, position, intent, request, now):
    """Pure accounting for one fill. Returns (receipt, new_cash, new_realized, position)."""
    limits = parse_product(
        request["product"], intent["product_id"], account["currency"]
    )
    book = parse_book(request["book"], intent["product_id"])
    check_fresh(book["time"], now())
    base_inc, quote_inc = limits["base_increment"], limits["quote_increment"]
    fee_bps, cash = account["fee_bps"], account["cash"]
    held = position["quantity"] if position else Decimal(0)
    basis = position["cost_basis"] if position else Decimal(0)
    size = Decimal(intent["size"])
    realized = None

    if intent["side"] == "BUY":
        if intent["size_type"] == "quote_size":
            if not is_multiple(size, quote_inc):
                raise PaperError(
                    "INVALID_INCREMENT", "quote_size is not a quote_increment multiple"
                )
            if size > cash:
                raise PaperError(
                    "INSUFFICIENT_CASH", "quote_size exceeds available paper cash"
                )
            base = size_quote_buy(book["asks"], size, fee_bps, base_inc, quote_inc)
        else:
            if not is_multiple(size, base_inc):
                raise PaperError(
                    "INVALID_INCREMENT", "base_size is not a base_increment multiple"
                )
            base = size
        notional, fee, fills = buy_cost(book["asks"], base, fee_bps, quote_inc)
        check_limits(limits, base, notional)
        total = notional + fee
        if total > cash:
            raise PaperError(
                "INSUFFICIENT_CASH", "order cost including fee exceeds paper cash"
            )
        new_cash = cash - total
        new_qty, new_basis = held + base, basis + total
    else:
        base = size
        if base > held:
            raise PaperError(
                "INSUFFICIENT_HOLDINGS", "base_size exceeds paper holdings"
            )
        if base != held and not is_multiple(base, base_inc):
            raise PaperError(
                "INVALID_INCREMENT", "base_size is not a base_increment multiple"
            )
        raw, fills = walk(book["bids"], base)
        notional = to_increment(raw, quote_inc, ROUND_FLOOR)
        check_limits(limits, base, notional)
        fee = fee_for(notional, fee_bps, quote_inc)
        total = notional - fee
        if base == held:
            removed = basis
        else:
            removed = min(
                basis, to_increment(basis * base / held, quote_inc, ROUND_HALF_EVEN)
            )
        realized = total - removed
        new_cash = cash + total
        new_qty, new_basis = held - base, basis - removed

    raw_notional = sum(Decimal(fill["price"]) * Decimal(fill["size"]) for fill in fills)
    filled_at = now()
    receipt = {
        "mode": "PAPER",
        "ok": True,
        "status": "FILLED",
        "request_id": intent["request_id"],
        "account_id": account["account_id"],
        "product_id": intent["product_id"],
        "side": intent["side"],
        "order_type": "MARKET",
        "requested": {intent["size_type"]: intent["size"]},
        "base_size": fmt(base, base_inc),
        "notional": fmt(notional, quote_inc),
        "fee": fmt(fee, quote_inc),
        "total": fmt(total, quote_inc),
        "average_price": fmt(raw_notional / base),
        "realized_pnl": None if realized is None else fmt(realized, quote_inc),
        "cash": fmt(new_cash, quote_inc),
        "position": {
            "quantity": fmt(new_qty, base_inc),
            "cost_basis": fmt(new_basis, quote_inc),
        },
        "currency": account["currency"],
        "snapshot_time": book["time_text"],
        "filled_at": filled_at.isoformat(),
        "fills": fills,
        "source": {
            "best_bid": fmt(book["bids"][0][0]),
            "best_ask": fmt(book["asks"][0][0]),
            "product": {key: fmt(value) for key, value in limits.items()},
        },
        "assumptions": {
            "model_version": MODEL_VERSION,
            "fee_bps": fmt(fee_bps),
            "rounding": (
                "buy notional and all fees round up to quote_increment; sell notional "
                "rounds down; partial-sell basis is pro rata (half-even)"
            ),
            "max_book_age_seconds": MAX_BOOK_AGE_SECONDS,
            "max_future_skew_seconds": MAX_FUTURE_SKEW_SECONDS,
        },
        "notice": NOTICE,
    }
    check_fresh(book["time"], filled_at)
    new_position = {
        "quantity": new_qty,
        "cost_basis": new_basis,
        "base_increment": base_inc,
        "quote_increment": quote_inc,
    }
    realized_total = account["realized_pnl"] + (realized or 0)
    return receipt, new_cash, realized_total, new_position


def intent_record(intent):
    """The order terms stored with each receipt (request_id is the row key)."""
    return json.dumps(
        {k: v for k, v in intent.items() if k != "request_id"}, sort_keys=True
    )


def find_receipt(state, intent, expected_account_id=None):
    """Return the committed receipt for a normalized intent, or None. Read-only."""
    conn, account = open_state(state, expected_account_id)
    try:
        if intent["account_id"] != account["account_id"]:
            raise PaperError(
                "ACCOUNT_MISMATCH",
                "request account_id does not match the selected paper account",
            )
        row = conn.execute(
            "SELECT intent, receipt FROM orders WHERE request_id = ?",
            (intent["request_id"],),
        ).fetchone()
    except sqlite3.OperationalError as exc:
        if "locked" in str(exc) or "busy" in str(exc):
            raise PaperError(
                "STATE_BUSY", "paper state is busy; retry the same request"
            ) from None
        raise PaperError("STATE_INVALID", "paper state could not be read") from None
    except sqlite3.DatabaseError:
        raise PaperError("STATE_INVALID", "paper state could not be read") from None
    finally:
        conn.close()
    if row is None:
        return None
    if row[0] != intent_record(intent):
        raise PaperError(
            "IDEMPOTENCY_CONFLICT", "request_id was already used for different terms"
        )
    return json.loads(row[1])


def trade(state, request, now=utcnow, expected_account_id=None):
    intent = parse_intent(request)
    conn, account = open_state(state, expected_account_id)
    try:
        try:
            conn.execute("BEGIN IMMEDIATE")
            account = load_account(conn, expected_account_id)
            if intent["account_id"] != account["account_id"]:
                raise PaperError(
                    "ACCOUNT_MISMATCH",
                    "request account_id does not match the selected paper account",
                )
            intent_json = intent_record(intent)
            existing = conn.execute(
                "SELECT intent, receipt FROM orders WHERE request_id = ?",
                (intent["request_id"],),
            ).fetchone()
            if existing:
                if existing[0] != intent_json:
                    raise PaperError(
                        "IDEMPOTENCY_CONFLICT",
                        "request_id was already used for different terms",
                    )
                conn.execute("ROLLBACK")
                return json.loads(existing[1])
            position = load_positions(conn).get(intent["product_id"])
            receipt, cash, realized, new_position = execute(
                account, position, intent, request, now
            )
            quote_inc = new_position["quote_increment"]
            money_inc = min(quote_inc, account["quote_increment"] or quote_inc)
            conn.execute(
                "UPDATE account SET cash = ?, realized_pnl = ?, quote_increment = ? WHERE id = 1",
                (canonical(cash), canonical(realized), canonical(money_inc)),
            )
            if new_position["quantity"] == 0:
                conn.execute(
                    "DELETE FROM positions WHERE product_id = ?",
                    (intent["product_id"],),
                )
            else:
                conn.execute(
                    "INSERT OR REPLACE INTO positions VALUES (?, ?, ?, ?, ?)",
                    (
                        intent["product_id"],
                        canonical(new_position["quantity"]),
                        canonical(new_position["cost_basis"]),
                        canonical(new_position["base_increment"]),
                        canonical(quote_inc),
                    ),
                )
            conn.execute(
                "INSERT INTO orders (request_id, intent, receipt, created_at) VALUES (?, ?, ?, ?)",
                (
                    intent["request_id"],
                    intent_json,
                    json.dumps(receipt),
                    receipt["filled_at"],
                ),
            )
            check_fresh(parse_time(receipt["snapshot_time"], "pricebook"), now())
            conn.execute("COMMIT")
            return receipt
        except BaseException:
            if conn.in_transaction:
                conn.execute("ROLLBACK")
            raise
    except sqlite3.OperationalError as exc:
        if "locked" in str(exc) or "busy" in str(exc):
            raise PaperError(
                "STATE_BUSY", "paper state is busy; retry the same request"
            ) from None
        raise PaperError("STATE_INVALID", "paper state could not be updated") from None
    except sqlite3.DatabaseError:
        raise PaperError("STATE_INVALID", "paper state could not be updated") from None
    finally:
        conn.close()


# ----------------------------------------------------------------- reports


def status(state, books=None, now=utcnow, expected_account_id=None):
    marks = {}
    if books is not None:
        if not isinstance(books, list) or len(books) > MAX_BOOKS:
            raise PaperError(
                "INVALID_BOOKS", f"books must be a JSON array of at most {MAX_BOOKS}"
            )
        current = now()
        for raw in books:
            book = parse_book(raw)
            if book["product_id"] in marks:
                raise PaperError(
                    "INVALID_BOOKS", f"duplicate book for {book['product_id']}"
                )
            try:
                check_fresh(book["time"], current)
                book["mark_status"] = "FRESH"
            except PaperError as exc:
                book["mark_status"] = exc.code.replace("_BOOK", "")
            marks[book["product_id"]] = book
    conn, account = open_state(state, expected_account_id)
    try:
        conn.execute("BEGIN")
        account = load_account(conn, expected_account_id)
        positions = load_positions(conn)
        conn.execute("COMMIT")
    finally:
        conn.close()
    cash, realized = account["cash"], account["realized_pnl"]
    money = account["quote_increment"]
    unrealized = Decimal(0)
    market_total = Decimal(0)
    priced = True
    rows = []
    for product_id in sorted(positions):
        position = positions[product_id]
        qty, basis = position["quantity"], position["cost_basis"]
        quote_inc = position["quote_increment"]
        book = marks.get(product_id)
        row = {
            "product_id": product_id,
            "quantity": fmt(qty, position["base_increment"]),
            "cost_basis": fmt(basis, quote_inc),
            "average_cost": fmt(basis / qty, quote_inc),
            "mark": None,
            "market_value": None,
            "unrealized_pnl": None,
            "mark_status": book["mark_status"] if book else "MISSING",
            "mark_time": book["time_text"] if book else None,
            "mark_source": "best_bid_indicative_excluding_exit_fees",
        }
        if book and book["mark_status"] == "FRESH":
            bid = book["bids"][0][0]
            value = to_increment(qty * bid, quote_inc, ROUND_FLOOR)
            row.update(
                mark=fmt(bid),
                market_value=fmt(value, quote_inc),
                unrealized_pnl=fmt(value - basis, quote_inc),
            )
            market_total += value
            unrealized += value - basis
        else:
            priced = False
        rows.append(row)
    return {
        "mode": "PAPER",
        "ok": True,
        "account_id": account["account_id"],
        "currency": account["currency"],
        "initial_cash": fmt(account["initial_cash"], money),
        "cash": fmt(cash, money),
        "fee_bps": fmt(account["fee_bps"]),
        "realized_pnl": fmt(realized, money),
        "unrealized_pnl": fmt(unrealized, money) if priced else None,
        "total_pnl": fmt(realized + unrealized, money) if priced else None,
        "equity": fmt(cash + market_total, money) if priced else None,
        "priced": priced,
        "positions": rows,
        "notice": NOTICE
        + ("" if priced else " Open positions without fresh marks are unpriced."),
    }


def history(state, limit=50, expected_account_id=None):
    if not 1 <= limit <= MAX_HISTORY:
        raise PaperError("INVALID_ARGUMENT", f"--limit must be 1-{MAX_HISTORY}")
    conn, account = open_state(state, expected_account_id)
    try:
        conn.execute("BEGIN")
        account = load_account(conn, expected_account_id)
        rows = conn.execute(
            "SELECT receipt FROM orders ORDER BY seq DESC LIMIT ?", (limit,)
        )
        orders = [json.loads(row[0]) for row in rows]
        count = conn.execute("SELECT COUNT(*) FROM orders").fetchone()[0]
        conn.execute("COMMIT")
    finally:
        conn.close()
    return {
        "mode": "PAPER",
        "ok": True,
        "account_id": account["account_id"],
        "order_count": count,
        "orders": orders,
    }


def backup(state, output, expected_account_id=None):
    target = check_location(output, "--output")
    conn, account = open_state(state, expected_account_id)
    try:
        if target.resolve() == check_location(state, "--state").resolve():
            raise PaperError("INVALID_PATH", "--output must differ from --state")
        create_new_file(target, conn.backup)
    finally:
        conn.close()
    return {
        "mode": "PAPER",
        "ok": True,
        "account_id": account["account_id"],
        "backup": str(target),
        "restore": "Use the backup path as --state; the original is unchanged.",
    }


def doctor(state, expected_account_id=None):
    report = {
        "mode": "PAPER",
        "ok": True,
        "python": sys.version.split()[0],
        "sqlite": sqlite3.sqlite_version,
        "state": str(check_location(state, "--state")),
        "network": "never used by this script",
    }
    if not Path(state).exists() and expected_account_id is None:
        report.update(
            state_status="MISSING",
            hint="initialize only for an explicitly new account; otherwise locate or restore it",
        )
        return report
    conn, account = open_state(state, expected_account_id)
    try:
        if conn.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise PaperError(
                "STATE_INVALID", "paper state failed SQLite integrity check"
            )
        orders = conn.execute("SELECT COUNT(*) FROM orders").fetchone()[0]
    finally:
        conn.close()
    report.update(
        state_status="OK",
        account_id=account["account_id"],
        currency=account["currency"],
        schema_version=SCHEMA_VERSION,
        model_version=MODEL_VERSION,
        order_count=orders,
    )
    return report


# --------------------------------------------------------------------- CLI


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise PaperError("INVALID_ARGUMENT", message)


def build_parser():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument(
        "--state",
        default=argparse.SUPPRESS,
        help="absolute path of the account SQLite file",
    )
    common.add_argument(
        "--profile",
        default=argparse.SUPPRESS,
        help="absolute path of a saved account binding (instead of --state)",
    )
    parser = Parser(
        prog="paper.py",
        description="Local PAPER trading simulator. Never places real orders or uses the network.",
        parents=[common],
    )
    commands = parser.add_subparsers(dest="command", required=True, parser_class=Parser)
    commands.add_parser(
        "doctor", parents=[common], help="check runtime and state health"
    )
    init = commands.add_parser(
        "init", parents=[common], help="create a new paper account"
    )
    init.add_argument("--cash", default="10000")
    init.add_argument("--currency", default="USD")
    init.add_argument(
        "--fee-bps", default="10", help="assumed taker fee in basis points"
    )
    bind_cmd = commands.add_parser(
        "bind",
        parents=[common],
        help="save a stable locator for an existing paper account",
    )
    bind_cmd.add_argument(
        "--account-id", required=True, help="expected paper account ID"
    )
    trade_cmd = commands.add_parser(
        "trade", parents=[common], help="fill a saved request"
    )
    trade_cmd.add_argument(
        "--request", required=True, help="request JSON file, or - for stdin"
    )
    status_cmd = commands.add_parser(
        "status", parents=[common], help="balances and P&L"
    )
    status_cmd.add_argument(
        "--books", help="JSON array of order-book responses for marks"
    )
    history_cmd = commands.add_parser(
        "history", parents=[common], help="recent paper orders"
    )
    history_cmd.add_argument("--limit", type=int, default=50)
    backup_cmd = commands.add_parser(
        "backup", parents=[common], help="copy state to a new file"
    )
    backup_cmd.add_argument("--output", required=True)
    return parser


def run(argv, now=utcnow):
    args = build_parser().parse_args(argv)
    state = getattr(args, "state", None)
    profile_path = getattr(args, "profile", None)
    if args.command == "bind":
        if not state or not profile_path:
            raise PaperError("INVALID_ARGUMENT", "bind requires --state and --profile")
        if not args.account_id.startswith("paper-") or not UUID_RE.fullmatch(
            args.account_id[6:]
        ):
            raise PaperError(
                "INVALID_ARGUMENT", "--account-id must be a paper account ID"
            )
        return bind_profile(state, profile_path, args.account_id)
    if bool(state) == bool(profile_path):
        raise PaperError("INVALID_ARGUMENT", "use exactly one of --state or --profile")
    expected_account_id = None
    if profile_path:
        if args.command == "init":
            raise PaperError(
                "INVALID_ARGUMENT",
                "--profile cannot initialize accounts; use --state only for explicitly new accounts",
            )
        binding = read_profile(profile_path)
        state, expected_account_id = binding["state"], binding["account_id"]
    if args.command == "doctor":
        return doctor(state, expected_account_id)
    if args.command == "init":
        return init_state(state, args.cash, args.currency, args.fee_bps, now)
    if args.command == "trade":
        return trade(
            state, read_json_file(args.request, "request"), now, expected_account_id
        )
    if args.command == "status":
        books = read_json_file(args.books, "books") if args.books else None
        return status(state, books, now, expected_account_id)
    if args.command == "history":
        return history(state, args.limit, expected_account_id)
    return backup(state, args.output, expected_account_id)


def main(argv=None):
    try:
        if sys.version_info < (3, 11):
            raise PaperError("UNSUPPORTED_RUNTIME", "Python 3.11 or newer is required")
        result = run(sys.argv[1:] if argv is None else argv)
        code = 0
    except PaperError as exc:
        result = {
            "mode": "PAPER",
            "ok": False,
            "error": {"code": exc.code, "message": exc.message},
        }
        code = 1
    except Exception as exc:  # fail closed without echoing raw input
        result = {
            "mode": "PAPER",
            "ok": False,
            "error": {"code": "INTERNAL_ERROR", "message": type(exc).__name__},
        }
        code = 1
    print(json.dumps(result, indent=2))
    return code


if __name__ == "__main__":
    sys.exit(main())
