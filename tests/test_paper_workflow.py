"""Black-box workflow tests for the local paper-trading simulator.

Every engine check runs `scripts/paper.py` as a subprocess with temporary state
outside the repository and a network guard. Expected values are independent
golden constants, not values computed by the engine.
"""

import ast
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / "skills" / "coinbase-paper-trading"
ENGINE = SKILL / "scripts" / "paper.py"
TIMEOUT = 60
RECEIPT_KEYS = (
    "request_id",
    "account_id",
    "product_id",
    "side",
    "base_size",
    "notional",
    "fee",
    "cash",
    "snapshot_time",
)
STATUS_KEYS = (
    "account_id",
    "currency",
    "initial_cash",
    "cash",
    "fee_bps",
    "realized_pnl",
    "unrealized_pnl",
    "total_pnl",
    "equity",
    "positions",
)
POSITION_KEYS = (
    "product_id",
    "quantity",
    "cost_basis",
    "average_cost",
    "mark",
    "market_value",
    "unrealized_pnl",
)
NETWORK_GUARD = """
import socket


def _blocked(*args, **kwargs):
    raise OSError("network access is blocked in paper-trading tests")


socket.socket.connect = _blocked
socket.socket.connect_ex = _blocked
socket.socket.sendto = _blocked
socket.create_connection = _blocked
socket.getaddrinfo = _blocked
"""
D = Decimal


def timestamp(offset_seconds: float = 0) -> str:
    moment = datetime.now(timezone.utc) + timedelta(seconds=offset_seconds)
    return moment.isoformat(timespec="microseconds").replace("+00:00", "Z")


def product(product_id: str = "BTC-USD", **overrides) -> dict:
    base, quote = product_id.split("-")
    value = {
        "product_id": product_id,
        "product_type": "SPOT",
        "base_currency_id": base,
        "quote_currency_id": quote,
        "base_increment": "0.00000001",
        "quote_increment": "0.01",
        "base_min_size": "0.00000001",
        "quote_min_size": "1",
    }
    value.update(overrides)
    return value


def book(bids, asks, product_id: str = "BTC-USD", time: str | None = None) -> dict:
    return {
        "pricebook": {
            "product_id": product_id,
            "time": timestamp() if time is None else time,
            "bids": [{"price": price, "size": size} for price, size in bids],
            "asks": [{"price": price, "size": size} for price, size in asks],
        }
    }


def structured(value: dict) -> dict:
    return {
        "content": [{"type": "text", "text": json.dumps(value)}],
        "structuredContent": value,
    }


def text_block(value: dict) -> dict:
    return {"content": [{"type": "text", "text": json.dumps(value)}]}


def positions(status: dict) -> dict:
    items = status["positions"]
    if isinstance(items, dict):
        items = list(items.values())
    return {item["product_id"]: item for item in items if D(item["quantity"]) != D("0")}


def tables(path: Path) -> set[str]:
    if path.stat().st_size == 0:
        return set()
    connection = sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True)
    try:
        rows = connection.execute("SELECT name FROM sqlite_master").fetchall()
    finally:
        connection.close()
    return {name for (name,) in rows}


def require_engine() -> None:
    if not ENGINE.is_file():
        raise AssertionError(
            f"paper engine is required at {ENGINE.relative_to(ROOT)}; "
            "these tests do not skip or stub a missing engine"
        )


class PaperCLITestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        require_engine()

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="paper-test-")).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.assertNotIn(ROOT, (self.tmp, *self.tmp.parents))
        guard = self.tmp / "guard"
        guard.mkdir()
        (guard / "sitecustomize.py").write_text(NETWORK_GUARD)
        self.env = {**os.environ, "PYTHONPATH": str(guard)}
        self.state = self.tmp / "account.sqlite3"
        self.counter = 0

    # Process helpers

    def command(self, args, state: Path | None = None) -> list[str]:
        state = self.state if state is None else state
        return [sys.executable, str(ENGINE), "--state", str(state), *args]

    def parse(self, stdout: str, stderr: str) -> dict:
        text = stdout.strip() or stderr.strip()
        try:
            value = json.loads(text)
        except json.JSONDecodeError:
            self.fail(f"expected JSON output\nstdout: {stdout}\nstderr: {stderr}")
        self.assertIsInstance(value, dict)
        return value

    def run_cli(self, args, state: Path | None = None, stdin: str | None = None):
        result = subprocess.run(
            self.command(args, state),
            input=stdin,
            capture_output=True,
            text=True,
            cwd=self.tmp,
            env=self.env,
            timeout=TIMEOUT,
        )
        self.assertNotIn("Traceback", result.stderr)
        return result, self.parse(result.stdout, result.stderr)

    def ok(self, args, state: Path | None = None, stdin: str | None = None) -> dict:
        result, data = self.run_cli(args, state, stdin)
        self.assertEqual(result.returncode, 0, data)
        self.assertEqual(data.get("mode"), "PAPER", data)
        return data

    def err(self, args, state: Path | None = None, stdin: str | None = None) -> dict:
        result, data = self.run_cli(args, state, stdin)
        self.assertNotEqual(result.returncode, 0, data)
        self.assertTrue(any(key in data for key in ("error", "code")), data)
        return data

    def popen(self, args, state: Path | None = None) -> subprocess.Popen:
        return subprocess.Popen(
            self.command(args, state),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=self.tmp,
            env=self.env,
        )

    def collect(self, processes) -> list[tuple[int, dict]]:
        results = []
        for process in processes:
            stdout, stderr = process.communicate(timeout=TIMEOUT)
            self.assertNotIn("Traceback", stderr)
            results.append((process.returncode, self.parse(stdout, stderr)))
        return results

    # Paper helpers

    def init(self, cash="10000", currency="USD", fee="10", state=None) -> str:
        data = self.ok(
            ["init", "--cash", cash, "--currency", currency, "--fee-bps", fee],
            state,
        )
        self.assertIsInstance(data["account_id"], str)
        self.assertTrue(data["account_id"])
        return data["account_id"]

    def request(
        self,
        account_id: str,
        side: str,
        snapshot: dict,
        *,
        base_size=None,
        quote_size=None,
        metadata: dict | None = None,
        product_id: str = "BTC-USD",
        request_id: str | None = None,
    ) -> dict:
        value = {
            "request_id": request_id or str(uuid.uuid4()),
            "account_id": account_id,
            "product_id": product_id,
            "side": side,
        }
        if base_size is not None:
            value["base_size"] = base_size
        if quote_size is not None:
            value["quote_size"] = quote_size
        value["product"] = product(product_id) if metadata is None else metadata
        value["book"] = snapshot
        return value

    def write_json(self, value, name: str | None = None) -> Path:
        self.counter += 1
        path = self.tmp / (name or f"file-{self.counter}.json")
        path.write_text(json.dumps(value))
        return path

    def trade(self, request: dict, state: Path | None = None) -> dict:
        receipt = self.ok(["trade", "--request", str(self.write_json(request))], state)
        self.assertReceipt(receipt, request)
        return receipt

    def reject(self, request, state: Path | None = None) -> dict:
        return self.err(["trade", "--request", str(self.write_json(request))], state)

    def status(self, books=None, state: Path | None = None) -> dict:
        args = ["status"]
        if books is not None:
            args += ["--books", str(self.write_json(books))]
        data = self.ok(args, state)
        for key in STATUS_KEYS:
            self.assertIn(key, data)
        for item in positions(data).values():
            for key in POSITION_KEYS:
                self.assertIn(key, item)
        return data

    def ledger(self, state: Path | None = None):
        data = self.status(state=state)
        history = self.ok(["history"], state)["orders"]
        return (
            data["account_id"],
            D(data["cash"]),
            D(data["realized_pnl"]),
            {
                pid: (D(item["quantity"]), D(item["cost_basis"]))
                for pid, item in positions(data).items()
            },
            sorted(order["request_id"] for order in history),
        )

    # Assertions

    def assertDecimal(self, value, expected: str) -> None:
        self.assertIsInstance(value, str, f"expected decimal string, got {value!r}")
        self.assertEqual(D(value), D(expected))

    def assertReceipt(self, receipt: dict, request: dict) -> None:
        for key in RECEIPT_KEYS:
            self.assertIn(key, receipt)
        for key in ("request_id", "account_id", "product_id", "side"):
            self.assertEqual(receipt[key], request[key])
        for key in ("base_size", "notional", "fee", "cash"):
            self.assertIsInstance(receipt[key], str)

    def assertFill(self, receipt: dict, base, notional, fee, cash) -> None:
        self.assertDecimal(receipt["base_size"], base)
        self.assertDecimal(receipt["notional"], notional)
        self.assertDecimal(receipt["fee"], fee)
        self.assertDecimal(receipt["cash"], cash)

    def assertSameReceipt(self, first: dict, second: dict) -> None:
        self.assertEqual(
            {key: first[key] for key in RECEIPT_KEYS},
            {key: second[key] for key in RECEIPT_KEYS},
        )


class GoldenJourneyTest(PaperCLITestCase):
    def test_full_journey(self) -> None:
        self.run_cli(["doctor"])
        self.assertFalse(self.state.exists(), "doctor must not create state")

        account = self.init()
        self.assertTrue(self.state.is_file())
        if os.name == "posix":
            self.assertEqual(self.state.stat().st_mode & 0o077, 0)
        self.ok(["doctor"])
        start = self.status()
        self.assertEqual(start["account_id"], account)
        self.assertEqual(start["currency"], "USD")
        self.assertDecimal(start["initial_cash"], "10000")
        self.assertDecimal(start["cash"], "10000")
        self.assertDecimal(start["equity"], "10000")
        self.assertDecimal(start["realized_pnl"], "0")
        self.assertEqual(positions(start), {})

        buy_snapshot = book([("99", "10")], [("100", "10")])
        buy = self.request(account, "BUY", buy_snapshot, base_size="2")
        receipt = self.trade(buy)
        self.assertFill(receipt, "2", "200", "0.20", "9799.80")
        self.assertEqual(
            datetime.fromisoformat(receipt["snapshot_time"]),
            datetime.fromisoformat(buy_snapshot["pricebook"]["time"]),
        )

        self.assertSameReceipt(self.trade(buy), receipt)
        stale_retry = dict(
            buy, book=book([("99", "10")], [("100", "10")], time=timestamp(-600))
        )
        self.assertSameReceipt(self.trade(stale_retry), receipt)

        unpriced = self.status()
        self.assertDecimal(unpriced["cash"], "9799.80")
        held = positions(unpriced)["BTC-USD"]
        self.assertDecimal(held["quantity"], "2")
        self.assertDecimal(held["cost_basis"], "200.20")
        self.assertDecimal(held["average_cost"], "100.10")
        self.assertIsNone(held["mark"])
        self.assertIsNone(held["market_value"])
        self.assertIsNone(held["unrealized_pnl"])
        for key in ("equity", "unrealized_pnl", "total_pnl"):
            self.assertIsNone(unpriced[key])

        sell_snapshot = book([("110", "10")], [("111", "10")])
        sell = self.request(account, "SELL", sell_snapshot, base_size="1")
        self.assertFill(self.trade(sell), "1", "110", "0.11", "9909.69")

        marked = self.status([book([("110", "10")], [("111", "10")])])
        self.assertDecimal(marked["cash"], "9909.69")
        self.assertDecimal(marked["realized_pnl"], "9.79")
        self.assertDecimal(marked["unrealized_pnl"], "9.90")
        self.assertDecimal(marked["total_pnl"], "19.69")
        self.assertDecimal(marked["equity"], "10019.69")
        held = positions(marked)["BTC-USD"]
        self.assertDecimal(held["quantity"], "1")
        self.assertDecimal(held["cost_basis"], "100.10")
        self.assertDecimal(held["mark"], "110")
        self.assertDecimal(held["market_value"], "110")
        self.assertDecimal(held["unrealized_pnl"], "9.90")

        stale_mark = self.status(
            [book([("110", "1")], [("111", "1")], time=timestamp(-600))]
        )
        self.assertIsNone(stale_mark["equity"])
        self.assertIsNone(positions(stale_mark)["BTC-USD"]["mark"])

        close = self.request(
            account, "SELL", book([("110", "10")], [("111", "10")]), base_size="1"
        )
        self.assertFill(self.trade(close), "1", "110", "0.11", "10019.58")
        flat = self.status()
        self.assertEqual(positions(flat), {})
        self.assertDecimal(flat["cash"], "10019.58")
        self.assertDecimal(flat["equity"], "10019.58")
        self.assertDecimal(flat["realized_pnl"], "19.58")
        self.assertDecimal(flat["total_pnl"], "19.58")
        if flat["unrealized_pnl"] is not None:
            self.assertDecimal(flat["unrealized_pnl"], "0")

        orders = self.ok(["history"])["orders"]
        self.assertEqual(
            sorted(order["request_id"] for order in orders),
            sorted([buy["request_id"], sell["request_id"], close["request_id"]]),
        )
        for order in orders:
            for key in RECEIPT_KEYS:
                self.assertIn(key, order)
        self.assertEqual(len(self.ok(["history", "--limit", "1"])["orders"]), 1)

        before = self.ledger()
        backup = self.tmp / "backups" / "account-backup.sqlite3"
        backup.parent.mkdir(mode=0o700)
        self.ok(["backup", "--output", str(backup)])
        self.assertTrue(backup.is_file())
        self.err(["backup", "--output", str(backup)])
        self.assertEqual(self.ledger(state=backup), before)
        self.assertSameReceipt(self.trade(buy, state=backup), receipt)
        self.assertEqual(self.ledger(state=backup), before)
        self.assertEqual(self.ledger(), before)

        second = self.tmp / "second" / "account.sqlite3"
        second.parent.mkdir(mode=0o700)
        second_account = self.init(state=second)
        self.assertNotEqual(second_account, account)
        self.assertDecimal(self.status(state=second)["cash"], "10000")
        self.reject(
            self.request(
                account, "BUY", book([("99", "10")], [("100", "10")]), base_size="1"
            ),
            state=second,
        )
        self.assertEqual(self.ledger(), before)


class AccountingTest(PaperCLITestCase):
    DEPTH = [("100", "1"), ("101", "1"), ("102", "5")]

    def test_depth_weighted_base_buy(self) -> None:
        account = self.init()
        receipt = self.trade(
            self.request(
                account, "BUY", book([("99", "1")], self.DEPTH), base_size="2.5"
            )
        )
        self.assertFill(receipt, "2.5", "252", "0.26", "9747.74")
        held = positions(self.status())["BTC-USD"]
        self.assertDecimal(held["cost_basis"], "252.26")
        self.assertDecimal(held["average_cost"], "100.904")

    def test_quote_budget_includes_fee_and_full_close_clears_basis(self) -> None:
        account = self.init()
        metadata = product(base_increment="0.01", base_min_size="0.01")
        buy = self.request(
            account,
            "BUY",
            book([("99", "10")], [("100", "10")]),
            quote_size="100",
            metadata=metadata,
        )
        self.assertFill(self.trade(buy), "0.99", "99", "0.10", "9900.90")
        self.assertDecimal(positions(self.status())["BTC-USD"]["cost_basis"], "99.10")

        sell = self.request(
            account,
            "SELL",
            book([("99", "10")], [("100", "10")]),
            base_size="0.99",
            metadata=metadata,
        )
        self.assertFill(self.trade(sell), "0.99", "98.01", "0.10", "9998.81")
        flat = self.status()
        self.assertEqual(positions(flat), {})
        self.assertDecimal(flat["realized_pnl"], "-1.19")
        self.assertDecimal(flat["equity"], "9998.81")

    def test_quote_budget_across_levels(self) -> None:
        account = self.init()
        request = self.request(
            account,
            "BUY",
            book([("99", "1")], self.DEPTH),
            quote_size="150",
            metadata=product(base_increment="0.01", base_min_size="0.01"),
        )
        self.assertFill(self.trade(request), "1.49", "149.49", "0.15", "9850.36")

    def test_quote_budget_beyond_book_rejected(self) -> None:
        account = self.init()
        before = self.ledger()
        self.reject(
            self.request(
                account,
                "BUY",
                book([("99", "1")], [("100", "1"), ("101", "1")]),
                quote_size="1000",
            )
        )
        self.assertEqual(self.ledger(), before)

    def test_fee_rounds_up_to_quote_increment(self) -> None:
        account = self.init()
        receipt = self.trade(
            self.request(
                account, "BUY", book([("99", "1")], [("100", "1")]), base_size="0.01"
            )
        )
        self.assertFill(receipt, "0.01", "1", "0.01", "9998.99")

    def test_metadata_increment_not_two_decimal_places(self) -> None:
        account = self.init(cash="1", currency="BTC")
        metadata = product(
            "ETH-BTC",
            base_increment="0.0001",
            quote_increment="0.00001",
            base_min_size="0.0001",
            quote_min_size="0.0001",
        )
        receipt = self.trade(
            self.request(
                account,
                "BUY",
                book([("0.0511", "10")], [("0.0512", "10")], product_id="ETH-BTC"),
                base_size="0.3",
                metadata=metadata,
                product_id="ETH-BTC",
            )
        )
        self.assertFill(receipt, "0.3", "0.01536", "0.00002", "0.98462")

    def test_wrappers_are_equivalent(self) -> None:
        results = []
        for name, wrap in (
            ("raw", dict),
            ("structured", structured),
            ("text", text_block),
        ):
            with self.subTest(wrapper=name):
                state = self.tmp / f"{name}.sqlite3"
                account = self.init(state=state)
                request = self.request(
                    account,
                    "BUY",
                    wrap(book([("99", "10")], [("100", "10")])),
                    base_size="2",
                    metadata=wrap(product()),
                )
                receipt = self.trade(request, state=state)
                self.assertFill(receipt, "2", "200", "0.20", "9799.80")
                marks = self.status(
                    [wrap(book([("110", "10")], [("111", "10")]))], state=state
                )
                self.assertDecimal(marks["equity"], "10019.80")
                results.append(
                    (
                        receipt["base_size"],
                        receipt["notional"],
                        receipt["fee"],
                        receipt["cash"],
                    )
                )
        self.assertEqual(len(set(results)), 1)

    def test_realistic_extra_response_fields_and_stdin(self) -> None:
        account = self.init()
        metadata = product(
            price="100.5",
            volume_24h="1234.5",
            status="online",
            trading_disabled=False,
            is_disabled=False,
            cancel_only=False,
            limit_only=False,
            post_only=False,
            base_max_size="1000",
            quote_max_size="1000000",
        )
        snapshot = book([("99", "10")], [("100", "10")])
        snapshot.update(
            last="100", mid_market="99.5", spread_bps="100", spread_absolute="1"
        )
        request = self.request(
            account, "BUY", snapshot, base_size="1", metadata=metadata
        )
        receipt = self.ok(["trade", "--request", "-"], stdin=json.dumps(request))
        self.assertReceipt(receipt, request)
        self.assertFill(receipt, "1", "100", "0.10", "9899.90")


class RejectionTest(PaperCLITestCase):
    def test_bad_requests_fail_without_mutation(self) -> None:
        account = self.init()
        self.trade(
            self.request(
                account, "BUY", book([("99", "10")], [("100", "10")]), base_size="2"
            )
        )
        before = self.ledger()

        def fresh():
            return book([("99", "10")], [("100", "10")])

        def buy(**kwargs):
            kwargs.setdefault("base_size", "1")
            return self.request(
                account, "BUY", kwargs.pop("snapshot", None) or fresh(), **kwargs
            )

        def with_book(bids, asks, **kwargs):
            return buy(snapshot=book(bids, asks, **kwargs))

        def without(request, *path):
            target = request
            for key in path[:-1]:
                target = target[key]
            del target[path[-1]]
            return request

        def changed(request, **fields):
            request.update(fields)
            return request

        secret = "SECRET-MARKER-7f3a"
        cases = {
            "insufficient cash": lambda: buy(
                base_size="200", snapshot=book([("99", "10")], [("100", "1000")])
            ),
            "insufficient holdings": lambda: self.request(
                account, "SELL", fresh(), base_size="3"
            ),
            "insufficient liquidity": lambda: buy(base_size="20"),
            "quote-sized sell": lambda: self.request(
                account, "SELL", fresh(), quote_size="50"
            ),
            "both sizes": lambda: buy(base_size="1", quote_size="100"),
            "no size": lambda: without(buy(), "base_size"),
            "misspelled size": lambda: changed(buy(), base_szie="1"),
            "unknown term": lambda: changed(buy(), limit_price="90"),
            "bad side": lambda: changed(buy(), side="HOLD"),
            "wrong account": lambda: changed(buy(), account_id=str(uuid.uuid4())),
            "request product mismatch": lambda: changed(buy(), product_id="ETH-USD"),
            "book product mismatch": lambda: buy(
                snapshot=book([("99", "10")], [("100", "10")], product_id="ETH-USD")
            ),
            "metadata product mismatch": lambda: buy(metadata=product("ETH-USD")),
            "quote currency mismatch": lambda: self.request(
                account,
                "BUY",
                book([("99", "10")], [("100", "10")], product_id="BTC-EUR"),
                base_size="1",
                metadata=product("BTC-EUR"),
                product_id="BTC-EUR",
            ),
            "non-spot": lambda: buy(metadata=product(product_type="FUTURE")),
            "trading disabled": lambda: buy(metadata=product(trading_disabled=True)),
            "offline": lambda: buy(metadata=product(status="offline")),
            "limit only": lambda: buy(metadata=product(limit_only=True)),
            "post only": lambda: buy(metadata=product(post_only=True)),
            "below base minimum": lambda: buy(
                base_size="0.01", metadata=product(base_min_size="0.1")
            ),
            "above base maximum": lambda: buy(
                base_size="1.5", metadata=product(base_max_size="1")
            ),
            "off base increment": lambda: buy(base_size="0.000000001"),
            "below quote minimum": lambda: buy(base_size=None, quote_size="0.5"),
            "crossed book": lambda: with_book([("101", "10")], [("100", "10")]),
            "unordered asks": lambda: with_book(
                [("99", "10")], [("101", "1"), ("100", "10")]
            ),
            "unordered bids": lambda: with_book(
                [("98", "1"), ("99", "10")], [("100", "10")]
            ),
            "zero level size": lambda: with_book([("99", "10")], [("100", "0")]),
            "negative price": lambda: with_book([("99", "10")], [("-100", "10")]),
            "nonfinite price": lambda: with_book([("99", "10")], [("NaN", "10")]),
            "stale book": lambda: with_book(
                [("99", "10")], [("100", "10")], time=timestamp(-120)
            ),
            "future book": lambda: with_book(
                [("99", "10")], [("100", "10")], time=timestamp(60)
            ),
            "naive book time": lambda: with_book(
                [("99", "10")],
                [("100", "10")],
                time=datetime.now(timezone.utc).replace(tzinfo=None).isoformat(),
            ),
            "missing book time": lambda: without(buy(), "book", "pricebook", "time"),
            "missing pricebook": lambda: buy(snapshot={"bids": [], "asks": []}),
            "error envelope": lambda: buy(
                snapshot={
                    "isError": True,
                    "content": [{"type": "text", "text": secret}],
                }
            ),
            "truncated text": lambda: buy(
                snapshot={
                    "content": [{"type": "text", "text": json.dumps(fresh())[:-7]}]
                }
            ),
            "two text blocks": lambda: buy(
                snapshot={
                    "content": [
                        {"type": "text", "text": json.dumps(fresh())},
                        {"type": "text", "text": json.dumps(fresh())},
                    ]
                }
            ),
            "string book": lambda: buy(snapshot=json.dumps(fresh())),
            "number size": lambda: buy(base_size=1),
            "nan size": lambda: buy(base_size="NaN"),
            "infinite size": lambda: buy(base_size="Infinity"),
            "exponent size": lambda: buy(base_size="1e400"),
            "huge size": lambda: buy(base_size="1" + "0" * 60),
            "overprecise size": lambda: buy(base_size="0." + "0" * 60 + "1"),
            "zero size": lambda: buy(base_size="0"),
            "negative size": lambda: buy(base_size="-1"),
            "empty size": lambda: buy(base_size=""),
        }
        for name, build in cases.items():
            with self.subTest(case=name):
                result, data = self.run_cli(
                    ["trade", "--request", str(self.write_json(build()))]
                )
                self.assertNotEqual(result.returncode, 0, data)
                self.assertTrue(any(key in data for key in ("error", "code")), data)
                self.assertNotIn(secret, result.stdout + result.stderr)
                self.assertEqual(self.ledger(), before)

        for name, text in (("not json", "{"), ("array", "[]"), ("empty", "")):
            with self.subTest(request_file=name):
                path = self.tmp / f"bad-{name}.json"
                path.write_text(text)
                self.err(["trade", "--request", str(path)])
                self.assertEqual(self.ledger(), before)
        self.err(["trade", "--request", str(self.tmp / "missing.json")])
        self.assertEqual(self.ledger(), before)


class IdempotencyTest(PaperCLITestCase):
    def test_retry_conflict_and_distinct_orders(self) -> None:
        account = self.init()
        buy = self.request(
            account, "BUY", book([("99", "10")], [("100", "10")]), base_size="1"
        )
        receipt = self.trade(buy)
        self.assertFill(receipt, "1", "100", "0.10", "9899.90")
        before = self.ledger()

        refreshed = dict(buy, book=book([("104", "10")], [("105", "10")]))
        self.assertSameReceipt(self.trade(refreshed), receipt)
        self.assertEqual(self.ledger(), before)

        conflicts = {
            "size": dict(buy, base_size="2"),
            "side": dict(buy, side="SELL"),
            "sizing": {
                k: v for k, v in dict(buy, quote_size="100").items() if k != "base_size"
            },
            "product": dict(
                buy,
                product_id="ETH-USD",
                product=product("ETH-USD"),
                book=book([("99", "10")], [("100", "10")], product_id="ETH-USD"),
            ),
        }
        for name, request in conflicts.items():
            with self.subTest(conflict=name):
                self.reject(request)
                self.assertEqual(self.ledger(), before)

        other = self.init(state=self.tmp / "other.sqlite3")
        self.reject(dict(buy, account_id=other))
        self.assertEqual(self.ledger(), before)

        twin = dict(
            buy,
            request_id=str(uuid.uuid4()),
            book=book([("99", "10")], [("100", "10")]),
        )
        self.assertFill(self.trade(twin), "1", "100", "0.10", "9799.80")
        self.assertEqual(len(self.ok(["history"])["orders"]), 2)

    def test_concurrent_same_request_fills_once(self) -> None:
        account = self.init()
        request = self.request(
            account, "BUY", book([("99", "10")], [("100", "10")]), base_size="1"
        )
        path = self.write_json(request)
        results = self.collect(
            [self.popen(["trade", "--request", str(path)]) for _ in range(8)]
        )
        receipts = [data for code, data in results if code == 0]
        self.assertTrue(receipts, results)
        for receipt in receipts:
            self.assertEqual(receipt["mode"], "PAPER")
            self.assertSameReceipt(receipt, receipts[0])
        for code, data in results:
            if code != 0:
                self.assertTrue(any(key in data for key in ("error", "code")), data)
        _, cash, _, held, history = self.ledger()
        self.assertEqual(cash, D("9899.90"))
        self.assertEqual(held, {"BTC-USD": (D("1"), D("100.10"))})
        self.assertEqual(history, [request["request_id"]])

    def test_concurrent_distinct_requests_cannot_overspend(self) -> None:
        account = self.init(cash="1000")
        paths = [
            self.write_json(
                self.request(
                    account,
                    "BUY",
                    book([("99", "100")], [("100", "100")]),
                    base_size="3",
                )
            )
            for _ in range(8)
        ]
        results = self.collect(
            [self.popen(["trade", "--request", str(p)]) for p in paths]
        )
        fills = sum(1 for code, _ in results if code == 0)
        self.assertGreaterEqual(fills, 1)
        self.assertLessEqual(fills, 3)
        _, cash, _, held, history = self.ledger()
        self.assertEqual(len(history), fills)
        self.assertEqual(cash, D("1000") - D("300.30") * fills)
        self.assertGreaterEqual(cash, D("0"))
        self.assertEqual(held, {"BTC-USD": (D("3") * fills, D("300.30") * fills)})

    def test_concurrent_init_creates_one_account(self) -> None:
        args = ["init", "--cash", "10000", "--currency", "USD", "--fee-bps", "10"]
        results = self.collect([self.popen(args) for _ in range(6)])
        created = [data for code, data in results if code == 0]
        self.assertEqual(len(created), 1, results)
        self.assertEqual(self.status()["account_id"], created[0]["account_id"])


class StateSafetyTest(PaperCLITestCase):
    def test_missing_state_is_never_created(self) -> None:
        request = self.write_json({"request_id": str(uuid.uuid4())})
        for args in (
            ["status"],
            ["history"],
            ["trade", "--request", str(request)],
            ["backup", "--output", str(self.tmp / "copy.sqlite3")],
        ):
            with self.subTest(command=args[0]):
                self.err(args)
                self.assertFalse(self.state.exists())
        self.assertFalse((self.tmp / "copy.sqlite3").exists())

    def test_duplicate_init_does_not_reseed(self) -> None:
        account = self.init()
        self.trade(
            self.request(
                account, "BUY", book([("99", "10")], [("100", "10")]), base_size="1"
            )
        )
        before = self.ledger()
        self.err(["init", "--cash", "500", "--currency", "USD", "--fee-bps", "10"])
        self.assertEqual(self.ledger(), before)

    def test_corrupt_empty_and_foreign_state_fail_closed(self) -> None:
        corrupt = self.tmp / "corrupt.sqlite3"
        corrupt.write_bytes(b"not a sqlite database\x00" * 64)
        empty = self.tmp / "empty.sqlite3"
        empty.write_bytes(b"")
        foreign = self.tmp / "foreign.sqlite3"
        with sqlite3.connect(foreign) as connection:
            connection.execute("CREATE TABLE unrelated (value TEXT)")
        connection.close()
        for path in (corrupt, empty, foreign):
            original = path.read_bytes() if path is corrupt else tables(path)
            with self.subTest(state=path.name):
                self.err(["status"], state=path)
                self.err(
                    ["init", "--cash", "10000", "--currency", "USD", "--fee-bps", "10"],
                    state=path,
                )
                current = path.read_bytes() if path is corrupt else tables(path)
                self.assertEqual(current, original)

    def test_invalid_init_creates_nothing(self) -> None:
        for name, cash, currency, fee in (
            ("negative cash", "-1", "USD", "10"),
            ("nan cash", "NaN", "USD", "10"),
            ("huge cash", "1" + "0" * 60, "USD", "10"),
            ("empty currency", "10000", "", "10"),
            ("negative fee", "10000", "USD", "-1"),
            ("huge fee", "10000", "USD", "100000"),
        ):
            with self.subTest(case=name):
                path = self.tmp / f"{name.replace(' ', '-')}.sqlite3"
                self.err(
                    ["init", "--cash", cash, "--currency", currency, "--fee-bps", fee],
                    state=path,
                )
                self.assertFalse(path.exists())

    def test_state_inside_skill_is_rejected(self) -> None:
        path = SKILL / f"test-state-{uuid.uuid4().hex}.sqlite3"
        try:
            self.err(
                ["init", "--cash", "10000", "--currency", "USD", "--fee-bps", "10"],
                state=path,
            )
            self.assertFalse(path.exists())
        finally:
            for leftover in SKILL.glob(f"{path.name}*"):
                leftover.unlink()

    def test_backup_never_overwrites(self) -> None:
        self.init()
        existing = self.tmp / "existing.sqlite3"
        existing.write_text("keep me")
        self.err(["backup", "--output", str(existing)])
        self.assertEqual(existing.read_text(), "keep me")

    def test_history_limit_bounds_orders(self) -> None:
        account = self.init()
        for _ in range(3):
            self.trade(
                self.request(
                    account, "BUY", book([("99", "10")], [("100", "10")]), base_size="1"
                )
            )
        self.assertEqual(len(self.ok(["history"])["orders"]), 3)
        self.assertEqual(len(self.ok(["history", "--limit", "2"])["orders"]), 2)

    def test_network_guard_is_active(self) -> None:
        probe = (
            "import socket\n"
            "try:\n"
            "    socket.create_connection(('127.0.0.1', 9), timeout=1)\n"
            "except OSError as error:\n"
            "    print('blocked' if 'blocked' in str(error) else 'other')\n"
        )
        result = subprocess.run(
            [sys.executable, "-c", probe],
            capture_output=True,
            text=True,
            env=self.env,
            timeout=TIMEOUT,
        )
        self.assertEqual(result.stdout.strip(), "blocked")

    def test_engine_imports_no_network_modules(self) -> None:
        tree = ast.parse(ENGINE.read_text())
        imported = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported.add(node.module.split(".")[0])
        forbidden = {
            "socket",
            "ssl",
            "http",
            "urllib",
            "requests",
            "asyncio",
            "subprocess",
        }
        self.assertEqual(imported & forbidden, set())


class SkillDocumentationTest(unittest.TestCase):
    """Static checks only; they are not a model-behavior evaluation."""

    ALLOWED_TOOLS = {
        "coinbase_products_get",
        "coinbase_products_book",
        "coinbase_products_candles",
    }

    def documents(self) -> dict[str, str]:
        paths = [
            SKILL / "SKILL.md",
            SKILL / "references" / "mcp.md",
            SKILL / "references" / "cli.md",
        ]
        return {path.name: path.read_text() for path in paths}

    def test_frontmatter(self) -> None:
        text = (SKILL / "SKILL.md").read_text()
        match = re.match(r"^---\n(.*?)\n---\n", text, re.DOTALL)
        self.assertIsNotNone(match)
        header = match.group(1)
        self.assertIn("name: coinbase-paper-trading", header)
        self.assertRegex(header, r"\n  author: Coinbase\n")
        self.assertRegex(header, r"\n  version: 1\.2\.0(\n|$)")

    def test_paper_workflow_uses_only_read_only_tools(self) -> None:
        for name, text in self.documents().items():
            with self.subTest(document=name):
                tools = set(re.findall(r"coinbase_[a-z0-9_]+", text))
                self.assertLessEqual(tools, self.ALLOWED_TOOLS)
                self.assertNotIn("--now", text)
                self.assertNotIn("--allow-stale", text)
                self.assertNotRegex(text, r"/Users/|/home/[a-z]")

    def test_key_instructions_present(self) -> None:
        skill = self.documents()["SKILL.md"]
        for phrase in (
            "PAPER",
            "bin/coinbase-paper",
            "--state",
            "60 seconds",
            "same `--request-id`",
            "never places real orders",
        ):
            self.assertIn(phrase.casefold(), skill.casefold())
        cli = self.documents()["cli.md"]
        for command in (
            "doctor",
            "init",
            "bind --state ABS --account-id ID",
            "buy PRODUCT",
            "sell PRODUCT --base-size N --request-id UUID",
            "status [--refresh]",
            "history",
            "backup --output ABS",
            "candles PRODUCT",
        ):
            self.assertIn(command, cli)
        # The optional legacy route still documents the offline engine.
        legacy = self.documents()["mcp.md"]
        for command in (
            "scripts/paper.py",
            "--profile",
            "doctor",
            "init",
            "trade --request",
            "status [--books FILE]",
            "history",
            "backup --output",
            "same `request_id`",
        ):
            self.assertIn(command, legacy)

    def test_entry_skill_routes_to_paper_trading(self) -> None:
        self.assertIn(
            "../coinbase-paper-trading/SKILL.md",
            (ROOT / "skills/coinbase/SKILL.md").read_text(),
        )
        self.assertIn(
            "skills/coinbase-paper-trading/SKILL.md", (ROOT / "README.md").read_text()
        )


class DistributionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        require_engine()

    def test_distributions_bundle_engine_without_caches(self) -> None:
        cache = ENGINE.parent / "__pycache__"
        created = not cache.exists()
        cache.mkdir(exist_ok=True)
        marker = cache / "paper-test-marker.pyc"
        marker.write_bytes(b"cache")
        output = Path(tempfile.mkdtemp(prefix="paper-dist-")).resolve()
        try:
            subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "scripts" / "build-distributions.py"),
                    str(output / "dist"),
                ],
                check=True,
                capture_output=True,
                text=True,
                timeout=TIMEOUT,
            )
            packages = list((output / "dist" / "site" / "packages").iterdir())
            self.assertEqual(len(packages), 3)
            engines = list(
                (output / "dist").rglob("coinbase-paper-trading/scripts/paper.py")
            )
            self.assertEqual(len(engines), 3)
            for engine in engines:
                self.assertEqual(engine.read_bytes(), ENGINE.read_bytes())
            leaked = [
                path
                for path in (output / "dist").rglob("*")
                if path.name == "__pycache__"
                or path.suffix in {".pyc", ".sqlite3", ".db"}
            ]
            self.assertEqual(leaked, [])
        finally:
            shutil.rmtree(output, True)
            marker.unlink(missing_ok=True)
            if created:
                shutil.rmtree(cache, True)


if __name__ == "__main__":
    unittest.main()
