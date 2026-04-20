import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { log } from "./logger";

/**
 * Normalized decode of the JSON blob stored under
 * `ItemTable.key = 'windsurfAuthStatus'` in Windsurf's `state.vscdb`.
 *
 * Every field is optional — the upstream shape evolves and missing keys are
 * acceptable as long as `apiKey` is present. Additional fields are retained
 * under the index signature for forward-compatibility with future Windsurf
 * builds (`firebaseIdToken`, `name`, etc.).
 */
export interface WindsurfLocalAuthStatus {
  apiKey?: string;
  apiServerUrl?: string;
  email?: string;
  name?: string;
  firebaseIdToken?: string;
  [key: string]: unknown;
}

// ── Extension-context plumbing ────────────────────────────────────────────
//
// Needed so we can derive the `state.vscdb` path from our own
// `globalStorageUri` rather than hard-coding `%APPDATA%\Windsurf\...`, which
// would break for users running a portable Windsurf build or a custom
// `--user-data-dir`.

let extContext: vscode.ExtensionContext | null = null;

export function setExtensionContext(context: vscode.ExtensionContext): void {
  extContext = context;
}

/**
 * Locate Windsurf's shared `state.vscdb`. VS Code / Windsurf stores each
 * extension's global storage at:
 *   `{userDataDir}/User/globalStorage/{publisher}.{extensionName}/`
 * and writes the shared IDE state to:
 *   `{userDataDir}/User/globalStorage/state.vscdb`
 *
 * So going one level up from our own `globalStorageUri` lands us in the
 * correct directory regardless of platform or portable install.
 */
function resolveStateDbPath(): string | null {
  if (!extContext) {
    return null;
  }
  try {
    const ours = extContext.globalStorageUri.fsPath;
    const parent = path.dirname(ours);
    return path.join(parent, "state.vscdb");
  } catch {
    return null;
  }
}

// ── sql.js initialization (one-shot per process) ──────────────────────────

let sqlJsInstance: SqlJsStatic | null = null;
let sqlJsInit: Promise<SqlJsStatic> | null = null;

async function getSqlJs(): Promise<SqlJsStatic> {
  if (sqlJsInstance) {
    return sqlJsInstance;
  }
  if (!sqlJsInit) {
    // Resolve the sql.js dist directory via require.resolve so the path
    // survives packaging (relative-to-__dirname would break when vsce
    // flattens the tree, and hard-coding `node_modules/...` would break
    // if a host chooses an alternate module resolver).
    const sqlJsDir = path.dirname(require.resolve("sql.js"));
    sqlJsInit = initSqlJs({
      locateFile: (file: string) => path.join(sqlJsDir, file),
    }).then((SQL) => {
      sqlJsInstance = SQL;
      return SQL;
    });
  }
  return sqlJsInit;
}

// ── Public entry point ────────────────────────────────────────────────────

/**
 * Best-effort read of the Windsurf auth blob from the shared VS Code state
 * DB. Returns null for every failure mode (no context, DB missing, SQL error,
 * key absent, malformed JSON) — the caller treats null as "no local creds"
 * and falls through to the in-memory / remote paths.
 *
 * We intentionally open the file by reading its bytes into memory (rather
 * than opening it as a SQLite handle on disk) because:
 *   1. sql.js is pure WASM and works against a buffer.
 *   2. It avoids any file-locking contention with the running Windsurf IDE,
 *      which holds a shared lock via `@vscode/sqlite3`.
 */
export async function readLocalAuthStatus(): Promise<WindsurfLocalAuthStatus | null> {
  const dbPath = resolveStateDbPath();
  if (!dbPath) {
    log("windsurfAuth: no extension context yet — cannot locate state.vscdb");
    return null;
  }
  if (!fs.existsSync(dbPath)) {
    log(`windsurfAuth: state.vscdb not found at ${dbPath}`);
    return null;
  }
  log(`windsurfAuth: reading ${dbPath}`);

  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(dbPath);
  } catch (e: unknown) {
    log(`windsurfAuth: readFileSync failed: ${(e as Error)?.message ?? e}`);
    return null;
  }

  let SQL: SqlJsStatic;
  try {
    SQL = await getSqlJs();
  } catch (e: unknown) {
    log(`windsurfAuth: sql.js init failed: ${(e as Error)?.message ?? e}`);
    return null;
  }

  let db: InstanceType<SqlJsStatic["Database"]> | null = null;
  try {
    db = new SQL.Database(buffer);
    // 1) Try the canonical key first — matches cockpit-tools' read path.
    const direct = readByKey(db, "windsurfAuthStatus");
    if (direct) {
      log("windsurfAuth: got windsurfAuthStatus directly");
      return direct;
    }
    log(
      "windsurfAuth: windsurfAuthStatus absent, scanning ItemTable for an auth-shaped blob"
    );
    // 2) Fallback: scan for any JSON value that looks like the auth blob
    //    (contains an `sk-ws-*` apiKey). This covers Windsurf builds that
    //    renamed the key.
    const scanned = scanForAuthBlob(db);
    if (scanned) {
      log(`windsurfAuth: recovered auth blob from fallback key "${scanned.key}"`);
      return scanned.value;
    }
    log("windsurfAuth: no auth blob found in state.vscdb");
    return null;
  } catch (e: unknown) {
    log(`windsurfAuth: SQL error: ${(e as Error)?.message ?? e}`);
    return null;
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  }
}

function readByKey(
  db: InstanceType<SqlJsStatic["Database"]>,
  key: string
): WindsurfLocalAuthStatus | null {
  const stmt = db.prepare(
    "SELECT value FROM ItemTable WHERE key = ? LIMIT 1"
  );
  try {
    stmt.bind([key]);
    if (!stmt.step()) {
      return null;
    }
    const row = stmt.getAsObject() as { value: unknown };
    const jsonStr = valueToString(row.value);
    if (!jsonStr) {
      return null;
    }
    try {
      const parsed = JSON.parse(jsonStr) as WindsurfLocalAuthStatus;
      if (!parsed || typeof parsed !== "object") {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  } finally {
    stmt.free();
  }
}

/**
 * Walk every row of ItemTable once, looking for a JSON value that (a) parses,
 * (b) is an object, and (c) carries an `sk-ws-*` apiKey either at the top
 * level or under `apiKey` / `api_key`. Returns the first match.
 *
 * This is intentionally O(n) over the table because (1) state.vscdb is
 * typically <1 MB, (2) sql.js runs in memory against our own copy, and
 * (3) it only fires when the direct key lookup already failed.
 */
function scanForAuthBlob(
  db: InstanceType<SqlJsStatic["Database"]>
): { key: string; value: WindsurfLocalAuthStatus } | null {
  const stmt = db.prepare(
    "SELECT key, value FROM ItemTable WHERE value LIKE '%sk-ws-%' LIMIT 50"
  );
  try {
    while (stmt.step()) {
      const row = stmt.getAsObject() as { key: unknown; value: unknown };
      const key = typeof row.key === "string" ? row.key : "";
      const jsonStr = valueToString(row.value);
      if (!jsonStr) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonStr);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object") {
        continue;
      }
      const rec = parsed as Record<string, unknown>;
      const apiKey = rec["apiKey"] ?? rec["api_key"];
      if (typeof apiKey === "string" && apiKey.startsWith("sk-ws-")) {
        return { key, value: rec as WindsurfLocalAuthStatus };
      }
    }
  } finally {
    stmt.free();
  }
  return null;
}

function valueToString(raw: unknown): string | null {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw instanceof Uint8Array) {
    return Buffer.from(raw).toString("utf8");
  }
  return null;
}

/**
 * In-memory cache for the decoded auth blob so repeated quota refreshes
 * don't re-hit the SQLite file. Invalidated by `clearLocalAuthCache()`
 * on Full Refresh.
 */
let cached: WindsurfLocalAuthStatus | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 60_000;

export async function getLocalAuthStatus(): Promise<WindsurfLocalAuthStatus | null> {
  const now = Date.now();
  if (cached && now - cachedAt < CACHE_TTL_MS) {
    return cached;
  }
  const fresh = await readLocalAuthStatus();
  cached = fresh;
  cachedAt = now;
  return fresh;
}

export function clearLocalAuthCache(): void {
  cached = null;
  cachedAt = 0;
}
