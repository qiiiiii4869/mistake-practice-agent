import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.mjs';
import { openDatabase } from '../src/database.mjs';

test('admins reset users and themselves; plaintext is confined to credential storage and authorized viewing',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'mistake-password-')),path=join(folder,'accounts.sqlite');
  const app=await createApp({databasePath:path,rateLimits:false}),db=openDatabase(path);
  const original='Synthetic-original-password-42',changed='Synthetic-new-password-84',selfPassword='Synthetic-admin-password-99';
  const call=async(method,url,payload,token)=>{const res=await app.inject({method,url,...(payload?{payload}:{}),headers:token?{authorization:'Bearer '+token}:{}});return {status:res.statusCode,body:res.json()};};
  const register=async username=>(await call('POST','/v1/auth/register',{username,password:original})).body;
  const login=(username,password)=>call('POST','/v1/auth/login',{username,password});
  try{
    const owner=await register('owner'),user=await register('teacher'),secondAdmin=await register('other_admin');
    db.prepare("UPDATE users SET role='admin' WHERE id IN (?,?)").run(owner.user.id,secondAdmin.user.id);
    db.prepare('UPDATE users SET credits=3 WHERE id=?').run(user.user.id);
    await call('POST','/v1/generations',{requestKey:randomUUID()},user.token);
    const url=`/v1/admin/users/${user.user.id}/password`,payload={confirmUsername:'teacher',newPassword:changed,requestKey:randomUUID()};
    assert.equal((await call('POST',url,payload)).status,401);
    assert.equal((await call('POST',url,payload,user.token)).status,403);
    assert.equal((await call('POST',url,{...payload,newPassword:'short'},owner.token)).status,400);
    assert.equal((await call('POST',url,{...payload,confirmUsername:'wrong'},owner.token)).status,409);
    const response=await call('POST',url,payload,owner.token);assert.equal(response.status,200);assert.equal(response.body.self,false);
    assert.ok(!JSON.stringify(response).includes(changed));
    assert.equal((await call('POST',url,payload,owner.token)).body.duplicate,true);
    assert.equal((await call('GET','/v1/me',null,user.token)).status,401);
    assert.equal((await login('teacher',original)).body.error,'invalid_credentials');
    const relogged=(await login('teacher',changed)).body;assert.equal(relogged.user.credits,3);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM generations WHERE user_id=? AND state='reserved'").get(user.user.id).n,0);
    const listing=await call('GET','/v1/admin/users',null,owner.token);
    assert.ok(!JSON.stringify(listing).includes('password_hash'));assert.ok(!JSON.stringify(listing).includes(changed));
    const audit=await call('GET',`/v1/admin/users/${user.user.id}/account-audit`,null,owner.token);
    assert.equal(audit.body.items.filter(i=>i.action==='reset_password').length,1);assert.ok(!JSON.stringify(audit).includes(changed));
    db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(user.user.id);
    assert.equal((await call('POST',url,{...payload,requestKey:randomUUID()},owner.token)).status,200);
    assert.equal(db.prepare('SELECT status FROM users WHERE id=?').get(user.user.id).status,'disabled');
    assert.equal((await login('teacher',changed)).body.error,'account_disabled');
    const adminUrl=`/v1/admin/users/${secondAdmin.user.id}/password`,adminBody={confirmUsername:'other_admin',newPassword:changed,requestKey:randomUUID()};
    assert.equal((await call('POST',adminUrl,adminBody,owner.token)).body.error,'current_password_required');
    assert.equal((await call('POST',adminUrl,{...adminBody,currentPassword:changed},owner.token)).body.error,'current_password_incorrect');
    assert.equal((await call('POST',adminUrl,{...adminBody,currentPassword:original},owner.token)).status,200);
    assert.equal((await call('GET','/v1/me',null,secondAdmin.token)).status,401);
    const selfUrl=`/v1/admin/users/${owner.user.id}/password`,selfBody={confirmUsername:'owner',newPassword:selfPassword,requestKey:randomUUID()};
    assert.equal((await call('POST',selfUrl,selfBody,owner.token)).body.error,'current_password_required');
    const selfResult=await call('POST',selfUrl,{...selfBody,currentPassword:original},owner.token);
    assert.equal(selfResult.status,200);assert.equal(selfResult.body.reauthenticate,true);
    assert.equal((await call('GET','/v1/me',null,owner.token)).status,401);
    assert.equal((await login('owner',original)).body.error,'invalid_credentials');
    assert.equal((await login('owner',selfPassword)).body.user.role,'admin');
    assert.equal(db.prepare('SELECT password_plain FROM users WHERE id=?').get(owner.user.id).password_plain,selfPassword);
    for(const table of ['sessions','account_audit','credit_ledger','generations']){
      const contents=JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all());
      for(const secret of [original,changed,selfPassword])assert.ok(!contents.includes(secret),table);
    }
  }finally{db.close();await app.close();rmSync(folder,{recursive:true,force:true});}
});
