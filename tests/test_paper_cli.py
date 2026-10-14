"""Tests for the coinbase-paper controller with injected fake market data.

No test touches the network: a fake public-data client is injected in process,
and subprocesses run with a socket guard. All state lives in temporary dirs.
"""

import contextlib
import importlib.util
import io
import json
import os
import sqlite3
import stat
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from test_paper_workflow import NETWORK_GUARD, SKILL, TIMEOUT, book, product

SCRIPTS = SKILL / "scripts"
CLI = SCRIPTS / "paper_cli.py"
sys.dont_write_bytecode = True
_spec = importlib.util.spec_from_file_location("paper_cli_under_test", CLI)
cli = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cli)
paper = cli.paper

DRIVER = """
import json, os, sys, time
from datetime import datetime, timezone
sys.dont_write_bytecode = True
sys.path.insert(0, {scripts!r})
import paper_cli

cfg = json.loads(os.environ.get("FAKE_MARKET", "{{}}"))


class Fake:
    def product(self, product_id):
        base, quote = product_id.split("-")
        return {{"product_id": product_id, "product_type": "SPOT",
                "base_currency_id": base, "quote_currency_id": quote,
                "base_increment": "0.00000001", "quote_increment": "0.01"}}

    def book(self, product_id):
        time.sleep(cfg.get("delay", 0))
        stamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        return {{"pricebook": {{"product_id": product_id, "time": stamp,
                "bids": [{{"price": "99", "size": "10"}}],
                "asks": [{{"price": "100", "size": "10"}}]}}}}


if cfg.get("no_adapter"):
    sys.modules["public_data"] = None
    factory = paper_cli.default_client
else:
    factory = Fake
sys.exit(paper_cli.main(sys.argv[1:], client_factory=factory))
"""


class FakeClient:
    def __init__(self, bids=(("99", "10"),), asks=(("100", "10"),), fail=None):
        self.bids, self.asks, self.fail = bids, asks, fail
        self.calls = []

    def product(self, product_id):
        self.calls.append(("product", product_id))
        if self.fail:
            raise self.fail
        return product(product_id)

    def book(self, product_id):
        self.calls.append(("book", product_id))
        if self.fail:
            raise self.fail
        return book(self.bids, self.asks, product_id)

    def candles(self, product_id, start, end, granularity):
        self.calls.append(("candles", product_id, start, end, granularity))
        return {"candles": [{"start": str(start), "close": "100.5"}]}


def tree(path):
    return sorted(str(p.relative_to(path)) for p in Path(path).rglob("*"))


class CLITestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name).resolve()
        self.root = self.tmp / "paper home"
        self.environ = {"COINBASE_PAPER_HOME": str(self.root)}
        self.client = FakeClient()
        self.factory_calls = 0

    def factory(self):
        self.factory_calls += 1
        return self.client

    def forbid_network(self):
        raise AssertionError("market data must not be fetched")

    def call(self, *argv, factory=None, environ=None, error=None):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = cli.main(
                list(argv),
                client_factory=factory or self.factory,
                environ=self.environ if environ is None else environ,
            )
        text = out.getvalue()
        data = json.loads(text)
        self.assertEqual(data["mode"], "PAPER")
        if error:
            self.assertEqual(code, 1, data)
            self.assertFalse(data["ok"])
            self.assertEqual(data["error"]["code"], error, data)
        else:
            self.assertEqual(code, 0, data)
            self.assertTrue(data["ok"])
        return data, text

    def ok(self, *argv, **kwargs):
        return self.call(*argv, **kwargs)[0]

    def init(self, *extra):
        return self.ok("init", *extra)

    def buy(self, request_id, size="1", flag="--base-size", **kwargs):
        return self.call(
            "buy", "BTC-USD", flag, size, "--request-id", request_id, **kwargs
        )

    def intent_path(self, request_id):
        return self.root / "requests" / f"{request_id}.json"

    def orders(self, state=None):
        conn = sqlite3.connect(
            Path(state or self.root / "account.sqlite3").as_uri() + "?mode=ro", uri=True
        )
        try:
            return conn.execute("SELECT request_id FROM orders").fetchall()
        finally:
            conn.close()


class RootResolutionTest(unittest.TestCase):
    def test_precedence_and_defaults(self):
        env = {"COINBASE_PAPER_HOME": "/a", "XDG_DATA_HOME": "/x"}
        self.assertEqual(cli.resolve_root("/d", env), (Path("/d"), "--data-dir"))
        self.assertEqual(
            cli.resolve_root(None, env), (Path("/a"), "COINBASE_PAPER_HOME")
        )
        self.assertEqual(
            cli.resolve_root(None, {"XDG_DATA_HOME": "/x"}),
            (Path("/x/coinbase-paper"), "XDG_DATA_HOME"),
        )
        root, source = cli.resolve_root(None, {"XDG_DATA_HOME": "rel"})
        self.assertEqual(source, "default")
        self.assertEqual(root, Path.home() / ".local/share/coinbase-paper")

    def test_relative_overrides_rejected(self):
        for args in (("rel", {}), (None, {"COINBASE_PAPER_HOME": "rel/dir"})):
            with self.assertRaises(cli.PaperError) as caught:
                cli.resolve_root(*args)
            self.assertEqual(caught.exception.code, "INVALID_PATH")

    def test_state_inside_skill_rejected(self):
        with self.assertRaises(cli.PaperError) as caught:
            cli.Home(SKILL / "state", "--data-dir")
        self.assertEqual(caught.exception.code, "INVALID_PATH")


class SetupTest(CLITestCase):
    def test_doctor_is_read_only_and_explicit(self):
        report = self.ok("doctor")
        self.assertFalse(self.root.exists())
        self.assertFalse(report["ready"])
        self.assertEqual(report["profile_status"], "MISSING")
        self.assertEqual(report["state_status"], "MISSING")
        self.assertIn("UNVERIFIED", report["persistence"])
        self.assertEqual(report["data_dir_source"], "COINBASE_PAPER_HOME")

    def test_init_binds_and_refuses_reseed(self):
        created = self.init("--cash", "5000.50", "--fee-bps", "25")
        self.assertEqual(created["cash"], "5000.5")
        profile = json.loads((self.root / "profile.json").read_text())
        self.assertEqual(profile["account_id"], created["account_id"])
        self.assertEqual(
            stat.S_IMODE((self.root / "profile.json").stat().st_mode), 0o600
        )
        self.assertEqual(stat.S_IMODE(self.root.stat().st_mode), 0o700)
        report = self.ok("doctor")
        self.assertTrue(report["ready"])
        self.assertEqual(report["account_id"], created["account_id"])
        self.assertIn("UNVERIFIED", report["persistence"])
        before = (self.root / "account.sqlite3").read_bytes()
        self.call("init", error="ACCOUNT_EXISTS")
        self.assertEqual((self.root / "account.sqlite3").read_bytes(), before)

    def test_partial_init_requires_explicit_bind(self):
        state = self.root / "account.sqlite3"
        created = paper.init_state(str(state), "10000", "USD", "10")
        self.call("init", error="ACCOUNT_EXISTS")
        data, _ = self.buy(str(uuid.uuid4()), error="PROFILE_NOT_FOUND")
        self.assertIn("bind --state", data["error"]["message"])
        report = self.ok("doctor")
        self.assertEqual(report["state_status"], "UNBOUND")
        self.assertEqual(report["account_id"], created["account_id"])
        self.assertFalse((self.root / "profile.json").exists())
        bound = self.ok(
            "bind", "--state", str(state), "--account-id", created["account_id"]
        )
        self.assertTrue(bound["created"])
        self.assertTrue(self.ok("doctor")["ready"])

    def test_init_bind_failure_reports_recovery(self):
        def fail(*args):
            raise cli.PaperError("PROFILE_PATH_UNAVAILABLE", "disk full")

        original = paper.bind_profile
        paper.bind_profile = fail
        try:
            data, _ = self.call("init", error="INIT_INCOMPLETE")
        finally:
            paper.bind_profile = original
        self.assertIn("bind --state", data["error"]["message"])
        self.assertTrue((self.root / "account.sqlite3").exists())
        self.call("init", error="ACCOUNT_EXISTS")

    def test_bind_existing_legacy_database(self):
        legacy = self.tmp / "legacy" / "old.sqlite3"
        created = paper.init_state(str(legacy), "10000", "USD", "10")
        other = paper.init_state(str(self.tmp / "other.sqlite3"), "1", "USD", "10")
        self.call(
            "bind",
            "--state",
            str(legacy),
            "--account-id",
            other["account_id"],
            error="ACCOUNT_MISMATCH",
        )
        self.call(
            "bind",
            "--state",
            "rel.sqlite3",
            "--account-id",
            created["account_id"],
            error="INVALID_PATH",
        )
        self.ok("bind", "--state", str(legacy), "--account-id", created["account_id"])
        again = self.ok(
            "bind", "--state", str(legacy), "--account-id", created["account_id"]
        )
        self.assertFalse(again["created"])
        self.call(
            "bind",
            "--state",
            str(self.tmp / "other.sqlite3"),
            "--account-id",
            other["account_id"],
            error="PROFILE_EXISTS",
        )
        self.assertFalse((self.root / "account.sqlite3").exists())
        receipt, _ = self.buy(str(uuid.uuid4()))
        self.assertEqual(receipt["account_id"], created["account_id"])
        self.assertEqual(len(self.orders(legacy)), 1)


class TradeTest(CLITestCase):
    def setUp(self):
        super().setUp()
        self.account = self.init()["account_id"]

    def test_buy_sell_status_history_backup(self):
        rid = str(uuid.uuid4())
        receipt, _ = self.buy(rid)
        self.assertEqual(
            (receipt["status"], receipt["notional"], receipt["fee"], receipt["cash"]),
            ("FILLED", "100.00", "0.10", "9899.90"),
        )
        self.assertEqual(
            self.client.calls, [("product", "BTC-USD"), ("book", "BTC-USD")]
        )
        sell, _ = self.call(
            "sell", "BTC-USD", "--base-size", "0.5", "--request-id", str(uuid.uuid4())
        )
        self.assertEqual(
            (
                sell["notional"],
                sell["fee"],
                sell["total"],
                sell["realized_pnl"],
                sell["cash"],
            ),
            ("49.50", "0.05", "49.45", "-0.60", "9949.35"),
        )
        offline = self.ok("status", factory=self.forbid_network)
        self.assertFalse(offline["priced"])
        self.assertIsNone(offline["equity"])
        self.assertEqual(offline["positions"][0]["mark_status"], "MISSING")
        fresh = self.ok("status", "--refresh")
        self.assertTrue(fresh["priced"])
        self.assertEqual(fresh["positions"][0]["market_value"], "49.50")
        self.assertEqual(fresh["unrealized_pnl"], "-0.55")
        self.assertEqual(fresh["equity"], "9998.85")
        history = self.ok("history", "--limit", "1", factory=self.forbid_network)
        self.assertEqual(history["order_count"], 2)
        self.assertEqual(history["orders"][0], sell)
        target = self.tmp / "backups" / "copy.sqlite3"
        self.ok("backup", "--output", str(target), factory=self.forbid_network)
        self.assertTrue(target.is_file())
        self.call("backup", "--output", "rel.sqlite3", error="INVALID_PATH")

    def test_quote_buy_includes_fees(self):
        receipt, _ = self.buy(str(uuid.uuid4()), "100.10", "--quote-size")
        self.assertEqual(receipt["requested"], {"quote_size": "100.1"})
        self.assertEqual(
            (receipt["base_size"], receipt["total"]), ("1.00000000", "100.10")
        )

    def test_refresh_without_positions_needs_no_network(self):
        self.assertTrue(
            self.ok("status", "--refresh", factory=self.forbid_network)["priced"]
        )

    def test_replay_is_exact_and_offline(self):
        rid = str(uuid.uuid4())
        first, text = self.buy(rid, "1.50")
        for spelling in ("1.5", "1.500"):
            again, again_text = self.buy(
                rid.upper(), spelling, factory=self.forbid_network
            )
            self.assertEqual(again_text, text)
        self.assertEqual(len(self.orders()), 1)
        saved = json.loads(self.intent_path(rid).read_text())
        self.assertEqual(saved["size"], "1.5")
        self.assertEqual(stat.S_IMODE(self.intent_path(rid).stat().st_mode), 0o600)
        self.buy(rid, "2", factory=self.forbid_network, error="IDEMPOTENCY_CONFLICT")
        self.call(
            "sell",
            "BTC-USD",
            "--base-size",
            "1.5",
            "--request-id",
            rid,
            factory=self.forbid_network,
            error="IDEMPOTENCY_CONFLICT",
        )

    def test_intent_persisted_before_network_failure(self):
        rid = str(uuid.uuid4())
        self.client.fail = cli.PaperError(
            "NETWORK_UNAVAILABLE", "public data unreachable"
        )
        self.buy(rid, "0.10", error="NETWORK_UNAVAILABLE")
        saved = json.loads(self.intent_path(rid).read_text())
        self.assertEqual(
            saved,
            {
                "version": 1,
                "request_id": rid,
                "account_id": self.account,
                "product_id": "BTC-USD",
                "side": "BUY",
                "size_type": "base_size",
                "size": "0.1",
            },
        )
        self.assertEqual(self.orders(), [])
        self.buy(rid, "0.2", factory=self.forbid_network, error="IDEMPOTENCY_CONFLICT")
        self.buy(
            rid,
            "0.1",
            "--quote-size",
            factory=self.forbid_network,
            error="IDEMPOTENCY_CONFLICT",
        )
        self.client.fail = None
        receipt, _ = self.buy(rid, "0.1")
        self.assertEqual(receipt["base_size"], "0.10000000")
        self.assertEqual(json.loads(self.intent_path(rid).read_text()), saved)

    def test_rejected_order_is_not_reinterpreted(self):
        rid = str(uuid.uuid4())
        self.client.asks = (("100", "1000"),)
        self.buy(rid, "200", error="INSUFFICIENT_CASH")
        self.assertEqual(self.orders(), [])
        self.buy(rid, "199", factory=self.forbid_network, error="IDEMPOTENCY_CONFLICT")

    def test_legacy_receipt_without_intent_file_replays(self):
        rid = str(uuid.uuid4())
        state = str(self.root / "account.sqlite3")
        legacy = paper.trade(
            state,
            {
                "request_id": rid,
                "account_id": self.account,
                "product_id": "BTC-USD",
                "side": "BUY",
                "base_size": "2",
                "product": product(),
                "book": book([("99", "10")], [("100", "10")]),
            },
        )
        replay, _ = self.buy(rid, "2.0", factory=self.forbid_network)
        self.assertEqual(replay, legacy)
        self.assertFalse(self.intent_path(rid).exists())
        self.buy(rid, "3", factory=self.forbid_network, error="IDEMPOTENCY_CONFLICT")

    def test_corrupt_intent_fails_closed(self):
        rid = str(uuid.uuid4())
        self.intent_path(rid).parent.mkdir()
        self.intent_path(rid).write_text("{not json")
        self.buy(rid, factory=self.forbid_network, error="REQUEST_INVALID")
        self.assertEqual(self.orders(), [])

    def test_unexpected_client_error_is_sanitized(self):
        self.client.fail = RuntimeError("raw body: secret-token")
        data, text = self.buy(str(uuid.uuid4()), error="INTERNAL_ERROR")
        self.assertEqual(data["error"]["message"], "RuntimeError")
        self.assertNotIn("secret-token", text)

    def test_bad_input_rejected_before_network(self):
        rid = str(uuid.uuid4())
        cases = [
            (
                ("buy", "BTC-USD", "--base-size", "1", "--request-id", "nope"),
                "INVALID_REQUEST",
            ),
            (
                ("buy", "btc-usd", "--base-size", "1", "--request-id", rid),
                "INVALID_REQUEST",
            ),
            (
                ("buy", "BTC-USD", "--base-size", "1e3", "--request-id", rid),
                "INVALID_DECIMAL",
            ),
            (
                ("buy", "BTC-USD", "--base-size", "0", "--request-id", rid),
                "INVALID_DECIMAL",
            ),
            (
                (
                    "buy",
                    "BTC-USD",
                    "--base-size",
                    "1",
                    "--quote-size",
                    "1",
                    "--request-id",
                    rid,
                ),
                "INVALID_ARGUMENT",
            ),
            (("buy", "BTC-USD", "--base-size", "1"), "INVALID_ARGUMENT"),
            (
                ("sell", "BTC-USD", "--quote-size", "1", "--request-id", rid),
                "INVALID_ARGUMENT",
            ),
            (("history", "--limit", "0"), "INVALID_ARGUMENT"),
            (
                (
                    "candles",
                    "BTC-USD",
                    "--start",
                    "1",
                    "--end",
                    "2",
                    "--granularity",
                    "ONE_WEEK",
                ),
                "INVALID_ARGUMENT",
            ),
            (
                (
                    "candles",
                    "BTC-USD",
                    "--start",
                    "5",
                    "--end",
                    "5",
                    "--granularity",
                    "ONE_DAY",
                ),
                "INVALID_ARGUMENT",
            ),
            (("trade",), "INVALID_ARGUMENT"),
        ]
        for argv, code in cases:
            with self.subTest(argv=argv):
                self.call(*argv, factory=self.forbid_network, error=code)
        self.assertFalse((self.root / "requests").exists())

    def test_profile_and_state_failures(self):
        rid = str(uuid.uuid4())
        profile = self.root / "profile.json"
        good = profile.read_text()
        other = paper.init_state(str(self.tmp / "other.sqlite3"), "1", "USD", "10")
        swapped = json.loads(good)
        swapped["state"] = other["state"]
        profile.write_text(json.dumps(swapped))
        self.buy(rid, factory=self.forbid_network, error="ACCOUNT_MISMATCH")
        data, _ = self.call("doctor", error="ACCOUNT_MISMATCH")
        self.assertEqual(data["state_status"], "INVALID")
        profile.write_text("{broken")
        self.buy(rid, factory=self.forbid_network, error="PROFILE_INVALID")
        data, _ = self.call("doctor", error="PROFILE_INVALID")
        self.assertEqual(data["profile_status"], "INVALID")
        profile.write_text(good)
        state = self.root / "account.sqlite3"
        state.rename(self.tmp / "moved.sqlite3")
        self.buy(rid, factory=self.forbid_network, error="STATE_NOT_FOUND")
        data, _ = self.call("doctor", error="STATE_NOT_FOUND")
        self.assertEqual(data["state_status"], "MISSING")
        self.call("init", error="ACCOUNT_EXISTS")
        state.write_bytes(b"not sqlite" * 100)
        self.buy(rid, factory=self.forbid_network, error="STATE_INVALID")
        self.assertFalse((self.root / "requests").exists())


class ReviewRegressionTest(CLITestCase):
    @unittest.skipIf(
        not hasattr(os, "geteuid") or os.geteuid() == 0,
        "requires non-root POSIX permissions",
    )
    def test_unwritable_data_directory_does_not_create_state(self):
        self.root.mkdir(mode=0o700)
        self.root.chmod(0o500)
        try:
            self.call(
                "init", factory=self.forbid_network, error="STATE_PATH_UNAVAILABLE"
            )
            self.assertEqual(list(self.root.iterdir()), [])
        finally:
            self.root.chmod(0o700)

    @unittest.skipIf(
        not hasattr(os, "geteuid") or os.geteuid() == 0,
        "requires non-root POSIX permissions",
    )
    def test_unwritable_requests_directory_fails_before_network(self):
        self.init()
        requests = self.root / "requests"
        requests.mkdir(mode=0o500)
        try:
            self.buy(
                str(uuid.uuid4()),
                factory=self.forbid_network,
                error="REQUEST_PATH_UNAVAILABLE",
            )
            self.assertEqual(self.orders(), [])
            self.assertEqual(list(requests.iterdir()), [])
        finally:
            requests.chmod(0o700)

    @unittest.skipIf(
        not hasattr(os, "geteuid") or os.geteuid() == 0,
        "requires non-root POSIX permissions",
    )
    def test_readonly_database_never_fills_or_recreates(self):
        self.init()
        state = self.root / "account.sqlite3"
        before = state.read_bytes()
        state.chmod(0o400)
        try:
            self.buy(str(uuid.uuid4()), error="STATE_INVALID")
            self.assertEqual(state.read_bytes(), before)
            self.assertEqual(self.orders(), [])
        finally:
            state.chmod(0o600)

    def test_refresh_limit_is_checked_before_market_data(self):
        self.init()
        report = {"positions": [{"product_id": "BTC-USD"}] * (paper.MAX_BOOKS + 1)}
        with patch.object(paper, "status", return_value=report):
            self.call(
                "status",
                "--refresh",
                factory=self.forbid_network,
                error="INVALID_BOOKS",
            )

    def test_bad_book_refresh_is_all_or_error_and_preserves_offline_status(self):
        self.init()
        self.buy(str(uuid.uuid4()))
        self.ok("buy", "ETH-USD", "--base-size", "1", "--request-id", str(uuid.uuid4()))
        original = self.client.book
        self.client.book = lambda pid: (
            book([], [], pid) if pid == "ETH-USD" else original(pid)
        )
        before = (self.root / "account.sqlite3").read_bytes()
        self.call("status", "--refresh", error="INVALID_BOOK")
        self.assertEqual((self.root / "account.sqlite3").read_bytes(), before)
        offline = self.ok("status", factory=self.forbid_network)
        self.assertEqual(len(offline["positions"]), 2)
        self.assertIsNone(offline["equity"])

    def test_bind_uses_existing_legacy_profile_values_without_reseed(self):
        state, profile = self.tmp / "legacy.sqlite3", self.tmp / "legacy-profile.json"
        old = paper.init_state(str(state), "4321", "USD", "10")
        paper.bind_profile(str(state), str(profile), old["account_id"])
        saved = paper.read_profile(str(profile))
        before = state.read_bytes()
        self.ok("bind", "--state", saved["state"], "--account-id", saved["account_id"])
        self.assertEqual(self.ok("status")["cash"], "4321")
        self.assertEqual(self.ok("doctor")["account_id"], saved["account_id"])
        self.assertEqual(state.read_bytes(), before)
        self.assertFalse((self.root / "account.sqlite3").exists())

    def test_committed_receipts_are_protected_across_bindings(self):
        created = self.init()
        request_id = str(uuid.uuid4())
        original, _ = self.buy(request_id)
        alternate = self.tmp / "replacement binding"
        self.ok(
            "bind",
            "--state",
            str(self.root / "account.sqlite3"),
            "--account-id",
            created["account_id"],
            "--data-dir",
            str(alternate),
        )
        replay = self.ok(
            "buy",
            "BTC-USD",
            "--base-size",
            "1",
            "--request-id",
            request_id,
            "--data-dir",
            str(alternate),
            factory=self.forbid_network,
        )
        self.assertEqual(replay, original)
        self.call(
            "buy",
            "BTC-USD",
            "--base-size",
            "2",
            "--request-id",
            request_id,
            "--data-dir",
            str(alternate),
            factory=self.forbid_network,
            error="IDEMPOTENCY_CONFLICT",
        )
        self.assertFalse((alternate / "requests").exists())


class CandlesTest(CLITestCase):
    def test_candles_need_no_account_and_create_nothing(self):
        data = self.ok(
            "candles",
            "BTC-USD",
            "--start",
            "100",
            "--end",
            "200",
            "--granularity",
            "ONE_HOUR",
        )
        self.assertEqual(data["candles"], [{"start": "100", "close": "100.5"}])
        self.assertIn("Never used as fills", data["notice"])
        self.assertEqual(
            self.client.calls, [("candles", "BTC-USD", 100, 200, "ONE_HOUR")]
        )
        self.assertFalse(self.root.exists())

    def test_malformed_candle_response(self):
        self.client.candles = lambda *args: {"unexpected": True}
        self.call(
            "candles",
            "BTC-USD",
            "--start",
            "1",
            "--end",
            "2",
            "--granularity",
            "ONE_DAY",
            error="INVALID_CANDLES",
        )


class SubprocessTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name).resolve()
        guard = self.tmp / "guard"
        guard.mkdir()
        (guard / "sitecustomize.py").write_text(NETWORK_GUARD)
        self.driver = self.tmp / "driver.py"
        self.driver.write_text(DRIVER.format(scripts=str(SCRIPTS)))
        self.home = self.tmp / "home dir"
        self.home.mkdir()
        self.cwd = self.tmp / "elsewhere"
        self.cwd.mkdir()
        self.env = {
            key: value
            for key, value in os.environ.items()
            if key not in ("COINBASE_PAPER_HOME", "XDG_DATA_HOME")
        }
        self.env.update(HOME=str(self.home), PYTHONPATH=str(guard))
        self.root = self.home / ".local" / "share" / "coinbase-paper"

    def command(self, args, script=None):
        return [sys.executable, str(script or self.driver), *args]

    def run_cli(self, *args, script=None, market=None, error=None, cwd=None):
        env = dict(self.env, FAKE_MARKET=json.dumps(market or {}))
        process = subprocess.run(
            self.command(args, script),
            capture_output=True,
            text=True,
            cwd=cwd or self.cwd,
            env=env,
            timeout=TIMEOUT,
        )
        self.assertNotIn("Traceback", process.stderr)
        data = json.loads(process.stdout)
        self.assertEqual(data["mode"], "PAPER")
        if error:
            self.assertEqual(process.returncode, 1, data)
            self.assertEqual(data["error"]["code"], error, data)
        else:
            self.assertEqual(process.returncode, 0, data)
        return data, process.stdout

    def test_help_and_version_create_nothing(self):
        for flag in ("--help", "--version"):
            process = subprocess.run(
                self.command([flag], CLI),
                capture_output=True,
                text=True,
                cwd=self.cwd,
                env=self.env,
                timeout=TIMEOUT,
            )
            self.assertEqual(process.returncode, 0, process.stderr)
            self.assertIn("coinbase-paper", process.stdout)
        self.assertEqual(tree(self.home), [])
        self.assertEqual(tree(self.cwd), [])
        self.assertFalse(any(SCRIPTS.glob("__pycache__")))

    def test_direct_script_offline_lifecycle_is_cwd_independent(self):
        report, _ = self.run_cli("doctor", script=CLI)
        self.assertEqual(report["data_dir"], str(self.root))
        self.assertEqual(tree(self.home), [])
        created, _ = self.run_cli("init", script=CLI)
        other = self.tmp / "other cwd"
        other.mkdir()
        report, _ = self.run_cli("doctor", script=CLI, cwd=other)
        self.assertTrue(report["ready"])
        self.assertEqual(report["account_id"], created["account_id"])
        status, _ = self.run_cli("status", script=CLI, cwd=other)
        self.assertEqual(status["cash"], "10000")
        self.run_cli("history", script=CLI)
        self.assertEqual(tree(self.cwd), [])
        self.assertEqual(tree(other), [])

    def test_missing_adapter_after_intent_saved(self):
        self.run_cli("init")
        rid = str(uuid.uuid4())
        args = ("buy", "BTC-USD", "--base-size", "1", "--request-id", rid)
        self.run_cli(
            *args, market={"no_adapter": True}, error="PUBLIC_DATA_UNAVAILABLE"
        )
        self.assertTrue((self.root / "requests" / f"{rid}.json").is_file())
        changed = ("buy", "BTC-USD", "--base-size", "2", "--request-id", rid)
        self.run_cli(
            *changed, market={"no_adapter": True}, error="IDEMPOTENCY_CONFLICT"
        )
        first, text = self.run_cli(*args)
        _, replay = self.run_cli(*args, market={"no_adapter": True})
        self.assertEqual(replay, text)
        self.assertEqual(first["status"], "FILLED")

    def spawn(self, args, market):
        env = dict(self.env, FAKE_MARKET=json.dumps(market))
        return subprocess.Popen(
            self.command(args),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=self.cwd,
            env=env,
        )

    def collect(self, processes):
        results = []
        for process in processes:
            out, err = process.communicate(timeout=TIMEOUT)
            self.assertNotIn("Traceback", err)
            results.append((process.returncode, json.loads(out), out))
        return results

    def order_count(self):
        conn = sqlite3.connect(
            (self.root / "account.sqlite3").as_uri() + "?mode=ro", uri=True
        )
        try:
            return conn.execute("SELECT COUNT(*) FROM orders").fetchone()[0]
        finally:
            conn.close()

    def test_concurrent_identical_requests_fill_once(self):
        self.run_cli("init")
        rid = str(uuid.uuid4())
        args = ("buy", "BTC-USD", "--base-size", "1", "--request-id", rid)
        results = self.collect([self.spawn(args, {"delay": 0.3}) for _ in range(4)])
        self.assertEqual({code for code, _, _ in results}, {0})
        self.assertEqual(len({out for _, _, out in results}), 1)
        self.assertEqual(self.order_count(), 1)
        status, _ = self.run_cli("status")
        self.assertEqual(status["cash"], "9899.90")

    def test_concurrent_different_terms_one_wins(self):
        self.run_cli("init")
        rid = str(uuid.uuid4())
        processes = [
            self.spawn(
                ("buy", "BTC-USD", "--base-size", size, "--request-id", rid),
                {"delay": 0.3},
            )
            for size in ("1", "2", "3", "4")
        ]
        results = self.collect(processes)
        winners = [data for code, data, _ in results if code == 0]
        losers = [data["error"]["code"] for code, data, _ in results if code != 0]
        self.assertEqual(len(winners), 1, results)
        self.assertEqual(losers, ["IDEMPOTENCY_CONFLICT"] * 3)
        self.assertEqual(self.order_count(), 1)
        saved = json.loads((self.root / "requests" / f"{rid}.json").read_text())
        self.assertEqual(saved["size"], winners[0]["requested"]["base_size"])


if __name__ == "__main__":
    unittest.main()
