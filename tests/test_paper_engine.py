"""Unit tests for the local paper-trading engine (synthetic fixtures only)."""

import datetime as dt
import errno
import importlib.util
import json
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
import uuid
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

SCRIPT = (
    Path(__file__).resolve().parents[1]
    / "skills"
    / "coinbase-paper-trading"
    / "scripts"
    / "paper.py"
)
sys.dont_write_bytecode = True  # keep the skill tree free of __pycache__
spec = importlib.util.spec_from_file_location("paper_engine", SCRIPT)
paper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(paper)

NOW = dt.datetime(2026, 1, 2, 3, 4, 5, tzinfo=dt.timezone.utc)


def clock(*times):
    """Return a fake clock yielding the given times, then repeating the last one."""
    values = list(times) or [NOW]

    def now():
        return values.pop(0) if len(values) > 1 else values[0]

    return now


def product(**changes):
    item = {
        "product_id": "BTC-USD",
        "product_type": "SPOT",
        "base_currency_id": "BTC",
        "quote_currency_id": "USD",
        "base_increment": "0.00000001",
        "quote_increment": "0.01",
        "base_min_size": "0.00000001",
        "quote_min_size": "1",
    }
    item.update(changes)
    return item


def book(bids=(("99", "10"),), asks=(("100", "10"),), time=None, product_id="BTC-USD"):
    stamp = (time or NOW).isoformat().replace("+00:00", "Z")
    return {
        "pricebook": {
            "product_id": product_id,
            "time": stamp,
            "bids": [{"price": p, "size": s} for p, s in bids],
            "asks": [{"price": p, "size": s} for p, s in asks],
        }
    }


class EngineCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.state = str(self.dir / "paper" / "account.sqlite3")
        self.account = paper.init_state(self.state, "10000", "USD", "10")["account_id"]

    def tearDown(self):
        self.tmp.cleanup()

    def request(self, side="BUY", request_id=None, **fields):
        req = {
            "request_id": request_id or str(uuid.uuid4()),
            "account_id": self.account,
            "product_id": "BTC-USD",
            "side": side,
            "product": product(),
            "book": book(),
        }
        if "base_size" not in fields and "quote_size" not in fields:
            fields["base_size"] = "1"
        req.update(fields)
        return req

    def trade(self, now=None, **kwargs):
        return paper.trade(self.state, self.request(**kwargs), now or clock())

    def status(self, books=None, now=None):
        return paper.status(self.state, books, now or clock())

    def assert_error(self, code, func, *args):
        with self.assertRaises(paper.PaperError) as caught:
            func(*args)
        self.assertEqual(caught.exception.code, code, caught.exception.message)

    def assert_rejected_unchanged(self, code, **kwargs):
        before = Path(self.state).read_bytes()
        with self.assertRaises(paper.PaperError) as caught:
            self.trade(**kwargs)
        self.assertEqual(caught.exception.code, code, caught.exception.message)
        self.assertEqual(Path(self.state).read_bytes(), before)


class GoldenAccounting(EngineCase):
    def test_golden_journey(self):
        buy = self.trade(base_size="2")
        self.assertEqual(
            [Decimal(buy[k]) for k in ("notional", "fee", "cash")],
            [Decimal("200"), Decimal("0.20"), Decimal("9799.80")],
        )
        pos = self.status()["positions"][0]
        self.assertEqual(Decimal(pos["quantity"]), 2)
        self.assertEqual(Decimal(pos["cost_basis"]), Decimal("200.20"))
        self.assertEqual(Decimal(pos["average_cost"]), Decimal("100.10"))

        at110 = book(bids=[("110", "10")], asks=[("111", "10")])
        sell = self.trade(side="SELL", base_size="1", book=at110)
        self.assertEqual(Decimal(sell["fee"]), Decimal("0.11"))
        self.assertEqual(Decimal(sell["cash"]), Decimal("9909.69"))
        self.assertEqual(Decimal(sell["realized_pnl"]), Decimal("9.79"))

        marked = self.status([at110])
        self.assertEqual(Decimal(marked["equity"]), Decimal("10019.69"))
        self.assertEqual(Decimal(marked["unrealized_pnl"]), Decimal("9.90"))
        self.assertEqual(Decimal(marked["total_pnl"]), Decimal("19.69"))
        self.assertEqual(
            Decimal(marked["positions"][0]["cost_basis"]), Decimal("100.10")
        )

        self.trade(side="SELL", base_size="1", book=at110)
        final = self.status()
        self.assertEqual(final["positions"], [])
        for key in ("cash", "equity", "realized_pnl", "total_pnl"):
            expected = "10019.58" if key in ("cash", "equity") else "19.58"
            self.assertEqual(Decimal(final[key]), Decimal(expected), key)
        values = list(final.values()) + [
            v for p in final["positions"] for v in p.values()
        ]
        self.assertFalse(any(isinstance(v, float) for v in values))

    def test_money_outputs_are_strings(self):
        receipt = self.trade()
        for key in ("base_size", "notional", "fee", "cash", "total"):
            self.assertIsInstance(receipt[key], str)
        for key in ("request_id", "account_id", "product_id", "side", "snapshot_time"):
            self.assertIn(key, receipt)
        self.assertEqual(receipt["mode"], "PAPER")

    def test_depth_weighted_buy_and_sell(self):
        deep = book(
            bids=[("99", "1"), ("98", "2")],
            asks=[("100", "1"), ("101", "0.5"), ("105", "10")],
        )
        buy = self.trade(base_size="2", book=deep)
        # 1*100 + 0.5*101 + 0.5*105 = 203; fee ceil(0.203) = 0.21
        self.assertEqual(Decimal(buy["notional"]), Decimal("203"))
        self.assertEqual(Decimal(buy["fee"]), Decimal("0.21"))
        self.assertEqual(len(buy["fills"]), 3)
        sell = self.trade(side="SELL", base_size="2", book=deep)
        # 99 + 98 = 197; fee ceil(0.197) = 0.20; proceeds 196.80; basis 203.21
        self.assertEqual(Decimal(sell["notional"]), Decimal("197"))
        self.assertEqual(Decimal(sell["realized_pnl"]), Decimal("-6.41"))

    def test_quote_budget_includes_fee_and_rounds_down_to_increment(self):
        req = self.request(quote_size="100", product=product(base_increment="0.001"))
        receipt = paper.trade(self.state, req, clock())
        # 0.999 * 100 = 99.90 + fee 0.10 = 100.00; 1.000 would cost 100.10
        self.assertEqual(Decimal(receipt["base_size"]), Decimal("0.999"))
        self.assertEqual(Decimal(receipt["total"]), Decimal("100.00"))
        self.assertEqual(Decimal(receipt["cash"]), Decimal("9900.00"))

    def test_quote_budget_leaves_dust_with_fine_increment(self):
        receipt = self.trade(quote_size="100")
        self.assertLessEqual(Decimal(receipt["total"]), Decimal("100"))
        one_more = Decimal(receipt["base_size"]) + Decimal("0.00000001")
        notional = (one_more * 100).quantize(Decimal("0.01"), rounding="ROUND_CEILING")
        fee = (notional / 1000).quantize(Decimal("0.01"), rounding="ROUND_CEILING")
        self.assertGreater(notional + fee, Decimal("100"))

    def test_quote_budget_beyond_depth_rejected(self):
        self.assert_rejected_unchanged(
            "INSUFFICIENT_LIQUIDITY", quote_size="5000", book=book(asks=[("100", "1")])
        )

    def test_full_close_removes_residual_basis(self):
        self.trade(base_size="1", book=book(bids=[("99", "5")], asks=[("100.01", "5")]))
        self.trade(base_size="2")
        self.assertEqual(
            Decimal(self.status()["positions"][0]["cost_basis"]), Decimal("300.32")
        )
        partial = self.trade(
            side="SELL",
            base_size="1",
            book=book(asks=[("101", "1")], bids=[("100", "9")]),
        )
        self.assertEqual(Decimal(partial["position"]["cost_basis"]), Decimal("200.21"))
        self.trade(
            side="SELL",
            base_size="2",
            book=book(asks=[("101", "1")], bids=[("100", "9")]),
        )
        final = self.status()
        self.assertEqual(final["positions"], [])
        self.assertEqual(Decimal(final["equity"]) - 10000, Decimal(final["total_pnl"]))

    def test_flat_account_equity_is_cash_and_unpriced_is_null(self):
        flat = self.status()
        self.assertEqual(flat["equity"], flat["cash"])
        self.trade()
        held = self.status()
        self.assertIsNone(held["equity"])
        self.assertIsNone(held["total_pnl"])
        self.assertEqual(held["positions"][0]["mark_status"], "MISSING")
        stale = self.status([book(time=NOW - dt.timedelta(seconds=61))])
        self.assertIsNone(stale["equity"])
        self.assertEqual(stale["positions"][0]["mark_status"], "STALE")


class Rejections(EngineCase):
    def test_insufficient_cash_holdings_liquidity_do_not_mutate(self):
        self.assert_rejected_unchanged(
            "INSUFFICIENT_CASH", base_size="99.99", book=book(asks=[("100", "1000")])
        )
        self.assert_rejected_unchanged("INSUFFICIENT_CASH", quote_size="10000.01")
        self.assert_rejected_unchanged(
            "INSUFFICIENT_HOLDINGS", side="SELL", base_size="1"
        )
        self.assert_rejected_unchanged("INSUFFICIENT_LIQUIDITY", base_size="11")

    def test_increments_and_limits(self):
        self.assert_rejected_unchanged("INVALID_INCREMENT", base_size="0.000000001")
        self.assert_rejected_unchanged("INVALID_INCREMENT", quote_size="10.001")
        self.assert_rejected_unchanged("BELOW_MINIMUM", base_size="0.001")
        self.assert_rejected_unchanged(
            "ABOVE_MAXIMUM", base_size="2", product=product(base_max_size="1")
        )

    def test_product_validation(self):
        cases = {
            "PRODUCT_MISMATCH": product(product_id="ETH-USD"),
            "UNSUPPORTED_PRODUCT": product(product_type="FUTURE"),
            "CURRENCY_MISMATCH": None,
            "PRODUCT_UNAVAILABLE": product(trading_disabled=True),
            "INVALID_DECIMAL": product(base_increment="0"),
        }
        for code, item in cases.items():
            with self.subTest(code=code):
                if code == "CURRENCY_MISMATCH":
                    req = self.request(
                        product_id="BTC-EUR",
                        product=product(product_id="BTC-EUR", quote_currency_id="EUR"),
                        book=book(product_id="BTC-EUR"),
                    )
                    self.assert_error(code, paper.trade, self.state, req, clock())
                else:
                    self.assert_rejected_unchanged(code, product=item)
        for flag in ("limit_only", "post_only", "is_disabled", "cancel_only"):
            self.assert_rejected_unchanged(
                "PRODUCT_UNAVAILABLE", product=product(**{flag: True})
            )
        self.assert_rejected_unchanged(
            "PRODUCT_UNAVAILABLE", product=product(status="offline")
        )
        self.trade(product=product(limit_only=False, status="online"))

    def test_bad_books(self):
        crossed = book(bids=[("100", "1")], asks=[("100", "1")])
        unordered = book(asks=[("101", "1"), ("100", "1")])
        empty = book(bids=[])
        for bad in (
            crossed,
            unordered,
            empty,
            book(asks=[("0", "1")]),
            book(asks=[("100", "-1")]),
        ):
            self.assert_rejected_unchanged(_code(bad), book=bad)
        self.assert_rejected_unchanged(
            "PRODUCT_MISMATCH", book=book(product_id="ETH-USD")
        )
        self.assert_rejected_unchanged("INVALID_BOOK", book={"bids": [], "asks": []})

    def test_time_validation(self):
        self.assert_rejected_unchanged(
            "STALE_BOOK", book=book(time=NOW - dt.timedelta(seconds=61))
        )
        self.assert_rejected_unchanged(
            "FUTURE_BOOK", book=book(time=NOW + dt.timedelta(seconds=6))
        )
        self.trade(book=book(time=NOW + dt.timedelta(seconds=4)))
        self.trade(book=book(time=NOW - dt.timedelta(seconds=59)))
        for stamp in (None, "2026-01-02T03:04:05", "yesterday", 1767323045):
            bad = book()
            bad["pricebook"]["time"] = stamp
            if stamp is None:
                del bad["pricebook"]["time"]
            self.assert_rejected_unchanged("INVALID_BOOK", book=bad)

    def test_freshness_rechecked_immediately_before_commit(self):
        late = NOW + dt.timedelta(seconds=61)
        self.assert_rejected_unchanged("STALE_BOOK", now=clock(NOW, NOW, late))

    def test_decimal_inputs_fail_closed(self):
        for value in (
            "NaN",
            "Infinity",
            "1e2",
            "-1",
            "0",
            " 1",
            "1" * 16,
            "0." + "1" * 19,
            "",
        ):
            self.assert_rejected_unchanged("INVALID_DECIMAL", base_size=value)
        self.assert_rejected_unchanged("INVALID_DECIMAL", base_size=Decimal("1"))
        self.assert_rejected_unchanged("INVALID_DECIMAL", base_size=1)

    def test_request_shape(self):
        req = self.request()
        req["quote_size"] = "10"
        self.assert_error("INVALID_REQUEST", paper.trade, self.state, req, clock())
        req = self.request(side="SELL", quote_size="10")
        self.assert_error("INVALID_REQUEST", paper.trade, self.state, req, clock())
        for change in (
            {"side": "buy"},
            {"sid": "BUY"},
            {"request_id": "abc"},
            {"product_id": "btc"},
        ):
            req = self.request()
            req.update(change)
            self.assert_error("INVALID_REQUEST", paper.trade, self.state, req, clock())
        req = self.request()
        del req["book"]
        self.assert_error("INVALID_REQUEST", paper.trade, self.state, req, clock())
        self.assert_rejected_unchanged("ACCOUNT_MISMATCH", account_id="paper-other")

    def test_json_parsing_rejects_nonfinite_and_duplicates(self):
        for text in ('{"a": NaN}', '{"a": 1, "a": 2}', '{"a": Infinity}', "{"):
            self.assert_error("INVALID_JSON", paper.loads, text, "request")


def _code(bad):
    return (
        "INVALID_DECIMAL"
        if any(
            level["price"] in ("0",) or level["size"].startswith("-")
            for side in ("bids", "asks")
            for level in bad["pricebook"][side]
        )
        else "INVALID_BOOK"
    )


class Envelopes(EngineCase):
    def test_wrappers_are_equivalent(self):
        raw_book, raw_product = book(), product()
        variants = [
            (raw_product, raw_book),
            ({"structuredContent": raw_product}, {"structuredContent": raw_book}),
            (
                {"content": [{"type": "text", "text": json.dumps(raw_product)}]},
                {
                    "content": [{"type": "text", "text": json.dumps(raw_book)}],
                    "isError": False,
                },
            ),
        ]
        results = []
        for item, bk in variants:
            receipt = self.trade(product=item, book=bk)
            results.append(
                {
                    k: receipt[k]
                    for k in ("base_size", "notional", "fee", "fills", "source")
                }
            )
        self.assertEqual(results[0], results[1])
        self.assertEqual(results[0], results[2])

    def test_bad_envelopes(self):
        text = json.dumps(book())
        bad = [
            {"structuredContent": book(), "isError": True},
            {"content": [{"type": "text", "text": text[:-5]}]},
            {
                "content": [
                    {"type": "text", "text": text},
                    {"type": "text", "text": text},
                ]
            },
            {"content": [{"type": "image", "data": "x"}]},
            {"content": [{"type": "text", "text": text}], "truncated": True},
            {"isError": True, "content": []},
            {"error": "boom"},
            {"structuredContent": ["not", "object"]},
        ]
        for envelope in bad:
            with self.subTest(envelope=str(envelope)[:60]):
                before = Path(self.state).read_bytes()
                with self.assertRaises(paper.PaperError) as caught:
                    self.trade(book=envelope)
                self.assertIn(
                    caught.exception.code, {"INVALID_ENVELOPE", "INVALID_JSON"}
                )
                self.assertEqual(Path(self.state).read_bytes(), before)


class Idempotency(EngineCase):
    def test_retry_returns_original_receipt_without_market_check(self):
        rid = str(uuid.uuid4())
        first = self.trade(request_id=rid)
        stale = book(time=NOW - dt.timedelta(days=1), asks=[("500", "1")])
        replay = self.trade(
            request_id=rid, book=stale, now=clock(NOW + dt.timedelta(hours=1))
        )
        self.assertEqual(first, replay)
        self.assertEqual(self.status()["positions"][0]["quantity"], "1.00000000")
        self.assertEqual(paper.history(self.state)["order_count"], 1)
        replay_canonical = self.trade(request_id=rid, base_size="1.000")
        self.assertEqual(first, replay_canonical)

    def test_changed_intent_conflicts(self):
        rid = str(uuid.uuid4())
        self.trade(request_id=rid)
        for change in ({"base_size": "2"}, {"side": "SELL"}, {"quote_size": "1"}):
            fields = {"base_size": "1"}
            fields.update(change)
            if "quote_size" in change:
                del fields["base_size"]
            with self.subTest(change=change):
                with self.assertRaises(paper.PaperError) as caught:
                    self.trade(request_id=rid, **fields)
                self.assertEqual(caught.exception.code, "IDEMPOTENCY_CONFLICT")
        req = self.request(
            request_id=rid,
            product_id="ETH-USD",
            product=product(product_id="ETH-USD", base_currency_id="ETH"),
            book=book(product_id="ETH-USD"),
        )
        self.assert_error("IDEMPOTENCY_CONFLICT", paper.trade, self.state, req, clock())

    def test_rejected_request_can_be_retried_with_same_id(self):
        rid = str(uuid.uuid4())
        with self.assertRaises(paper.PaperError):
            self.trade(request_id=rid, book=book(time=NOW - dt.timedelta(seconds=90)))
        self.assertEqual(self.trade(request_id=rid)["status"], "FILLED")

    def test_concurrent_same_id_fills_once(self):
        rid = str(uuid.uuid4())
        results = self._parallel([self.request(request_id=rid) for _ in range(6)])
        self.assertEqual(len({json.dumps(r, sort_keys=True) for r in results}), 1)
        self.assertEqual(paper.history(self.state)["order_count"], 1)

    def test_concurrent_distinct_ids_cannot_overspend(self):
        deep = book(asks=[("100", "1000")])
        results = self._parallel(
            [self.request(base_size="60", book=deep) for _ in range(5)]
        )
        filled = [r for r in results if isinstance(r, dict)]
        self.assertEqual(len(filled), 1)
        self.assertTrue(
            all(r == "INSUFFICIENT_CASH" for r in results if isinstance(r, str))
        )
        self.assertEqual(
            Decimal(self.status()["cash"]), Decimal("10000") - Decimal("6006")
        )

    def _parallel(self, requests):
        results = []
        lock = threading.Lock()

        def run(req):
            try:
                outcome = paper.trade(self.state, req, clock())
            except paper.PaperError as exc:
                outcome = exc.code
            with lock:
                results.append(outcome)

        threads = [threading.Thread(target=run, args=(r,)) for r in requests]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        return results


class StateSafety(EngineCase):
    def test_duplicate_init_and_missing_state(self):
        before = Path(self.state).read_bytes()
        self.assert_error(
            "STATE_EXISTS", paper.init_state, self.state, "5", "USD", "10"
        )
        self.assertEqual(Path(self.state).read_bytes(), before)
        missing = str(self.dir / "missing.sqlite3")
        self.assert_error("STATE_NOT_FOUND", paper.status, missing)
        self.assertFalse(Path(missing).exists())
        self.assertEqual(paper.doctor(missing)["state_status"], "MISSING")
        self.assertFalse(Path(missing).exists())

    def test_corrupt_and_unsupported_state_fail_closed(self):
        corrupt = self.dir / "corrupt.sqlite3"
        corrupt.write_bytes(b"not a database at all" * 100)
        for func in (paper.status, paper.doctor, paper.history):
            self.assert_error("STATE_INVALID", func, str(corrupt))
        self.assertEqual(corrupt.read_bytes(), b"not a database at all" * 100)
        foreign = self.dir / "foreign.sqlite3"
        sqlite3.connect(foreign).execute("CREATE TABLE x (y)").connection.close()
        self.assert_error("STATE_INVALID", paper.status, str(foreign))
        conn = sqlite3.connect(self.state)
        conn.execute("PRAGMA user_version = 99")
        conn.close()
        self.assert_error("STATE_UNSUPPORTED", paper.status, self.state)

    def test_paths(self):
        self.assert_error("INVALID_PATH", paper.status, "relative.sqlite3")
        inside = str(paper.SKILL_DIR / "state.sqlite3")
        self.assert_error("INVALID_PATH", paper.init_state, inside, "1", "USD", "10")
        self.assertFalse(Path(inside).exists())
        self.assertEqual(Path(self.state).stat().st_mode & 0o777, 0o600)
        self.assertEqual(Path(self.state).parent.stat().st_mode & 0o777, 0o700)

    def test_init_arguments(self):
        target = str(self.dir / "new.sqlite3")
        for args in (
            ("0", "USD", "10"),
            ("1", "usd", "10"),
            ("1", "USD", "1001"),
            ("1", "USD", "-1"),
        ):
            with self.assertRaises(paper.PaperError):
                paper.init_state(target, *args)
        self.assertFalse(Path(target).exists())
        self.assertEqual(paper.init_state(target, "500", "USDC", "0")["fee_bps"], "0")

    def test_concurrent_init_creates_once(self):
        target = str(self.dir / "race.sqlite3")
        outcomes = []

        def run():
            try:
                outcomes.append(
                    paper.init_state(target, "1", "USD", "10")["account_id"]
                )
            except paper.PaperError as exc:
                outcomes.append(exc.code)

        threads = [threading.Thread(target=run) for _ in range(6)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        accounts = [o for o in outcomes if o.startswith("paper-")]
        self.assertEqual(len(accounts), 1)
        self.assertEqual(paper.status(target)["account_id"], accounts[0])
        self.assertEqual(
            sorted(p.name for p in self.dir.iterdir()), ["paper", "race.sqlite3"]
        )

    def test_backup_preserves_identity_and_idempotency(self):
        rid = str(uuid.uuid4())
        first = self.trade(request_id=rid)
        out = str(self.dir / "backups" / "copy.sqlite3")
        self.assertEqual(paper.backup(self.state, out)["account_id"], self.account)
        self.assert_error("STATE_EXISTS", paper.backup, self.state, out)
        self.assert_error("INVALID_PATH", paper.backup, self.state, self.state)
        restored = paper.status(out)
        self.assertEqual(restored["account_id"], self.account)
        self.assertEqual(restored["cash"], self.status()["cash"])
        self.assertEqual(paper.trade(out, self.request(request_id=rid), clock()), first)

    def test_history_bounds_and_order(self):
        ids = [self.trade()["request_id"] for _ in range(3)]
        history = paper.history(self.state, 2)
        self.assertEqual([o["request_id"] for o in history["orders"]], ids[::-1][:2])
        self.assert_error("INVALID_ARGUMENT", paper.history, self.state, 0)
        self.assert_error("INVALID_ARGUMENT", paper.history, self.state, 1001)

    def test_no_binary_floats_in_storage(self):
        self.trade()
        conn = sqlite3.connect(self.state)
        for table in ("account", "positions", "orders"):
            for row in conn.execute(f"SELECT * FROM {table}"):
                self.assertFalse(any(isinstance(v, float) for v in row))
        conn.close()


class ReviewRegressions(EngineCase):
    def test_average_fill_price_excludes_notional_rounding(self):
        buy = self.trade(
            base_size="0.01",
            book=book(bids=[("100", "10")], asks=[("100.01", "10")]),
        )
        self.assertEqual(Decimal(buy["notional"]), Decimal("1.01"))
        self.assertEqual(Decimal(buy["average_price"]), Decimal("100.01"))
        sell = self.trade(
            side="SELL",
            base_size="0.01",
            book=book(bids=[("100.02", "10")], asks=[("101", "10")]),
        )
        self.assertEqual(Decimal(sell["notional"]), Decimal("1.00"))
        self.assertEqual(Decimal(sell["average_price"]), Decimal("100.02"))

    def enable_wal(self):
        # Permit a writer to commit during a reader's snapshot deterministically.
        conn = sqlite3.connect(self.state)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.close()

    def test_status_uses_one_snapshot_during_a_trade(self):
        self.enable_wal()
        original = paper.load_positions
        injected = False

        def read_after_trade(conn):
            nonlocal injected
            if not injected:
                injected = True
                self.trade(base_size="2")
            return original(conn)

        with patch.object(paper, "load_positions", side_effect=read_after_trade):
            report = self.status([book()])
        self.assertEqual(report["positions"], [])
        self.assertEqual(Decimal(report["equity"]), Decimal("10000"))
        self.assertEqual(
            Decimal(report["equity"]) - Decimal(report["initial_cash"]),
            Decimal(report["total_pnl"]),
        )
        self.assertEqual(Decimal(self.status()["cash"]), Decimal("9799.80"))

    def test_history_uses_one_snapshot_during_a_trade(self):
        self.enable_wal()
        self.trade()
        original = json.loads
        injected = False

        def decode_after_trade(text, *args, **kwargs):
            nonlocal injected
            result = original(text, *args, **kwargs)
            if not injected:
                injected = True
                self.trade()
            return result

        with patch.object(paper.json, "loads", side_effect=decode_after_trade):
            report = paper.history(self.state)
        self.assertEqual(len(report["orders"]), 1)
        self.assertEqual(report["order_count"], 1)
        self.assertEqual(paper.history(self.state)["order_count"], 2)

    def test_storage_errors_are_actionable_without_partial_state(self):
        new_state = str(self.dir / "readonly" / "new.sqlite3")
        with patch.object(
            paper.os,
            "mkdir",
            side_effect=PermissionError(errno.EACCES, "Permission denied"),
        ):
            self.assert_error(
                "STATE_PATH_UNAVAILABLE",
                paper.init_state,
                new_state,
                "100",
                "USD",
                "10",
            )
        self.assertFalse(Path(new_state).exists())
        backup = str(self.dir / "unsupported.sqlite3")
        with patch.object(
            paper.os,
            "link",
            side_effect=OSError(errno.EOPNOTSUPP, "Operation not supported"),
        ):
            self.assert_error(
                "STATE_PATH_UNAVAILABLE", paper.backup, self.state, backup
            )
        self.assertFalse(Path(backup).exists())
        self.assertFalse(list(self.dir.glob(".*.tmp*")))

    def test_truncation_rejected_in_raw_and_wrapped_payloads(self):
        for field in ("product", "book"):
            for wrapper in (
                lambda value: value,
                lambda value: {"structuredContent": value},
                lambda value: {
                    "content": [{"type": "text", "text": json.dumps(value)}]
                },
            ):
                with self.subTest(field=field, wrapper=wrapper):
                    value = product() if field == "product" else book()
                    value["truncated"] = True
                    self.assert_rejected_unchanged(
                        "INVALID_ENVELOPE", **{field: wrapper(value)}
                    )

    def test_input_errors_do_not_echo_arbitrary_keys(self):
        secret = "SECRET-MARKER-untrusted-key"
        text = json.dumps({secret: 1})[:-1] + "," + json.dumps(secret) + ":2}"
        with self.assertRaises(paper.PaperError) as caught:
            paper.loads(text, "request")
        self.assertNotIn(secret, caught.exception.message)
        with self.assertRaises(paper.PaperError) as caught:
            self.trade(**{secret: "unexpected"})
        self.assertNotIn(secret, caught.exception.message)

    def test_trailing_newlines_are_not_valid_identifiers_or_numbers(self):
        self.assert_rejected_unchanged("INVALID_DECIMAL", base_size="1\n")
        self.assert_rejected_unchanged("INVALID_REQUEST", product_id="BTC-USD\n")
        self.assert_rejected_unchanged(
            "INVALID_REQUEST", request_id=str(uuid.uuid4()) + "\n"
        )

    def test_state_file_symlink_is_rejected(self):
        alias = self.dir / "alias.sqlite3"
        alias.symlink_to(self.state)
        with patch.object(paper, "SKILL_DIR", Path(self.state).parent):
            self.assert_error("INVALID_PATH", paper.status, str(alias))

    def test_rejected_database_connection_is_closed(self):
        foreign = self.dir / "foreign.sqlite3"
        conn = sqlite3.connect(foreign)
        self.addCleanup(conn.close)
        with patch.object(paper, "connect", return_value=conn):
            self.assert_error("STATE_INVALID", paper.open_state, str(foreign))
        with self.assertRaises(sqlite3.ProgrammingError):
            conn.execute("SELECT 1")

    def test_connection_setup_failure_closes_connection(self):
        with patch.object(paper.sqlite3, "connect") as connect:
            conn = connect.return_value
            conn.execute.side_effect = sqlite3.DatabaseError("invalid database")
            with self.assertRaises(sqlite3.DatabaseError):
                paper.connect(Path(self.state))
            conn.close.assert_called_once_with()

    def test_changed_quote_increment_cannot_make_remaining_basis_negative(self):
        # A product can change its increments between two market-data reads.
        self.trade(
            product=product(quote_min_size="0.01"),
            book=book(bids=[("0.58", "10")], asks=[("0.59", "10")]),
        )
        self.trade(
            side="SELL",
            base_size="0.95",
            product=product(quote_increment="1", quote_min_size="1"),
            book=book(bids=[("10", "10")], asks=[("11", "10")]),
        )
        position = self.status()["positions"][0]
        self.assertGreaterEqual(Decimal(position["cost_basis"]), 0)
        self.assertEqual(Decimal(position["quantity"]), Decimal("0.05"))


class Cli(unittest.TestCase):
    def run_cli(self, *args, stdin=None):
        proc = subprocess.run(
            [sys.executable, str(SCRIPT), *args],
            input=stdin,
            capture_output=True,
            text=True,
            timeout=60,
        )
        return proc.returncode, proc.stdout

    def test_help_and_errors_are_machine_readable(self):
        code, out = self.run_cli("--help")
        self.assertEqual(code, 0)
        self.assertIn("PAPER", out)
        code, out = self.run_cli("status")
        self.assertNotEqual(code, 0)
        self.assertEqual(json.loads(out)["error"]["code"], "INVALID_ARGUMENT")
        code, out = self.run_cli("--state", "/nonexistent-dir-paper/x.sqlite3", "bogus")
        self.assertEqual(json.loads(out)["error"]["code"], "INVALID_ARGUMENT")

    def test_cli_trade_via_stdin_with_current_time(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = str(Path(tmp) / "a.sqlite3")
            code, out = self.run_cli("--state", state, "init")
            self.assertEqual(code, 0)
            account = json.loads(out)["account_id"]
            now = dt.datetime.now(dt.timezone.utc)
            req = {
                "request_id": str(uuid.uuid4()),
                "account_id": account,
                "product_id": "BTC-USD",
                "side": "BUY",
                "quote_size": "100",
                "product": product(),
                "book": book(time=now),
            }
            code, out = self.run_cli(
                "--state", state, "trade", "--request", "-", stdin=json.dumps(req)
            )
            self.assertEqual(code, 0, out)
            self.assertEqual(json.loads(out)["mode"], "PAPER")
            code, out = self.run_cli(
                "--state", state, "trade", "--request", "-", stdin="{bad"
            )
            self.assertEqual(code, 1)
            self.assertNotIn("{bad", out)
            code, out = self.run_cli("status", "--state", state)
            self.assertEqual(code, 0)
            self.assertIsNone(json.loads(out)["equity"])


if __name__ == "__main__":
    unittest.main()
