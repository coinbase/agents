import { describe, it, mock, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { RequestOptions } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { PublicMarketData } from './market-data.ts';
import type { HttpsRequest } from './market-data.ts';
import { PaperError } from './types.ts';

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);

class FakeRequest extends EventEmitter {
  destroyed = false;
  ended = false;
  end() { this.ended = true; return this; }
  destroy() { this.destroyed = true; return this; }
}

type Script = (req: FakeRequest, respond: (res: PassThrough) => void) => void;

function response(status: number, body?: string | Buffer, headers: Record<string, string> = { 'content-type': 'application/json' }): PassThrough {
  const res = new PassThrough();
  Object.assign(res, { statusCode: status, headers });
  if (body !== undefined) res.end(body);
  return res;
}

function json(value: unknown, status = 200): Script {
  return (_req, respond) => respond(response(status, JSON.stringify(value)));
}

function harness(...scripts: Script[]) {
  const calls: RequestOptions[] = [];
  const requests: FakeRequest[] = [];
  const sleeps: number[] = [];
  const request: HttpsRequest = (options, onResponse) => {
    calls.push(options);
    const req = new FakeRequest();
    requests.push(req);
    const script = scripts.shift();
    if (!script) throw new Error('unexpected request');
    setImmediate(() => script(req, (res) => onResponse(res as unknown as IncomingMessage)));
    return req as unknown as ClientRequest;
  };
  const md = new PublicMarketData({ request, now: () => NOW, sleep: async (ms) => { sleeps.push(ms); } });
  return { md, calls, requests, sleeps };
}

async function rejectsWith(promise: Promise<unknown>, code: string, forbidden: string[] = []): Promise<PaperError> {
  const err = await promise.then(() => assert.fail('expected rejection'), (e: unknown) => e);
  assert.ok(err instanceof PaperError, `expected PaperError, got ${String(err)}`);
  assert.equal(err.code, code, err.message);
  for (const text of forbidden) assert.ok(!err.message.includes(text), `error leaked ${text}`);
  return err;
}

const candle = (start: number, extra: Record<string, unknown> = {}) => ({
  start: String(start), low: '99.5', high: '101', open: '100', close: '100.25', volume: '12.000000000000000001', ...extra,
});

describe('PublicMarketData requests', () => {
  it('issues only fixed anonymous HTTPS GETs to the public market paths', async () => {
    const { md, calls, requests } = harness(json({ product_id: 'BTC-USD' }), json({ pricebook: {} }), json({ candles: [] }));
    assert.deepEqual(await md.product('BTC-USD'), { product_id: 'BTC-USD' });
    assert.deepEqual(await md.book('BTC-USD'), { pricebook: {} });
    assert.deepEqual(await md.candles('BTC-USD', '1760097600', '1760101200', 'ONE_HOUR'), { candles: [] });
    assert.deepEqual(calls.map((c) => c.path), [
      '/api/v3/brokerage/market/products/BTC-USD',
      '/api/v3/brokerage/market/product_book?product_id=BTC-USD&limit=100',
      '/api/v3/brokerage/market/products/BTC-USD/candles?start=1760097600&end=1760101200&granularity=ONE_HOUR',
    ]);
    for (const c of calls) {
      assert.deepEqual(
        { protocol: c.protocol, hostname: c.hostname, port: c.port, method: c.method, agent: c.agent, rejectUnauthorized: c.rejectUnauthorized },
        { protocol: 'https:', hostname: 'api.coinbase.com', port: 443, method: 'GET', agent: false, rejectUnauthorized: true },
      );
      assert.deepEqual(c.headers, { Accept: 'application/json', 'Accept-Encoding': 'identity', 'User-Agent': 'coinbase-cli-paper' });
      assert.equal(Object.keys(c).sort().join(','), 'agent,headers,hostname,method,path,port,protocol,rejectUnauthorized');
    }
    assert.ok(requests.every((r) => r.ended && r.destroyed));
  });

  it('rejects malformed product ids before any request', async () => {
    const { md, calls } = harness();
    for (const id of ['btc-usd', 'BTC-USD/../x', 'BTC-USD?x=1', 'BTCUSD', '', 'BTC-USD ', 'A-B-C']) {
      await rejectsWith(md.product(id), 'INVALID_REQUEST');
      await rejectsWith(md.book(id), 'INVALID_REQUEST');
    }
    assert.equal(calls.length, 0);
  });

  it('refuses redirects and does not retry rejections', async () => {
    const redirect = harness((_r, respond) => respond(response(302, '', { location: 'https://evil.example/' })));
    await rejectsWith(redirect.md.product('BTC-USD'), 'MARKET_DATA_REDIRECT', ['evil']);
    assert.equal(redirect.calls.length, 1);
    const missing = harness((_r, respond) => respond(response(404, '{"secret":"body"}')));
    await rejectsWith(missing.md.product('NOPE-USD'), 'MARKET_DATA_REJECTED', ['secret']);
    assert.equal(missing.calls.length, 1);
  });

  it('reports PRODUCT_NOT_FOUND only for a product 404 whose JSON body says NOT_FOUND', async () => {
    const body = '{"error":"NOT_FOUND","message":"Product AAPL-USD not supported"}';
    const found = harness((_r, respond) => respond(response(404, body)));
    await rejectsWith(found.md.product('AAPL-USD'), 'PRODUCT_NOT_FOUND');
    assert.equal(found.calls.length, 1, 'a definitive not-found is not retried');
    const cases: Array<[string, Script]> = [
      ['book 404', (_r, respond) => respond(response(404, body))],
      ['other error', (_r, respond) => respond(response(404, '{"error":"INVALID_ARGUMENT"}'))],
      ['html', (_r, respond) => respond(response(404, '<html>NOT_FOUND</html>', { 'content-type': 'text/html' }))],
      ['not json', (_r, respond) => respond(response(404, 'NOT_FOUND'))],
      ['array', (_r, respond) => respond(response(404, '["NOT_FOUND"]'))],
      ['400', (_r, respond) => respond(response(400, body))],
    ];
    for (const [label, script] of cases) {
      const h = harness(script);
      const call = label === 'book 404' ? h.md.book('AAPL-USD') : h.md.product('AAPL-USD');
      await rejectsWith(call, label === 'array' ? 'MARKET_DATA_INVALID' : 'MARKET_DATA_REJECTED');
    }
    const busy = harness((_r, respond) => respond(response(429, body)), (_r, respond) => respond(response(503, body)), (_r, respond) => respond(response(500, body)));
    await rejectsWith(busy.md.product('AAPL-USD'), 'MARKET_DATA_UNAVAILABLE');
    assert.equal(busy.calls.length, 3, 'transient failures are retried, never treated as not-found');
  });
});

describe('PublicMarketData retries', () => {
  it('retries transient statuses with bounded backoff, then fails', async () => {
    const fail = (_r: FakeRequest, respond: (res: PassThrough) => void) => respond(response(503, 'down'));
    const { md, calls, sleeps } = harness(fail, fail, fail);
    const err = await rejectsWith(md.book('BTC-USD'), 'MARKET_DATA_UNAVAILABLE');
    assert.match(err.message, /3 attempts/);
    assert.equal(calls.length, 3);
    assert.deepEqual(sleeps, [250, 500]);
  });

  it('honors a short Retry-After and succeeds', async () => {
    const { md, sleeps } = harness(
      (_r, respond) => respond(response(429, '', { 'retry-after': '2' })),
      json({ ok: true }),
    );
    assert.deepEqual(await md.product('BTC-USD'), { ok: true });
    assert.deepEqual(sleeps, [2000]);
  });

  it('honors an HTTP-date Retry-After', async () => {
    const at = new Date(NOW + 3000).toUTCString();
    const { md, sleeps } = harness((_r, respond) => respond(response(503, '', { 'retry-after': at })), json({ ok: true }));
    await md.product('BTC-USD');
    assert.deepEqual(sleeps, [3000]);
  });

  it('fails instead of waiting on a long or unreadable Retry-After', async () => {
    for (const value of ['11', '99999999999', 'soon', '-1', '1.5']) {
      const { md, calls, sleeps } = harness((_r, respond) => respond(response(429, '', { 'retry-after': value })));
      await rejectsWith(md.product('BTC-USD'), 'MARKET_DATA_RATE_LIMITED');
      assert.equal(calls.length, 1, value);
      assert.deepEqual(sleeps, []);
    }
  });

  it('retries connection resets but not TLS failures, without leaking socket details', async () => {
    const reset = harness((req) => req.emit('error', Object.assign(new Error('connect 10.0.0.1 reset'), { code: 'ECONNRESET' })), json({ ok: 1 }));
    assert.deepEqual(await reset.md.product('BTC-USD'), { ok: 1 });
    assert.equal(reset.calls.length, 2);
    const tls = harness((req) => req.emit('error', Object.assign(new Error('cert for 10.0.0.1 expired'), { code: 'CERT_HAS_EXPIRED' })));
    await rejectsWith(tls.md.product('BTC-USD'), 'MARKET_DATA_FAILED', ['10.0.0.1', 'expired']);
    assert.equal(tls.calls.length, 1);
    const unknown = harness((req) => req.emit('error', new Error('weird')));
    await rejectsWith(unknown.md.product('BTC-USD'), 'MARKET_DATA_FAILED', ['weird']);
  });

  it('treats a body cut off mid-stream as transient', async () => {
    const cut: Script = (_r, respond) => {
      const res = response(200);
      respond(res);
      res.write('{"pricebook":');
      res.destroy();
    };
    const { md, calls } = harness(cut, cut, cut);
    await rejectsWith(md.book('BTC-USD'), 'MARKET_DATA_UNAVAILABLE', ['pricebook']);
    assert.equal(calls.length, 3);
  });

  it('fails synchronously thrown request construction closed', async () => {
    const md = new PublicMarketData({ request: () => { throw new Error('boom'); }, now: () => NOW });
    await rejectsWith(md.product('BTC-USD'), 'MARKET_DATA_FAILED', ['boom']);
  });
});

describe('PublicMarketData deadline', () => {
  afterEach(() => mock.timers.reset());

  it('times out a request that never connects or responds', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const { md, requests } = harness(() => {});
    const pending = md.product('BTC-USD');
    await new Promise((r) => setImmediate(r));
    mock.timers.tick(14_999);
    assert.equal(requests[0].destroyed, false);
    mock.timers.tick(1);
    await rejectsWith(pending, 'MARKET_DATA_UNAVAILABLE');
    assert.equal(requests[0].destroyed, true);
    assert.equal(requests.length, 1);
  });

  it('times out a body that stalls after headers', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    let stalled: PassThrough | undefined;
    const { md } = harness((_r, respond) => {
      stalled = response(200);
      respond(stalled);
      stalled.write('{"a":');
    });
    const pending = md.product('BTC-USD');
    await new Promise((r) => setImmediate(r));
    mock.timers.tick(15_000);
    await rejectsWith(pending, 'MARKET_DATA_UNAVAILABLE');
    assert.equal(stalled?.destroyed, true);
  });

  it('does not sleep past the overall deadline', async () => {
    let clock = NOW;
    const scripts: Script[] = [(_r, respond) => { clock += 9_000; respond(response(503, '', { 'retry-after': '7' })); }];
    const sleeps: number[] = [];
    const md = new PublicMarketData({
      request: (_o, onResponse) => {
        const req = new FakeRequest();
        const script = scripts.shift()!;
        setImmediate(() => script(req, (res) => onResponse(res as unknown as IncomingMessage)));
        return req as unknown as ClientRequest;
      },
      now: () => clock,
      sleep: async (ms) => { sleeps.push(ms); },
    });
    const err = await rejectsWith(md.product('BTC-USD'), 'MARKET_DATA_UNAVAILABLE');
    assert.match(err.message, /deadline/);
    assert.deepEqual(sleeps, []);
  });
});

describe('PublicMarketData response content', () => {
  const cases: Array<[string, Script, string]> = [
    ['html', (_r, respond) => respond(response(200, '<html>', { 'content-type': 'text/html' })), 'MARKET_DATA_INVALID'],
    ['missing content-type', (_r, respond) => respond(response(200, '{}', {})), 'MARKET_DATA_INVALID'],
    ['gzip', (_r, respond) => respond(response(200, '{}', { 'content-type': 'application/json', 'content-encoding': 'gzip' })), 'MARKET_DATA_INVALID'],
    ['invalid json', (_r, respond) => respond(response(200, '{"a":')), 'MARKET_DATA_INVALID'],
    ['invalid utf-8', (_r, respond) => respond(response(200, Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]))), 'MARKET_DATA_INVALID'],
    ['array', json([1, 2]), 'MARKET_DATA_INVALID'],
    ['null', (_r, respond) => respond(response(200, 'null')), 'MARKET_DATA_INVALID'],
    ['declared too large', (_r, respond) => respond(response(200, '{}', { 'content-type': 'application/json', 'content-length': '2000001' })), 'MARKET_DATA_TOO_LARGE'],
    ['bad content-length', (_r, respond) => respond(response(200, '{}', { 'content-type': 'application/json', 'content-length': '1e3' })), 'MARKET_DATA_TOO_LARGE'],
  ];
  for (const [name, script, code] of cases) {
    it(`rejects ${name} without retrying`, async () => {
      const { md, calls } = harness(script);
      await rejectsWith(md.product('BTC-USD'), code);
      assert.equal(calls.length, 1);
    });
  }

  it('stops reading a streamed body over 2MB', async () => {
    let res: PassThrough | undefined;
    const { md } = harness((_r, respond) => {
      res = response(200);
      respond(res);
      res.write(Buffer.alloc(1_000_000, 0x20));
      res.write(Buffer.alloc(1_000_001, 0x20));
    });
    await rejectsWith(md.product('BTC-USD'), 'MARKET_DATA_TOO_LARGE');
    assert.equal(res?.destroyed, true);
  });

  it('accepts a body at exactly 2MB', async () => {
    const body = '{}'.padEnd(2_000_000, ' ');
    const { md } = harness((_r, respond) => respond(response(200, body, { 'content-type': 'application/json; charset=utf-8', 'content-length': '2000000' })));
    assert.deepEqual(await md.product('BTC-USD'), {});
  });

  it('passes decimal-string amounts through unchanged for the engine', async () => {
    const { md } = harness((_r, respond) => respond(response(200, '{"pricebook":{"bids":[{"price":"86800.010000000000000001","size":"0.1"}]}}')));
    assert.deepEqual(await md.book('BTC-USD'), { pricebook: { bids: [{ price: '86800.010000000000000001', size: '0.1' }] } });
  });
});

describe('PublicMarketData candles', () => {
  const start = 1760097600;

  it('validates arguments before any request', async () => {
    const { md, calls } = harness();
    const bad: Array<[string, string, string]> = [
      ['x', '1760101200', 'ONE_HOUR'],
      ['01760097600', '1760101200', 'ONE_HOUR'],
      ['-1', '1760101200', 'ONE_HOUR'],
      ['1760097600.0', '1760101200', 'ONE_HOUR'],
      ['100000000000', '100000000001', 'ONE_HOUR'],
      ['1760101200', '1760101200', 'ONE_HOUR'],
      ['1760101200', '1760097600', 'ONE_HOUR'],
      ['1760097600', '1760101200', 'HOURLY'],
      ['1760097600', '1760101200', 'constructor'],
      ['1760097600', '1760101200', '__proto__'],
      [String(start), String(start + 351 * 60), 'ONE_MINUTE'],
      [String(start), String(start + 350 * 60 + 1), 'ONE_MINUTE'],
      [String(NOW / 1000), String(NOW / 1000 + 86_401), 'ONE_DAY'],
    ];
    for (const [s, e, g] of bad) await rejectsWith(md.candles('BTC-USD', s, e, g), 'INVALID_REQUEST');
    await rejectsWith(md.candles('btc', String(start), String(start + 60), 'ONE_MINUTE'), 'INVALID_REQUEST');
    assert.equal(calls.length, 0);
  });

  it('accepts exactly 350 intervals and 350 records, whitelisting OHLCV fields', async () => {
    const rows = Array.from({ length: 350 }, (_, i) => candle(start + i * 60, { extra: 'drop me', note: { x: 1 } }));
    const { md } = harness(json({ candles: rows, other: 'ignored' }));
    const result = await md.candles('BTC-USD', String(start), String(start + 350 * 60), 'ONE_MINUTE');
    assert.equal(result.candles.length, 350);
    assert.deepEqual(result.candles[0], {
      start: String(start), low: '99.5', high: '101', open: '100', close: '100.25', volume: '12.000000000000000001',
    });
    assert.deepEqual(Object.keys(result), ['candles']);
  });

  it('accepts a bucket that starts before an unaligned start', async () => {
    const { md } = harness(json({ candles: [candle(start)] }));
    const result = await md.candles('BTC-USD', String(start + 1800), String(start + 7200), 'ONE_HOUR');
    assert.equal(result.candles[0].start, String(start));
  });

  const invalid: Array<[string, unknown]> = [
    ['missing array', undefined],
    ['object', { start: '1' }],
    ['351 records', Array.from({ length: 351 }, (_, i) => candle(start + i * 60))],
    ['json number price', [candle(start, { low: 99.5 })]],
    ['json number start', [candle(start, { start })]],
    ['exponent', [candle(start, { high: '1e3' })]],
    ['negative', [candle(start, { low: '-1' })]],
    ['zero price', [candle(start, { low: '0', open: '0' })]],
    ['too many decimals', [candle(start, { volume: '1.0000000000000000001' })]],
    ['too many integer digits', [candle(start, { high: '1000000000000000' })]],
    ['missing field', [{ start: String(start), low: '1', high: '2', open: '1', close: '1' }]],
    ['high below open', [candle(start, { high: '99.9' })]],
    ['close below low', [candle(start, { close: '99' })]],
    ['duplicate start', [candle(start), candle(start)]],
    ['start before range', [candle(start - 60)]],
    ['start after end', [candle(start + 3660)]],
    ['null record', [null]],
    ['array record', [[start, 1, 2, 1, 1, 1]]],
  ];
  for (const [name, rows] of invalid) {
    it(`rejects candles with ${name}`, async () => {
      const { md } = harness(json(rows === undefined ? {} : { candles: rows }));
      await rejectsWith(md.candles('BTC-USD', String(start), String(start + 3600), 'ONE_MINUTE'), 'MARKET_DATA_INVALID');
    });
  }
});
