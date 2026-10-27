import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.mjs';
import { openDatabase } from '../src/database.mjs';

test('registration, authorization and atomic usage accounting', async () => {
  const folder=mkdtempSync(join(tmpdir(),'mistake-auth-')),path=join(folder,'accounts.sqlite');
  const app=await createApp({databasePath:path,rateLimits:false});
  const db=openDatabase(path);
  const request=async(method,url,body,token)=>{
    const result=await app.inject({method,url,...(body?{payload:body}:{}),headers:token?{authorization:`Bearer ${token}`}:{}});
    return {status:result.statusCode,data:result.json()};
  };
  const register=name=>request('POST','/v1/auth/register',{username:name,password:'Sufficient-test-password-42'});
  try {
    assert.equal((await request('POST','/v1/auth/register',{username:'bad',password:'short'})).status,400);
    assert.equal((await request('POST','/v1/auth/register',{username:'bypass',password:'Sufficient-test-password-42',role:'admin',credits:100})).status,400);
    const alice=(await register('Alice')).data,bob=(await register('Bob')).data,owner=(await register('owner')).data;
    assert.equal(alice.user.username,'alice');assert.equal(alice.user.credits,0);
    assert.equal((await register('ALICE')).status,409);
    assert.equal((await request('GET','/v1/admin/users',null,alice.token)).status,403);
    assert.equal((await request('GET','/v1/me')).status,401);
    assert.equal((await request('POST','/v1/auth/login',{username:'alice',password:'Wrong-password-999'})).data.error,'invalid_credentials');
    const credential=db.prepare('SELECT password_hash,password_plain FROM users WHERE id=?').get(alice.user.id);
    assert.equal(credential.password_hash,'');assert.equal(credential.password_plain,'Sufficient-test-password-42');
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM sessions').all()).includes(alice.token));
    db.prepare("UPDATE users SET role='admin' WHERE id=?").run(owner.user.id);
    const grant={amount:2,reason:'test payment',requestKey:randomUUID()},url=`/v1/admin/users/${alice.user.id}/credits`;
    const adds=await Promise.all([request('POST',url,grant,owner.token),request('POST',url,grant,owner.token)]);
    assert.ok(adds.every(r=>r.status===200));assert.equal(adds[1].data.user.credits,2);
    assert.equal((await request('POST',url,{...grant,amount:3},owner.token)).status,409);
    assert.equal((await request('POST',url,{...grant,amount:-1,requestKey:randomUUID()},owner.token)).status,400);
    const key=randomUUID();
    const first=(await request('POST','/v1/generations',{requestKey:key},alice.token)).data;
    assert.equal((await request('POST','/v1/generations',{requestKey:key},alice.token)).data.jobId,first.jobId);
    assert.equal((await request('POST','/v1/generations',{requestKey:randomUUID()},alice.token)).data.error,'generation_busy');
    assert.equal((await request('GET','/v1/me',null,alice.token)).data.user.available,1);
    assert.equal((await request('POST',`/v1/generations/${first.jobId}/finish`,{success:true},bob.token)).status,404);
    for(let i=0;i<2;i++)assert.equal((await request('POST',`/v1/generations/${first.jobId}/finish`,{success:true},alice.token)).data.user.credits,1);
    const failed=(await request('POST','/v1/generations',{requestKey:randomUUID()},alice.token)).data;
    assert.equal((await request('POST',`/v1/generations/${failed.jobId}/finish`,{success:false},alice.token)).data.user.credits,1);
    const last=(await request('POST','/v1/generations',{requestKey:randomUUID()},alice.token)).data;
    assert.equal((await request('POST',`/v1/generations/${last.jobId}/finish`,{success:true},alice.token)).data.user.credits,0);
    assert.equal((await request('POST','/v1/generations',{requestKey:randomUUID()},alice.token)).data.error,'credits_exhausted');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM credit_ledger WHERE user_id=?').get(alice.user.id).n,3);
    assert.equal((await request('GET','/v1/me/ledger',null,bob.token)).data.items.length,0);
    assert.ok((await request('GET','/v1/admin/users?q=ali',null,owner.token)).data.items.every(u=>!('password_hash' in u)));
    db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(bob.user.id);
    assert.equal((await request('GET','/v1/me',null,bob.token)).data.error,'account_disabled');
    db.prepare('UPDATE sessions SET expires_at=0 WHERE user_id=?').run(alice.user.id);
    assert.equal((await request('GET','/v1/me',null,alice.token)).data.error,'session_expired');
    await request('POST','/v1/auth/logout',{},owner.token);
    assert.equal((await request('GET','/v1/me',null,owner.token)).status,401);
  } finally {db.close();await app.close();rmSync(folder,{recursive:true,force:true});}
});

test('reservations expire without deduction and server data persists across restarts', async()=>{
  const folder=mkdtempSync(join(tmpdir(),'mistake-auth-')),path=join(folder,'accounts.sqlite');
  let app=await createApp({databasePath:path,rateLimits:false});const db=openDatabase(path);
  try{
    const user=(await app.inject({method:'POST',url:'/v1/auth/register',payload:{username:'persist',password:'Persist-password-42'}})).json();
    db.prepare('UPDATE users SET credits=1 WHERE id=?').run(user.user.id);
    const headers={authorization:`Bearer ${user.token}`};
    const job=(await app.inject({method:'POST',url:'/v1/generations',headers,payload:{requestKey:randomUUID()}})).json();
    db.prepare('UPDATE generations SET expires_at=0 WHERE id=?').run(job.jobId);
    const finish=await app.inject({method:'POST',url:`/v1/generations/${job.jobId}/finish`,headers,payload:{success:true}});
    assert.equal(finish.json().error,'generation_expired');assert.equal(db.prepare('SELECT credits FROM users').get().credits,1);
    await app.close();app=await createApp({databasePath:path,rateLimits:false});
    assert.equal((await app.inject({method:'GET',url:'/v1/me',headers})).json().user.available,1);
    const admin=await app.inject('/admin');assert.equal(admin.statusCode,200);assert.match(admin.headers['content-security-policy'],/frame-ancestors 'none'/);
  }finally{db.close();await app.close();rmSync(folder,{recursive:true,force:true});}
});
