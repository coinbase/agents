import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { registerHooks } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PaperError, type Account, type FillResult, type Intent, type PaperPaths, type Position } from './types.ts';

// Storage is tested against a stand-in for the pure engine (owned and tested
// separately), so these tests exercise transactions and files, not economics.
const ENGINE_URL = 'paper-test:engine';
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === './engine.ts' && context.parentURL?.endsWith('/paper/store.ts')) return { url: ENGINE_URL, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url !== ENGINE_URL) return next(url, context);
    // The real order model, with the legacy market simulators replaced by the stand-in.
    const real = new URL('./engine.ts', import.meta.url).href;
    const stubbed = ['simulate', 'checkFresh', 'simulateExternal', 'checkExternalFresh', 'validateInitialAccount'];
    const source = [
      `export * from ${JSON.stringify(real)};`,
      ...stubbed.map((name) => `export const ${name} = (...a) => globalThis.paperTestEngine.${name}(...a);`),
    ].join('\n');
    return { format: 'module', source, shortCircuit: true };
  },
});

interface TestBook {
  price: string;
  time: string;
}

interface Controls {
  crashOnFresh?: boolean;
  simulateCalls: number;
}

const controls: Controls = { simulateCalls: 0 };

(globalThis as Record<string, unknown>).paperTestEngine = {
  validateInitialAccount(cash: string, currency: string, feeBps: string) {
    if (!/^[1-9][0-9]*$/.test(cash)) throw new PaperError('INVALID_ARGUMENT', 'bad cash');
    return { cash, currency, fee_bps: feeBps, maker_fee_bps: feeBps, taker_fee_bps: feeBps };
  },
  checkFresh(snapshotTime: string, now: number) {
    if (controls.crashOnFresh) process.exit(9);
    if (Date.parse(snapshotTime) + 60_000 < now) throw new PaperError('STALE_BOOK', 'stale');
  },
  checkExternalFresh(asOf: string, now: number) {
    if (Date.parse(asOf) + 86_400_000 < now) throw new PaperError('EXTERNAL_QUOTE_STALE', 'stale quote');
    return Math.trunc((now - Date.parse(asOf)) / 1000);
  },
  simulateExternal(account: Account, position: Position | null, intent: Intent, _metadata: unknown, now: number): FillResult {
    const engine = (globalThis as unknown as { paperTestEngine: { simulate: (...a: unknown[]) => FillResult; checkExternalFresh: (a: string, n: number) => number } }).paperTestEngine;
    const age = engine.checkExternalFresh(intent.price_as_of as string, now);
    const fill = engine.simulate(account, position, intent, {}, { price: intent.reference_price, time: intent.price_as_of }, now);
    return {
      ...fill,
      position: { ...fill.position, asset_class: 'EQUITY' },
      receipt: {
        ...fill.receipt,
        asset_class: 'EQUITY',
        price_verification: 'UNVERIFIED_EXTERNAL_QUOTE',
        price_age_seconds: age,
        source: { provider: 'external', url: intent.price_source, as_of: intent.price_as_of, reference_price: intent.reference_price, slippage_bps: '10', metadata: 'assumed' },
      },
    };
  },
  simulate(account: Account, position: Position | null, intent: Intent, _product: unknown, book: TestBook, now: number): FillResult {
    controls.simulateCalls += 1;
    const size = BigInt(intent.size);
    const price = BigInt(book.price);
    const held = BigInt(position?.quantity ?? '0');
    const basis = BigInt(position?.cost_basis ?? '0');
    let cash = BigInt(account.cash);
    let quantity = held;
    let costBasis = basis;
    let realized = BigInt(account.realized_pnl);
    if (intent.side === 'BUY') {
      if (size * price > cash) throw new PaperError('INSUFFICIENT_FUNDS', 'not enough cash');
      cash -= size * price;
      quantity += size;
      costBasis += size * price;
    } else {
      if (size > held) throw new PaperError('INSUFFICIENT_POSITION', 'not enough base');
      const removed = (basis * size) / held;
      cash += size * price;
      realized += size * price - removed;
      quantity -= size;
      costBasis -= removed;
    }
    const nextPosition = { product_id: intent.product_id, quantity: String(quantity), cost_basis: String(costBasis), base_increment: '1', quote_increment: '0.01' };
    return {
      cash: String(cash),
      realized_pnl: String(realized),
      position: nextPosition,
      receipt: {
        mode: 'PAPER',
        ok: true,
        status: 'FILLED',
        request_id: intent.request_id,
        account_id: intent.account_id,
        product_id: intent.product_id,
        side: intent.side,
        order_type: 'MARKET',
        requested: { [intent.size_type]: intent.size },
        base_size: intent.size,
        notional: String(size * price),
        fee: '0',
        total: String(size * price),
        average_price: book.price,
        realized_pnl: null,
        cash: String(cash),
        position: { quantity: nextPosition.quantity, cost_basis: nextPosition.cost_basis },
        currency: account.currency,
        snapshot_time: book.time,
        filled_at: new Date(now).toISOString(),
        fills: [{ price: book.price, size: intent.size }],
        source: { test: true },
        assumptions: { nested: { order: [1, 2] } },
        notice: 'test',
      },
    };
  },
};

const store = await import('./store.ts');
const THIS_FILE = fileURLToPath(import.meta.url);

function tempRoot(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'paper-store-')));
}

function freshPaths(): PaperPaths {
  return store.resolvePaths(path.join(tempRoot(), 'data'), {}, '/nonexistent');
}

function book(now = Date.now(), price = '100'): TestBook {
  return { price, time: new Date(now).toISOString() };
}

function intent(accountId: string, side: 'BUY' | 'SELL' = 'BUY', size = '1', requestId: string = randomUUID()): Intent {
  return { request_id: requestId, account_id: accountId, product_id: 'BTC-USD', side, size_type: 'base_size', size };
}

function equityIntent(accountId: string, side: 'BUY' | 'SELL' = 'BUY', size = '1', asOf = new Date().toISOString().replace(/\.\d+Z$/, 'Z'), requestId: string = randomUUID()): Intent {
  return { ...intent(accountId, side, size, requestId), product_id: 'BRK.B-USD', reference_price: '100', price_source: 'https://example.com/quote', price_as_of: asOf };
}

const ASSUMED = { source: 'assumed' as const, base_increment: '0.00001', quote_increment: '0.01', whole_shares: false };

async function rawDb(file: string) {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(file);
}

async function initialized(cash = '1000'): Promise<{ paths: PaperPaths; accountId: string }> {
  const paths = freshPaths();
  const result = await store.initAccount(paths, { cash, currency: 'USD', fee_bps: '10' });
  return { paths, accountId: String(result.account_id) };
}

function digest(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function mode(file: string): number {
  return fs.statSync(file).mode & 0o777;
}

async function rejects(promise: Promise<unknown> | (() => unknown), code: string): Promise<void> {
  await assert.rejects(async () => (typeof promise === 'function' ? promise() : promise), (err: unknown) => err instanceof PaperError && err.code === code);
}

async function makePrototype(dir: string, accountId: string): Promise<{ state: string; profile: string }> {
  const { DatabaseSync } = await import('node:sqlite');
  fs.mkdirSync(path.join(dir, 'requests'), { recursive: true });
  const state = path.join(dir, 'account.sqlite3');
  const db = new DatabaseSync(state);
  db.exec(`PRAGMA application_id = ${0x50415052}; PRAGMA user_version = 1;
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta VALUES ('account_id', '${accountId}'), ('schema_version', '1');`);
  db.close();
  const profile = path.join(dir, 'profile.json');
  fs.writeFileSync(profile, JSON.stringify({ version: 1, state, account_id: accountId }));
  return { state, profile };
}

interface ChildResult {
  code: number | null;
  stdout: string;
}

function child(job: Record<string, unknown>): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', THIS_FILE], {
      env: { ...process.env, PAPER_STORE_CHILD: JSON.stringify(job), NODE_TEST_CONTEXT: '' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let stdout = '';
    proc.stdout.on('data', (chunk) => (stdout += chunk));
    proc.on('error', reject);
    proc.on('exit', (code) => resolve({ code, stdout }));
  });
}

async function runChild(job: { paths: PaperPaths; intent: Intent; crashOnFresh?: boolean; startAt: number }): Promise<void> {
  const account = await store.openAccount(job.paths);
  try {
    while (Date.now() < job.startAt) await new Promise((r) => setTimeout(r, 5));
    controls.crashOnFresh = job.crashOnFresh;
    const replay = account.reserve(job.intent);
    const receipt = replay ?? account.commit(job.intent, {}, book(), Date.now);
    process.stdout.write(JSON.stringify({ ok: true, receipt }));
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, code: (err as PaperError).code }));
  } finally {
    account.close();
  }
}

if (process.env.PAPER_STORE_CHILD) {
  await runChild(JSON.parse(process.env.PAPER_STORE_CHILD));
} else {
  registerTests();
}

function registerTests(): void {
  test('resolvePaths uses --data-dir, then COINBASE_PAPER_HOME, then absolute XDG_DATA_HOME, then home', () => {
    assert.equal(store.resolvePaths('/a/b/', { COINBASE_PAPER_HOME: '/c' }, '/h').state, '/a/b/account.sqlite3');
    assert.equal(store.resolvePaths(undefined, { COINBASE_PAPER_HOME: '/c', XDG_DATA_HOME: '/x' }, '/h').profile, '/c/profile.json');
    assert.equal(store.resolvePaths(undefined, { XDG_DATA_HOME: '/x' }, '/h').dataDir, '/x/coinbase-paper');
    assert.equal(store.resolvePaths(undefined, { XDG_DATA_HOME: 'rel' }, '/h').dataDir, '/h/.local/share/coinbase-paper');
    assert.throws(() => store.resolvePaths('rel'), (err: PaperError) => err.code === 'INVALID_PATH');
    assert.throws(() => store.resolvePaths(undefined, { COINBASE_PAPER_HOME: 'rel' }, '/h'), (err: PaperError) => err.code === 'INVALID_PATH');
    assert.throws(() => store.resolvePaths(undefined, {}, ''), (err: PaperError) => err.code === 'HOME_UNAVAILABLE');
  });

  test('unsupportedRuntime accepts only Node versions with unflagged node:sqlite', () => {
    for (const version of ['22.13.0', '22.23.2', '23.4.0', '24.12.0', '25.0.0']) assert.equal(store.unsupportedRuntime(version), null, version);
    for (const version of ['20.18.0', '22.6.0', '22.12.9', '23.3.0']) assert.match(String(store.unsupportedRuntime(version)), /Node 24 LTS/, version);
  });

  test('initAccount creates private bound state and never reseeds', async () => {
    const { paths, accountId } = await initialized();
    assert.match(accountId, /^paper-[0-9a-f-]{36}$/);
    assert.equal(mode(paths.dataDir), 0o700);
    assert.equal(mode(paths.state), 0o600);
    assert.equal(mode(paths.profile), 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(paths.profile, 'utf8')), { version: 2, state: paths.state, account_id: accountId });
    assert.deepEqual(fs.readdirSync(paths.dataDir).sort(), ['account.sqlite3', 'profile.json']);
    const before = [digest(paths.state), digest(paths.profile)];
    await rejects(store.initAccount(paths, { cash: '5', currency: 'USD', fee_bps: '0' }), 'ACCOUNT_EXISTS');
    fs.rmSync(paths.profile);
    await rejects(store.initAccount(paths, { cash: '5', currency: 'USD', fee_bps: '0' }), 'ACCOUNT_EXISTS');
    assert.equal(digest(paths.state), before[0]);
    const report = await store.doctor(paths);
    assert.equal(report.state_status, 'UNBOUND');
    assert.equal(report.account_id, accountId);
  });

  test('initAccount rejects invalid terms before creating files', async () => {
    const paths = freshPaths();
    await rejects(store.initAccount(paths, { cash: '-1', currency: 'USD', fee_bps: '10' }), 'INVALID_ARGUMENT');
    assert.equal(fs.existsSync(paths.dataDir), false);
  });

  test('doctor is read-only and reports a ready account', async () => {
    const missing = freshPaths();
    const empty = await store.doctor(missing);
    assert.equal(empty.ok, true);
    assert.equal(empty.state_status, 'MISSING');
    assert.equal(fs.existsSync(missing.dataDir), false);
    const { paths, accountId } = await initialized();
    const before = digest(paths.state);
    const report = await store.doctor(paths);
    assert.equal(report.ready, true);
    assert.equal(report.account_id, accountId);
    assert.equal(report.pending_count, 0);
    assert.match(String(report.durability), /^UNVERIFIED/);
    assert.equal(digest(paths.state), before);
  });

  test('an interrupted write is reported as recovery pending by read-only doctor and bind, not as corrupt', async () => {
    const { paths, accountId } = await initialized('1000');
    // A writer that spills uncommitted pages into the database file, then dies, leaves a hot rollback journal.
    const writer = [
      "const { DatabaseSync } = require('node:sqlite');",
      `const db = new DatabaseSync(${JSON.stringify(paths.state)});`,
      "db.exec('PRAGMA cache_size = 2'); db.exec('BEGIN IMMEDIATE');",
      "const s = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');",
      "for (let i = 0; i < 5000; i++) s.run('k' + i, 'x'.repeat(200));",
      "process.kill(process.pid, 'SIGKILL');",
    ].join('\n');
    const killed = spawnSync(process.execPath, ['--no-warnings', '-e', writer], { encoding: 'utf8' });
    assert.equal(killed.signal, 'SIGKILL');
    const journal = `${paths.state}-journal`;
    assert.ok(fs.existsSync(journal), 'hot journal left behind');
    const before = digest(paths.state);

    const report = await store.doctor(paths);
    assert.equal(report.ok, false);
    assert.equal(report.ready, false);
    assert.equal(report.state_status, 'RECOVERY_PENDING');
    const error = report.error as { code: string; hint: string };
    assert.equal(error.code, 'STATE_RECOVERY_PENDING');
    assert.match(error.hint, /coinbase-paper balance/);
    assert.match(error.hint, /Do not run init/);
    assert.equal(digest(paths.state), before, 'doctor stays read-only');
    assert.ok(fs.existsSync(journal), 'doctor does not roll back');

    const other = freshPaths();
    await assert.rejects(store.bindAccount(other, paths.state, accountId), (err: PaperError) => err.code === 'STATE_RECOVERY_PENDING');
    assert.equal(fs.existsSync(other.profile), false, 'bind wrote no profile');
    assert.equal(digest(paths.state), before, 'bind stays read-only');

    const account = await store.openAccount(paths);
    try {
      assert.equal(account.readSnapshot().account.cash, '1000');
    } finally {
      account.close();
    }
    assert.equal(fs.existsSync(journal), false, 'opening the account rolled back the interrupted write');
    const healthy = await store.doctor(paths);
    assert.equal(healthy.ready, true);
    assert.equal(healthy.state_status, 'OK');
  });

  test('prototype data is refused and left unchanged', async () => {
    const paths = freshPaths();
    const accountId = `paper-${randomUUID()}`;
    const proto = await makePrototype(paths.dataDir, accountId);
    const before = [digest(proto.state), digest(proto.profile)];
    await rejects(store.openAccount(paths), 'PROFILE_UNSUPPORTED');
    await rejects(store.bindAccount(store.resolvePaths(path.join(tempRoot(), 'other')), proto.state, accountId), 'STATE_UNSUPPORTED');
    await rejects(store.initAccount(paths, { cash: '5', currency: 'USD', fee_bps: '0' }), 'ACCOUNT_EXISTS');
    const report = await store.doctor(paths);
    assert.equal(report.ok, false);
    assert.equal(report.profile_status, 'UNSUPPORTED');
    assert.equal(report.prototype_artifacts, true);
    fs.rmSync(proto.profile);
    const unbound = await store.doctor(paths);
    assert.equal(unbound.state_status, 'UNSUPPORTED');
    fs.writeFileSync(proto.profile, JSON.stringify({ version: 1, state: proto.state, account_id: accountId }));
    assert.deepEqual([digest(proto.state), digest(proto.profile)], before);
  });

  test('openAccount fails closed on missing, corrupt or mismatched state', async () => {
    const none = freshPaths();
    await rejects(store.openAccount(none), 'PROFILE_NOT_FOUND');

    const { paths, accountId } = await initialized();
    const state = fs.readFileSync(paths.state);
    fs.rmSync(paths.state);
    await rejects(store.openAccount(paths), 'STATE_NOT_FOUND');
    assert.equal(fs.existsSync(paths.state), false);

    fs.writeFileSync(paths.state, 'not a database at all, just text padding'.repeat(200));
    await rejects(store.openAccount(paths), 'STATE_INVALID');
    assert.equal((await store.doctor(paths)).state_status, 'INVALID');

    fs.writeFileSync(paths.state, state);
    const profile = fs.readFileSync(paths.profile, 'utf8');
    fs.writeFileSync(paths.profile, profile.replace(accountId, `paper-${randomUUID()}`));
    await rejects(store.openAccount(paths), 'ACCOUNT_MISMATCH');
    fs.writeFileSync(paths.profile, '{"version": 2,');
    await rejects(store.openAccount(paths), 'PROFILE_INVALID');
    fs.writeFileSync(paths.profile, profile);
    (await store.openAccount(paths)).close();
  });

  test('reserve records terms before market data and replays the exact receipt', async () => {
    const { paths, accountId } = await initialized();
    const account = await store.openAccount(paths);
    try {
      const order = intent(accountId, 'BUY', '3');
      assert.equal(account.reserve(order), null);
      assert.equal(account.reserve(order), null);
      assert.equal((await store.doctor(paths)).pending_count, 1);
      const receipt = account.commit(order, {}, book(), Date.now);
      assert.equal(receipt.cash, '700');
      const calls = controls.simulateCalls;
      assert.deepEqual(account.reserve(order), receipt);
      assert.deepEqual(account.commit(order, {}, book(), Date.now), receipt);
      assert.equal(controls.simulateCalls, calls);
      await rejects(() => account.reserve({ ...order, size: '4' }), 'IDEMPOTENCY_CONFLICT');
      await rejects(() => account.reserve({ ...order, account_id: `paper-${randomUUID()}` }), 'ACCOUNT_MISMATCH');
      await rejects(() => account.commit(intent(accountId), {}, book(), Date.now), 'INTENT_NOT_RESERVED');
      assert.deepEqual(account.readSnapshot().positions, [{ product_id: 'BTC-USD', quantity: '3', cost_basis: '300', base_increment: '1', quote_increment: '0.01' }]);
      assert.equal(account.readSnapshot().account.quote_increment, '0.01');
    } finally {
      account.close();
    }
    const reopened = await store.openAccount(paths);
    try {
      assert.equal(reopened.history(10).length, 1);
    } finally {
      reopened.close();
    }
  });

  test('malformed or mismatched stored receipts fail closed on history and same-ID replay', async () => {
    const { paths, accountId } = await initialized();
    const account = await store.openAccount(paths);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(paths.state);
    try {
      const order = intent(accountId, 'BUY', '1');
      account.reserve(order);
      const receipt = account.commit(order, {}, book(), Date.now);
      const cash = account.readSnapshot().account.cash;
      const calls = controls.simulateCalls;
      const malformed = [
        '{}', '[]', 'not-json',
        ...[
          { ...receipt, mode: 'LIVE' }, { ...receipt, status: 'OPEN' },
          { ...receipt, account_id: `paper-${randomUUID()}` }, { ...receipt, request_id: randomUUID() },
          { ...receipt, side: 'OTHER' }, { ...receipt, product_id: 'BTC' },
          { ...receipt, cash: 900 }, { ...receipt, fee: 'NaN' }, { ...receipt, base_size: '-1' },
          { ...receipt, requested: {} }, { ...receipt, position: {} },
          { ...receipt, fills: [{ price: '100', size: 1 }] }, { ...receipt, filled_at: 'unknown' },
        ].map(value => JSON.stringify(value)),
      ];
      for (const text of malformed) {
        db.prepare('UPDATE orders SET receipt = ? WHERE request_id = ?').run(text, order.request_id);
        await rejects(() => account.history(10), 'STATE_INVALID');
        await rejects(() => account.reserve(order), 'STATE_INVALID');
        await rejects(() => account.commit(order, {}, book(), Date.now), 'STATE_INVALID');
        assert.equal(account.readSnapshot().account.cash, cash);
        assert.equal(controls.simulateCalls, calls, 'invalid cached output must not trigger another fill');
      }
      db.prepare('UPDATE orders SET receipt = ? WHERE request_id = ?').run(JSON.stringify(receipt), order.request_id);
      assert.deepEqual(account.reserve(order), receipt, 'valid receipts replay unchanged');
      assert.deepEqual(account.history(10), [receipt]);
    } finally { db.close(); account.close(); }
  });

  test('a failed fill or stale commit rolls back and keeps the pending intent', async () => {
    const { paths, accountId } = await initialized('100');
    const account = await store.openAccount(paths);
    try {
      const big = intent(accountId, 'BUY', '2');
      account.reserve(big);
      await rejects(() => account.commit(big, {}, book(), Date.now), 'INSUFFICIENT_FUNDS');
      const stale = intent(accountId, 'BUY', '1');
      account.reserve(stale);
      const old = Date.now() - 120_000;
      await rejects(() => account.commit(stale, {}, book(old), () => Date.now()), 'STALE_BOOK');
      const snapshot = account.readSnapshot();
      assert.equal(snapshot.account.cash, '100');
      assert.deepEqual(snapshot.positions, []);
      assert.deepEqual(account.history(10), []);
      assert.equal((await store.doctor(paths)).pending_count, 2);
      assert.equal(account.commit(stale, {}, book(), Date.now).cash, '0');
    } finally {
      account.close();
    }
  });

  test('selling everything removes the position and history is newest first', async () => {
    const { paths, accountId } = await initialized();
    const account = await store.openAccount(paths);
    try {
      const buy = intent(accountId, 'BUY', '2');
      account.reserve(buy);
      account.commit(buy, {}, book(), Date.now);
      const sell = intent(accountId, 'SELL', '2');
      account.reserve(sell);
      account.commit(sell, {}, book(Date.now(), '150'), Date.now);
      const snapshot = account.readSnapshot();
      assert.deepEqual(snapshot.positions, []);
      assert.equal(snapshot.account.realized_pnl, '100');
      assert.deepEqual(account.history(10).map((r) => r.request_id), [sell.request_id, buy.request_id]);
      assert.deepEqual(account.history(1).map((r) => r.request_id), [sell.request_id]);
      await rejects(() => account.history(0), 'INVALID_ARGUMENT');
      await rejects(() => account.history(1001), 'INVALID_ARGUMENT');
    } finally {
      account.close();
    }
  });

  test('a state file replaced while open is not written', async () => {
    const { paths, accountId } = await initialized();
    const account = await store.openAccount(paths);
    try {
      const copy = `${paths.state}.copy`;
      fs.copyFileSync(paths.state, copy);
      fs.renameSync(copy, paths.state);
      await rejects(() => account.reserve(intent(accountId)), 'STATE_CHANGED');
    } finally {
      account.close();
    }
  });

  test('backup is private, consistent, includes pending intents and never overwrites', async () => {
    const { paths, accountId } = await initialized();
    const account = await store.openAccount(paths);
    const out = path.join(tempRoot(), 'nested', 'backup.sqlite3');
    const pending = intent(accountId, 'BUY', '1');
    try {
      const filled = intent(accountId, 'BUY', '2');
      account.reserve(filled);
      account.commit(filled, {}, book(), Date.now);
      account.reserve(pending);
      const result = await account.backup(out);
      assert.equal(result.backup, out);
      assert.equal(mode(out), 0o600);
      assert.deepEqual(fs.readdirSync(path.dirname(out)), ['backup.sqlite3']);
      const before = digest(out);
      await rejects(account.backup(out), 'BACKUP_EXISTS');
      await rejects(account.backup(paths.state), 'INVALID_PATH');
      assert.equal(digest(out), before);
    } finally {
      account.close();
    }

    const restored = store.resolvePaths(path.join(tempRoot(), 'restore'));
    const bound = await store.bindAccount(restored, out, accountId);
    assert.equal(bound.created, true);
    assert.equal((await store.bindAccount(restored, out, accountId)).created, false);
    await rejects(store.bindAccount(restored, paths.state, accountId), 'PROFILE_EXISTS');
    await rejects(store.bindAccount(store.resolvePaths(path.join(tempRoot(), 'x')), out, `paper-${randomUUID()}`), 'ACCOUNT_MISMATCH');
    await rejects(store.bindAccount(restored, out, 'not-an-id'), 'INVALID_ARGUMENT');
    const copy = await store.openAccount(restored);
    try {
      assert.equal(copy.readSnapshot().account.cash, '800');
      assert.equal(copy.reserve(pending), null);
      assert.equal(copy.commit(pending, {}, book(), Date.now).cash, '700');
    } finally {
      copy.close();
    }
    const original = await store.openAccount(paths);
    try {
      assert.equal(original.readSnapshot().account.cash, '800');
    } finally {
      original.close();
    }
  });

  test('concurrent processes with distinct orders cannot overspend', async () => {
    const { paths, accountId } = await initialized('1000');
    const startAt = Date.now() + 1500;
    const jobs = Array.from({ length: 6 }, () => child({ paths, intent: intent(accountId, 'BUY', '3'), startAt }));
    const results = (await Promise.all(jobs)).map((r) => JSON.parse(r.stdout));
    assert.equal(results.filter((r) => r.ok).length, 3);
    assert.deepEqual(results.filter((r) => !r.ok).map((r) => r.code), ['INSUFFICIENT_FUNDS', 'INSUFFICIENT_FUNDS', 'INSUFFICIENT_FUNDS']);
    const account = await store.openAccount(paths);
    try {
      assert.equal(account.readSnapshot().account.cash, '100');
      assert.equal(account.history(10).length, 3);
    } finally {
      account.close();
    }
  });

  test('concurrent processes with the same request ID fill exactly once', async () => {
    const { paths, accountId } = await initialized('1000');
    const order = intent(accountId, 'BUY', '1');
    const startAt = Date.now() + 1500;
    const results = (await Promise.all(Array.from({ length: 5 }, () => child({ paths, intent: order, startAt })))).map((r) => JSON.parse(r.stdout));
    assert.ok(results.every((r) => r.ok));
    for (const r of results) assert.deepEqual(r.receipt, results[0].receipt);
    const account = await store.openAccount(paths);
    try {
      assert.equal(account.readSnapshot().account.cash, '900');
      assert.equal(account.history(10).length, 1);
    } finally {
      account.close();
    }
  });

  test('a process crash inside the commit transaction leaves no partial fill', async () => {
    const { paths, accountId } = await initialized('1000');
    const order = intent(accountId, 'BUY', '4');
    const crashed = await child({ paths, intent: order, crashOnFresh: true, startAt: 0 });
    assert.equal(crashed.code, 9);
    assert.equal(crashed.stdout, '');
    const account = await store.openAccount(paths);
    try {
      assert.equal(account.readSnapshot().account.cash, '1000');
      assert.deepEqual(account.readSnapshot().positions, []);
      assert.equal(account.reserve(order), null);
      assert.equal(account.commit(order, {}, book(), Date.now).cash, '600');
    } finally {
      account.close();
    }
  });

  test('crypto order terms keep the exact legacy serialization; equity terms add the quote', async () => {
    const { paths, accountId } = await initialized();
    const account = await store.openAccount(paths);
    const crypto = intent(accountId);
    const equity = equityIntent(accountId, 'BUY', '1', '2026-01-02T03:00:00Z');
    try {
      account.reserve(crypto);
      account.reserve(equity);
    } finally { account.close(); }
    const db = await rawDb(paths.state);
    try {
      const row = (id: string) => (db.prepare('SELECT terms FROM orders WHERE request_id = ?').get(id) as { terms: string }).terms;
      assert.equal(row(crypto.request_id), `{"account_id":"${accountId}","product_id":"BTC-USD","request_id":"${crypto.request_id}","side":"BUY","size":"1","size_type":"base_size"}`);
      assert.equal(row(equity.request_id), `{"account_id":"${accountId}","price_as_of":"2026-01-02T03:00:00Z","price_source":"https://example.com/quote","product_id":"BRK.B-USD","reference_price":"100","request_id":"${equity.request_id}","side":"BUY","size":"1","size_type":"base_size"}`);
      assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 4, 'fresh accounts are created as schema 4');
    } finally { db.close(); }
  });

  test('changed quote fields conflict for pending and filled orders; replays skip simulation and freshness', async () => {
    const { paths, accountId } = await initialized();
    const account = await store.openAccount(paths);
    try {
      const order = equityIntent(accountId);
      assert.equal(account.reserve(order), null);
      for (const change of [{ reference_price: '101' }, { price_source: 'https://example.com/other' }, { price_as_of: '2026-01-02T03:00:01Z' }, { reference_price: undefined, price_source: undefined, price_as_of: undefined }]) {
        await rejects(() => account.reserve({ ...order, ...change }), 'IDEMPOTENCY_CONFLICT');
      }
      const receipt = account.commitExternal(order, ASSUMED, Date.now);
      assert.equal(receipt.asset_class, 'EQUITY');
      const calls = controls.simulateCalls;
      // A day later the quote is stale, but a filled order still replays its stored receipt.
      assert.deepEqual(account.reserve(order), receipt);
      assert.deepEqual(account.commitExternal(order, ASSUMED, () => Date.now() + 2 * 86_400_000), receipt);
      assert.equal(controls.simulateCalls, calls);
      await rejects(() => account.reserve({ ...order, reference_price: '99' }), 'IDEMPOTENCY_CONFLICT');
      assert.deepEqual(account.history(10), [receipt]);
    } finally { account.close(); }
  });

  test('equity fills keep their asset class across reopen, backup and bind', async () => {
    const { paths, accountId } = await initialized();
    const account = await store.openAccount(paths);
    const out = path.join(tempRoot(), 'equity-backup.sqlite3');
    let cryptoReceipt;
    try {
      const crypto = intent(accountId, 'BUY', '2');
      account.reserve(crypto);
      cryptoReceipt = account.commit(crypto, {}, book(), Date.now);
      assert.equal((await store.doctor(paths)).schema_version, 4, 'fresh accounts are schema 4');
      const pendingCrypto = intent(accountId, 'BUY', '1');
      account.reserve(pendingCrypto);
      const equity = equityIntent(accountId, 'BUY', '3');
      account.reserve(equity);
      account.commitExternal(equity, ASSUMED, Date.now);
      assert.equal((await store.doctor(paths)).schema_version, 4);
      assert.deepEqual(account.readSnapshot().positions, [
        { product_id: 'BRK.B-USD', quantity: '3', cost_basis: '300', base_increment: '1', quote_increment: '0.01', asset_class: 'EQUITY' },
        { product_id: 'BTC-USD', quantity: '2', cost_basis: '200', base_increment: '1', quote_increment: '0.01' },
      ]);
      assert.equal(account.commit(pendingCrypto, {}, book(), Date.now).cash, '400', 'legacy pending crypto order still completes');
      assert.deepEqual(account.history(10).at(-1), cryptoReceipt, 'legacy crypto receipt replays unchanged');
      await account.backup(out);
    } finally { account.close(); }
    const db = await rawDb(paths.state);
    try {
      assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 4, 'older clients (schema 2/3 only) refuse this file');
      assert.equal((db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value, '4');
    } finally { db.close(); }
    const reopened = await store.openAccount(paths);
    try {
      assert.equal(reopened.readSnapshot().positions[0].asset_class, 'EQUITY');
      const sell = equityIntent(accountId, 'SELL', '3');
      reopened.reserve(sell);
      reopened.commitExternal(sell, ASSUMED, Date.now);
      assert.deepEqual(reopened.readSnapshot().positions.map((p) => p.product_id), ['BTC-USD']);
    } finally { reopened.close(); }
    const restored = store.resolvePaths(path.join(tempRoot(), 'restore'));
    await store.bindAccount(restored, out, accountId);
    const copy = await store.openAccount(restored);
    try {
      assert.equal(copy.readSnapshot().positions[0].asset_class, 'EQUITY');
      assert.equal(copy.history(10).length, 3);
    } finally { copy.close(); }
  });

  test('a stale or failed equity commit rolls back the fill, keeping the intent pending', async () => {
    const { paths, accountId } = await initialized();
    const account = await store.openAccount(paths);
    try {
      const old = new Date(Date.now() - 2 * 86_400_000).toISOString().replace(/\.\d+Z$/, 'Z');
      const stale = equityIntent(accountId, 'BUY', '1', old);
      account.reserve(stale);
      await rejects(() => account.commitExternal(stale, ASSUMED, Date.now), 'EXTERNAL_QUOTE_STALE');
      // Fresh when simulated, expired by the time the write is ready (e.g. after waiting for the lock).
      const asOf = new Date(Date.now() - 86_400_000 + 60_000).toISOString();
      const expiring = equityIntent(accountId, 'BUY', '1', asOf);
      account.reserve(expiring);
      let calls = 0;
      await rejects(() => account.commitExternal(expiring, ASSUMED, () => (calls++ === 0 ? Date.now() : Date.now() + 120_000)), 'EXTERNAL_QUOTE_STALE');
      const big = equityIntent(accountId, 'BUY', '50');
      account.reserve(big);
      await rejects(() => account.commitExternal(big, ASSUMED, Date.now), 'INSUFFICIENT_FUNDS');
      const snapshot = account.readSnapshot();
      assert.equal(snapshot.account.cash, '1000');
      assert.deepEqual(snapshot.positions, []);
      assert.equal((await store.doctor(paths)).pending_count, 3);
      assert.equal((await store.doctor(paths)).schema_version, 4);
    } finally { account.close(); }
  });

  test('asset class cannot switch for a held product, and unknown classes fail closed', async () => {
    const { paths, accountId } = await initialized();
    const account = await store.openAccount(paths);
    try {
      const equity = equityIntent(accountId);
      account.reserve(equity);
      account.commitExternal(equity, ASSUMED, Date.now);
      const asCrypto = { ...intent(accountId), product_id: 'BRK.B-USD' };
      account.reserve(asCrypto);
      await rejects(() => account.commit(asCrypto, {}, book(), Date.now), 'STATE_INVALID');
      const crypto = intent(accountId);
      account.reserve(crypto);
      account.commit(crypto, {}, book(), Date.now);
      const asEquity = { ...equityIntent(accountId), product_id: 'BTC-USD' };
      account.reserve(asEquity);
      await rejects(() => account.commitExternal(asEquity, ASSUMED, Date.now), 'STATE_INVALID');
    } finally { account.close(); }
    const db = await rawDb(paths.state);
    try {
      db.exec('PRAGMA ignore_check_constraints = ON');
      db.prepare("UPDATE positions SET asset_class = 'BOND' WHERE product_id = 'BRK.B-USD'").run();
    } finally { db.close(); }
    await rejects(store.openAccount(paths), 'STATE_INVALID');
  });

  test('malformed external receipts fail closed; schema/meta mismatches are unsupported', async () => {
    const { paths, accountId } = await initialized();
    const account = await store.openAccount(paths);
    const db = await rawDb(paths.state);
    try {
      const order = equityIntent(accountId);
      account.reserve(order);
      const receipt = account.commitExternal(order, ASSUMED, Date.now);
      const malformed = [
        { ...receipt, asset_class: 'CRYPTO' }, { ...receipt, price_verification: 'VERIFIED' }, { ...receipt, price_age_seconds: 1.5 },
        { ...receipt, source: { ...receipt.source, provider: 'coinbase' } }, { ...receipt, source: { ...receipt.source, url: 'http://x' } },
        { ...receipt, source: { ...receipt.source, metadata: 'listing' } }, { ...receipt, source: { ...receipt.source, reference_price: '-1' } },
        { ...receipt, source: { ...receipt.source, as_of: '2020-01-01T00:00:00Z' } },
        Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'price_verification')),
        { ...intent(accountId), ...receipt, product_id: 'brk.b-USD' },
      ];
      for (const value of malformed) {
        db.prepare('UPDATE orders SET receipt = ? WHERE request_id = ?').run(JSON.stringify(value), order.request_id);
        await rejects(() => account.history(10), 'STATE_INVALID');
        await rejects(() => account.reserve(order), 'STATE_INVALID');
      }
      db.prepare('UPDATE orders SET receipt = ? WHERE request_id = ?').run(JSON.stringify(receipt), order.request_id);
      assert.deepEqual(account.reserve(order), receipt);
    } finally { db.close(); account.close(); }
    const meta = await rawDb(paths.state);
    try { meta.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run(); } finally { meta.close(); }
    await rejects(store.openAccount(paths), 'STATE_UNSUPPORTED');
    const future = await rawDb(paths.state);
    try { future.exec('PRAGMA user_version = 5'); } finally { future.close(); }
    await rejects(store.openAccount(paths), 'STATE_UNSUPPORTED');
  });
  registerLedgerTests();
}

// Real engine (the stand-in above only replaces the legacy market simulators inside store.ts).
const real = await import('./engine.ts');
const REAL_PRODUCT = {
  product_id: 'BTC-USD', product_type: 'SPOT', base_currency_id: 'BTC', quote_currency_id: 'USD', status: 'online',
  is_disabled: false, trading_disabled: false, cancel_only: false, limit_only: false, post_only: false, auction_mode: false,
  base_increment: '0.01', quote_increment: '0.01', base_min_size: '0.01', base_max_size: '1000', quote_min_size: '0.01', quote_max_size: '10000000',
};
function realBook(now: number, bid = '99', ask = '101') {
  return { pricebook: { product_id: 'BTC-USD', time: new Date(now).toISOString(), bids: [{ price: bid, size: '100' }], asks: [{ price: ask, size: '100' }] } };
}

/** Writes a schema-2 (or, with an equity fill, schema-3) account with real receipts, as older clients did. */
async function legacyAccount(options: { buys: number; sells?: number; equity?: boolean; pending?: boolean }): Promise<{ paths: PaperPaths; accountId: string; rows: Array<{ request_id: string; terms: string; receipt: string | null; fill_seq: number | null }> }> {
  const paths = freshPaths();
  fs.mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
  const accountId = `paper-${randomUUID()}`;
  const now = Date.now();
  let acct: Account = { account_id: accountId, currency: 'USD', initial_cash: '100000', cash: '100000', realized_pnl: '0', fee_bps: '10', quote_increment: null, created_at: new Date(now).toISOString() };
  const positions = new Map<string, Position>();
  const rows: Array<{ request_id: string; terms: string; receipt: string | null; fill_seq: number | null }> = [];
  const add = (fill: FillResult, intentTerms: string) => {
    acct = { ...acct, cash: fill.cash, realized_pnl: fill.realized_pnl, quote_increment: '0.01' };
    if (BigInt(fill.position.quantity.replace('.', '').replace(/^0+(?=.)/, '')) === 0n) positions.delete(fill.position.product_id);
    else positions.set(fill.position.product_id, fill.position);
    rows.push({ request_id: fill.receipt.request_id, terms: intentTerms, receipt: JSON.stringify(fill.receipt), fill_seq: rows.filter((r) => r.receipt).length + 1 });
  };
  const trade = (side: 'BUY' | 'SELL', size: string) => {
    const intent = real.normalizeIntent({ request_id: randomUUID(), account_id: accountId, product_id: 'BTC-USD', side, base_size: size });
    add(real.simulate(acct, positions.get('BTC-USD') ?? null, intent, REAL_PRODUCT, realBook(now), now), real.legacyTerms(intent));
  };
  for (let i = 0; i < options.buys; i++) trade('BUY', '0.03');
  for (let i = 0; i < (options.sells ?? 0); i++) trade('SELL', '0.01');
  if (options.equity) {
    const intent = real.normalizeIntent({ request_id: randomUUID(), account_id: accountId, product_id: 'BRK.B-USD', side: 'BUY', base_size: '1.5', reference_price: '450.12', price_source: 'https://example.com/q', price_as_of: new Date(now).toISOString().replace(/\.\d+Z$/, 'Z') });
    add(real.simulateExternal(acct, null, intent, real.ASSUMED_EQUITY_METADATA, now), real.legacyTerms(intent));
  }
  if (options.pending) {
    const intent = real.normalizeIntent({ request_id: randomUUID(), account_id: accountId, product_id: 'BTC-USD', side: 'BUY', quote_size: '10' });
    rows.push({ request_id: intent.request_id, terms: real.legacyTerms(intent), receipt: null, fill_seq: null });
  }
  const schema = options.equity ? 3 : 2;
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(paths.state);
  db.exec(`PRAGMA application_id = ${0x50415052}; PRAGMA user_version = ${schema};
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE account (id INTEGER PRIMARY KEY CHECK (id = 1), cash TEXT NOT NULL, realized_pnl TEXT NOT NULL, quote_increment TEXT) STRICT;
    CREATE TABLE positions (product_id TEXT PRIMARY KEY, quantity TEXT NOT NULL, cost_basis TEXT NOT NULL, base_increment TEXT NOT NULL, quote_increment TEXT NOT NULL${schema === 3 ? ", asset_class TEXT CHECK (asset_class IS NULL OR asset_class = 'EQUITY')" : ''}) STRICT;
    CREATE TABLE orders (request_id TEXT PRIMARY KEY, terms TEXT NOT NULL, reserved_at TEXT NOT NULL, fill_seq INTEGER UNIQUE, receipt TEXT, CHECK ((fill_seq IS NULL) = (receipt IS NULL))) STRICT;`);
  const meta = db.prepare('INSERT INTO meta VALUES (?, ?)');
  for (const [k, v] of [['app', 'coinbase-paper'], ['schema_version', String(schema)], ['model_version', 'snapshot-market-v1'], ['account_id', accountId], ['currency', 'USD'], ['initial_cash', '100000'], ['fee_bps', '10'], ['created_at', acct.created_at]]) meta.run(k, v);
  db.prepare('INSERT INTO account VALUES (1, ?, ?, ?)').run(acct.cash, acct.realized_pnl, acct.quote_increment);
  for (const p of positions.values()) {
    if (schema === 3) db.prepare('INSERT INTO positions VALUES (?, ?, ?, ?, ?, ?)').run(p.product_id, p.quantity, p.cost_basis, p.base_increment, p.quote_increment, p.asset_class ?? null);
    else db.prepare('INSERT INTO positions VALUES (?, ?, ?, ?, ?)').run(p.product_id, p.quantity, p.cost_basis, p.base_increment, p.quote_increment);
  }
  const insert = db.prepare('INSERT INTO orders VALUES (?, ?, ?, ?, ?)');
  for (const r of rows) insert.run(r.request_id, r.terms, new Date(now).toISOString(), r.fill_seq, r.receipt);
  db.close();
  fs.writeFileSync(paths.profile, JSON.stringify({ version: 2, state: paths.state, account_id: accountId }), { mode: 0o600 });
  return { paths, accountId, rows };
}

function registerLedgerTests(): void {
  test('schema 2 migrates to 4 transactionally: >1000 receipts backfilled, terms/receipts/sequences byte-identical', async () => {
    const { paths, accountId, rows } = await legacyAccount({ buys: 1001, sells: 3, pending: true });
    const doctorBefore = await store.doctor(paths);
    assert.equal(doctorBefore.schema_version, 2, 'doctor never migrates');
    assert.match(String(doctorBefore.migration), /next paper account command/);
    const before = await rawDb(paths.state);
    const snapshot = before.prepare('SELECT cash, realized_pnl FROM account').get();
    before.close();
    const account = await store.openAccount(paths);
    try {
      const ledger = account.readLedger();
      assert.deepEqual({ cash: ledger.account.cash, realized_pnl: ledger.account.realized_pnl }, { ...snapshot });
      assert.equal(ledger.orders.length, 1005);
      assert.equal(ledger.orders.filter((o) => o.status === 'FILLED' && o.order_type === 'MARKET').length, 1004);
      const pending = ledger.orders.find((o) => o.status === 'PENDING')!;
      assert.deepEqual([pending.cash_hold, pending.base_hold, pending.filled_size], ['0', '0', '0'], 'pending is never resting');
      assert.equal(ledger.fills.length, 1004);
      assert.ok(ledger.fills.every((f) => f.liquidity_indicator === 'TAKER'));
      assert.equal(ledger.account.maker_fee_bps, '10');
      assert.equal(ledger.account.taker_fee_bps, '10');
      const sold = ledger.fills.filter((f) => f.side === 'SELL');
      assert.ok(sold.every((f) => f.cost_basis_removed !== '0' && f.realized_pnl !== null));
      assert.equal(account.history(1000).length, 1000);
      const legacyReceipt = JSON.parse(rows[0].receipt!);
      assert.deepEqual(account.lookup(rows[0].request_id)?.receipt, legacyReceipt, 'legacy receipts replay unchanged');
    } finally { account.close(); }
    const db = await rawDb(paths.state);
    try {
      assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 4);
      assert.equal((db.prepare("SELECT value FROM meta WHERE key = 'model_version'").get() as { value: string }).value, 'paper-orders-v2');
      const stored = db.prepare('SELECT request_id, terms, receipt, fill_seq FROM orders ORDER BY fill_seq IS NULL, fill_seq').all() as typeof rows;
      assert.deepEqual(stored.map((r) => ({ ...r })), rows, 'original terms, receipts and sequences unchanged');
    } finally { db.close(); }
    assert.equal((await store.doctor(paths)).schema_version, 4);
  });

  test('schema 3 (equities) migrates to 4 keeping asset classes; older clients refuse 4', async () => {
    const { paths } = await legacyAccount({ buys: 2, equity: true });
    const account = await store.openAccount(paths);
    try {
      const ledger = account.readLedger();
      assert.deepEqual(ledger.orders.map((o) => o.product_type).sort(), ['EQUITY', 'SPOT', 'SPOT']);
      assert.equal(ledger.positions.find((p) => p.product_id === 'BRK.B-USD')?.asset_class, 'EQUITY');
      assert.equal(ledger.fills.find((f) => f.product_type === 'EQUITY')?.price, ledger.orders.find((o) => o.product_type === 'EQUITY')?.current_receipt?.fills[0].price);
    } finally { account.close(); }
  });

  test('a history that does not reproduce the stored account fails STATE_INVALID and rolls back the migration', async () => {
    const { paths } = await legacyAccount({ buys: 2 });
    const db = await rawDb(paths.state);
    db.prepare("UPDATE account SET cash = '1'").run();
    db.close();
    const digestBefore = digest(paths.state);
    await rejects(store.openAccount(paths), 'STATE_INVALID');
    assert.equal(digest(paths.state), digestBefore);
    const check = await rawDb(paths.state);
    try { assert.equal(check.prepare('PRAGMA user_version').get()?.user_version, 2); } finally { check.close(); }
  });

  test('placeOrder/closePosition persist provenance at first placement; replays return the byte-identical receipt', async () => {
    const { paths, accountId } = await initialized('100000');
    const account = await store.openAccount(paths);
    const now = Date.now();
    const provenance = (n: number) => ({
      reconciliation: { status: 'NOT_NEEDED' as const, attempted_at: new Date(now).toISOString(), reconciled_at: new Date(now).toISOString(), reason: null, orders_checked: n, orders_filled: 0, orders_expired: 0, windows: [] },
      requests: { product: 1, book: 1, candles: 0, total: 2, cache_hits: 0, http_attempts: null },
    });
    try {
      const market = { kind: 'crypto' as const, product: REAL_PRODUCT, book: realBook(now) };
      const buy = real.normalizeOrderInput({ request_id: randomUUID(), account_id: accountId, product_id: 'BTC-USD', side: 'BUY', type: 'limit', base_size: '2', limit_price: '101.5' });
      const first = account.placeOrder(buy, market, () => now, provenance(0));
      assert.deepEqual(first.source.requests, provenance(0).requests);
      assert.deepEqual(first.reconciliation, provenance(0).reconciliation);
      assert.equal(JSON.stringify(account.reserveOrder(buy, now + 1)), JSON.stringify(first), 'reserve of an accepted request returns its stored result');
      const replay = account.placeOrder(buy, { ...market, book: realBook(now + 120_000, '1', '2') }, () => now + 120_000, provenance(7));
      assert.equal(JSON.stringify(replay), JSON.stringify(first), 'replay is byte-identical and does not overwrite provenance');
      assert.equal(JSON.stringify(account.findAcceptance(buy)), JSON.stringify(first));
      await rejects(() => account.placeOrder({ ...buy, limit_price: '101' }, market, () => now), 'IDEMPOTENCY_CONFLICT');
      const close = real.normalizeClosePositionInput({ request_id: randomUUID(), account_id: accountId, product_id: 'BTC-USD' });
      const closed = account.closePosition(close, market, () => now, provenance(1));
      assert.equal(closed.success, true);
      assert.equal(closed.base_size, '2.00');
      assert.deepEqual(closed.source.requests, provenance(1).requests);
      const again = account.closePosition(close, market, () => now + 1, provenance(9));
      assert.equal(JSON.stringify(again), JSON.stringify(closed), 'a full-close retry never recomputes the position');
    } finally { account.close(); }
  });

  test('tampered order-model receipts (amounts, times, ids, configuration) fail closed on same-ID replay', async () => {
    const { paths, accountId } = await initialized('100000');
    const account = await store.openAccount(paths);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(paths.state);
    const now = Date.now();
    try {
      const market = { kind: 'crypto' as const, product: REAL_PRODUCT, book: realBook(now) };
      const buy = real.normalizeOrderInput({ request_id: randomUUID(), account_id: accountId, product_id: 'BTC-USD', side: 'BUY', type: 'market', base_size: '1' });
      const receipt = JSON.parse(JSON.stringify(account.placeOrder(buy, market, () => now)));
      assert.ok(receipt.fills.length > 0);
      const fill = (patch: Record<string, unknown>) => ({ ...receipt, fills: [{ ...receipt.fills[0], ...patch }] });
      const tampered = [
        fill({ notional: 'not-a-decimal' }), fill({ commission: '-1000' }), fill({ trade_time: 'not-a-time' }),
        fill({ liquidity_indicator: 'OTHER' }), fill({ trade_id: '' }),
        { ...receipt, order_configuration: { ...receipt.order_configuration, base_size: 'not-a-decimal' } },
        { ...receipt, requested: { base_size: 'not-a-decimal' } }, { ...receipt, requested: { other: '1' } },
        { ...receipt, request_id: randomUUID() }, { ...receipt, client_order_id: randomUUID() },
      ];
      for (const value of tampered) {
        db.prepare('UPDATE orders SET receipt = ? WHERE request_id = ?').run(JSON.stringify(value), buy.request_id);
        await rejects(() => account.placeOrder(buy, market, () => now + 1), 'STATE_INVALID');
      }
      db.prepare('UPDATE orders SET receipt = ? WHERE request_id = ?').run(JSON.stringify(receipt), buy.request_id);
      assert.equal(JSON.stringify(account.placeOrder(buy, market, () => now + 1)), JSON.stringify(receipt), 'the untampered receipt still replays');
    } finally { db.close(); account.close(); }
  });

  test('a sized close-position receipt replays; tampered equity quote provenance fails closed', async () => {
    const { paths, accountId } = await initialized('100000');
    const account = await store.openAccount(paths);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(paths.state);
    const now = Date.now();
    try {
      const market = { kind: 'crypto' as const, product: REAL_PRODUCT, book: realBook(now) };
      account.placeOrder(real.normalizeOrderInput({ request_id: randomUUID(), account_id: accountId, product_id: 'BTC-USD', side: 'BUY', type: 'market', base_size: '1' }), market, () => now);
      const close = real.normalizeClosePositionInput({ request_id: randomUUID(), account_id: accountId, product_id: 'BTC-USD', size: '0.5' });
      const closed = account.closePosition(close, market, () => now);
      assert.equal(closed.success, true);
      assert.equal(JSON.stringify(account.closePosition(close, market, () => now + 1)), JSON.stringify(closed), 'sized close replays');
      const asOf = new Date(now - 60_000).toISOString();
      const buy = real.normalizeOrderInput({ request_id: randomUUID(), account_id: accountId, product_id: 'AAPL-USD', side: 'BUY', type: 'market', base_size: '1', reference_price: '200', price_source: 'https://example.com/q/AAPL', price_as_of: asOf });
      const equityMarket = { kind: 'equity' as const, metadata: ASSUMED };
      const receipt = JSON.parse(JSON.stringify(account.placeOrder(buy, equityMarket, () => now)));
      assert.equal(receipt.price_verification, 'UNVERIFIED_EXTERNAL_QUOTE');
      const src = (patch: Record<string, unknown>) => ({ ...receipt, source: { ...receipt.source, ...patch } });
      const { asset_class: _drop, ...noClass } = receipt;
      const { price_age_seconds: _age, ...noAge } = receipt;
      for (const value of [src({ as_of: 'not-a-time' }), src({ slippage_bps: 'not-a-decimal' }), src({ reference_price: '0' }), src({ url: 'http://example.com' }), noClass, noAge]) {
        db.prepare('UPDATE orders SET receipt = ? WHERE request_id = ?').run(JSON.stringify(value), buy.request_id);
        await rejects(() => account.placeOrder(buy, equityMarket, () => now + 1), 'STATE_INVALID');
      }
      db.prepare('UPDATE orders SET receipt = ? WHERE request_id = ?').run(JSON.stringify(receipt), buy.request_id);
      assert.equal(JSON.stringify(account.placeOrder(buy, equityMarket, () => now + 1)), JSON.stringify(receipt));
    } finally { db.close(); account.close(); }
  });

  test('abandonReservation removes only an unexecuted PENDING reservation with identical terms', async () => {
    const { paths, accountId } = await initialized('100000');
    const account = await store.openAccount(paths);
    const now = Date.now();
    try {
      const market = { kind: 'crypto' as const, product: REAL_PRODUCT, book: realBook(now) };
      const pending = real.normalizeOrderInput({ request_id: randomUUID(), account_id: accountId, product_id: 'BTC-USD', side: 'BUY', type: 'market', base_size: '1' });
      assert.equal(account.reserveOrder(pending, now), null);
      const other = real.normalizeOrderInput({ request_id: pending.request_id, account_id: accountId, product_id: 'BTC-USD', side: 'BUY', type: 'market', base_size: '2' });
      assert.equal(account.abandonReservation(other), false, 'different terms are never removed');
      assert.equal(account.abandonReservation(pending), true);
      assert.equal(account.readLedger().orders.some((o) => o.order_id === pending.request_id), false);
      const filled = real.normalizeOrderInput({ request_id: randomUUID(), account_id: accountId, product_id: 'BTC-USD', side: 'BUY', type: 'market', base_size: '1' });
      const receipt = account.placeOrder(filled, market, () => now);
      assert.equal(account.abandonReservation(filled), false, 'an executed order is never removed');
      assert.equal(JSON.stringify(account.placeOrder(filled, market, () => now + 1)), JSON.stringify(receipt));
    } finally { account.close(); }
  });

  test('holds: cash = available + hold, market orders cannot spend holds, failed edits keep old terms, cancels release', async () => {
    const { paths, accountId } = await initialized('1000');
    const account = await store.openAccount(paths);
    const now = Date.now();
    const market = { kind: 'crypto' as const, product: REAL_PRODUCT, book: realBook(now) };
    const order = (fields: Record<string, unknown>) => real.normalizeOrderInput({ request_id: randomUUID(), account_id: accountId, product_id: 'BTC-USD', side: 'BUY', type: 'limit', ...fields } as never);
    try {
      const rest = account.placeOrder(order({ base_size: '9', limit_price: '100' }), market, () => now);
      // 900 + ceil(0.9) = 900.90 held of 1000.
      assert.equal(account.readLedger().holds.cash, '900.9');
      assert.equal(account.readLedger().account.cash, '1000');
      await assert.rejects(async () => account.placeOrder(order({ type: 'market', base_size: '1' }), market, () => now), (e: PaperError) => {
        assert.equal(e.code, 'INSUFFICIENT_CASH');
        assert.deepEqual(e.details, { currency: 'USD', available: '99.10', required: '101.11', shortfall: '2.01', hold: '900.90' });
        return true;
      });
      await rejects(() => account.editOrder(rest.order_id, { base_size: '10' }, market, () => now), 'INSUFFICIENT_CASH');
      assert.equal(account.getOrder(rest.order_id)?.order_configuration.base_size, '9', 'failed edit keeps old terms');
      const same = account.editOrder(rest.order_id, { limit_price: '100' }, null, () => now);
      assert.equal(same.edited, false, 'a no-op edit needs no book and writes nothing');
      const edited = account.editOrder(rest.order_id, { limit_price: '50' }, market, () => now + 1);
      assert.equal(edited.edited, true);
      assert.equal(account.readLedger().holds.cash, '450.45');
      assert.deepEqual(account.getOrder(rest.order_id)?.status_history.map((e) => e.event_type), ['ACCEPTED', 'OPENED', 'EDITED']);
      account.cancelOrders([rest.order_id], now + 2);
      assert.equal(account.readLedger().holds.cash, '0');
      const page = account.listOrders({ status: 'CANCELLED', limit: 1 });
      assert.deepEqual([page.items.length, page.has_next], [1, false]);
      await rejects(() => account.listOrders({ cursor: 'bad!' }), 'PAPER_INVALID_CURSOR');
    } finally { account.close(); }
  });

  test('malformed schema-4 receipts and current views fail STATE_INVALID on replay, get and list', async () => {
    const { paths, accountId } = await initialized('1000');
    const now = Date.now();
    const market = { kind: 'crypto' as const, product: REAL_PRODUCT, book: realBook(now) };
    const buy = real.normalizeOrderInput({ request_id: randomUUID(), account_id: accountId, product_id: 'BTC-USD', side: 'BUY', type: 'limit', base_size: '1', limit_price: '100' } as never);
    let account = await store.openAccount(paths);
    const first = account.placeOrder(buy, market, () => now);
    account.close();
    const corrupt = async (table: 'orders' | 'order_state', change: (value: Record<string, unknown>) => void, check: (a: Awaited<ReturnType<typeof store.openAccount>>) => unknown) => {
      const column = table === 'orders' ? 'receipt' : 'current_receipt';
      const key = table === 'orders' ? 'request_id' : 'order_id';
      const db = await rawDb(paths.state);
      const original = (db.prepare(`SELECT ${column} AS v FROM ${table} WHERE ${key} = ?`).get(first.order_id) as { v: string }).v;
      const value = JSON.parse(original) as Record<string, unknown>;
      change(value);
      db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${key} = ?`).run(JSON.stringify(value), first.order_id);
      db.close();
      account = await store.openAccount(paths);
      try { await rejects(() => check(account), 'STATE_INVALID'); } finally { account.close(); }
      const restore = await rawDb(paths.state);
      restore.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${key} = ?`).run(original, first.order_id);
      restore.close();
    };
    const replay = (a: Awaited<ReturnType<typeof store.openAccount>>) => a.findAcceptance(buy);
    await corrupt('orders', (v) => { v.base_size = 'not-a-decimal'; }, replay);
    await corrupt('orders', (v) => { v.fills = [null]; }, replay);
    await corrupt('orders', (v) => { v.order_configuration = []; }, replay);
    await corrupt('orders', (v) => { delete v.hold; }, replay);
    await corrupt('order_state', (v) => { v.status = 'FILLED'; }, (a) => a.getOrder(first.order_id));
    await corrupt('order_state', (v) => { v.filled_size = '1'; }, (a) => a.listOrders({}));
    await corrupt('order_state', (v) => { v.account_id = 'paper-00000000-0000-4000-8000-000000000000'; }, (a) => a.getOrder(first.order_id));
    account = await store.openAccount(paths);
    try {
      assert.equal(JSON.stringify(account.findAcceptance(buy)), JSON.stringify(first), 'the restored receipt still replays');
      assert.equal(account.getOrder(first.order_id)?.status, 'OPEN');
    } finally { account.close(); }
  });
}
