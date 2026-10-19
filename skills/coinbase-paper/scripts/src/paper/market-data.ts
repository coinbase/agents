// Anonymous public market data for the local paper simulator. This is intentionally separate
// from the authenticated Agent API transport: only three fixed GET shapes on one hardcoded
// host are possible, with no credentials, config, environment-derived URL, proxy or redirects.
import { request as httpsRequest } from 'node:https';
import type { RequestOptions } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { parseDecimalToBigInt } from '../lib/decimal.ts';
import { PaperError } from './types.ts';
import type { Candle, CandleGranularity, CandleWindow, CandleWindowRequest, CommandMarketData, MarketData, RequestStats } from './types.ts';

export type { Candle } from './types.ts';

const HOST = 'api.coinbase.com';
const BASE_PATH = '/api/v3/brokerage/market/';
const HEADERS = Object.freeze({
  Accept: 'application/json',
  'Accept-Encoding': 'identity',
  'User-Agent': 'coinbase-cli-paper',
});
const BOOK_LIMIT = 100;
const MAX_RESPONSE_BYTES = 2_000_000;
const DEADLINE_MS = 15_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [250, 500];
const MAX_RETRY_AFTER_MS = 10_000;
const MAX_CANDLES = 350;
const MAX_UNIX_TIME = 100_000_000_000;
const MAX_FUTURE_END_SECONDS = 86_400;
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);
// Connection-level failures where repeating an idempotent GET is safe. Anything else
// (TLS verification, protocol errors) fails without retry.
const TRANSIENT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT',
  'EAI_AGAIN', 'ENOTFOUND', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN',
]);
const GRANULARITIES: Record<string, number> = {
  ONE_MINUTE: 60,
  FIVE_MINUTE: 300,
  FIFTEEN_MINUTE: 900,
  THIRTY_MINUTE: 1800,
  ONE_HOUR: 3600,
  TWO_HOUR: 7200,
  FOUR_HOUR: 14400,
  SIX_HOUR: 21600,
  ONE_DAY: 86400,
};
const PRODUCT_ID = /^[A-Z0-9]{1,15}-[A-Z0-9]{1,10}$/;
const UNIX_SECONDS = /^(?:0|[1-9]\d{0,10})$/;
const DECIMAL = /^(?:0|[1-9]\d{0,14})(?:\.\d{1,18})?$/;
const RETRY_HINT = 'No simulated trade used this data. Retry later with the same client_order_id; do not fall back to a live trading command.';

export type HttpsRequest = (options: RequestOptions, onResponse: (res: IncomingMessage) => void) => ClientRequest;

export interface PublicMarketDataOptions {
  request?: HttpsRequest;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

class TransientFailure extends Error {
  readonly retryAfter: string | undefined;
  readonly rateLimited: boolean;

  constructor(reason: string, retryAfter?: string, rateLimited = false) {
    super(reason);
    this.retryAfter = retryAfter;
    this.rateLimited = rateLimited;
  }
}

function invalidRequest(message: string): PaperError {
  return new PaperError('INVALID_REQUEST', message);
}

function invalidData(what: string, detail: string): PaperError {
  return new PaperError('MARKET_DATA_INVALID', `public ${what} response ${detail}`, RETRY_HINT);
}

function productId(value: string): string {
  if (typeof value !== 'string' || !PRODUCT_ID.test(value)) {
    throw invalidRequest('product_id must look like BTC-USD');
  }
  return value;
}

function unixSeconds(value: unknown, field: string): number {
  if (typeof value !== 'string' || !UNIX_SECONDS.test(value) || Number(value) >= MAX_UNIX_TIME) {
    throw invalidRequest(`${field} must be UNIX seconds`);
  }
  return Number(value);
}

/** Returns the delay in ms, or null when the header is unreadable. */
function parseRetryAfter(value: string, nowMs: number): number | null {
  const text = value.trim();
  if (/^\d{1,9}$/.test(text)) return Number(text) * 1000;
  if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text)) return null;
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
}

function candleRecords(rows: unknown, from: number, to: number, interval: number): Candle[] {
  if (!Array.isArray(rows) || rows.length > MAX_CANDLES) {
    throw invalidData('candles', `must contain at most ${MAX_CANDLES} records`);
  }
  const earliest = from - (from % interval);
  const seen = new Set<number>();
  return rows.map((row: unknown): Candle => {
    const bad = () => invalidData('candles', 'contains an invalid OHLCV record');
    if (row === null || typeof row !== 'object' || Array.isArray(row)) throw bad();
    const r = row as Record<string, unknown>;
    if (typeof r.start !== 'string' || !UNIX_SECONDS.test(r.start)) throw bad();
    const start = Number(r.start);
    if (start < earliest || start > to || seen.has(start)) throw bad();
    seen.add(start);
    const values: Record<string, bigint> = {};
    for (const field of ['low', 'high', 'open', 'close', 'volume']) {
      const v = r[field];
      if (typeof v !== 'string' || !DECIMAL.test(v)) throw bad();
      values[field] = parseDecimalToBigInt(v, 18);
    }
    const { low, high, open, close } = values;
    if (low <= 0n || low > open || low > close || open > high || close > high) throw bad();
    return { start: r.start, low: r.low as string, high: r.high as string, open: r.open as string, close: r.close as string, volume: r.volume as string };
  });
}

export class PublicMarketData implements MarketData {
  private readonly request: HttpsRequest;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  /** HTTP attempts started, including retries. */
  httpAttempts = 0;

  constructor(options: PublicMarketDataOptions = {}) {
    this.request = options.request ?? httpsRequest;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
  }

  async product(id: string): Promise<Record<string, unknown>> {
    return this.get(`products/${productId(id)}`, 'product');
  }

  async book(id: string): Promise<Record<string, unknown>> {
    return this.get(`product_book?product_id=${productId(id)}&limit=${BOOK_LIMIT}`, 'book');
  }

  async candles(id: string, start: string, end: string, granularity: string): Promise<{ candles: Candle[] }> {
    const product = productId(id);
    const from = unixSeconds(start, 'start');
    const to = unixSeconds(end, 'end');
    const interval = Object.hasOwn(GRANULARITIES, granularity) ? GRANULARITIES[granularity] : undefined;
    if (interval === undefined) {
      throw invalidRequest(`granularity must be one of ${Object.keys(GRANULARITIES).join(', ')}`);
    }
    if (to <= from) throw invalidRequest('end must be after start');
    if (Math.ceil((to - from) / interval) > MAX_CANDLES) {
      throw invalidRequest(`range exceeds ${MAX_CANDLES} candles; narrow start/end or use a larger granularity`);
    }
    if (to > Math.floor(this.now() / 1000) + MAX_FUTURE_END_SECONDS) {
      throw invalidRequest('end is too far in the future');
    }
    const raw = await this.get(
      `products/${product}/candles?start=${from}&end=${to}&granularity=${granularity}`,
      'candles',
    );
    return { candles: candleRecords(raw.candles, from, to, interval) };
  }

  private async get(path: string, what: string): Promise<Record<string, unknown>> {
    const deadline = this.now() + DEADLINE_MS;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.once(path, what, deadline - this.now());
      } catch (err) {
        if (!(err instanceof TransientFailure)) throw err;
        const exhausted = (detail: string) => new PaperError(
          err.rateLimited ? 'MARKET_DATA_RATE_LIMITED' : 'MARKET_DATA_UNAVAILABLE',
          `public ${what} request failed (${err.message}); ${detail}`,
          RETRY_HINT,
        );
        if (attempt >= MAX_ATTEMPTS) throw exhausted(`gave up after ${MAX_ATTEMPTS} attempts`);
        let delay = BACKOFF_MS[attempt - 1];
        if (err.retryAfter !== undefined) {
          const asked = parseRetryAfter(err.retryAfter, this.now());
          if (asked === null) throw exhausted('Retry-After is unreadable');
          if (asked > MAX_RETRY_AFTER_MS) throw exhausted(`server asked to wait more than ${MAX_RETRY_AFTER_MS / 1000}s`);
          delay = Math.max(delay, asked);
        }
        if (this.now() + delay >= deadline) throw exhausted(`retry would exceed the ${DEADLINE_MS / 1000}s deadline`);
        await this.sleep(delay);
      }
    }
  }

  private once(path: string, what: string, budgetMs: number): Promise<Record<string, unknown>> {
    if (budgetMs <= 0) {
      return Promise.reject(new PaperError('MARKET_DATA_UNAVAILABLE', `public ${what} request exceeded the ${DEADLINE_MS / 1000}s deadline`, RETRY_HINT));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let req: ClientRequest | undefined;
      let res: IncomingMessage | undefined;
      const finish = (err: Error | null, value?: Record<string, unknown>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        res?.destroy();
        req?.destroy();
        if (err) reject(err);
        else resolve(value as Record<string, unknown>);
      };
      const fatal = (code: string, message: string) => finish(new PaperError(code, `public ${what} ${message}`, RETRY_HINT));
      // One deadline covers DNS, connect, TLS, headers and the full body.
      const timer = setTimeout(
        () => fatal('MARKET_DATA_UNAVAILABLE', `request exceeded the ${DEADLINE_MS / 1000}s deadline`),
        budgetMs,
      );

      const onResponse = (response: IncomingMessage) => {
        res = response;
        if (settled) return;
        const status = response.statusCode ?? 0;
        const header = (name: string) => {
          const v = response.headers[name];
          return typeof v === 'string' ? v : undefined;
        };
        if (status >= 300 && status < 400) return fatal('MARKET_DATA_REDIRECT', `request was redirected (HTTP ${status}); refusing`);
        if (TRANSIENT_STATUSES.has(status)) {
          return finish(new TransientFailure(`HTTP ${status}`, header('retry-after'), status === 429));
        }
        // A product 404 is a definitive not-found only when the body says so; anything else is a rejection.
        const notFoundProbe = status === 404 && what === 'product';
        const rejected = () => fatal('MARKET_DATA_REJECTED', `request was rejected (HTTP ${status})`);
        if (status !== 200 && !notFoundProbe) return rejected();
        const type = (header('content-type') ?? '').toLowerCase();
        if (!/^application\/json\s*(?:;|$)/.test(type)) return notFoundProbe ? rejected() : fatal('MARKET_DATA_INVALID', 'response is not JSON');
        const encoding = (header('content-encoding') ?? 'identity').trim().toLowerCase();
        if (encoding !== 'identity' && encoding !== '') return fatal('MARKET_DATA_INVALID', 'response is encoded');
        const length = header('content-length');
        if (length !== undefined && (!/^\d{1,10}$/.test(length.trim()) || Number(length) > MAX_RESPONSE_BYTES)) {
          return fatal('MARKET_DATA_TOO_LARGE', `response exceeds ${MAX_RESPONSE_BYTES} bytes`);
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) return fatal('MARKET_DATA_TOO_LARGE', `response exceeds ${MAX_RESPONSE_BYTES} bytes`);
          chunks.push(chunk);
        });
        response.on('end', () => {
          let value: unknown;
          try {
            value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
          } catch {
            if (notFoundProbe) return rejected();
            return finish(invalidData(what, 'is not valid UTF-8 JSON'));
          }
          if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            return finish(invalidData(what, 'is not a JSON object'));
          }
          if (notFoundProbe) {
            if ((value as Record<string, unknown>).error !== 'NOT_FOUND') return rejected();
            return finish(new PaperError('PRODUCT_NOT_FOUND', 'public product was not found (HTTP 404 NOT_FOUND)', 'Coinbase lists no crypto product with this product_id. Check the product_id; equities need an external quote.'));
          }
          finish(null, value as Record<string, unknown>);
        });
        response.on('error', () => finish(new TransientFailure('connection lost')));
        response.on('aborted', () => finish(new TransientFailure('connection lost')));
        response.on('close', () => finish(new TransientFailure('connection closed early')));
      };

      this.httpAttempts += 1;
      try {
        req = this.request({
          protocol: 'https:',
          hostname: HOST,
          port: 443,
          path: BASE_PATH + path,
          method: 'GET',
          headers: { ...HEADERS },
          agent: false,
          rejectUnauthorized: true,
        }, onResponse);
      } catch {
        return fatal('MARKET_DATA_FAILED', 'request could not be started');
      }
      req.on('error', (err: NodeJS.ErrnoException) => {
        if (typeof err.code === 'string' && TRANSIENT_CODES.has(err.code)) finish(new TransientFailure('network error'));
        else fatal('MARKET_DATA_FAILED', 'request failed (TLS or protocol error)');
      });
      req.end();
    });
  }
}

// ------------------------------------------------------- command data session

/** Per-command simulator work bounds (not trading quotas or account limits). */
export const REQUEST_BUDGET = Object.freeze({
  max_product_requests: 1,
  max_book_requests: 100,
  max_candle_requests: 32,
  max_total_requests: 133,
  max_candles_per_request: MAX_CANDLES,
});

export const CANDLE_SECONDS: Readonly<Record<CandleGranularity, number>> = Object.freeze({
  ONE_MINUTE: 60,
  FIVE_MINUTE: 300,
  ONE_HOUR: 3600,
  ONE_DAY: 86400,
});

function budgetExceeded(kind: string, required: number, maximum: number): PaperError {
  return new PaperError(
    'PAPER_REQUEST_BUDGET_EXCEEDED',
    `Paper command requires ${required} ${kind} requests; the per-command work budget is ${maximum}.`,
    'No candle fills were guessed. Reduce the requested performance period or inspect/cancel unneeded open orders; retry without switching to live trading.',
  );
}

function windowError(message: string): PaperError {
  return new PaperError('INVALID_REQUEST', `candle window ${message}`);
}

/** Validates one aligned candle page response; sorted ascending. Missing buckets are allowed here; callers decide. */
export function validateCandleWindow(raw: unknown, request: CandleWindowRequest): Candle[] {
  const interval = CANDLE_SECONDS[request.granularity];
  const response = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  const rows = response && Object.hasOwn(response, 'candles') ? response.candles : undefined;
  if (!Array.isArray(rows) || rows.length > MAX_CANDLES) throw invalidData('candles', `must contain at most ${MAX_CANDLES} records`);
  const bad = (detail: string) => invalidData('candles', detail);
  const seen = new Set<number>();
  const candles = rows.map((row: unknown): Candle => {
    if (row === null || typeof row !== 'object' || Array.isArray(row) || Object.getPrototypeOf(row) !== Object.prototype) throw bad('contains an invalid OHLCV record');
    const r = row as Record<string, unknown>;
    const start = typeof r.start === 'string' && UNIX_SECONDS.test(r.start) ? Number(r.start) : NaN;
    if (!Number.isSafeInteger(start) || start % interval !== 0) throw bad('contains an unaligned or invalid candle start');
    if (start < request.start || start + interval > request.end) throw bad('contains a candle outside the requested window');
    if (seen.has(start)) throw bad('contains duplicate candle starts');
    seen.add(start);
    const values: Record<string, bigint> = {};
    for (const key of ['low', 'high', 'open', 'close', 'volume']) {
      const v = Object.hasOwn(r, key) ? r[key] : undefined;
      if (typeof v !== 'string' || !DECIMAL.test(v)) throw bad('contains an invalid OHLCV record');
      values[key] = parseDecimalToBigInt(v, 18);
    }
    const { low, high, open, close } = values;
    if (low <= 0n || low > open || low > close || open > high || close > high) throw bad('contains an inconsistent OHLC record');
    return { start: String(start), low: r.low as string, high: r.high as string, open: r.open as string, close: r.close as string, volume: r.volume as string };
  });
  return candles.sort((a, b) => Number(a.start) - Number(b.start));
}

function checkWindowRequest(request: CandleWindowRequest, nowMs: number): number {
  if (request === null || typeof request !== 'object') throw windowError('request must be an object');
  productId(request.product_id);
  const interval = Object.hasOwn(CANDLE_SECONDS, request.granularity) ? CANDLE_SECONDS[request.granularity] : undefined;
  if (interval === undefined) throw windowError('granularity must be ONE_MINUTE, FIVE_MINUTE, ONE_HOUR or ONE_DAY');
  const { start, end } = request;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) throw windowError('needs integer UNIX seconds with end after start');
  if (start % interval !== 0 || end % interval !== 0) throw windowError('start and end must be aligned to the granularity');
  if ((end - start) / interval > MAX_CANDLES) throw windowError(`exceeds ${MAX_CANDLES} candles`);
  if (end > Math.floor(nowMs / 1000)) throw windowError('must end at or before the command time (completed candles only)');
  return interval;
}

/**
 * One command's market-data session: caches identical calls (including failures),
 * counts logical source calls against the simulator work budget and validates
 * candle pages at this boundary, also for injected sources.
 */
export function createCommandMarketData(source: MarketData, options: { provider: string; now: () => number }): CommandMarketData {
  const counts = { product: 0, book: 0, candles: 0 };
  let hits = 0;
  const cache = new Map<string, Promise<unknown>>();
  const limits = { product: REQUEST_BUDGET.max_product_requests, book: REQUEST_BUDGET.max_book_requests, candles: REQUEST_BUDGET.max_candle_requests };
  const call = <T>(kind: 'product' | 'book' | 'candles', key: string, run: () => Promise<T>): Promise<T> => {
    const cached = cache.get(key);
    if (cached) {
      hits += 1;
      return cached as Promise<T>;
    }
    const total = counts.product + counts.book + counts.candles;
    if (counts[kind] + 1 > limits[kind]) return Promise.reject(budgetExceeded(kind === 'candles' ? 'candle' : kind, counts[kind] + 1, limits[kind]));
    if (total + 1 > REQUEST_BUDGET.max_total_requests) return Promise.reject(budgetExceeded('total', total + 1, REQUEST_BUDGET.max_total_requests));
    counts[kind] += 1;
    let promise: Promise<T>;
    try {
      promise = Promise.resolve(run());
    } catch (err) {
      promise = Promise.reject(err);
    }
    promise.catch(() => undefined);
    cache.set(key, promise);
    return promise;
  };
  const session: CommandMarketData = {
    provider: options.provider,
    product: (id) => call('product', `product\u0000${id}`, () => source.product(id)),
    book: (id) => call('book', `book\u0000${id}`, () => source.book(id)),
    candles: (id, start, end, granularity) => call('candles', `candles\u0000${id}\u0000${start}\u0000${end}\u0000${granularity}`, () => source.candles(id, start, end, granularity)),
    async candleWindow(request: CandleWindowRequest): Promise<CandleWindow> {
      checkWindowRequest(request, options.now());
      const raw = await session.candles(request.product_id, String(request.start), String(request.end - 1), request.granularity);
      const candles = validateCandleWindow(raw, request);
      return { request: { ...request }, candles, provider: options.provider, fetched_at: new Date(options.now()).toISOString() };
    },
    stats(): RequestStats {
      const attempts = (source as { httpAttempts?: unknown }).httpAttempts;
      return {
        product: counts.product,
        book: counts.book,
        candles: counts.candles,
        total: counts.product + counts.book + counts.candles,
        cache_hits: hits,
        http_attempts: typeof attempts === 'number' && Number.isSafeInteger(attempts) ? attempts : null,
      };
    },
  };
  return session;
}
