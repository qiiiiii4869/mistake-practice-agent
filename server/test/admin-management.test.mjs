import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.mjs';
import { openDatabase } from '../src/database.mjs';
import { hashPassword } from '../src/password.mjs';
import { exportAdmin,importAdmin } from '../src/admin-transfer.mjs';

test('only server-authorized admins can deactivate ordinary users; sessions revoked and credit history preserved',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'mistake-admin-')),path=join(folder,'accounts.sqlite');
  const app=await createApp({databasePath:path,rateLimits:false}),db=openDatabase(path);
  const password='Synthetic-deactivation-password-42';
  const call=async(method,url,payload,token)=>{
    const response=await app.inject({method,url,...(payload?{payload}:{}),headers:token?{authorization:'Bearer '+token}:{}});
    return {status:response.statusCode,body:response.json()};
  };
  const register=async username=>(await call('POST','/v1/auth/register',{username,password})).body;
  try{
    const owner=await register('owner'),target=await register('ordinary'),other=await register('another'),namedAdmin=await register('admin_account');
    assert.equal(namedAdmin.user.role,'user');assert.equal(namedAdmin.user.credits,0);
    assert.equal((await call('POST','/v1/auth/register',{username:'injected',password,role:'admin'})).status,400);
    assert.equal((await call('POST','/v1/auth/register',{username:'injected',password,isAdmin:true})).status,400);
    db.prepare("UPDATE users SET role='admin' WHERE id=?").run(owner.user.id);
    db.prepare('UPDATE users SET credits=3 WHERE id=?').run(target.user.id);
    const job=(await call('POST','/v1/generations',{requestKey:randomUUID()},target.token)).body;
    const body={confirmUsername:'ordinary',reason:'管理员测试注销',requestKey:randomUUID()},url=`/v1/admin/users/${target.user.id}/deactivate`;
    assert.equal((await call('POST',url,body)).status,401);
    assert.equal((await call('POST',url,body,other.token)).status,403);
    assert.equal((await call('POST',`/v1/admin/users/${owner.user.id}/deactivate`,{...body,confirmUsername:'owner'},owner.token)).body.error,'protected_account');
    assert.equal((await call('POST',url,{...body,confirmUsername:'wrong'},owner.token)).body.error,'username_confirmation_mismatch');
    assert.equal((await call('POST',url,body,owner.token)).body.user.status,'disabled');
    assert.equal((await call('POST',url,body,owner.token)).body.duplicate,true);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account_audit').get().n,1);
    assert.equal(db.prepare('SELECT credits FROM users WHERE id=?').get(target.user.id).credits,3);
    assert.equal(db.prepare('SELECT state FROM generations WHERE id=?').get(job.jobId).state,'cancelled');
    assert.equal((await call('GET','/v1/me',null,target.token)).status,401);
    assert.equal((await call('POST','/v1/auth/login',{username:'ordinary',password})).body.error,'account_disabled');
    assert.equal((await call('POST',`/v1/admin/users/${target.user.id}/credits`,{amount:1,reason:'不允许给已注销账号加次',requestKey:randomUUID()},owner.token)).body.error,'account_inactive');
    assert.equal((await call('POST','/v1/auth/register',{username:'ordinary',password})).status,409);
    assert.equal((await call('POST',`/v1/admin/users/${other.user.id}/deactivate`,{...body,confirmUsername:'another'},owner.token)).body.error,'idempotency_conflict');
    const audit=(await call('GET',`/v1/admin/users/${target.user.id}/account-audit`,null,owner.token)).body.items;
    assert.equal(audit.length,1);assert.equal(audit[0].actor,'owner');assert.equal(audit[0].action,'deactivate_user');
    assert.equal((await call('GET','/v1/me',null,owner.token)).status,200);
  }finally{db.close();await app.close();rmSync(folder,{recursive:true,force:true});}
});

test('admin transfer preserves ID, password and complete own ledger, creates no sessions and does not overwrite conflicts',async()=>{
  const source=openDatabase(':memory:'),destination=openDatabase(':memory:');
  try{
    const id=randomUUID(),hash=await hashPassword('Synthetic-transfer-password-42');
    source.prepare("INSERT INTO users(id,username,password_hash,role,credits,created_at) VALUES(?,'wangmin',?,'admin',10,?)").run(id,hash,Date.now());
    source.prepare("INSERT INTO credit_ledger VALUES(?,?,10,10,'admin_grant',?,?,?,?)").run(randomUUID(),id,id,randomUUID(),'测试迁移余额',Date.now());
    source.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run('a'.repeat(64),id,Date.now(),Date.now()+10000);
    const document=exportAdmin(source,'wangmin');assert.equal('sessions' in document,false);
    const first=importAdmin(destination,document);assert.equal(first.id,id);assert.equal(first.credits,10);
    assert.equal(destination.prepare('SELECT password_hash FROM users').get().password_hash,hash);
    assert.equal(destination.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,0);
    assert.equal(destination.prepare('SELECT COUNT(*) AS n FROM credit_ledger').get().n,1);
    assert.equal(importAdmin(destination,document).duplicate,true);
    assert.equal(destination.prepare('SELECT COUNT(*) AS n FROM account_audit').get().n,1);
    assert.throws(()=>importAdmin(destination,{...document,user:{...document.user,credits:11}}),/ledger_balance_mismatch/);
    assert.throws(()=>importAdmin(destination,{...document,user:{...document.user,id:randomUUID()}}),/invalid_admin_transfer/);
    assert.throws(()=>importAdmin(destination,{...document,user:{...document.user,password_hash:'scrypt-v1$'+'b'.repeat(32)+'$'+'c'.repeat(128)}}),/existing_account_conflict/);
  }finally{source.close();destination.close();}
});
