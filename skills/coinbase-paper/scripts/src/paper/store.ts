// Local paper account storage: the simulator keeps virtual balances on this machine and
// never calls a trading API. node:sqlite is imported lazily so help and parsing work on
// Node versions without it.
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { parseDecimalToBigInt } from '../lib/decimal.ts';
import { formatUnits, parseStoredDecimal } from './decimal.ts';
import {
  checkExternalFresh,
  checkFresh,
  checkOrderIntent,
  finishWork,
  insufficientCash,
  insufficientHoldings,
  intentFromLegacyTerms,
  legacyTerms,
  openWork,
  orderTerms,
  parseOrderTime,
  pendingOrder,
  planCancel,
  planEdit,
  planOrder,
  recordLegacyFill,
  summarizeHolds,
  simulate,
  simulateExternal,
  validateInitialAccount,
  type Work,
} from './engine.ts';
import {
  ORDER_MODEL_VERSION,
  PAPER_MODE,
  PAPER_MODEL_VERSION,
  PAPER_NOTICE,
  PaperError,
  type Account,
  type AccountSnapshot,
  type ActivityFilter,
  type CancelResult,
  type EditOrderInput,
  type EquityMetadata,
  type FillFilter,
  type FillResult,
  type Intent,
  type LedgerAccount,
  type LedgerMutation,
  type LedgerSnapshot,
  type OrderEvent,
  type OrderFilter,
  type OrderIntent,
  type OrderReceipt,
  type OrderState,
  type OrderView,
  type Page,
  type PaperFill,
  type PaperPaths,
  type PlacementMarket,
  type PlacementProvenance,
  type Position,
  type ProductRules,
  type Receipt,
  type ReconcileMutation,
} from './types.ts';

const APP_DIR = 'coinbase-paper';
const STATE_FILE = 'account.sqlite3';
const PROFILE_FILE = 'profile.json';
// The earlier unreleased prototype kept per-request JSON files here; its presence
// means the directory holds prototype state that must not be reseeded.
const PROTOTYPE_REQUESTS_DIR = 'requests';
const APP_ID = 0x50415052; // "PAPR", shared with the prototype so its files are recognized.
const PROTOTYPE_SCHEMA_VERSION = 1;
// Schema 2: market-only accounts. Schema 3: schema 2 plus positions.asset_class (equities).
// Schema 4: resting/conditional orders with holds, a fills ledger and order events. Older
// clients accept only 2 and 3, so they refuse (rather than misread) accounts with holds.
const LEGACY_SCHEMA_VERSION = 2;
const EQUITY_SCHEMA_VERSION = 3;
const SCHEMA_VERSION = 4;
const ASSET_CLASS_COLUMN = "asset_class TEXT CHECK (asset_class IS NULL OR asset_class = 'EQUITY')";
const PROFILE_VERSION = 2;
const BUSY_TIMEOUT_MS = 5000;
const MAX_HISTORY = 1000;
const MAX_PROFILE_BYTES = 64 * 1024;
const ACCOUNT_ID = /^paper-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STORED_DECIMAL = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const MONEY_SCALE = 18;
const DURABILITY = 'UNVERIFIED: local files only; host persistence, backups and VM lifetime are not verified.';
const SQLITE_STATUS = 'node:sqlite is not a stable Node API (experimental or release candidate depending on Node version).';

const LEGACY_SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE account (id INTEGER PRIMARY KEY CHECK (id = 1), cash TEXT NOT NULL,
  realized_pnl TEXT NOT NULL, quote_increment TEXT) STRICT;
CREATE TABLE positions (product_id TEXT PRIMARY KEY, quantity TEXT NOT NULL, cost_basis TEXT NOT NULL,
  base_increment TEXT NOT NULL, quote_increment TEXT NOT NULL) STRICT;
CREATE TABLE orders (request_id TEXT PRIMARY KEY, terms TEXT NOT NULL, reserved_at TEXT NOT NULL,
  fill_seq INTEGER UNIQUE, receipt TEXT, CHECK ((fill_seq IS NULL) = (receipt IS NULL))) STRICT;
`;
// Additive schema-4 objects, applied to fresh accounts and by migration.
const ORDER_SCHEMA = `
ALTER TABLE account ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE account ADD COLUMN last_reconciled_at TEXT;
CREATE TABLE order_state (
  order_id TEXT PRIMARY KEY REFERENCES orders(request_id),
  order_seq INTEGER NOT NULL UNIQUE,
  product_id TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  order_type TEXT NOT NULL CHECK (order_type IN ('MARKET', 'LIMIT', 'STOPLIMIT', 'BRACKET')),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'OPEN', 'FILLED', 'CANCELLED', 'EXPIRED')),
  product_type TEXT NOT NULL CHECK (product_type IN ('SPOT', 'EQUITY')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  priority_at TEXT NOT NULL,
  time_in_force TEXT CHECK (time_in_force IS NULL OR time_in_force IN ('GTC', 'GTD', 'IOC', 'FOK')),
  end_time TEXT,
  base_size TEXT,
  filled_size TEXT NOT NULL DEFAULT '0',
  remaining_size TEXT NOT NULL DEFAULT '0',
  limit_price TEXT,
  stop_price TEXT,
  stop_direction TEXT CHECK (stop_direction IS NULL OR stop_direction IN ('STOP_DIRECTION_STOP_UP', 'STOP_DIRECTION_STOP_DOWN')),
  post_only INTEGER NOT NULL DEFAULT 0 CHECK (post_only IN (0, 1)),
  triggered_at TEXT,
  evaluate_after TEXT NOT NULL,
  cash_hold TEXT NOT NULL DEFAULT '0',
  base_hold TEXT NOT NULL DEFAULT '0',
  parent_order_id TEXT REFERENCES orders(request_id),
  attached_take_profit_price TEXT,
  attached_stop_loss_price TEXT,
  take_profit_status TEXT CHECK (take_profit_status IS NULL OR take_profit_status IN ('OPEN', 'CANCELLED', 'FILLED')),
  stop_loss_status TEXT CHECK (stop_loss_status IS NULL OR stop_loss_status IN ('OPEN', 'TRIGGERED', 'CANCELLED', 'FILLED')),
  stop_limit_price TEXT,
  product_rules TEXT,
  terminal_reason TEXT,
  current_receipt TEXT,
  CHECK (status = 'OPEN' OR (cash_hold = '0' AND base_hold = '0')),
  CHECK (status NOT IN ('FILLED', 'CANCELLED', 'EXPIRED') OR remaining_size = '0'),
  CHECK (status <> 'PENDING' OR filled_size = '0')
) STRICT;
CREATE INDEX order_state_open ON order_state (status, product_id, evaluate_after);
CREATE INDEX order_state_product ON order_state (product_id, order_seq);
CREATE INDEX order_state_parent ON order_state (parent_order_id);
CREATE INDEX order_state_created ON order_state (created_at, order_seq);
CREATE TABLE fills (
  fill_seq INTEGER PRIMARY KEY,
  trade_id TEXT NOT NULL UNIQUE,
  order_id TEXT NOT NULL REFERENCES orders(request_id),
  batch_id TEXT NOT NULL,
  batch_index INTEGER NOT NULL,
  product_id TEXT NOT NULL,
  product_type TEXT NOT NULL CHECK (product_type IN ('SPOT', 'EQUITY')),
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  trade_time TEXT NOT NULL,
  price TEXT NOT NULL,
  size TEXT NOT NULL,
  notional TEXT NOT NULL,
  commission TEXT NOT NULL,
  liquidity_indicator TEXT NOT NULL CHECK (liquidity_indicator IN ('MAKER', 'TAKER')),
  cost_basis_removed TEXT NOT NULL DEFAULT '0',
  realized_pnl TEXT,
  source TEXT NOT NULL,
  UNIQUE (batch_id, batch_index)
) STRICT;
CREATE INDEX fills_order ON fills (order_id, fill_seq);
CREATE INDEX fills_product ON fills (product_id, trade_time, fill_seq);
CREATE TABLE order_events (
  event_seq INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  order_id TEXT NOT NULL REFERENCES orders(request_id),
  product_id TEXT NOT NULL,
  event_time TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('ACCEPTED', 'OPENED', 'TRIGGERED', 'FILL', 'EDITED', 'CANCELLED', 'EXPIRED', 'ATTACHED_ACTIVATED', 'AMBIGUOUS_OCO')),
  status TEXT NOT NULL,
  details TEXT NOT NULL
) STRICT;
CREATE INDEX order_events_order ON order_events (order_id, event_seq);
`;
const MAX_PAGE = 1000;
const DEFAULT_PAGE = 50;
const ORDER_STATUSES = new Set(['PENDING', 'OPEN', 'FILLED', 'CANCELLED', 'EXPIRED']);
const PRODUCT_ID = /^[A-Z0-9][A-Z0-9.]{0,14}-[A-Z0-9]{1,10}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Sqlite = typeof import('node:sqlite');

export interface InitOptions {
  cash: string;
  currency: string;
  fee_bps: string;
  maker_fee_bps?: string;
  taker_fee_bps?: string;
  now?: () => number;
}

interface Binding {
  version: number;
  state: string;
  account_id: string;
}

interface FileId {
  dev: number;
  ino: number;
}

// Returns null when this Node can load node:sqlite without flags.
export function unsupportedRuntime(version: string = process.versions.node): string | null {
  const [major = 0, minor = 0] = version.split('.').map((part) => Number.parseInt(part, 10));
  const ok = major >= 24 || (major === 23 && minor >= 4) || (major === 22 && minor >= 13);
  return ok ? null : `Node ${version} cannot run paper storage; it needs Node >=22.13 (or >=23.4 on Node 23). Node 24 LTS is recommended.`;
}

let sqlitePromise: Promise<Sqlite> | undefined;
let sqliteModule: Sqlite | undefined;

// Loading node:sqlite emits a one-time ExperimentalWarning on stderr, which would break the
// JSON-only stderr contract. Drop only that warning while the module loads; doctor and the docs
// disclose the API's stability status instead. Every other warning passes through unchanged.
async function importSqliteQuietly(): Promise<Sqlite> {
  const original = process.emitWarning;
  process.emitWarning = function (this: unknown, warning: string | Error, ...rest: unknown[]) {
    const type = typeof rest[0] === 'string' ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
    const text = typeof warning === 'string' ? warning : warning?.message;
    const kind = warning instanceof Error ? warning.name : type;
    if (kind === 'ExperimentalWarning' && /SQLite/i.test(String(text))) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    return await import('node:sqlite');
  } finally {
    process.emitWarning = original;
  }
}

async function loadSqlite(): Promise<Sqlite> {
  const reason = unsupportedRuntime();
  if (reason) throw new PaperError('UNSUPPORTED_RUNTIME', reason, 'Install Node 24 LTS and retry; no paper state was created or changed.');
  sqlitePromise ??= importSqliteQuietly().then((module) => {
    sqliteModule = module;
    return module;
  }, () => {
    sqlitePromise = undefined;
    throw new PaperError('UNSUPPORTED_RUNTIME', 'This Node build has no usable node:sqlite module.', 'Install Node 24 LTS and retry; no paper state was created or changed.');
  });
  return sqlitePromise;
}

export function resolvePaths(dataDir?: string, env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): PaperPaths {
  let root: string;
  if (dataDir !== undefined) {
    root = requireAbsolute(dataDir, '--data-dir');
  } else if (env.COINBASE_PAPER_HOME) {
    root = requireAbsolute(env.COINBASE_PAPER_HOME, 'COINBASE_PAPER_HOME');
  } else if (env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME)) {
    root = path.join(path.normalize(env.XDG_DATA_HOME), APP_DIR);
  } else {
    if (!home || !path.isAbsolute(home)) {
      throw new PaperError('HOME_UNAVAILABLE', 'Cannot determine an absolute home directory for paper state.', 'Pass --data-dir with an absolute path.');
    }
    root = path.join(path.normalize(home), '.local', 'share', APP_DIR);
  }
  return { dataDir: root, profile: path.join(root, PROFILE_FILE), state: path.join(root, STATE_FILE) };
}

function requireAbsolute(value: string, what: string): string {
  if (!path.isAbsolute(value)) throw new PaperError('INVALID_PATH', `${what} must be an absolute path.`, `Pass an absolute path for ${what}.`);
  return path.normalize(value);
}

function lstat(file: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw pathError(err, file);
  }
}

function pathError(err: unknown, file: string): PaperError {
  const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
  return new PaperError('STATE_PATH_UNAVAILABLE', `Cannot use ${file} (${code}).`, 'Use a writable local filesystem with hard-link support, or pass a different --data-dir.');
}

function ensurePrivateDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw pathError(err, dir);
  }
  let isDir = false;
  try {
    isDir = fs.statSync(dir).isDirectory();
  } catch (err) {
    throw pathError(err, dir);
  }
  if (!isDir) throw new PaperError('INVALID_PATH', `${dir} is not a directory.`, 'Use a directory path, not a file.');
}

function fsyncPath(file: string): void {
  const fd = fs.openSync(file, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncDir(dir: string): void {
  // Windows cannot open a directory for fsync.
  if (process.platform !== 'win32') fsyncPath(dir);
}

// Write into a private temp directory next to the target, make it 0600 and durable,
// then hard-link it into place so an existing target is never replaced.
function publishNew(target: string, build: (tempFile: string) => void, existsCode: string, existsHint: string): void {
  const dir = path.dirname(target);
  ensurePrivateDir(dir);
  let tempDir: string | undefined;
  try {
    if (lstat(target)) throw new PaperError(existsCode, `${target} already exists; refusing to overwrite it.`, existsHint);
    tempDir = fs.mkdtempSync(path.join(dir, `.${path.basename(target)}.`));
    const tempFile = path.join(tempDir, path.basename(target));
    build(tempFile);
    fs.chmodSync(tempFile, 0o600);
    fsyncPath(tempFile);
    try {
      fs.linkSync(tempFile, target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new PaperError(existsCode, `${target} already exists; refusing to overwrite it.`, existsHint);
      throw err;
    }
    fsyncDir(dir);
  } catch (err) {
    if (err instanceof PaperError) throw err;
    throw pathError(err, target);
  } finally {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

const SQLITE_READONLY_ROLLBACK = 776;

function sqliteError(err: unknown, action: string): PaperError {
  if (err instanceof PaperError) return err;
  const errcode = (err as { errcode?: number }).errcode;
  if (errcode !== undefined && ((errcode & 0xff) === 5 || (errcode & 0xff) === 6)) {
    return new PaperError('STATE_BUSY', 'Paper state is busy.', 'Retry the same command with the same client_order_id.');
  }
  // SQLITE_READONLY_ROLLBACK: a writer was interrupted and left a hot rollback journal. Read-only
  // checks (doctor, bind) cannot roll it back; the account is not corrupt.
  if (errcode === SQLITE_READONLY_ROLLBACK) {
    return new PaperError(
      'STATE_RECOVERY_PENDING',
      'An interrupted paper write is waiting to be rolled back; the account is not known to be corrupt.',
      'Run coinbase-paper balance on the data directory bound to this file; opening the account rolls back the unfinished write. Then rerun this command. Do not run init and do not restore or bind a backup as a guess.',
    );
  }
  return new PaperError('STATE_INVALID', `Paper state could not be ${action}.`, 'Run coinbase-paper doctor. Do not initialize a new account over existing state.');
}

function connect(sqlite: Sqlite, file: string, readOnly = false): DatabaseSync {
  const db = new sqlite.DatabaseSync(file, readOnly ? { readOnly: true } : {});
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    if (!readOnly) db.exec('PRAGMA synchronous = FULL');
    db.exec('PRAGMA foreign_keys = ON');
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

function pragma(db: DatabaseSync, name: 'application_id' | 'user_version'): unknown {
  return (db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined)?.[name];
}

function checkDecimal(value: unknown, negativeOk = false): string {
  if (typeof value !== 'string' || !STORED_DECIMAL.test(value) || (!negativeOk && value.startsWith('-'))) {
    throw new PaperError('STATE_INVALID', 'Paper state contains an invalid amount.', 'Run coinbase-paper doctor; restore from a backup if needed.');
  }
  return value;
}

function checkSchema(db: DatabaseSync): number {
  if (pragma(db, 'application_id') !== APP_ID) {
    throw new PaperError('STATE_INVALID', 'File is not a paper-trading account.', 'Bind a paper account file created by coinbase-paper init or backup.');
  }
  const version = pragma(db, 'user_version');
  if (version === PROTOTYPE_SCHEMA_VERSION) {
    throw new PaperError(
      'STATE_UNSUPPORTED',
      'This account uses the earlier prototype format (schema 1). It was left unchanged and is not supported by this CLI.',
      'Keep the file. Use a new empty --data-dir with coinbase-paper init for a native account; no automatic migration exists.',
    );
  }
  if (version !== LEGACY_SCHEMA_VERSION && version !== EQUITY_SCHEMA_VERSION && version !== SCHEMA_VERSION) {
    throw new PaperError('STATE_UNSUPPORTED', `Unsupported paper state schema version ${String(version)}.`, 'Upgrade coinbase-cli; the file was left unchanged.');
  }
  return version;
}

function loadAccount(db: DatabaseSync, expectedId: string): LedgerAccount {
  const version = checkSchema(db);
  const meta = new Map<string, string>();
  for (const row of db.prepare('SELECT key, value FROM meta').all() as Array<{ key: string; value: string }>) meta.set(row.key, row.value);
  const model = version === SCHEMA_VERSION ? ORDER_MODEL_VERSION : PAPER_MODEL_VERSION;
  if (meta.get('schema_version') !== String(version) || meta.get('model_version') !== model) {
    throw new PaperError('STATE_UNSUPPORTED', 'Unsupported paper state or fill model version.', 'Upgrade coinbase-cli; the file was left unchanged.');
  }
  const accountId = meta.get('account_id');
  if (!accountId) throw new PaperError('STATE_INVALID', 'Paper state has no account ID.', 'Run coinbase-paper doctor; restore from a backup if needed.');
  if (accountId !== expectedId) {
    throw new PaperError('ACCOUNT_MISMATCH', 'Paper account ID does not match the bound account.', 'Stop and verify the account binding with coinbase-paper doctor.');
  }
  const current = version === SCHEMA_VERSION;
  const row = db.prepare(`SELECT cash, realized_pnl, quote_increment${current ? ', revision, last_reconciled_at' : ''} FROM account WHERE id = 1`).get() as Record<string, unknown> | undefined;
  const currency = meta.get('currency');
  const createdAt = meta.get('created_at');
  if (!row || !currency || !createdAt) {
    throw new PaperError('STATE_INVALID', 'Paper state is missing account data.', 'Run coinbase-paper doctor; restore from a backup if needed.');
  }
  const fee = checkDecimal(meta.get('fee_bps'));
  const revision = current ? row.revision : 0;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) throw invalidState('Paper state has an invalid revision.');
  const reconciled = current ? row.last_reconciled_at ?? null : null;
  if (reconciled !== null && !isIsoTime(reconciled)) throw invalidState('Paper state has an invalid reconciliation time.');
  return {
    account_id: accountId,
    currency,
    initial_cash: checkDecimal(meta.get('initial_cash')),
    cash: checkDecimal(row.cash),
    realized_pnl: checkDecimal(row.realized_pnl, true),
    fee_bps: fee,
    quote_increment: row.quote_increment === null ? null : checkDecimal(row.quote_increment),
    created_at: createdAt,
    maker_fee_bps: current ? checkDecimal(meta.get('maker_fee_bps')) : fee,
    taker_fee_bps: current ? checkDecimal(meta.get('taker_fee_bps')) : fee,
    revision,
    last_reconciled_at: reconciled as string | null,
  };
}

function invalidState(message: string): PaperError {
  return new PaperError('STATE_INVALID', message, 'Stop and run coinbase-paper doctor; do not reinitialize or edit the account.');
}

function isIsoTime(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && new Date(value).toISOString() === value;
}

function loadPositions(db: DatabaseSync): Position[] {
  const classColumn = checkSchema(db) === LEGACY_SCHEMA_VERSION ? '' : ', asset_class';
  const rows = db.prepare(`SELECT product_id, quantity, cost_basis, base_increment, quote_increment${classColumn} FROM positions ORDER BY product_id`).all() as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const position: Position = {
      product_id: String(row.product_id),
      quantity: checkDecimal(row.quantity),
      cost_basis: checkDecimal(row.cost_basis),
      base_increment: checkDecimal(row.base_increment),
      quote_increment: checkDecimal(row.quote_increment),
    };
    const assetClass = row.asset_class ?? null;
    if (assetClass === 'EQUITY') position.asset_class = 'EQUITY';
    else if (assetClass !== null) throw new PaperError('STATE_INVALID', 'Paper state contains an unknown position asset class.', 'Upgrade coinbase-cli or run coinbase-paper doctor; the file was left unchanged.');
    return position;
  });
}

// Serialized market order terms; the exact legacy serialization, so existing pending and
// filled orders still match their retries.
function terms(intent: Intent): string {
  return legacyTerms(intent);
}

function scaled(value: string): bigint {
  try {
    return parseDecimalToBigInt(value, MONEY_SCALE);
  } catch {
    throw new PaperError('STATE_INVALID', 'Simulation produced an amount outside the supported precision.', 'Do not retry with a different client_order_id; report this defect.');
  }
}

function fileId(file: string): FileId | undefined {
  const stat = lstat(file);
  return stat?.isFile() ? { dev: stat.dev, ino: stat.ino } : undefined;
}

function readBinding(paths: PaperPaths): Binding {
  const stat = lstat(paths.profile);
  if (!stat) {
    const unbound = lstat(paths.state) !== undefined;
    throw new PaperError(
      'PROFILE_NOT_FOUND',
      unbound ? `An account file exists at ${paths.state} but is not bound.` : `No paper account is bound in ${paths.dataDir}.`,
      unbound
        ? 'Run coinbase-paper doctor to see its account ID, then coinbase-paper bind. Do not initialize.'
        : 'Run coinbase-paper init only for an explicitly new account, or bind an existing account file.',
    );
  }
  const invalid = new PaperError('PROFILE_INVALID', `${paths.profile} is not a valid account binding.`, 'Restore or remove the binding manually after checking which account it names; do not initialize.');
  if (!stat.isFile() || stat.size > MAX_PROFILE_BYTES) throw invalid;
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(paths.profile, 'utf8'));
  } catch {
    throw invalid;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid;
  const record = value as Record<string, unknown>;
  if (record.version === 1) {
    throw new PaperError(
      'PROFILE_UNSUPPORTED',
      'This binding is from the earlier prototype format and is not supported by this CLI. It was left unchanged.',
      'Keep the files. Use a new empty --data-dir with coinbase-paper init for a native account; no automatic migration exists.',
    );
  }
  const keys = Object.keys(record).sort().join(',');
  if (
    keys !== 'account_id,state,version' ||
    record.version !== PROFILE_VERSION ||
    typeof record.state !== 'string' ||
    !path.isAbsolute(record.state) ||
    typeof record.account_id !== 'string' ||
    !ACCOUNT_ID.test(record.account_id)
  ) {
    throw invalid;
  }
  return { version: PROFILE_VERSION, state: record.state, account_id: record.account_id };
}

function checkStateFile(state: string): string {
  const resolved = requireAbsolute(state, 'state path');
  const stat = lstat(resolved);
  if (!stat) {
    throw new PaperError('STATE_NOT_FOUND', `No paper account file at ${resolved}.`, 'Restore the file or bind a backup; do not initialize a replacement.');
  }
  if (!stat.isFile()) throw new PaperError('INVALID_PATH', `${resolved} must be a regular file, not a symlink or directory.`, 'Bind the real account file path.');
  return resolved;
}

function hasPrototypeArtifacts(paths: PaperPaths): boolean {
  return lstat(path.join(paths.dataDir, PROTOTYPE_REQUESTS_DIR)) !== undefined;
}

export async function doctor(paths: PaperPaths): Promise<Record<string, unknown>> {
  const report: Record<string, unknown> = {
    mode: PAPER_MODE,
    ok: true,
    ready: false,
    node: process.versions.node,
    sqlite_status: SQLITE_STATUS,
    network: 'not used by doctor',
    durability: DURABILITY,
    data_dir: paths.dataDir,
    data_dir_exists: lstat(paths.dataDir)?.isDirectory() ?? false,
    profile: paths.profile,
  };
  if (hasPrototypeArtifacts(paths)) report.prototype_artifacts = true;
  let sqlite: Sqlite;
  try {
    sqlite = await loadSqlite();
  } catch (err) {
    return fail(report, err);
  }
  let binding: Binding | undefined;
  try {
    binding = readBinding(paths);
    report.profile_status = 'OK';
  } catch (err) {
    const code = (err as PaperError).code;
    if (code !== 'PROFILE_NOT_FOUND') {
      report.profile_status = code === 'PROFILE_UNSUPPORTED' ? 'UNSUPPORTED' : 'INVALID';
      return fail(report, err);
    }
    report.profile_status = 'MISSING';
    report.hint = (err as PaperError).hint;
  }
  const state = binding?.state ?? paths.state;
  report.state = state;
  if (!binding && !lstat(state)) {
    report.state_status = 'MISSING';
    return report;
  }
  try {
    const file = checkStateFile(state);
    const db = connect(sqlite, file, true);
    try {
      report.sqlite = (db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v;
      const schemaVersion = checkSchema(db);
      const meta = db.prepare("SELECT value FROM meta WHERE key = 'account_id'").get() as { value: string } | undefined;
      const accountId = binding?.account_id ?? meta?.value ?? '';
      loadAccount(db, accountId);
      const check = db.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined;
      if (check?.quick_check !== 'ok') throw new PaperError('STATE_INVALID', 'Paper state failed the SQLite integrity check.', 'Restore from a backup; the file was left unchanged.');
      const counts = db.prepare('SELECT COUNT(receipt) AS filled, COUNT(*) - COUNT(receipt) AS pending FROM orders').get() as { filled: number; pending: number };
      report.account_id = accountId;
      report.order_count = counts.filled;
      report.pending_count = counts.pending;
      report.schema_version = schemaVersion;
      report.model_version = schemaVersion === SCHEMA_VERSION ? ORDER_MODEL_VERSION : PAPER_MODEL_VERSION;
      if (schemaVersion !== SCHEMA_VERSION) report.migration = `schema ${schemaVersion} will be upgraded to schema ${SCHEMA_VERSION} by the next paper account command (balance, orders, backup); doctor and bind never change it`;
      report.state_status = binding ? 'OK' : 'UNBOUND';
      report.ready = binding !== undefined;
    } finally {
      db.close();
    }
  } catch (err) {
    const error = sqliteError(err, 'read');
    report.state_status = error.code === 'STATE_UNSUPPORTED' ? 'UNSUPPORTED' : error.code === 'STATE_NOT_FOUND' ? 'MISSING' : error.code === 'STATE_RECOVERY_PENDING' ? 'RECOVERY_PENDING' : 'INVALID';
    return fail(report, error);
  }
  return report;
}

function fail(report: Record<string, unknown>, err: unknown): Record<string, unknown> {
  const error = err instanceof PaperError ? err : sqliteError(err, 'read');
  return { ...report, ok: false, ready: false, error: { code: error.code, message: error.message, hint: error.hint } };
}

export async function initAccount(paths: PaperPaths, options: InitOptions): Promise<Record<string, unknown>> {
  const sqlite = await loadSqlite();
  const initial = validateInitialAccount(options.cash, options.currency, options.fee_bps, options.maker_fee_bps, options.taker_fee_bps);
  for (const existing of [paths.profile, paths.state, path.join(paths.dataDir, PROTOTYPE_REQUESTS_DIR)]) {
    if (lstat(existing)) {
      throw new PaperError('ACCOUNT_EXISTS', `${existing} already exists; init never reseeds or replaces an account.`, 'Use coinbase-paper balance or doctor, or pass a new empty --data-dir.');
    }
  }
  const accountId = `paper-${randomUUID()}`;
  const createdAt = new Date((options.now ?? Date.now)()).toISOString();
  const meta: Array<[string, string]> = [
    ['app', APP_DIR],
    ['schema_version', String(SCHEMA_VERSION)],
    ['model_version', ORDER_MODEL_VERSION],
    ['account_id', accountId],
    ['currency', initial.currency],
    ['initial_cash', initial.cash],
    ['fee_bps', initial.fee_bps],
    ['created_at', createdAt],
    ['maker_fee_bps', initial.maker_fee_bps],
    ['taker_fee_bps', initial.taker_fee_bps],
  ];
  publishNew(
    paths.state,
    (temp) => {
      const db = connect(sqlite, temp);
      try {
        db.exec('PRAGMA journal_mode = DELETE');
        db.exec('BEGIN IMMEDIATE');
        db.exec(`PRAGMA application_id = ${APP_ID}`);
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        db.exec(LEGACY_SCHEMA);
        db.exec(`ALTER TABLE positions ADD COLUMN ${ASSET_CLASS_COLUMN}`);
        db.exec(ORDER_SCHEMA);
        const insert = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
        for (const [key, value] of meta) insert.run(key, value);
        db.prepare("INSERT INTO account (id, cash, realized_pnl, quote_increment) VALUES (1, ?, '0', NULL)").run(initial.cash);
        db.exec('COMMIT');
      } finally {
        db.close();
      }
    },
    'ACCOUNT_EXISTS',
    'Use coinbase-paper balance or doctor; init never replaces an account.',
  );
  let state = paths.state;
  try {
    state = path.join(fs.realpathSync(path.dirname(paths.state)), path.basename(paths.state));
    writeBinding(paths, { version: PROFILE_VERSION, state, account_id: accountId });
  } catch (err) {
    const message = err instanceof PaperError ? err.message : String(err);
    throw new PaperError(
      'INIT_INCOMPLETE',
      `Account ${accountId} was created at ${paths.state} but not bound: ${message}`,
      `Run coinbase-paper bind --state ${paths.state} --account-id ${accountId}. Do not run init again.`,
    );
  }
  return {
    mode: PAPER_MODE,
    ok: true,
    account_id: accountId,
    data_dir: paths.dataDir,
    profile: paths.profile,
    state,
    currency: initial.currency,
    initial_cash: initial.cash,
    cash: initial.cash,
    fee_bps: initial.fee_bps,
    maker_fee_bps: initial.maker_fee_bps,
    taker_fee_bps: initial.taker_fee_bps,
    fee_note: 'Assumed maker/taker fees for simulation, not your Coinbase fee tier. fee_bps is a deprecated alias of taker_fee_bps.',
    schema_version: SCHEMA_VERSION,
    model_version: ORDER_MODEL_VERSION,
    durability: DURABILITY,
    notice: PAPER_NOTICE,
  };
}

function writeBinding(paths: PaperPaths, binding: Binding): boolean {
  const text = `${JSON.stringify(binding, null, 2)}\n`;
  try {
    publishNew(
      paths.profile,
      (temp) => {
        fs.writeFileSync(temp, text, { mode: 0o600, flag: 'wx' });
      },
      'PROFILE_EXISTS',
      'A different account is already bound here; do not replace it. Use another --data-dir.',
    );
    return true;
  } catch (err) {
    if (!(err instanceof PaperError) || err.code !== 'PROFILE_EXISTS') throw err;
    const current = readBinding(paths);
    if (current.state === binding.state && current.account_id === binding.account_id) return false;
    throw err;
  }
}

export async function bindAccount(paths: PaperPaths, state: string, accountId: string): Promise<Record<string, unknown>> {
  const sqlite = await loadSqlite();
  if (!ACCOUNT_ID.test(accountId)) {
    throw new PaperError('INVALID_ARGUMENT', '--account-id must be a paper account ID such as paper-<uuid>.', 'Run coinbase-paper doctor to read the account ID.');
  }
  const file = checkStateFile(state);
  let resolved: string;
  try {
    resolved = path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
  } catch (err) {
    throw pathError(err, file);
  }
  try {
    const db = connect(sqlite, resolved, true);
    try {
      loadAccount(db, accountId);
      const check = db.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined;
      if (check?.quick_check !== 'ok') throw new PaperError('STATE_INVALID', 'Paper state failed the SQLite integrity check.', 'Bind a different backup; the file was left unchanged.');
    } finally {
      db.close();
    }
  } catch (err) {
    throw sqliteError(err, 'read');
  }
  const created = writeBinding(paths, { version: PROFILE_VERSION, state: resolved, account_id: accountId });
  return { mode: PAPER_MODE, ok: true, data_dir: paths.dataDir, profile: paths.profile, state: resolved, account_id: accountId, created };
}

export async function openAccount(paths: PaperPaths): Promise<PaperStore> {
  const sqlite = await loadSqlite();
  const binding = readBinding(paths);
  const file = checkStateFile(binding.state);
  const before = fileId(file);
  let db: DatabaseSync;
  try {
    db = connect(sqlite, file);
  } catch (err) {
    throw sqliteError(err, 'opened');
  }
  const store = new PaperStore(db, file, binding.account_id, before, paths);
  try {
    store.migrate();
    store.readSnapshot();
  } catch (err) {
    store.close();
    throw err;
  }
  return store;
}

type Mutation = Pick<LedgerMutation, 'account' | 'positions' | 'orders' | 'fills' | 'events' | 'acceptances'>;

const ORDER_COLUMNS = [
  'order_id', 'order_seq', 'product_id', 'side', 'order_type', 'status', 'product_type', 'created_at', 'updated_at',
  'priority_at', 'time_in_force', 'end_time', 'base_size', 'filled_size', 'remaining_size', 'limit_price', 'stop_price',
  'stop_direction', 'post_only', 'triggered_at', 'evaluate_after', 'cash_hold', 'base_hold', 'parent_order_id',
  'attached_take_profit_price', 'attached_stop_loss_price', 'take_profit_status', 'stop_loss_status', 'stop_limit_price',
  'product_rules', 'terminal_reason', 'current_receipt',
] as const;
const FILL_COLUMNS = [
  'trade_id', 'order_id', 'batch_id', 'batch_index', 'product_id', 'product_type', 'side', 'trade_time', 'price', 'size',
  'notional', 'commission', 'liquidity_indicator', 'cost_basis_removed', 'realized_pnl', 'source',
] as const;

export class PaperStore {
  readonly accountId: string;
  readonly state: string;
  #db: DatabaseSync | undefined;
  #fileId: FileId | undefined;
  #paths: PaperPaths | undefined;

  constructor(db: DatabaseSync, state: string, accountId: string, opened: FileId | undefined, paths?: PaperPaths) {
    this.#db = db;
    this.state = state;
    this.accountId = accountId;
    this.#fileId = opened;
    this.#paths = paths;
  }

  /**
   * Upgrades a schema-2 or schema-3 account to schema 4 in one transaction:
   * additive tables, then a backfill of every stored receipt (in fill order) as
   * MARKET/FILLED orders with TAKER fills and events, verified against the stored
   * cash, P&L and positions. Original terms, receipts and sequences are untouched.
   */
  migrate(): void {
    this.#transaction('BEGIN IMMEDIATE', 'upgraded', (db) => {
      const version = checkSchema(db);
      const account = loadAccount(db, this.accountId);
      if (version === SCHEMA_VERSION) return;
      if (version === LEGACY_SCHEMA_VERSION) {
        db.exec(`ALTER TABLE positions ADD COLUMN ${ASSET_CLASS_COLUMN}`);
      } else {
        const columns = (db.prepare('PRAGMA table_info(positions)').all() as Array<{ name: string }>).map((row) => row.name);
        if (!columns.includes('asset_class')) throw invalidState('Schema-3 paper state has no positions.asset_class column.');
      }
      db.exec(ORDER_SCHEMA);
      const insertMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
      insertMeta.run('maker_fee_bps', account.fee_bps);
      insertMeta.run('taker_fee_bps', account.fee_bps);
      const positions = loadPositions(db);
      const work = openWork({
        account: { ...account, cash: account.initial_cash, realized_pnl: '0', quote_increment: null, maker_fee_bps: account.fee_bps, taker_fee_bps: account.fee_bps },
        positions: [],
        orders: [],
        fills: [],
        events: [],
        holds: { cash: '0', positions: {} },
      });
      const rows = db.prepare('SELECT request_id, terms, reserved_at, fill_seq, receipt FROM orders ORDER BY fill_seq IS NULL, fill_seq, reserved_at, request_id').all() as Array<{ request_id: string; terms: string; reserved_at: string; fill_seq: number | null; receipt: string | null }>;
      let seq = 0;
      const pending: OrderState[] = [];
      for (const row of rows) {
        seq = row.fill_seq ?? seq + 1;
        if (row.receipt !== null) {
          if (!Number.isSafeInteger(row.fill_seq)) throw invalidState('A stored order has an invalid fill sequence.');
          const receipt = parseReceipt(row.receipt, this.accountId, row.request_id);
          recordLegacyFill(work, receipt, row.fill_seq as number, normalizeTime(row.reserved_at));
        } else {
          pending.push(pendingOrder(intentFromLegacyTerms(row.terms), seq, normalizeTime(row.reserved_at)));
        }
      }
      for (const order of pending) {
        work.orders.set(order.order_id, order);
        work.touchedOrders.add(order.order_id);
      }
      const result = finishWork(work);
      const expected = new Map(positions.map((p) => [p.product_id, p]));
      const rebuilt = result.positions.filter((p): p is Position => !('deleted' in p));
      const same = (a: string, b: string) => scaled(a) === scaled(b);
      if (!same(result.account.cash, account.cash) || !same(result.account.realized_pnl, account.realized_pnl)
        || rebuilt.length !== expected.size
        || rebuilt.some((p) => {
          const stored = expected.get(p.product_id);
          return !stored || !same(stored.quantity, p.quantity) || !same(stored.cost_basis, p.cost_basis) || (stored.asset_class === 'EQUITY') !== (p.asset_class === 'EQUITY');
        })) {
        throw invalidState('Paper order history does not reproduce the stored cash, P&L and positions; the account was left at its previous schema.');
      }
      // Positions and account balances stay exactly as stored; only order rows are added.
      this.#writeRows(db, { ...result, positions: [], acceptances: [] }, false);
      db.prepare("UPDATE meta SET value = ? WHERE key = 'model_version'").run(ORDER_MODEL_VERSION);
      db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION));
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  }

  readSnapshot(): AccountSnapshot {
    return this.#transaction('BEGIN', 'read', (db) => ({ account: loadAccount(db, this.accountId), positions: loadPositions(db) }));
  }

  /** Complete ledger (all orders, fills and events) for planners and reports. */
  readLedger(): LedgerSnapshot {
    return this.#transaction('BEGIN', 'read', (db) => this.#ledger(db));
  }

  reserve(intent: Intent): Receipt | null {
    return this.#transaction('BEGIN IMMEDIATE', 'updated', (db) => {
      loadAccount(db, this.accountId);
      this.#checkIntentAccount(intent);
      const existing = this.#order(db, intent);
      if (existing) return existing.receipt;
      const reservedAt = new Date().toISOString();
      this.#insertPending(db, { operation: 'create', ...intent, type: 'market' }, terms(intent), reservedAt);
      return null;
    });
  }

  /** The stored first result for these terms (legacy receipts keep their original shape); null if absent or unresolved. */
  findAcceptance(intent: OrderIntent): OrderReceipt | null {
    const checked = checkOrderIntent(intent);
    return this.#transaction('BEGIN', 'read', (db) => {
      loadAccount(db, this.accountId);
      return this.#acceptance(db, checked);
    });
  }

  /** Records the request terms (PENDING, no hold) before any market read, or returns the stored first result. */
  reserveOrder(intent: OrderIntent, now: number): OrderReceipt | null {
    const checked = checkOrderIntent(intent);
    return this.#transaction('BEGIN IMMEDIATE', 'updated', (db) => {
      loadAccount(db, this.accountId);
      this.#checkAccountId(checked.account_id);
      const row = db.prepare('SELECT 1 FROM orders WHERE request_id = ?').get(checked.request_id);
      if (row) return this.#acceptance(db, checked);
      this.#insertPending(db, checked, orderTerms(checked), new Date(now).toISOString());
      return null;
    });
  }

  /**
   * Removes this request's PENDING reservation when placement was rejected for a reason no retry
   * can fix (for example a missing equity quote). Only an unexecuted reservation with identical
   * terms, no receipt, no hold, no fills and no events is removed; anything else is left alone.
   * Returns true when a reservation was removed.
   */
  abandonReservation(intent: OrderIntent): boolean {
    const checked = checkOrderIntent(intent);
    return this.#transaction('BEGIN IMMEDIATE', 'updated', (db) => {
      loadAccount(db, this.accountId);
      const row = db.prepare('SELECT terms, receipt FROM orders WHERE request_id = ?').get(checked.request_id) as { terms: string; receipt: string | null } | undefined;
      if (!row || row.receipt !== null || row.terms !== orderTerms(checked)) return false;
      const state = db.prepare("SELECT status, filled_size, cash_hold, base_hold FROM order_state WHERE order_id = ?").get(checked.request_id) as Record<string, unknown> | undefined;
      if (!state || state.status !== 'PENDING' || scaled(String(state.filled_size)) !== 0n || scaled(String(state.cash_hold)) !== 0n || scaled(String(state.base_hold)) !== 0n) return false;
      const used = db.prepare('SELECT (SELECT COUNT(*) FROM fills WHERE order_id = ?) + (SELECT COUNT(*) FROM order_events WHERE order_id = ?) AS n').get(checked.request_id, checked.request_id) as { n: number };
      if (used.n !== 0) return false;
      db.prepare('DELETE FROM order_state WHERE order_id = ?').run(checked.request_id);
      db.prepare('DELETE FROM orders WHERE request_id = ?').run(checked.request_id);
      db.prepare('UPDATE account SET revision = revision + 1 WHERE id = 1').run();
      return true;
    });
  }

  /**
   * Places a reserved (or new) order against fresh market data under the write
   * lock. A request that already has a stored result returns it unchanged, so a
   * concurrent same-ID create returns the winner's receipt. `provenance` is stored
   * in the first receipt only.
   */
  placeOrder(intent: OrderIntent, market: PlacementMarket, now: () => number, provenance?: PlacementProvenance): OrderReceipt {
    const checked = checkOrderIntent(intent);
    return this.#transaction('BEGIN IMMEDIATE', 'updated', (db) => {
      loadAccount(db, this.accountId);
      this.#checkAccountId(checked.account_id);
      const exists = db.prepare('SELECT 1 FROM orders WHERE request_id = ?').get(checked.request_id);
      if (exists) {
        const prior = this.#acceptance(db, checked);
        if (prior) return prior;
      } else {
        this.#insertPending(db, checked, orderTerms(checked), new Date(now()).toISOString());
      }
      const ledger = this.#ledger(db);
      const mutation = planOrder(ledger, checked, market, now(), provenance);
      this.#apply(db, ledger.account.revision, mutation);
      // Market data must still be fresh after any wait for the write lock.
      recheckMarket(market, checked, now());
      return JSON.parse(JSON.stringify(mutation.receipt)) as OrderReceipt;
    });
  }

  /** Close-position is a market SELL placed through placeOrder. */
  closePosition(intent: OrderIntent, market: PlacementMarket, now: () => number, provenance?: PlacementProvenance): OrderReceipt {
    if (intent?.operation !== 'close-position') throw new PaperError('INVALID_REQUEST', 'closePosition needs a close-position intent');
    return this.placeOrder(intent, market, now, provenance);
  }

  /** Edits an open order atomically; old terms and holds remain on any failure. A no-op edit writes nothing. */
  editOrder(orderId: string, edit: EditOrderInput, market: PlacementMarket | null, now: () => number): OrderReceipt {
    const id = normalizeId(orderId);
    return this.#transaction('BEGIN IMMEDIATE', 'updated', (db) => {
      const account = loadAccount(db, this.accountId);
      const mutation = planEdit(this.#ledger(db), id, edit, market, now());
      if (mutation.receipt.edited === true) {
        this.#apply(db, account.revision, mutation);
        if (market) recheckMarket(market, null, now());
      }
      return mutation.receipt;
    });
  }

  /** Cancels open or pending orders, releasing only their stored remaining holds. */
  cancelOrders(orderIds: string[], now: number): CancelResult[] {
    return this.#transaction('BEGIN IMMEDIATE', 'updated', (db) => {
      const account = loadAccount(db, this.accountId);
      const mutation = planCancel(this.#ledger(db), orderIds, now);
      if (mutation.orders.length > 0) this.#apply(db, account.revision, mutation);
      return mutation.results;
    });
  }

  /** Commits a reconciliation plan only if the ledger is still at the planned revision. */
  applyReconciliation(expectedRevision: number, mutation: ReconcileMutation): boolean {
    return this.#transaction('BEGIN IMMEDIATE', 'updated', (db) => {
      const account = loadAccount(db, this.accountId);
      if (account.revision !== expectedRevision) return false;
      this.#apply(db, account.revision, mutation);
      return true;
    });
  }

  /** The stored current view (checked against this account), or the minimal pending view. */
  #currentView(order: OrderState): OrderReceipt {
    if (order.current_receipt === null) return pendingView(order, this.accountId);
    if (order.current_receipt.account_id !== this.accountId) throw invalidState('Paper order view does not match its order.');
    return order.current_receipt;
  }

  getOrder(orderId: string): OrderView | undefined {
    const id = normalizeId(orderId);
    return this.#transaction('BEGIN', 'read', (db) => {
      loadAccount(db, this.accountId);
      const row = db.prepare('SELECT * FROM order_state WHERE order_id = ?').get(id) as Record<string, unknown> | undefined;
      if (!row) return undefined;
      const order = parseOrderRow(row);
      const events = (db.prepare('SELECT * FROM order_events WHERE order_id = ? ORDER BY event_seq').all(id) as Array<Record<string, unknown>>).map(parseEventRow);
      const view = this.#currentView(order);
      return { ...view, status_history: events };
    });
  }

  listOrders(filter: OrderFilter = {}): Page<OrderView> {
    const f = checkFilter(filter, ['status', 'product_ids', 'side', 'product_type', 'start', 'end', 'limit', 'cursor']);
    return this.#transaction('BEGIN', 'read', (db) => {
      loadAccount(db, this.accountId);
      const where: string[] = [];
      const args: Array<string | number> = [];
      if (f.status !== undefined) {
        if (!ORDER_STATUSES.has(f.status)) throw filterError('status must be PENDING, OPEN, FILLED, CANCELLED or EXPIRED');
        where.push('status = ?');
        args.push(f.status);
      }
      if (f.product_type !== undefined) {
        if (f.product_type === 'FUTURE') where.push('0');
        else if (f.product_type === 'SPOT' || f.product_type === 'EQUITY') { where.push('product_type = ?'); args.push(f.product_type); }
        else throw filterError('product_type must be SPOT, EQUITY or FUTURE');
      }
      addCommon(where, args, f, 'created_at');
      return this.#page(db, 'orders', 'order_state', 'order_seq', 'DESC', where, args, f, (row) => {
        const order = parseOrderRow(row);
        return { ...this.#currentView(order), status_history: [] } as OrderView;
      });
    });
  }

  listFills(filter: FillFilter = {}): Page<PaperFill> {
    const f = checkFilter(filter, ['order_ids', 'product_ids', 'side', 'start', 'end', 'limit', 'cursor']);
    return this.#transaction('BEGIN', 'read', (db) => {
      loadAccount(db, this.accountId);
      const where: string[] = [];
      const args: Array<string | number> = [];
      addCommon(where, args, f, 'trade_time');
      return this.#page(db, 'fills', 'fills', 'fill_seq', 'DESC', where, args, f, parseFillRow);
    });
  }

  listActivity(filter: ActivityFilter = {}): Page<OrderEvent> {
    const f = checkFilter(filter, ['order_ids', 'product_ids', 'start', 'end', 'limit', 'cursor']);
    return this.#transaction('BEGIN', 'read', (db) => {
      loadAccount(db, this.accountId);
      const where: string[] = [];
      const args: Array<string | number> = [];
      addCommon(where, args, f, 'event_time');
      return this.#page(db, 'activity', 'order_events', 'event_seq', 'ASC', where, args, f, parseEventRow);
    });
  }

  /**
   * Atomically rebinds this data directory to a replacement account, only if this
   * account is still at `expectedRevision` and still bound. Holds this account's
   * write lock across the profile rename, so no write can land in between.
   */
  switchBinding(replacement: { state: string; account_id: string }, expectedRevision: number): void {
    const paths = this.#paths;
    if (!paths) throw new PaperError('STATE_CHANGED', 'This account was not opened from a binding.', 'Open the account with its --data-dir and retry.');
    if (!ACCOUNT_ID.test(replacement.account_id) || replacement.account_id === this.accountId) {
      throw new PaperError('INVALID_ARGUMENT', 'Replacement must be a different paper account ID.', 'Create the replacement account first.');
    }
    const file = checkStateFile(replacement.state);
    const sqlite = sqliteModule;
    if (!sqlite) throw new PaperError('UNSUPPORTED_RUNTIME', 'node:sqlite is not loaded.', 'Install Node 24 LTS and retry.');
    try {
      const copy = connect(sqlite, file, true);
      try {
        if (checkSchema(copy) !== SCHEMA_VERSION) throw invalidState('Replacement account is not schema 4.');
        loadAccount(copy, replacement.account_id);
      } finally {
        copy.close();
      }
    } catch (err) {
      throw sqliteError(err, 'read');
    }
    this.#transaction('BEGIN IMMEDIATE', 'rebound', (db) => {
      const account = loadAccount(db, this.accountId);
      if (account.revision !== expectedRevision) {
        throw new PaperError('STATE_CHANGED', 'The paper account changed after it was archived; the binding was not switched.', 'Run the command again; the archive and staged files are kept.');
      }
      const text = `${JSON.stringify({ version: PROFILE_VERSION, state: file, account_id: replacement.account_id }, null, 2)}\n`;
      const temp = path.join(paths.dataDir, `.${PROFILE_FILE}.${randomUUID()}`);
      try {
        fs.writeFileSync(temp, text, { mode: 0o600, flag: 'wx' });
        fsyncPath(temp);
        fs.renameSync(temp, paths.profile);
        fsyncDir(paths.dataDir);
      } catch (err) {
        fs.rmSync(temp, { force: true });
        throw pathError(err, paths.profile);
      }
    });
  }

  commit(intent: Intent, product: unknown, book: unknown, nowFn: () => number): Receipt {
    return this.#commitFill(
      intent,
      (account, position) => simulate(account, position, intent, product, book, nowFn()),
      // The book must still be fresh at commit time, after any wait for the write lock.
      (receipt) => checkFresh(receipt.snapshot_time, nowFn()),
    );
  }

  /** Commits an external-quote equity order; the quote must still be fresh at commit time. */
  commitExternal(intent: Intent, metadata: EquityMetadata, nowFn: () => number): Receipt {
    return this.#commitFill(
      intent,
      (account, position) => simulateExternal(account, position, intent, metadata, nowFn()),
      () => checkExternalFresh(intent.price_as_of as string, nowFn()),
    );
  }

  // Legacy market API: same receipts as before, now also recorded in the ledger and
  // unable to spend cash or base held by open orders.
  #commitFill(intent: Intent, fillFor: (account: Account, position: Position | null) => FillResult, recheck: (receipt: Receipt) => void): Receipt {
    return this.#transaction('BEGIN IMMEDIATE', 'updated', (db) => {
      const account = loadAccount(db, this.accountId);
      this.#checkIntentAccount(intent);
      const existing = this.#order(db, intent);
      if (!existing) {
        throw new PaperError('INTENT_NOT_RESERVED', 'This client_order_id has no saved order intent.', 'Submit the order again with the same client_order_id.');
      }
      if (existing.receipt) return existing.receipt;
      const ledger = this.#ledger(db);
      const position = ledger.positions.find((item) => item.product_id === intent.product_id) ?? null;
      const fill = fillFor(account, position);
      const { receipt } = fill;
      const equity = fill.position.asset_class === 'EQUITY';
      if (equity !== (receipt.asset_class === 'EQUITY') || (position !== null && (position.asset_class === 'EQUITY') !== equity)) {
        throw new PaperError('STATE_INVALID', 'Simulation result does not match the position asset class.', 'Do not retry with a different client_order_id; report this defect.');
      }
      if (receipt.request_id !== intent.request_id || receipt.account_id !== this.accountId || fill.position.product_id !== intent.product_id) {
        throw new PaperError('STATE_INVALID', 'Simulation result does not match the order intent.', 'Do not retry with a different client_order_id; report this defect.');
      }
      const heldCash = scaled(ledger.holds.cash);
      const heldBase = scaled(ledger.holds.positions[intent.product_id] ?? '0');
      const increment = account.quote_increment === null ? null : scaled(account.quote_increment);
      if (intent.side === 'BUY' && scaled(fill.cash) < heldCash) {
        throw insufficientCash(scaled(account.cash), heldCash, scaled(receipt.total), account.currency, increment);
      }
      if (intent.side === 'SELL' && scaled(fill.position.quantity) < heldBase) {
        throw insufficientHoldings(intent.product_id, scaled(position?.quantity ?? '0'), heldBase, scaled(intent.size), null);
      }
      const work = openWork(ledger);
      const pending = work.orders.get(intent.request_id);
      recordLegacyFill(work, receipt, pending?.order_seq ?? work.nextOrderSeq, pending?.created_at ?? new Date().toISOString());
      const rows = finishWork(work);
      if (scaled(rows.account.cash) !== scaled(fill.cash) || scaled(rows.account.realized_pnl) !== scaled(fill.realized_pnl)) {
        throw new PaperError('STATE_INVALID', 'Simulation result does not reconcile with the ledger.', 'Do not retry with a different client_order_id; report this defect.');
      }
      const quoteIncrement = account.quote_increment === null || scaled(fill.position.quote_increment) < scaled(account.quote_increment) ? fill.position.quote_increment : account.quote_increment;
      const positionRow: Position | { product_id: string; deleted: true } = scaled(fill.position.quantity) === 0n
        ? { product_id: intent.product_id, deleted: true }
        : { ...fill.position };
      const stored = JSON.stringify(receipt);
      this.#apply(db, account.revision, {
        ...rows,
        account: { cash: fill.cash, realized_pnl: fill.realized_pnl, quote_increment: quoteIncrement },
        positions: [positionRow],
        acceptances: [{ request_id: intent.request_id, terms: terms(intent), receipt: stored }],
      });
      recheck(receipt);
      return JSON.parse(stored) as Receipt;
    });
  }

  history(limit: number): Receipt[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY) {
      throw new PaperError('INVALID_ARGUMENT', `--limit must be an integer from 1 to ${MAX_HISTORY}.`, 'Pass a smaller --limit.');
    }
    return this.#transaction('BEGIN', 'read', (db) => {
      loadAccount(db, this.accountId);
      const rows = db.prepare('SELECT request_id, receipt FROM orders WHERE receipt IS NOT NULL ORDER BY fill_seq DESC LIMIT ?').all(limit) as Array<{ request_id: string; receipt: string }>;
      return rows.map((row) => parseStoredReceipt(row.receipt, this.accountId, row.request_id) as Receipt);
    });
  }

  /** One order by client order ID: its receipt, or receipt null while the intent is still pending. */
  lookup(requestId: string): { receipt: Receipt | null } | undefined {
    return this.#transaction('BEGIN', 'read', (db) => {
      loadAccount(db, this.accountId);
      const row = db.prepare('SELECT receipt FROM orders WHERE request_id = ?').get(requestId) as { receipt: string | null } | undefined;
      if (!row) return undefined;
      return { receipt: row.receipt === null ? null : (parseStoredReceipt(row.receipt, this.accountId, requestId) as Receipt) };
    });
  }

  async backup(output: string): Promise<Record<string, unknown> & { revision: number; schema_version: number }> {
    const target = requireAbsolute(output, '--output');
    if (path.resolve(target) === path.resolve(this.state)) {
      throw new PaperError('INVALID_PATH', '--output must differ from the account file.', 'Choose a new backup file path.');
    }
    const sqlite = await loadSqlite();
    this.readSnapshot();
    const db = this.#open();
    let revision = -1;
    let schema = 0;
    publishNew(
      target,
      (temp) => {
        try {
          db.prepare('VACUUM INTO ?').run(temp);
          this.#checkFileId();
          const copy = connect(sqlite, temp, true);
          try {
            schema = checkSchema(copy);
            revision = loadAccount(copy, this.accountId).revision;
          } finally {
            copy.close();
          }
        } catch (err) {
          throw sqliteError(err, 'backed up');
        }
      },
      'BACKUP_EXISTS',
      'Choose a new backup file path; backups never overwrite files.',
    );
    return {
      mode: PAPER_MODE,
      ok: true,
      account_id: this.accountId,
      backup: target,
      revision,
      schema_version: schema,
      restore: 'To restore, keep a separate untouched copy of this file, then bind the file into a new empty --data-dir with coinbase-paper bind. The bound file becomes the live account and later trades change it. Never keep using two bindings of the same account ID; their histories diverge and a same-ID retry on each could fill twice. Creating the backup left the original account unchanged.',
      durability: DURABILITY,
    };
  }

  close(): void {
    this.#db?.close();
    this.#db = undefined;
  }

  #open(): DatabaseSync {
    if (!this.#db) throw new PaperError('STATE_CLOSED', 'Paper account is closed.', 'Run the command again.');
    return this.#db;
  }

  // A rename over the bound path would leave this connection writing an orphaned file.
  #checkFileId(): void {
    const current = fileId(this.state);
    if (!current || !this.#fileId || current.dev !== this.#fileId.dev || current.ino !== this.#fileId.ino) {
      throw new PaperError('STATE_CHANGED', 'The bound account file was replaced or removed while in use.', 'Run coinbase-paper doctor before retrying.');
    }
  }

  // After a reset switches the binding, handles opened on the old account must not write to it.
  #checkBinding(): void {
    if (!this.#paths) return;
    let binding: Binding;
    try {
      binding = readBinding(this.#paths);
    } catch {
      throw new PaperError('STATE_CHANGED', 'The paper account binding changed while this command was running.', 'Run coinbase-paper doctor, then retry the command.');
    }
    if (binding.account_id !== this.accountId || path.normalize(binding.state) !== this.state) {
      throw new PaperError('STATE_CHANGED', 'This data directory is now bound to a different paper account.', 'Run coinbase-paper doctor, then retry the command against the bound account.');
    }
  }

  #checkIntentAccount(intent: Intent): void {
    this.#checkAccountId(intent.account_id);
  }

  #checkAccountId(accountId: string): void {
    if (accountId !== this.accountId) {
      throw new PaperError('ACCOUNT_MISMATCH', 'Order account ID does not match the bound paper account.', 'Stop and verify the account with coinbase-paper balance.');
    }
  }

  #order(db: DatabaseSync, intent: Intent): { receipt: Receipt | null } | undefined {
    const row = db.prepare('SELECT terms, receipt FROM orders WHERE request_id = ?').get(intent.request_id) as { terms: string; receipt: string | null } | undefined;
    if (!row) return undefined;
    if (row.terms !== terms(intent)) throw idempotencyConflict();
    return { receipt: row.receipt === null ? null : (parseStoredReceipt(row.receipt, this.accountId, intent.request_id) as Receipt) };
  }

  #acceptance(db: DatabaseSync, intent: OrderIntent): OrderReceipt | null {
    const row = db.prepare('SELECT terms, receipt FROM orders WHERE request_id = ?').get(intent.request_id) as { terms: string; receipt: string | null } | undefined;
    if (!row) return null;
    if (row.terms !== orderTerms(intent)) throw idempotencyConflict();
    return row.receipt === null ? null : (parseStoredReceipt(row.receipt, this.accountId, intent.request_id) as OrderReceipt);
  }

  #insertPending(db: DatabaseSync, intent: OrderIntent, text: string, reservedAt: string): void {
    db.prepare('INSERT INTO orders (request_id, terms, reserved_at) VALUES (?, ?, ?)').run(intent.request_id, text, reservedAt);
    const seq = (db.prepare('SELECT COALESCE(MAX(order_seq), 0) + 1 AS seq FROM order_state').get() as { seq: number }).seq;
    this.#writeOrder(db, pendingOrder(intent, seq, reservedAt));
    db.prepare('UPDATE account SET revision = revision + 1 WHERE id = 1').run();
  }

  #ledger(db: DatabaseSync): LedgerSnapshot {
    const account = loadAccount(db, this.accountId);
    if (checkSchema(db) !== SCHEMA_VERSION) throw invalidState('Paper state was not upgraded to schema 4.');
    const positions = loadPositions(db);
    const orders = (db.prepare('SELECT * FROM order_state ORDER BY order_seq').all() as Array<Record<string, unknown>>).map(parseOrderRow);
    const fills = (db.prepare('SELECT * FROM fills ORDER BY fill_seq').all() as Array<Record<string, unknown>>).map(parseFillRow);
    const events = (db.prepare('SELECT * FROM order_events ORDER BY event_seq').all() as Array<Record<string, unknown>>).map(parseEventRow);
    const holds = summarizeHolds(orders);
    if (scaled(holds.cash) > scaled(account.cash)) throw invalidState('Paper cash holds exceed cash.');
    for (const [product, held] of Object.entries(holds.positions)) {
      const position = positions.find((p) => p.product_id === product);
      if (!position || scaled(held) > scaled(position.quantity)) throw invalidState('Paper holds exceed holdings.');
    }
    return { account, positions, orders, fills, events, holds };
  }

  #apply(db: DatabaseSync, revision: number, mutation: Mutation): void {
    this.#writeRows(db, mutation, true);
    const reconciled = (mutation.account as { last_reconciled_at?: string }).last_reconciled_at;
    const update = db.prepare(`UPDATE account SET cash = ?, realized_pnl = ?, quote_increment = ?, revision = revision + 1${reconciled === undefined ? '' : ', last_reconciled_at = ?'} WHERE id = 1 AND revision = ?`);
    const args: Array<string | number | null> = [checkDecimal(mutation.account.cash), checkDecimal(mutation.account.realized_pnl, true), mutation.account.quote_increment === null ? null : checkDecimal(mutation.account.quote_increment)];
    if (reconciled !== undefined) {
      if (!isIsoTime(reconciled)) throw invalidState('Reconciliation time is invalid.');
      args.push(reconciled);
    }
    args.push(revision);
    if (update.run(...args).changes !== 1) throw new PaperError('STATE_CHANGED', 'The paper account changed during this write.', 'Retry the same command.');
    // Re-validate the whole ledger inside the transaction; any broken invariant rolls back.
    this.#ledger(db);
  }

  #writeRows(db: DatabaseSync, mutation: Mutation, withPositions: boolean): void {
    for (const acceptance of mutation.acceptances) {
      const row = db.prepare('SELECT terms, receipt FROM orders WHERE request_id = ?').get(acceptance.request_id) as { terms: string; receipt: string | null } | undefined;
      if (row) {
        if (row.receipt !== null) throw invalidState('An order already has a stored result.');
        if (acceptance.terms !== '' && acceptance.terms !== row.terms) throw idempotencyConflict();
        db.prepare('UPDATE orders SET receipt = ?, fill_seq = (SELECT COALESCE(MAX(fill_seq), 0) + 1 FROM orders) WHERE request_id = ? AND receipt IS NULL').run(acceptance.receipt, acceptance.request_id);
      } else {
        if (acceptance.terms === '') throw invalidState('A new order has no terms.');
        db.prepare('INSERT INTO orders (request_id, terms, reserved_at, fill_seq, receipt) VALUES (?, ?, ?, (SELECT COALESCE(MAX(fill_seq), 0) + 1 FROM orders), ?)').run(acceptance.request_id, acceptance.terms, new Date().toISOString(), acceptance.receipt);
      }
    }
    if (withPositions) {
      for (const position of mutation.positions) {
        if ('deleted' in position) {
          db.prepare('DELETE FROM positions WHERE product_id = ?').run(position.product_id);
          continue;
        }
        db.prepare('INSERT OR REPLACE INTO positions (product_id, quantity, cost_basis, base_increment, quote_increment, asset_class) VALUES (?, ?, ?, ?, ?, ?)').run(
          position.product_id,
          checkDecimal(position.quantity),
          checkDecimal(position.cost_basis),
          checkDecimal(position.base_increment),
          checkDecimal(position.quote_increment),
          position.asset_class === 'EQUITY' ? 'EQUITY' : null,
        );
      }
    }
    for (const order of mutation.orders) this.#writeOrder(db, order);
    const insertFill = db.prepare(`INSERT INTO fills (${FILL_COLUMNS.join(', ')}) VALUES (${FILL_COLUMNS.map(() => '?').join(', ')})`);
    for (const fill of mutation.fills) {
      for (const key of ['price', 'size', 'notional', 'commission', 'cost_basis_removed'] as const) checkDecimal(fill[key]);
      if (fill.realized_pnl !== null) checkDecimal(fill.realized_pnl, true);
      insertFill.run(...FILL_COLUMNS.map((key) => (key === 'source' ? JSON.stringify(fill.source) : (fill[key] as string | number | null))));
    }
    const insertEvent = db.prepare('INSERT INTO order_events (event_id, order_id, product_id, event_time, event_type, status, details) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const event of mutation.events) {
      insertEvent.run(event.event_id, event.order_id, event.product_id, event.event_time, event.event_type, event.status, JSON.stringify(event.details));
    }
  }

  #writeOrder(db: DatabaseSync, order: OrderState): void {
    for (const key of ['filled_size', 'remaining_size', 'cash_hold', 'base_hold'] as const) checkDecimal(order[key]);
    const values = ORDER_COLUMNS.map((key) => {
      const value = order[key];
      if (key === 'post_only') return value ? 1 : 0;
      if (key === 'product_rules' || key === 'current_receipt') return value === null ? null : JSON.stringify(value);
      return value as string | number | null;
    });
    db.prepare(`INSERT OR REPLACE INTO order_state (${ORDER_COLUMNS.join(', ')}) VALUES (${ORDER_COLUMNS.map(() => '?').join(', ')})`).run(...values);
  }

  #page<T>(db: DatabaseSync, resource: string, table: string, seqColumn: string, direction: 'ASC' | 'DESC', where: string[], args: Array<string | number>, filter: Record<string, unknown>, map: (row: Record<string, unknown>) => T): Page<T> {
    const limit = filter.limit === undefined ? DEFAULT_PAGE : (filter.limit as number);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) throw filterError(`limit must be an integer from 1 to ${MAX_PAGE}`);
    const { cursor: _cursor, limit: _limit, ...rest } = filter;
    const fingerprint = createHash('sha256').update(JSON.stringify(Object.entries(rest).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : 1)))).digest('hex').slice(0, 32);
    const clauses = [...where];
    const params = [...args];
    let high: number;
    if (filter.cursor !== undefined) {
      const cursor = decodeCursor(filter.cursor as string, resource, this.accountId, fingerprint);
      high = cursor.h;
      clauses.push(direction === 'DESC' ? `${seqColumn} < ?` : `${seqColumn} > ?`, `${seqColumn} <= ?`);
      params.push(cursor.b, cursor.h);
    } else {
      high = (db.prepare(`SELECT COALESCE(MAX(${seqColumn}), 0) AS h FROM ${table}`).get() as { h: number }).h;
      clauses.push(`${seqColumn} <= ?`);
      params.push(high);
    }
    const sql = `SELECT * FROM ${table}${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY ${seqColumn} ${direction} LIMIT ?`;
    const rows = db.prepare(sql).all(...params, limit + 1) as Array<Record<string, unknown>>;
    const hasNext = rows.length > limit;
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    const cursor = hasNext && last ? encodeCursor({ v: 1, r: resource, a: this.accountId, f: fingerprint, b: last[seqColumn] as number, h: high }) : null;
    return { items: items.map(map), has_next: hasNext, cursor };
  }

  #transaction<T>(begin: 'BEGIN' | 'BEGIN IMMEDIATE', action: string, work: (db: DatabaseSync) => T): T {
    const db = this.#open();
    let open = false;
    try {
      db.exec(begin);
      open = true;
      // BEGIN is deferred; force the read lock so identity checks and reads share one snapshot.
      db.prepare('SELECT 1 FROM meta LIMIT 1').get();
      this.#checkFileId();
      this.#checkBinding();
      const result = work(db);
      db.exec('COMMIT');
      open = false;
      return result;
    } catch (err) {
      if (open) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // The connection is unusable; the error below is what the caller needs.
        }
      }
      throw sqliteError(err, action);
    }
  }
}

function idempotencyConflict(): PaperError {
  return new PaperError('IDEMPOTENCY_CONFLICT', 'This client_order_id was already used for different order terms.', 'Keep the original terms, or use a new client_order_id for a new order.');
}

function normalizeId(value: string): string {
  const id = typeof value === 'string' ? value.toLowerCase() : '';
  if (!UUID.test(id)) throw new PaperError('INVALID_ARGUMENT', 'order ID must be a UUID', 'Find it with coinbase-paper orders list.');
  return id;
}

function normalizeTime(value: string): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw invalidState('A stored order has an invalid reservation time.');
  return new Date(ms).toISOString();
}

/** Rechecks book or quote freshness after the write lock was acquired and the write prepared. */
function recheckMarket(market: PlacementMarket, intent: OrderIntent | null, now: number): void {
  if (market.kind === 'equity') {
    if (intent?.price_as_of !== undefined) checkExternalFresh(intent.price_as_of, now);
    return;
  }
  const book = market.book as { pricebook?: { time?: unknown } } | null;
  checkFresh(book?.pricebook?.time as string, now);
}

function filterError(message: string): PaperError {
  return new PaperError('INVALID_ARGUMENT', message, 'Run coinbase-paper orders --help for the supported filters.');
}

type CommonFilter = { order_ids?: string[]; product_ids?: string[]; side?: string; start?: string; end?: string; limit?: number; cursor?: string; status?: string; product_type?: string };

function checkFilter(filter: unknown, allowed: string[]): CommonFilter {
  if (filter === null || typeof filter !== 'object' || Array.isArray(filter)) throw filterError('filter must be an object');
  const record = filter as Record<string, unknown>;
  const extra = Object.keys(record).filter((key) => record[key] !== undefined && !allowed.includes(key));
  if (extra.length > 0) throw filterError(`unsupported filter ${extra.join(', ')}`);
  const out: CommonFilter = {};
  for (const key of ['order_ids', 'product_ids'] as const) {
    const value = record[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PAGE || value.some((item) => typeof item !== 'string')) throw filterError(`${key} must be a non-empty list of strings`);
    const list = key === 'order_ids' ? value.map((item: string) => item.toLowerCase()) : [...value];
    if (list.some((item) => !(key === 'order_ids' ? UUID : PRODUCT_ID).test(item)) || new Set(list).size !== list.length) throw filterError(`${key} must be distinct valid IDs`);
    out[key] = list;
  }
  if (record.side !== undefined) {
    if (record.side !== 'BUY' && record.side !== 'SELL') throw filterError('side must be BUY or SELL');
    out.side = record.side;
  }
  for (const key of ['start', 'end'] as const) {
    if (record[key] !== undefined) out[key] = parseOrderTime(record[key], key);
  }
  if (out.start !== undefined && out.end !== undefined && out.start >= out.end) throw filterError('start must be before end');
  for (const key of ['status', 'product_type', 'cursor'] as const) {
    if (record[key] === undefined) continue;
    if (typeof record[key] !== 'string') throw filterError(`${key} must be a string`);
    out[key] = record[key] as string;
  }
  if (record.limit !== undefined) out.limit = record.limit as number;
  return out;
}

function addCommon(where: string[], args: Array<string | number>, f: CommonFilter, timeColumn: string): void {
  if (f.order_ids) {
    where.push(`order_id IN (${f.order_ids.map(() => '?').join(', ')})`);
    args.push(...f.order_ids);
  }
  if (f.product_ids) {
    where.push(`product_id IN (${f.product_ids.map(() => '?').join(', ')})`);
    args.push(...f.product_ids);
  }
  if (f.side) {
    where.push('side = ?');
    args.push(f.side);
  }
  // Normalized ISO strings sort chronologically.
  if (f.start) {
    where.push(`${timeColumn} >= ?`);
    args.push(f.start);
  }
  if (f.end) {
    where.push(`${timeColumn} < ?`);
    args.push(f.end);
  }
}

interface Cursor {
  v: 1;
  r: string;
  a: string;
  f: string;
  b: number;
  h: number;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(text: string, resource: string, accountId: string, fingerprint: string): Cursor {
  const invalid = new PaperError('PAPER_INVALID_CURSOR', 'The pagination cursor is invalid or does not match this account, resource, or filter.', 'Restart the query without cursor, keeping the intended filters.');
  if (typeof text !== 'string' || text.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(text)) throw invalid;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
  } catch {
    throw invalid;
  }
  const c = value as Record<string, unknown>;
  if (typeof c !== 'object' || c === null || Object.keys(c).sort().join(',') !== 'a,b,f,h,r,v' || c.v !== 1 || c.r !== resource || c.a !== accountId || c.f !== fingerprint
    || !Number.isSafeInteger(c.b) || !Number.isSafeInteger(c.h) || (c.b as number) < 0 || (c.h as number) < 0) throw invalid;
  return c as unknown as Cursor;
}

function json(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'string') throw invalidState(`Paper ${what} is not JSON.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw invalidState(`Paper ${what} is not JSON.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw invalidState(`Paper ${what} is not an object.`);
  return parsed as Record<string, unknown>;
}

function text(value: unknown, what: string, pattern?: RegExp): string {
  if (typeof value !== 'string' || (pattern && !pattern.test(value))) throw invalidState(`Paper ${what} is invalid.`);
  return value;
}

function optional<T>(value: unknown, read: (v: unknown) => T): T | null {
  return value === null || value === undefined ? null : read(value);
}

function time(value: unknown, what: string): string {
  if (!isIsoTime(value)) throw invalidState(`Paper ${what} is not a normalized time.`);
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) throw invalidState(`Paper ${what} is invalid.`);
  return value as T;
}

function seqOf(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw invalidState(`Paper ${what} is invalid.`);
  return value;
}

function parseRules(value: unknown): ProductRules {
  const r = json(value, 'product rules');
  const dec = (key: string) => checkDecimal(r[key]);
  const opt = (key: string) => (r[key] === null ? null : checkDecimal(r[key]));
  return {
    product_type: oneOf(r.product_type, ['SPOT', 'EQUITY'] as const, 'product type'),
    base_currency_id: text(r.base_currency_id, 'base currency', /^[A-Z0-9.]{1,15}$/),
    quote_currency_id: text(r.quote_currency_id, 'quote currency', /^[A-Z0-9]{1,10}$/),
    base_increment: dec('base_increment'),
    quote_increment: dec('quote_increment'),
    base_min_size: opt('base_min_size'),
    base_max_size: opt('base_max_size'),
    quote_min_size: opt('quote_min_size'),
    quote_max_size: opt('quote_max_size'),
  };
}

function parseOrderRow(row: Record<string, unknown>): OrderState {
  const id = text(row.order_id, 'order ID', UUID);
  const status = oneOf(row.status, ['PENDING', 'OPEN', 'FILLED', 'CANCELLED', 'EXPIRED'] as const, 'order status');
  const order: OrderState = {
    order_id: id,
    order_seq: seqOf(row.order_seq, 'order sequence'),
    product_id: text(row.product_id, 'order product', PRODUCT_ID),
    side: oneOf(row.side, ['BUY', 'SELL'] as const, 'order side'),
    order_type: oneOf(row.order_type, ['MARKET', 'LIMIT', 'STOPLIMIT', 'BRACKET'] as const, 'order type'),
    status,
    product_type: oneOf(row.product_type, ['SPOT', 'EQUITY'] as const, 'product type'),
    created_at: time(row.created_at, 'order time'),
    updated_at: time(row.updated_at, 'order time'),
    priority_at: time(row.priority_at, 'order time'),
    time_in_force: optional(row.time_in_force, (v) => oneOf(v, ['GTC', 'GTD', 'IOC', 'FOK'] as const, 'time in force')),
    end_time: optional(row.end_time, (v) => time(v, 'end time')),
    base_size: optional(row.base_size, (v) => checkDecimal(v)),
    filled_size: checkDecimal(row.filled_size),
    remaining_size: checkDecimal(row.remaining_size),
    limit_price: optional(row.limit_price, (v) => checkDecimal(v)),
    stop_price: optional(row.stop_price, (v) => checkDecimal(v)),
    stop_direction: optional(row.stop_direction, (v) => oneOf(v, ['STOP_DIRECTION_STOP_UP', 'STOP_DIRECTION_STOP_DOWN'] as const, 'stop direction')),
    post_only: row.post_only === 1,
    triggered_at: optional(row.triggered_at, (v) => time(v, 'trigger time')),
    evaluate_after: time(row.evaluate_after, 'evaluation cursor'),
    cash_hold: checkDecimal(row.cash_hold),
    base_hold: checkDecimal(row.base_hold),
    parent_order_id: optional(row.parent_order_id, (v) => text(v, 'parent order', UUID)),
    attached_take_profit_price: optional(row.attached_take_profit_price, (v) => checkDecimal(v)),
    attached_stop_loss_price: optional(row.attached_stop_loss_price, (v) => checkDecimal(v)),
    take_profit_status: optional(row.take_profit_status, (v) => oneOf(v, ['OPEN', 'CANCELLED', 'FILLED'] as const, 'take-profit status')),
    stop_loss_status: optional(row.stop_loss_status, (v) => oneOf(v, ['OPEN', 'TRIGGERED', 'CANCELLED', 'FILLED'] as const, 'stop-loss status')),
    stop_limit_price: optional(row.stop_limit_price, (v) => checkDecimal(v)),
    product_rules: optional(row.product_rules, parseRules),
    terminal_reason: optional(row.terminal_reason, (v) => text(v, 'terminal reason', /^[A-Z_]{1,64}$/)),
    current_receipt: optional(row.current_receipt, (v) => json(v, 'order view') as unknown as OrderReceipt),
  };
  // The current view must be well formed and agree with its order row on identity, status and execution.
  const view = order.current_receipt as unknown as Record<string, unknown> | null;
  if (view && (!validOrderReceipt(view, id, null) || view.status !== status || view.product_id !== order.product_id || view.side !== order.side
    || view.order_type !== order.order_type || scaled(view.filled_size as string) !== scaled(order.filled_size)
    || scaled(view.remaining_size as string) !== scaled(order.remaining_size))) {
    throw invalidState('Paper order view does not match its order.');
  }
  if (status === 'PENDING' && (scaled(order.filled_size) !== 0n || scaled(order.cash_hold) !== 0n || scaled(order.base_hold) !== 0n)) throw invalidState('A pending paper order has an execution or hold.');
  return order;
}

function parseFillRow(row: Record<string, unknown>): PaperFill {
  return {
    fill_seq: seqOf(row.fill_seq, 'fill sequence'),
    trade_id: text(row.trade_id, 'trade ID', UUID),
    order_id: text(row.order_id, 'fill order', UUID),
    batch_id: text(row.batch_id, 'batch ID', UUID),
    batch_index: seqOf(row.batch_index, 'batch index'),
    product_id: text(row.product_id, 'fill product', PRODUCT_ID),
    product_type: oneOf(row.product_type, ['SPOT', 'EQUITY'] as const, 'fill product type'),
    side: oneOf(row.side, ['BUY', 'SELL'] as const, 'fill side'),
    trade_time: time(row.trade_time, 'trade time'),
    price: checkDecimal(row.price),
    size: checkDecimal(row.size),
    notional: checkDecimal(row.notional),
    commission: checkDecimal(row.commission),
    liquidity_indicator: oneOf(row.liquidity_indicator, ['MAKER', 'TAKER'] as const, 'liquidity indicator'),
    cost_basis_removed: checkDecimal(row.cost_basis_removed),
    realized_pnl: optional(row.realized_pnl, (v) => checkDecimal(v, true)),
    source: json(row.source, 'fill source'),
  };
}

function parseEventRow(row: Record<string, unknown>): OrderEvent {
  return {
    event_seq: seqOf(row.event_seq, 'event sequence'),
    event_id: text(row.event_id, 'event ID', UUID),
    order_id: text(row.order_id, 'event order', UUID),
    product_id: text(row.product_id, 'event product', PRODUCT_ID),
    event_time: time(row.event_time, 'event time'),
    event_type: oneOf(row.event_type, ['ACCEPTED', 'OPENED', 'TRIGGERED', 'FILL', 'EDITED', 'CANCELLED', 'EXPIRED', 'ATTACHED_ACTIVATED', 'AMBIGUOUS_OCO'] as const, 'event type'),
    status: oneOf(row.status, ['PENDING', 'OPEN', 'FILLED', 'CANCELLED', 'EXPIRED'] as const, 'event status'),
    details: json(row.details, 'event details'),
  };
}

/** Minimal view of a reservation that has not executed. */
function pendingView(order: OrderState, accountId: string): OrderReceipt {
  return {
    mode: PAPER_MODE, ok: true, request_id: order.order_id, order_id: order.order_id, client_order_id: order.order_id, account_id: accountId,
    product_id: order.product_id, side: order.side, order_type: order.order_type, status: order.status,
    requested: order.base_size === null ? {} : { base_size: order.base_size },
    base_size: '0', notional: '0', fee: '0', total: '0', average_price: null, realized_pnl: null, cash: '', position: { quantity: '0', cost_basis: '0' },
    currency: '', snapshot_time: null, filled_at: null, fills: [], source: {}, assumptions: {}, notice: `${PAPER_NOTICE} The order was recorded but not confirmed; rerun the original create command with the same client_order_id to finish or confirm it.`,
    created_time: order.created_at, updated_time: order.updated_at, time_in_force: order.time_in_force, end_time: order.end_time,
    order_configuration: { type: order.order_type.toLowerCase() as OrderReceipt['order_configuration']['type'], base_size: order.base_size, limit_price: order.limit_price, stop_price: order.stop_price, stop_direction: order.stop_direction, time_in_force: order.time_in_force, end_time: order.end_time, post_only: order.post_only, stop_limit_price: order.stop_limit_price },
    attached_order_configuration: order.attached_take_profit_price === null && order.attached_stop_loss_price === null ? null : { attached_take_profit_price: order.attached_take_profit_price, attached_stop_loss_price: order.attached_stop_loss_price },
    attached_order_id: null, attached_order_ids: [], parent_order_id: order.parent_order_id, filled_size: '0', remaining_size: '0', average_filled_price: null,
    total_fees: '0', number_of_fills: 0, last_fill_time: null, completion_percentage: '0', hold: { currency: '', cash: '0', base: '0' }, triggered_at: null, terminal_reason: order.terminal_reason,
  };
}

/** A stored receipt: an order-model receipt (has order_id) or a legacy market receipt. */
function parseStoredReceipt(text: string, accountId: string, requestId: string): Receipt | OrderReceipt {
  let value: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) value = parsed as Record<string, unknown>;
  } catch {
    // Reported below.
  }
  if (value && Object.hasOwn(value, 'order_id')) {
    if (validOrderReceipt(value, requestId, accountId)) return value as unknown as OrderReceipt;
    throw new PaperError('STATE_INVALID', 'A stored receipt is unreadable or inconsistent with its account/request.', 'Stop and inspect the saved account and receipt. Do not initialize a new account or retry with a new client_order_id.');
  }
  return parseReceipt(text, accountId, requestId);
}

/**
 * Structural check of an order-model receipt or current view at the storage boundary: identity,
 * every amount, fills, times and equity quote provenance. `accountId` null checks only its shape.
 */
function validOrderReceipt(value: Record<string, unknown>, orderId: string, accountId: string | null): boolean {
  const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  const amount = (v: unknown, signed = false) => {
    if (typeof v !== 'string' || !STORED_DECIMAL.test(v) || (!signed && v.startsWith('-'))) throw new Error('invalid receipt amount');
  };
  const instant = (v: unknown) => {
    if (typeof v !== 'string' || !Number.isFinite(Date.parse(v))) throw new Error('invalid receipt time');
  };
  try {
    if (value.mode !== PAPER_MODE || value.ok !== true || value.order_id !== orderId || typeof value.request_id !== 'string' || !UUID.test(value.request_id)
      || (accountId === null ? typeof value.account_id !== 'string' || !ACCOUNT_ID.test(value.account_id) : value.account_id !== accountId)
      || !ORDER_STATUSES.has(value.status as string) || !['MARKET', 'LIMIT', 'STOPLIMIT', 'BRACKET'].includes(value.order_type as string)
      || (value.side !== 'BUY' && value.side !== 'SELL') || typeof value.product_id !== 'string' || !PRODUCT_ID.test(value.product_id)
      || !object(value.requested) || !object(value.position) || !object(value.source) || !object(value.assumptions) || !object(value.hold)
      || typeof value.notice !== 'string' || !Array.isArray(value.fills) || !Array.isArray(value.attached_order_ids)) return false;
    const config = value.order_configuration;
    if (!object(config) || !['market', 'limit', 'stoplimit', 'bracket'].includes(config.type as string)) return false;
    if (value.attached_order_configuration !== null && !object(value.attached_order_configuration)) return false;
    for (const key of ['base_size', 'notional', 'fee', 'total', 'filled_size', 'remaining_size', 'total_fees', 'completion_percentage']) amount(value[key]);
    for (const key of ['average_price', 'average_filled_price']) if (value[key] !== null) amount(value[key]);
    if (value.realized_pnl !== null) amount(value.realized_pnl, true);
    if (value.cash !== '') amount(value.cash);
    for (const key of ['quantity', 'cost_basis']) amount(value.position[key]);
    for (const key of ['cash', 'base']) amount(value.hold[key]);
    if (value.request_id !== orderId || (value.client_order_id !== undefined && value.client_order_id !== orderId)) return false;
    for (const fill of value.fills) {
      if (!object(fill)) return false;
      for (const key of ['price', 'size', 'notional', 'commission']) amount(fill[key]);
      instant(fill.trade_time);
      if (typeof fill.trade_id !== 'string' || fill.trade_id === '' || (fill.liquidity_indicator !== 'MAKER' && fill.liquidity_indicator !== 'TAKER')) return false;
    }
    for (const key of ['base_size', 'limit_price', 'stop_price', 'stop_limit_price']) if (config[key] !== null && config[key] !== undefined) amount(config[key]);
    for (const [key, v] of Object.entries(value.requested)) {
      // close-position records its optional partial size as `size`.
      if (key !== 'base_size' && key !== 'quote_size' && !(key === 'size' && value.success === true)) return false;
      amount(v);
    }
    if (object(value.attached_order_configuration)) {
      for (const v of Object.values(value.attached_order_configuration)) if (v !== null) amount(v);
    }
    if (!Number.isSafeInteger(value.number_of_fills) || (value.number_of_fills as number) < 0) return false;
    instant(value.created_time);
    instant(value.updated_time);
    for (const key of ['snapshot_time', 'filled_at', 'last_fill_time', 'triggered_at', 'end_time']) if (value[key] !== null) instant(value[key]);
    if (value.status === 'FILLED' && value.fills.length === 0) return false;
    // Any equity discriminator (including an external quote source) must come with complete, valid quote provenance.
    const source = value.source;
    const external = ['asset_class', 'price_verification', 'price_age_seconds'].some((key) => Object.hasOwn(value, key)) || source.provider === 'external';
    if (external) {
      if (value.asset_class !== 'EQUITY' || value.price_verification !== 'UNVERIFIED_EXTERNAL_QUOTE' || source.provider !== 'external'
        || !Number.isSafeInteger(value.price_age_seconds) || (value.price_age_seconds as number) < 0
        || typeof source.url !== 'string' || !source.url.startsWith('https://')
        || (source.metadata !== 'assumed' && source.metadata !== 'coinbase-public-listing')) return false;
      amount(source.reference_price);
      if (!/[1-9]/.test(source.reference_price as string)) return false;
      amount(source.slippage_bps);
      instant(source.as_of);
    }
    return true;
  } catch {
    return false;
  }
}

function parseReceipt(text: string, accountId: string, requestId: string): Receipt {
  try {
    const value = JSON.parse(text) as unknown;
    const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
    if (!object(value) || value.mode !== PAPER_MODE || value.ok !== true || value.status !== 'FILLED' || value.order_type !== 'MARKET'
      || value.account_id !== accountId || value.request_id !== requestId || !ACCOUNT_ID.test(`paper-${requestId}`)
      || (value.side !== 'BUY' && value.side !== 'SELL')
      || typeof value.product_id !== 'string' || !(value.asset_class === undefined ? /^[A-Z0-9]{1,15}-[A-Z0-9]{1,10}$/ : /^[A-Z][A-Z0-9.]{0,9}-(USD|USDC)$/).test(value.product_id)
      || typeof value.currency !== 'string' || !/^[A-Z0-9]{2,10}$/.test(value.currency)
      || !object(value.requested) || !object(value.position) || !object(value.source) || !object(value.assumptions)
      || typeof value.notice !== 'string' || !Array.isArray(value.fills) || value.fills.length === 0 || value.fills.length > 1000) throw new Error('invalid receipt shape');
    const sizes = Object.keys(value.requested);
    if (sizes.length !== 1 || !['base_size', 'quote_size'].includes(sizes[0]) || (value.side === 'SELL' && sizes[0] !== 'base_size')) throw new Error('invalid receipt size');
    parseStoredDecimal(value.requested[sizes[0]], 'receipt requested size', { allowZero: false });
    for (const key of ['base_size', 'notional', 'average_price']) parseStoredDecimal(value[key], `receipt ${key}`, { allowZero: false });
    for (const key of ['fee', 'total', 'cash']) parseStoredDecimal(value[key], `receipt ${key}`);
    if (value.realized_pnl !== null) parseStoredDecimal(value.realized_pnl, 'receipt realized_pnl', { allowNegative: true });
    for (const key of ['quantity', 'cost_basis']) parseStoredDecimal(value.position[key], `receipt position ${key}`);
    for (const fill of value.fills) {
      if (!object(fill)) throw new Error('invalid receipt fill');
      parseStoredDecimal(fill.price, 'receipt fill price', { allowZero: false });
      parseStoredDecimal(fill.size, 'receipt fill size', { allowZero: false });
    }
    for (const key of ['snapshot_time', 'filled_at']) {
      if (typeof value[key] !== 'string' || !Number.isFinite(Date.parse(value[key]))) throw new Error('invalid receipt time');
    }
    // Legacy crypto receipts carry no discriminator; any discriminator must be a complete equity receipt.
    const external = ['asset_class', 'price_verification', 'price_age_seconds'].filter((key) => Object.hasOwn(value, key));
    if (external.length > 0) {
      const source = value.source;
      if (external.length !== 3 || value.asset_class !== 'EQUITY' || value.price_verification !== 'UNVERIFIED_EXTERNAL_QUOTE'
        || !Number.isSafeInteger(value.price_age_seconds) || value.fills.length !== 1
        || source.provider !== 'external' || typeof source.url !== 'string' || !source.url.startsWith('https://')
        || source.as_of !== value.snapshot_time || (source.metadata !== 'assumed' && source.metadata !== 'coinbase-public-listing')) throw new Error('invalid equity receipt');
      parseStoredDecimal(source.reference_price, 'receipt reference_price', { allowZero: false });
      parseStoredDecimal(source.slippage_bps, 'receipt slippage_bps');
    }
    return value as unknown as Receipt;
  } catch {
    // Reported below.
  }
  throw new PaperError('STATE_INVALID', 'A stored receipt is unreadable or inconsistent with its account/request.', 'Stop and inspect the saved account and receipt. Do not initialize a new account or retry with a new client_order_id.');
}
