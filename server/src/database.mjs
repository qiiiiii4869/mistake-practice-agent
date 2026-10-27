import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const usersSchema=`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  credits INTEGER NOT NULL DEFAULT 0 CHECK(credits >= 0 AND credits <= 1000000),
  created_at INTEGER NOT NULL, last_login_at INTEGER,
  failed_logins INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0
) STRICT;`;

function upgradeBasicUserStore(db,path){
  const columns=db.prepare('PRAGMA table_info(users)').all().map(column=>column.name);
  if(!columns.length||columns.includes('id'))return;
  if(columns.length!==3||!['username','password_hash','remaining_uses'].every(name=>columns.includes(name))
      ||db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().length!==1)
    throw new Error('unsupported_account_database_schema');
  const rows=db.prepare('SELECT username,password_hash,remaining_uses FROM users').all();
  const names=new Set();
  for(const row of rows){
    const name=row.username.toLowerCase();
    if(!/^[a-z0-9_]{3,32}$/.test(name)||names.has(name)||!Number.isSafeInteger(row.remaining_uses)||row.remaining_uses<0||row.remaining_uses>1000000
        ||!/^scrypt-v1\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(row.password_hash))throw new Error('legacy_accounts_require_manual_review');
    names.add(name);
  }
  // A complete SQLite snapshot precedes the transaction, including any WAL data.
  if(path!==':memory:'){
    const backup=resolve(path)+`.before-v1-${Date.now()}-${randomUUID()}.sqlite3`;
    db.prepare('VACUUM INTO ?').run(backup);chmodSync(backup,0o600);
  }
  transaction(db,()=>{
    db.exec('ALTER TABLE users RENAME TO users_before_accounts_v1');db.exec(usersSchema);
    const insert=db.prepare('INSERT INTO users(id,username,password_hash,credits,created_at) VALUES(?,?,?,?,?)');
    for(const row of rows)insert.run(randomUUID(),row.username.toLowerCase(),row.password_hash,row.remaining_uses,Date.now());
    db.exec('DROP TABLE users_before_accounts_v1');
  });
}

export function openDatabase(path) {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  try {
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;');
  if(db.prepare('PRAGMA user_version').get().user_version>3)throw new Error('unsupported_account_database_version');
  upgradeBasicUserStore(db,path);
  db.exec(usersSchema);
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS generations (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), request_key TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('reserved','completed','cancelled','expired')),
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, completed_at INTEGER,
      UNIQUE(user_id,request_key)
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_generation ON generations(user_id) WHERE state='reserved';
    CREATE TABLE IF NOT EXISTS credit_ledger (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), delta INTEGER NOT NULL,
      balance_after INTEGER NOT NULL CHECK(balance_after >= 0),
      kind TEXT NOT NULL CHECK(kind IN ('admin_grant','generation')),
      actor_id TEXT REFERENCES users(id), reference TEXT NOT NULL, reason TEXT NOT NULL,
      created_at INTEGER NOT NULL, UNIQUE(kind,reference)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS ledger_user ON credit_ledger(user_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS account_audit (
      id TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES users(id),
      target_id TEXT NOT NULL REFERENCES users(id),
      action TEXT NOT NULL CHECK(action IN ('deactivate_user','restore_user','import_admin')),
      request_key TEXT NOT NULL UNIQUE, reason TEXT NOT NULL, created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS account_audit_target ON account_audit(target_id,created_at DESC);
    `);
  const auditSchema=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='account_audit'").get().sql;
  if(!auditSchema.includes("'restore_user'")){
    transaction(db,()=>{
      db.exec(`ALTER TABLE account_audit RENAME TO account_audit_before_v3;
        DROP INDEX IF EXISTS account_audit_target;
        CREATE TABLE account_audit (
          id TEXT PRIMARY KEY,actor_id TEXT NOT NULL REFERENCES users(id),target_id TEXT NOT NULL REFERENCES users(id),
          action TEXT NOT NULL CHECK(action IN ('deactivate_user','restore_user','import_admin')),
          request_key TEXT NOT NULL UNIQUE,reason TEXT NOT NULL,created_at INTEGER NOT NULL
        ) STRICT;
        INSERT INTO account_audit SELECT * FROM account_audit_before_v3 ORDER BY rowid;
        DROP TABLE account_audit_before_v3;
        CREATE INDEX account_audit_target ON account_audit(target_id,created_at DESC);`);
    });
  }
  db.exec('PRAGMA user_version=3;');
  return db;
  }catch(error){db.close();throw error;}
}

export function transaction(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function expireJobs(db, now = Date.now()) {
  db.prepare("UPDATE generations SET state='expired' WHERE state='reserved' AND expires_at<=?").run(now);
}

export function publicUser(db, user) {
  const reserved = db.prepare("SELECT COUNT(*) AS n FROM generations WHERE user_id=? AND state='reserved' AND expires_at>?").get(user.id, Date.now()).n;
  return { id: user.id, username: user.username, role: user.role, status: user.status,
    credits: user.credits, reserved, available: user.credits - reserved, createdAt: user.created_at };
}
