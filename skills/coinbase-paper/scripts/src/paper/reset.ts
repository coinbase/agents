// Archive-first paper reset: back up the bound account, create a fresh account with
// the same settings, then atomically switch the binding only if the archived ledger
// revision is still current. Never deletes or reseeds the old account.
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { initAccount, type InitOptions } from './store.ts';
import { PAPER_MODE, PAPER_NOTICE, PaperError, type PaperPaths } from './types.ts';

/** The store operations reset needs; the bound PaperStore provides them. */
export interface ResetStore {
  readonly accountId: string;
  /** The bound account's state file, kept (never deleted) by reset. */
  readonly state: string;
  readLedger(): {
    account: {
      account_id: string;
      currency: string;
      initial_cash: string;
      maker_fee_bps: string;
      taker_fee_bps: string;
      revision: number;
    };
  };
  backup(output: string): Promise<{ revision: number }>;
  switchBinding(replacement: { state: string; account_id: string }, expectedRevision: number): void;
}

export interface ResetResult {
  mode: 'PAPER';
  ok: true;
  previous_account_id: string;
  /** The previous account's state file; it is kept, and is no longer the bound account. */
  previous_state: string;
  account_id: string;
  archive: string;
  state: string;
  initial_cash: string;
  currency: string;
  maker_fee_bps: string;
  taker_fee_bps: string;
  schema_version: number;
  notice: string;
}

type InitAccount = (paths: PaperPaths, options: InitOptions) => Promise<Record<string, unknown>>;

const ARCHIVE_DIR = 'archives';
const RESETS_DIR = 'resets';
const STATE_FILE = 'account.sqlite3';
const PROFILE_FILE = 'profile.json';
const FAILED_HINT = 'Run coinbase-paper doctor to identify the bound account. Keep the archive and staged files; do not delete state or reinitialize as a guess.';

/** Fails before any account I/O unless the user explicitly confirmed the reset. */
export function requireResetConfirmation(confirm: unknown): void {
  if (confirm !== true) {
    throw new PaperError(
      'PAPER_RESET_CONFIRMATION_REQUIRED',
      'Reset requires --confirm; the paper account was not changed.',
      'Run coinbase-paper reset --confirm only when the user explicitly wants a fresh account. The old account will be archived first.',
    );
  }
}

function failed(stage: string, cause: unknown): PaperError {
  const detail = cause instanceof PaperError ? ` Cause: ${cause.code}: ${cause.message}` : '';
  return new PaperError('PAPER_RESET_FAILED', `Paper reset could not complete safely at ${stage}.${detail}`, FAILED_HINT);
}

function stamp(now: number): string {
  return new Date(now).toISOString().replace(/[-:.]/g, '');
}

export async function resetAccount(paths: PaperPaths, store: ResetStore, now: number, init: InitAccount = initAccount): Promise<ResetResult> {
  if (!Number.isSafeInteger(now) || now < 0) throw new PaperError('INVALID_REQUEST', 'now must be a millisecond timestamp');
  const previous = store.accountId;
  let settings: ReturnType<ResetStore['readLedger']>['account'];
  try {
    settings = store.readLedger().account;
  } catch (error) {
    throw failed('read', error);
  }
  if (settings.account_id !== previous) throw failed('read', new PaperError('STATE_INVALID', 'ledger account does not match the bound account'));

  const archive = path.join(paths.dataDir, ARCHIVE_DIR, `${previous}-${stamp(now)}-${randomUUID()}.sqlite3`);
  let archived: number;
  try {
    archived = (await store.backup(archive)).revision;
  } catch (error) {
    throw failed('archive', error);
  }
  // The archive must describe the ledger whose settings are reused and whose revision gates the switch.
  if (archived !== settings.revision) {
    throw new PaperError('STATE_CHANGED', `The paper account changed while it was being archived; the binding was not switched. The archive at ${archive} was kept.`, 'Retry coinbase-paper reset --confirm; do not delete the archive.');
  }

  const staging = path.join(paths.dataDir, RESETS_DIR, randomUUID());
  const fresh: PaperPaths = { dataDir: staging, profile: path.join(staging, PROFILE_FILE), state: path.join(staging, STATE_FILE) };
  const options = {
    cash: settings.initial_cash,
    currency: settings.currency,
    fee_bps: settings.taker_fee_bps,
    maker_fee_bps: settings.maker_fee_bps,
    taker_fee_bps: settings.taker_fee_bps,
    now: () => now,
  };
  let created: Record<string, unknown>;
  try {
    created = await init(fresh, options);
  } catch (error) {
    throw failed('initialize', error);
  }
  const accountId = created.account_id;
  const state = created.state;
  const maker = created.maker_fee_bps ?? created.fee_bps;
  const taker = created.taker_fee_bps ?? created.fee_bps;
  if (typeof accountId !== 'string' || accountId === previous || typeof state !== 'string' || created.initial_cash !== settings.initial_cash
    || created.currency !== settings.currency || maker !== settings.maker_fee_bps || taker !== settings.taker_fee_bps
    || !Number.isSafeInteger(created.schema_version)) {
    throw failed('initialize', new PaperError('STATE_INVALID', 'the new account does not carry the original settings'));
  }

  try {
    store.switchBinding({ state, account_id: accountId }, archived);
  } catch (error) {
    if (error instanceof PaperError && error.code === 'STATE_CHANGED') throw error;
    throw failed('switch', error);
  }
  // The top-level profile now binds the new account; drop the staging profile so the same
  // account is not bound twice. Its state file stays where the binding points.
  try {
    fs.rmSync(fresh.profile, { force: true });
  } catch {
    // The switch already succeeded; a leftover staging profile is safe to keep.
  }

  return {
    mode: PAPER_MODE,
    ok: true,
    previous_account_id: previous,
    previous_state: store.state,
    account_id: accountId,
    archive,
    state,
    initial_cash: settings.initial_cash,
    currency: settings.currency,
    maker_fee_bps: settings.maker_fee_bps,
    taker_fee_bps: settings.taker_fee_bps,
    schema_version: created.schema_version as number,
    notice: `${PAPER_NOTICE} Reset created a new paper account with the same settings and no orders, positions or history. The previous account was archived to ${archive} and its state file was kept, not deleted.`,
  };
}
