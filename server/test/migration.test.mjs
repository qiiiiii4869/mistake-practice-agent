import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,readdirSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/database.mjs';
import { hashPassword } from '../src/password.mjs';

const basic=`CREATE TABLE users(username TEXT NOT NULL PRIMARY KEY CHECK(length(trim(username))>0),password_hash TEXT NOT NULL CHECK(length(password_hash)>0),remaining_uses INTEGER NOT NULL DEFAULT 0 CHECK(remaining_uses>=0)) STRICT`;
test('upgrades the basic user store, preserving password hashes and balances with a readable backup',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'mistake-migrate-')),path=join(folder,'users.sqlite3');
  try{
    const before=new DatabaseSync(path);before.exec(basic);
    const hash=await hashPassword('Synthetic-migration-password-42');
    before.prepare('INSERT INTO users VALUES(?,?,?)').run('Teacher_A',hash,7);before.close();
    const db=openDatabase(path),user=db.prepare('SELECT * FROM users').get();
    assert.equal(user.username,'teacher_a');assert.equal(user.password_hash,hash);assert.equal(user.credits,7);assert.equal(user.role,'user');assert.match(user.id,/^[a-f0-9-]{36}$/);
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');
    assert.equal(db.prepare('PRAGMA user_version').get().user_version,3);
    assert.throws(()=>db.prepare('UPDATE users SET credits=?').run(1.5));
    db.close();
    const backups=readdirSync(folder).filter(name=>name.includes('.before-v1-'));assert.equal(backups.length,1);
    const backup=new DatabaseSync(join(folder,backups[0]),{readOnly:true});
    assert.equal(backup.prepare('SELECT remaining_uses FROM users').get().remaining_uses,7);backup.close();
    const reopened=openDatabase(path);assert.equal(reopened.prepare('SELECT credits FROM users').get().credits,7);reopened.close();
    assert.equal(readdirSync(folder).filter(name=>name.includes('.before-v1-')).length,1);
  }finally{rmSync(folder,{recursive:true,force:true});}
});
test('unrecognized hashes or conflicting usernames stop migration without changing the original table',()=>{
  const folder=mkdtempSync(join(tmpdir(),'mistake-migrate-')),path=join(folder,'users.sqlite3');
  try{
    const before=new DatabaseSync(path);before.exec(basic);before.prepare('INSERT INTO users VALUES(?,?,?)').run('teacher','unrecognized-format',9);before.close();
    assert.throws(()=>openDatabase(path),/legacy_accounts_require_manual_review/);
    const after=new DatabaseSync(path,{readOnly:true});assert.equal(after.prepare('SELECT remaining_uses FROM users').get().remaining_uses,9);assert.equal(after.prepare('PRAGMA table_info(users)').all().length,3);after.close();
  }finally{rmSync(folder,{recursive:true,force:true});}
});
