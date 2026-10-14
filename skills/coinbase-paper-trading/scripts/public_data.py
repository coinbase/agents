"""Anonymous, read-only Coinbase public market-data client for paper trading.

Only three fixed GET shapes on a hardcoded host are possible. No credentials,
cookies, netrc, configurable URLs, private routes, telemetry, or redirects.
"""

import email.utils
import importlib.util
import ssl
import sys
import time
import urllib.request
from pathlib import Path


def _load_engine():
    """Return the sibling paper.py module, sharing it if already imported."""
    path = Path(__file__).resolve().with_name("paper.py")
    for module in list(sys.modules.values()):
        source = getattr(module, "__file__", None)
        if source and getattr(module, "PaperError", None) is not None:
            try:
                if Path(source).resolve() == path:
                    return module
            except OSError:
                continue
    spec = importlib.util.spec_from_file_location("paper", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    sys.modules.setdefault("paper", module)
    return module


paper = _load_engine()
PaperError = paper.PaperError

HOST = "api.coinbase.com"
BASE_URL = f"https://{HOST}/api/v3/brokerage/market/"
USER_AGENT = "coinbase-paper/1.2.0"
BOOK_LIMIT = 100
MAX_RESPONSE_BYTES = paper.MAX_INPUT_BYTES
TIMEOUT_SECONDS = 10
MAX_ATTEMPTS = 3
BACKOFF_SECONDS = (0.5, 1.0)
MAX_RETRY_AFTER_SECONDS = 10
MAX_CANDLES = 350
MAX_UNIX_TIME = 10**11
CANDLE_FIELDS = ("start", "low", "high", "open", "close", "volume")
GRANULARITIES = {
    "ONE_MINUTE": 60,
    "FIVE_MINUTE": 300,
    "FIFTEEN_MINUTE": 900,
    "THIRTY_MINUTE": 1800,
    "ONE_HOUR": 3600,
    "TWO_HOUR": 7200,
    "FOUR_HOUR": 14400,
    "SIX_HOUR": 21600,
    "ONE_DAY": 86400,
}
TRANSIENT_STATUSES = {429, 500, 502, 503, 504}
REQUEST_HEADERS = {
    "Accept": "application/json",
    "Accept-Encoding": "identity",
    "User-Agent": USER_AGENT,
}


class _Transient(Exception):
    def __init__(self, reason, retry_after=None):
        super().__init__(reason)
        self.reason = reason
        self.retry_after = retry_after


def _opener():
    # No proxy discovery/auth, redirects, cookies, or non-HTTPS handlers.
    # This paper-only client requires direct HTTPS with certificate verification.
    opener = urllib.request.OpenerDirector()
    opener.add_handler(
        urllib.request.HTTPSHandler(context=ssl.create_default_context())
    )
    return opener


def urllib_transport(url, headers, timeout):
    """Perform one GET; return (status, headers, body bytes up to the cap + 1)."""
    if not url.startswith(BASE_URL):
        raise PaperError("MARKET_DATA_FAILED", "refusing a non-public market URL")
    request = urllib.request.Request(url, headers=dict(headers), method="GET")
    response = _opener().open(request, timeout=timeout)
    if response is None:
        raise PaperError("MARKET_DATA_FAILED", "no HTTPS handler for market URL")
    with response:
        status = response.status
        response_headers = {k.lower(): v for k, v in response.headers.items()}
        body = response.read(MAX_RESPONSE_BYTES + 1) if status == 200 else b""
    return status, response_headers, body


def _product_id(product_id):
    if not isinstance(product_id, str) or not paper.PRODUCT_RE.fullmatch(product_id):
        raise PaperError("INVALID_REQUEST", "product_id must look like BTC-USD")
    return product_id


def _unix(value, field):
    if isinstance(value, str) and value.isascii() and value.isdigit():
        value = int(value)
    if isinstance(value, bool) or not isinstance(value, int):
        raise PaperError("INVALID_REQUEST", f"{field} must be UNIX seconds")
    if not 0 <= value < MAX_UNIX_TIME:
        raise PaperError("INVALID_REQUEST", f"{field} is out of range")
    return value


def _validated_candles(rows):
    """Return bounded numeric OHLCV records, never arbitrary response metadata."""
    if not isinstance(rows, list) or len(rows) > MAX_CANDLES:
        raise PaperError(
            "MARKET_DATA_INVALID", f"candles must contain at most {MAX_CANDLES} records"
        )
    result, seen = [], set()
    for row in rows:
        try:
            if not isinstance(row, dict) or not set(CANDLE_FIELDS).issubset(row):
                raise ValueError("missing candle fields")
            stamp = _unix(row["start"], "candle start")
            if stamp in seen:
                raise ValueError("duplicate candle")
            record = {"start": str(stamp)}
            numbers = {}
            for field in CANDLE_FIELDS[1:]:
                value = row[field]
                if (
                    not isinstance(value, (str, paper.Decimal))
                    and type(value) is not int
                ):
                    raise ValueError("invalid candle value")
                text = str(value)
                numbers[field] = paper.parse_decimal(
                    text, "candle value", allow_zero=field == "volume"
                )
                record[field] = text
            if not (
                numbers["low"] <= numbers["open"] <= numbers["high"]
                and numbers["low"] <= numbers["close"] <= numbers["high"]
            ):
                raise ValueError("inconsistent candle prices")
        except (PaperError, ValueError, OverflowError):
            raise PaperError(
                "MARKET_DATA_INVALID", "public candle contains invalid OHLCV values"
            ) from None
        seen.add(stamp)
        result.append(record)
    return result


class PublicData:
    """Fetch public product, order-book and candle data from Coinbase.

    `transport`, `sleep` and `clock` exist for test injection only; the default
    transport performs real anonymous HTTPS GETs to the fixed host.
    """

    def __init__(self, transport=None, sleep=time.sleep, clock=time.time):
        self._transport = transport or urllib_transport
        self._sleep = sleep
        self._clock = clock

    def product(self, product_id):
        product_id = _product_id(product_id)
        return self._get(f"products/{product_id}", "product")

    def book(self, product_id):
        product_id = _product_id(product_id)
        raw = self._get(
            f"product_book?product_id={product_id}&limit={BOOK_LIMIT}", "book"
        )
        if not isinstance(raw.get("pricebook"), dict):
            raise PaperError("MARKET_DATA_INVALID", "book response has no pricebook")
        return raw

    def candles(self, product_id, start, end, granularity):
        product_id = _product_id(product_id)
        start = _unix(start, "start")
        end = _unix(end, "end")
        if not isinstance(granularity, str) or granularity not in GRANULARITIES:
            raise PaperError(
                "INVALID_REQUEST",
                "granularity must be one of " + ", ".join(GRANULARITIES),
            )
        if end <= start:
            raise PaperError("INVALID_REQUEST", "end must be after start")
        interval = GRANULARITIES[granularity]
        if (end - start + interval - 1) // interval > MAX_CANDLES:
            raise PaperError("INVALID_REQUEST", f"range exceeds {MAX_CANDLES} candles")
        if end > self._clock() + 86400:
            raise PaperError("INVALID_REQUEST", "end is too far in the future")
        raw = self._get(
            f"products/{product_id}/candles?start={start}&end={end}"
            f"&granularity={granularity}",
            "candles",
        )
        return {"candles": _validated_candles(raw.get("candles"))}

    # -------------------------------------------------------------- internals

    def _get(self, path, what):
        url = BASE_URL + path
        for attempt in range(MAX_ATTEMPTS):
            try:
                return self._once(url, what)
            except _Transient as exc:
                if attempt + 1 == MAX_ATTEMPTS:
                    raise PaperError(
                        "MARKET_DATA_UNAVAILABLE",
                        f"public {what} request failed after {MAX_ATTEMPTS} "
                        f"attempts ({exc.reason})",
                    ) from None
                delay = BACKOFF_SECONDS[min(attempt, len(BACKOFF_SECONDS) - 1)]
                if exc.retry_after is not None:
                    if exc.retry_after > MAX_RETRY_AFTER_SECONDS:
                        raise PaperError(
                            "MARKET_DATA_RATE_LIMITED",
                            f"public {what} request asked to wait "
                            f"{exc.retry_after:.0f}s (max {MAX_RETRY_AFTER_SECONDS}s);"
                            " retry later",
                        ) from None
                    delay = max(delay, exc.retry_after)
                self._sleep(delay)
        raise AssertionError("unreachable")

    def _once(self, url, what):
        try:
            status, headers, body = self._transport(
                url, dict(REQUEST_HEADERS), TIMEOUT_SECONDS
            )
        except PaperError:
            raise
        except OSError as exc:  # includes URLError, SSLError and timeouts
            reason = getattr(exc, "reason", None)
            if isinstance(exc, ssl.SSLCertVerificationError) or isinstance(
                reason, ssl.SSLCertVerificationError
            ):
                raise PaperError(
                    "MARKET_DATA_FAILED", f"public {what} TLS verification failed"
                ) from None
            if isinstance(exc, TimeoutError) or isinstance(reason, TimeoutError):
                raise _Transient("timeout") from None
            raise _Transient("network error") from None
        except Exception:
            raise PaperError(
                "MARKET_DATA_FAILED", f"public {what} request failed"
            ) from None
        headers = {str(k).lower(): v for k, v in (headers or {}).items()}
        if 300 <= status < 400:
            raise PaperError(
                "MARKET_DATA_REDIRECT",
                f"public {what} request was redirected (HTTP {status}); refusing",
            )
        if status in TRANSIENT_STATUSES:
            retry_after = None
            if "retry-after" in headers:
                retry_after = self._retry_after(headers["retry-after"], what)
            raise _Transient(f"HTTP {status}", retry_after)
        if status != 200:
            raise PaperError(
                "MARKET_DATA_REJECTED",
                f"public {what} request was rejected (HTTP {status})",
            )
        encoding = str(headers.get("content-encoding", "identity")).lower()
        if encoding not in ("", "identity"):
            raise PaperError(
                "MARKET_DATA_INVALID", f"public {what} response is encoded"
            )
        length = headers.get("content-length")
        if length is not None:
            text = str(length).strip()
            if not text.isdigit() or int(text) > MAX_RESPONSE_BYTES:
                raise PaperError(
                    "MARKET_DATA_TOO_LARGE",
                    f"public {what} response exceeds {MAX_RESPONSE_BYTES} bytes",
                )
        if not isinstance(body, bytes):
            raise PaperError("MARKET_DATA_INVALID", f"public {what} body is invalid")
        if len(body) > MAX_RESPONSE_BYTES:
            raise PaperError(
                "MARKET_DATA_TOO_LARGE",
                f"public {what} response exceeds {MAX_RESPONSE_BYTES} bytes",
            )
        try:
            text = body.decode("utf-8")
        except UnicodeDecodeError:
            raise PaperError(
                "MARKET_DATA_INVALID", f"public {what} response is not UTF-8"
            ) from None
        try:
            value = paper.loads(text, f"public {what} response")
        except PaperError:
            raise PaperError(
                "MARKET_DATA_INVALID", f"public {what} response is not valid JSON"
            ) from None
        if not isinstance(value, dict):
            raise PaperError(
                "MARKET_DATA_INVALID", f"public {what} response is not an object"
            )
        return value

    def _retry_after(self, value, what):
        text = str(value).strip()
        if text.isascii() and text.isdigit():
            return float(int(text)) if len(text) <= 12 else float("inf")
        try:
            moment = email.utils.parsedate_to_datetime(text)
        except (TypeError, ValueError, IndexError, OverflowError):
            moment = None
        if moment is None or moment.tzinfo is None:
            raise PaperError(
                "MARKET_DATA_RATE_LIMITED",
                f"public {what} request was throttled with an unreadable "
                "Retry-After; retry later",
            )
        return max(0.0, moment.timestamp() - self._clock())
