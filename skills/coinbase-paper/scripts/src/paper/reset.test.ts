import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { requireResetConfirmation, resetAccount, type ResetStore } from './reset.ts';
import { resolvePaths } from './store.ts';
import { PaperError, type PaperPaths } from './types.ts';

const OLD_ID = 'paper-6f1c1b8e-6a43-4d5b-9b1e-1c2d3e4f5a6b';
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const code = (expected: string) => (error: unknown) => {
  assert.ok(error instanceof PaperError, String(error));
  assert.equal(error.code, expected, error.message);
  return true;
};

let root: string;
let paths: PaperPaths;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-reset-'));
  paths = resolvePaths(path.join(root, 'data'));
  fs.mkdirSync(paths.dataDir, { mode: 0o700 });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

interface Fake extends ResetStore {
  backups: string[];
  switches: Array<{ replacement: { state: string; account_id: string }; expectedRevision: number }>;
}

function fakeStore(options: { revision?: number; backupRevision?: number; backupError?: PaperError; switchError?: PaperError } = {}): Fake {
  const fake: Fake = {
    accountId: OLD_ID,
    state: '/old/account.sqlite3',
    backups: [],
    switches: [],
    readLedger: () => ({ account: { account_id: OLD_ID, currency: 'USD', initial_cash: '2500', maker_fee_bps: '10', taker_fee_bps: '10', revision: options.revision ?? 7 } }),
    async backup(output) {
      if (options.backupError) throw options.backupError;
      fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
      fs.writeFileSync(output, 'archived', { flag: 'wx', mode: 0o600 });
      fake.backups.push(output);
      return { revision: options.backupRevision ?? options.revision ?? 7 };
    },
    switchBinding(replacement, expectedRevision) {
      if (options.switchError) throw options.switchError;
      fake.switches.push({ replacement, expectedRevision });
    },
  };
  return fake;
}

describe('requireResetConfirmation', () => {
  it('refuses without an explicit true confirmation', () => {
    for (const value of [undefined, false, 'true', 1]) assert.throws(() => requireResetConfirmation(value), code('PAPER_RESET_CONFIRMATION_REQUIRED'));
    assert.doesNotThrow(() => requireResetConfirmation(true));
  });
});

describe('resetAccount', () => {
  it('archives first, creates a fresh account with the same settings, then switches at the archived revision', async () => {
    const store = fakeStore();
    const result = await resetAccount(paths, store, NOW);
    assert.equal(store.backups.length, 1);
    assert.equal(result.archive, store.backups[0]);
    assert.equal(path.dirname(result.archive), path.join(paths.dataDir, 'archives'));
    assert.match(path.basename(result.archive), new RegExp(`^${OLD_ID}-20261014T120000000Z-[0-9a-f-]{36}\\.sqlite3$`));
    assert.equal(fs.readFileSync(result.archive, 'utf8'), 'archived');

    assert.equal(result.previous_account_id, OLD_ID);
    assert.equal(result.previous_state, '/old/account.sqlite3');
    assert.notEqual(result.account_id, OLD_ID);
    assert.match(result.account_id, /^paper-[0-9a-f-]{36}$/);
    assert.equal(result.initial_cash, '2500');
    assert.equal(result.currency, 'USD');
    assert.equal(result.maker_fee_bps, '10');
    assert.equal(result.taker_fee_bps, '10');
    assert.equal(typeof result.schema_version, 'number');
    assert.deepEqual(store.switches, [{ replacement: { state: result.state, account_id: result.account_id }, expectedRevision: 7 }]);

    const staging = path.dirname(result.state);
    assert.equal(path.dirname(staging), fs.realpathSync(path.join(paths.dataDir, 'resets')));
    assert.ok(fs.existsSync(result.state));
    assert.ok(!fs.existsSync(path.join(staging, 'profile.json')), 'the staged account is bound only by the switched profile');
    // Only the data directory changed: no lock or config files were touched.
    assert.deepEqual(fs.readdirSync(paths.dataDir).sort(), ['archives', 'resets']);
    assert.deepEqual(fs.readdirSync(root), ['data']);
  });

  it('stops before creating anything when the archive fails', async () => {
    const store = fakeStore({ backupError: new PaperError('BACKUP_EXISTS', 'exists') });
    let initialized = false;
    await assert.rejects(resetAccount(paths, store, NOW, async () => {
      initialized = true;
      return {};
    }), (error: unknown) => code('PAPER_RESET_FAILED')(error) && /at archive\. Cause: BACKUP_EXISTS/.test((error as Error).message));
    assert.equal(initialized, false);
    assert.equal(store.switches.length, 0);
    assert.ok(!fs.existsSync(path.join(paths.dataDir, 'resets')));
  });

  it('refuses to switch when the ledger changed while archiving', async () => {
    const store = fakeStore({ revision: 7, backupRevision: 8 });
    await assert.rejects(resetAccount(paths, store, NOW), code('STATE_CHANGED'));
    assert.equal(store.switches.length, 0);
    assert.equal(store.backups.length, 1);
    assert.ok(fs.existsSync(store.backups[0]), 'archive kept');
    assert.ok(!fs.existsSync(path.join(paths.dataDir, 'resets')));
  });

  it('keeps the archive and old binding when initialization fails', async () => {
    const store = fakeStore();
    await assert.rejects(resetAccount(paths, store, NOW, async () => {
      throw new PaperError('STATE_PATH_UNAVAILABLE', 'disk full');
    }), code('PAPER_RESET_FAILED'));
    assert.equal(store.switches.length, 0);
    assert.ok(fs.existsSync(store.backups[0]));
  });

  it('refuses a new account that does not carry the original settings', async () => {
    const store = fakeStore();
    await assert.rejects(resetAccount(paths, store, NOW, async () => ({ account_id: 'paper-00000000-0000-4000-8000-000000000000', state: '/x', initial_cash: '10000', currency: 'USD', fee_bps: '10', schema_version: 4 })), code('PAPER_RESET_FAILED'));
    assert.equal(store.switches.length, 0);
  });

  it('reports a concurrent binding change without retrying, keeping staged files', async () => {
    const store = fakeStore({ switchError: new PaperError('STATE_CHANGED', 'revision moved') });
    await assert.rejects(resetAccount(paths, store, NOW), code('STATE_CHANGED'));
    const [staged] = fs.readdirSync(path.join(paths.dataDir, 'resets'));
    assert.ok(fs.existsSync(path.join(paths.dataDir, 'resets', staged, 'account.sqlite3')));
    assert.ok(fs.existsSync(store.backups[0]));
  });

  it('wraps any other switch failure as a safe reset failure', async () => {
    const store = fakeStore({ switchError: new PaperError('STATE_INVALID', 'binding mismatch') });
    await assert.rejects(resetAccount(paths, store, NOW), (error: unknown) => code('PAPER_RESET_FAILED')(error) && /at switch/.test((error as Error).message));
  });
});
