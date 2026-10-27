import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.mjs';
import { openDatabase } from '../src/database.mjs';
import { hashPassword } from '../src/password.mjs';

test('authorized password view verifies the admin; legacy accounts convert only after correct login',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'mistake-view-')),path=join(folder,'accounts.sqlite');
  const app=await createApp({databasePath:path,rateLimits:false}),db=openDatabase(path);
  const original='Synthetic-view-password-42',adminPassword='Synthetic-admin-view-84';
  const call=async(method,url,payload,token)=>{const r=await app.inject({method,url,...(payload?{payload}:{}),headers:token?{authorization:'Bearer '+token}:{}});return {status:r.statusCode,body:r.json()};};
  try{
    const owner=(await call('POST','/v1/auth/register',{username:'owner',password:adminPassword})).body;
    const ordinary=(await call('POST','/v1/auth/register',{username:'ordinary',password:original})).body;
    db.prepare("UPDATE users SET role='admin' WHERE id=?").run(owner.user.id);
    const url=`/v1/admin/users/${ordinary.user.id}/password/view`,proof={currentPassword:adminPassword,requestKey:randomUUID()};
    assert.equal((await call('POST',url,proof)).status,401);
    assert.equal((await call('POST',url,proof,ordinary.token)).status,403);
    assert.equal((await call('POST',url,{...proof,currentPassword:original},owner.token)).body.error,'current_password_incorrect');
    assert.equal((await call('POST',url,proof,owner.token)).body.password,original);
    const userList=(await call('GET','/v1/admin/users',null,owner.token)).body;
    assert.ok(!JSON.stringify(userList).includes(original));assert.ok(!JSON.stringify(userList).includes(adminPassword));
    const id=randomUUID(),hash=await hashPassword(original);
    db.prepare("INSERT INTO users(id,username,password_hash,created_at,credits) VALUES(?,'legacy_teacher',?,?,4)").run(id,hash,Date.now());
    const legacyUrl=`/v1/admin/users/${id}/password/view`;
    assert.deepEqual((await call('POST',legacyUrl,{...proof,requestKey:randomUUID()},owner.token)).body,{available:false,password:null});
    await call('POST','/v1/auth/login',{username:'legacy_teacher',password:adminPassword});
    assert.equal(db.prepare('SELECT password_plain FROM users WHERE id=?').get(id).password_plain,null);
    const logged=await call('POST','/v1/auth/login',{username:'legacy_teacher',password:original});assert.equal(logged.body.user.credits,4);
    assert.equal(db.prepare('SELECT password_plain FROM users WHERE id=?').get(id).password_plain,original);
    assert.equal(db.prepare('SELECT password_hash FROM users WHERE id=?').get(id).password_hash,'');
    assert.equal((await call('POST',legacyUrl,{...proof,requestKey:randomUUID()},owner.token)).body.password,original);
    assert.equal((await call('POST',`/v1/admin/users/${owner.user.id}/password/view`,{...proof,requestKey:randomUUID()},owner.token)).body.password,adminPassword);
    for(const table of ['account_audit','credit_ledger','sessions','generations']){
      const content=JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all());assert.ok(!content.includes(original));assert.ok(!content.includes(adminPassword));
    }
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(owner.user.id);
    assert.equal((await call('POST',url,proof,owner.token)).status,401);
  }finally{db.close();await app.close();rmSync(folder,{recursive:true,force:true});}
});
