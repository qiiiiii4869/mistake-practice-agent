import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/app.mjs';
import { openDatabase } from '../src/database.mjs';

test('restore preserves credentials and credits; hard delete removes all relations, permits a fresh registration and protects admins',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'mistake-lifecycle-')),path=join(folder,'accounts.sqlite');
  const app=await createApp({databasePath:path,rateLimits:false}),db=openDatabase(path);
  const password='Synthetic-lifecycle-password-42';
  const call=async(method,url,payload,token)=>{const response=await app.inject({method,url,...(payload?{payload}:{}),headers:token?{authorization:'Bearer '+token}:{}});return {status:response.statusCode,body:response.json()};};
  const reg=async username=>(await call('POST','/v1/auth/register',{username,password})).body;
  const body=(name,reason)=>({confirmUsername:name,reason,requestKey:randomUUID()});
  try{
    const owner=await reg('owner'),user=await reg('target_user'),other=await reg('untouched');
    db.prepare("UPDATE users SET role='admin' WHERE id=?").run(owner.user.id);
    const base=`/v1/admin/users/${user.user.id}`;
    await call('POST',base+'/credits',{amount:8,reason:'保留余额测试',requestKey:randomUUID()},owner.token);
    const originalHash=db.prepare('SELECT password_hash FROM users WHERE id=?').get(user.user.id).password_hash;
    const cancel1=body('target_user','先注销');await call('POST',base+'/deactivate',cancel1,owner.token);
    db.prepare('UPDATE users SET failed_logins=20,locked_until=? WHERE id=?').run(Date.now()+100000,user.user.id);
    const restore=body('target_user','恢复正常使用');
    assert.equal((await call('POST',base+'/restore',restore)).status,401);
    assert.equal((await call('POST',base+'/restore',restore,other.token)).status,403);
    assert.equal((await call('POST',base+'/restore',{...restore,confirmUsername:'wrong'},owner.token)).body.error,'username_confirmation_mismatch');
    assert.equal((await call('POST',base+'/restore',restore,owner.token)).body.user.credits,8);
    assert.equal((await call('POST',base+'/restore',restore,owner.token)).body.duplicate,true);
    assert.equal(db.prepare('SELECT password_hash FROM users WHERE id=?').get(user.user.id).password_hash,originalHash);
    assert.equal((await call('GET','/v1/me',null,user.token)).status,401);
    // A delayed retry of the first deactivation must not deactivate a restored account.
    assert.equal((await call('POST',base+'/deactivate',cancel1,owner.token)).body.user.status,'active');
    const login=(await call('POST','/v1/auth/login',{username:'target_user',password})).body;assert.ok(login.token);
    await call('POST','/v1/generations',{requestKey:randomUUID()},login.token);
    await call('POST',base+'/deactivate',body('target_user','再次注销'),owner.token);
    // A delayed retry of restoration must not override a later deactivation.
    assert.equal((await call('POST',base+'/restore',restore,owner.token)).body.user.status,'disabled');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM account_audit WHERE action='restore_user'").get().n,1);
    const deletion={confirmUsername:'target_user',confirmDelete:true};
    for(const action of ['delete','restore'])assert.equal((await call('POST',`/v1/admin/users/${owner.user.id}/${action}`,action==='delete'?{confirmUsername:'owner',confirmDelete:true}:body('owner','不允许恢复管理员'),owner.token)).body.error,'protected_account');
    assert.equal((await call('POST',base+'/delete',deletion,other.token)).status,403);
    assert.equal((await call('POST',base+'/delete',{...deletion,confirmDelete:false},owner.token)).status,400);
    assert.equal((await call('POST',base+'/delete',{...deletion,confirmUsername:'wrong'},owner.token)).status,409);
    const deleted=await call('POST',base+'/delete',deletion,owner.token);assert.equal(deleted.status,200);assert.equal(deleted.body.deleted,true);
    assert.equal((await call('POST',base+'/delete',deletion,owner.token)).body.alreadyDeleted,true);
    for(const table of ['users','sessions','generations','credit_ledger','account_audit']){
      const where=table==='users'?'id=?':table==='credit_ledger'?'user_id=? OR actor_id=?':table==='account_audit'?'target_id=? OR actor_id=?':'user_id=?';
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...Array((where.match(/\?/g)||[]).length).fill(user.user.id)).n,0,table);
    }
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    assert.equal((await call('POST',base+'/restore',body('target_user','删除后不能恢复'),owner.token)).status,404);
    const fresh=await reg('target_user');assert.notEqual(fresh.user.id,user.user.id);assert.equal(fresh.user.credits,0);assert.equal(fresh.user.role,'user');
    await call('POST',base+'/delete',deletion,owner.token);
    assert.equal((await call('GET','/v1/me',null,fresh.token)).status,200);
    // Active ordinary accounts can also be removed without first deactivating.
    assert.equal((await call('POST',`/v1/admin/users/${fresh.user.id}/delete`,deletion,owner.token)).body.deleted,true);
    assert.equal((await call('GET','/v1/me',null,fresh.token)).status,401);
    assert.equal((await call('GET','/v1/me',null,other.token)).status,200);
    assert.equal((await call('GET','/v1/me',null,owner.token)).status,200);
  }finally{db.close();await app.close();rmSync(folder,{recursive:true,force:true});}
});

test('version 2 audit schema upgrades transactionally and retains existing history',()=>{
  const folder=mkdtempSync(join(tmpdir(),'mistake-v3-')),path=join(folder,'accounts.sqlite');
  try{
    let db=new DatabaseSync(path);
    db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY);
      CREATE TABLE account_audit(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL REFERENCES users(id),target_id TEXT NOT NULL REFERENCES users(id),action TEXT NOT NULL CHECK(action IN ('deactivate_user','import_admin')),request_key TEXT NOT NULL UNIQUE,reason TEXT NOT NULL,created_at INTEGER NOT NULL) STRICT;
      CREATE INDEX account_audit_target ON account_audit(target_id,created_at DESC);
      INSERT INTO users VALUES('owner');INSERT INTO users VALUES('target');
      INSERT INTO account_audit VALUES('entry','owner','target','deactivate_user','old-key','旧注销记录',1);
      PRAGMA user_version=2;`);db.close();
    db=openDatabase(path);assert.equal(db.prepare('PRAGMA user_version').get().user_version,5);
    assert.equal(db.prepare('SELECT reason FROM account_audit WHERE id=?').get('entry').reason,'旧注销记录');
    db.prepare('INSERT INTO account_audit VALUES(?,?,?,?,?,?,?)').run('restore','owner','target','restore_user','restore-key','恢复测试',2);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);db.close();
  }finally{rmSync(folder,{recursive:true,force:true});}
});
