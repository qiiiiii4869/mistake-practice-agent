import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { openDatabase, transaction, expireJobs, publicUser } from './database.mjs';
import { hashPassword, verifyAccountPassword, tokenHash } from './password.mjs';
import { registerReportRoutes } from './report-runs.mjs';

const error = (code, statusCode = 400) => { throw Object.assign(new Error(code), { statusCode }); };
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, required, properties });
const username = { type: 'string', minLength: 3, maxLength: 32, pattern: '^[a-zA-Z0-9_]+$' };
const password = { type: 'string', minLength: 10, maxLength: 128 };
const uuid = { type: 'string', pattern: '^[a-f0-9-]{36}$' };
const credentials = object({ username, password });

export async function createApp({ databasePath = './data/accounts.sqlite', sessionHours = 12, rateLimits = true, trustedProxy = ['127.0.0.1', '::1'],
  modelKey = '', modelKeyFile, deliveryEnabled = false, allowLocalCredentials = false } = {}) {
  const db = openDatabase(databasePath);
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024, trustProxy: trustedProxy,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
  const dummy = await hashPassword(randomBytes(32).toString('hex'));
  if (rateLimits) await app.register(rateLimit, { max: 120, timeWindow: '1 minute', errorResponseBuilder: () => ({ error: 'rate_limited' }) });
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.headers({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });
    return payload;
  });
  app.setErrorHandler((err, _request, reply) => {
    const status = err.validation ? 400 : err.statusCode ?? 500;
    const code = err.validation || (err.code?.startsWith('FST_') && status === 400) ? 'invalid_input' : status===429 ? 'rate_limited' : status >= 500 && !['server_busy','model_unconfigured','model_configuration_failed'].includes(err.message) ? 'server_error' : err.message;
    reply.code(status).send({ error: code });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'not_found' }));
  app.addHook('onClose', async () => db.close());

  function readSession(request) {
    const header = request.headers.authorization ?? '';
    if (!/^Bearer [a-f0-9]{64}$/.test(header)) error('session_required', 401);
    const session = db.prepare('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?').get(tokenHash(header.slice(7)), Date.now());
    if (!session) error('session_expired', 401);
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(session.user_id);
    if (user?.status !== 'active') error('account_disabled', 403);
    request.account = user; request.sessionHash = session.token_hash;
  }
  async function authenticated(request) { readSession(request); }
  async function administrator(request) {
    await authenticated(request);
    if (request.account.role !== 'admin') error('admin_required', 403);
  }
  registerReportRoutes(app,{ db, authenticated, administrator, modelKey, modelKeyFile, deliveryEnabled, allowLocalCredentials });
  function sessionFor(user,loginPassword=null) {
    const token = randomBytes(32).toString('hex'), now = Date.now(), expiresAt = now + sessionHours * 3600_000;
    let current;
    transaction(db, () => {
      current=db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
      if(current?.status!=='active')error('account_disabled',403);
      if(current.password_hash!==user.password_hash||current.password_plain!==user.password_plain)error('invalid_credentials',401);
      if(loginPassword!==null&&current.password_plain===null){
        db.prepare("UPDATE users SET password_hash='',password_plain=? WHERE id=?").run(loginPassword,user.id);
      }
      db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(now);
      const sessions = db.prepare('SELECT token_hash FROM sessions WHERE user_id=? ORDER BY created_at DESC').all(user.id);
      for (const old of sessions.slice(4)) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(old.token_hash);
      db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(tokenHash(token), user.id, now, expiresAt);
      db.prepare('UPDATE users SET last_login_at=?,failed_logins=0,locked_until=0 WHERE id=?').run(now, user.id);
    });
    return { token, expiresAt, user: publicUser(db, current) };
  }
  const authLimit = { rateLimit: { max: 12, timeWindow: '15 minutes' } };
  app.get('/health', async () => ({ ok: true }));
  app.post('/v1/auth/register', { schema: { body: credentials }, config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async request => {
    const name = request.body.username.toLowerCase();
    const id = randomUUID();
    // Public registration never accepts role/status/balance and never creates admins.
    try { db.prepare("INSERT INTO users(id,username,password_hash,password_plain,role,status,credits,created_at) VALUES(?,?,'',?,'user','active',0,?)").run(id, name, request.body.password, Date.now()); }
    catch (err) { if (String(err.code).startsWith('ERR_SQLITE') && db.prepare('SELECT id FROM users WHERE username=?').get(name)) error('username_taken', 409); throw err; }
    return sessionFor(db.prepare('SELECT * FROM users WHERE id=?').get(id));
  });
  app.post('/v1/auth/login', { schema: { body: credentials }, config: authLimit }, async request => {
    const user = db.prepare('SELECT * FROM users WHERE username=?').get(request.body.username.toLowerCase());
    const matches = await verifyAccountPassword(request.body.password, user ?? {password_hash:dummy,password_plain:null});
    if (!user || !matches || user.locked_until > Date.now()) {
      if (user) db.prepare('UPDATE users SET failed_logins=failed_logins+1,locked_until=CASE WHEN failed_logins>=9 THEN ? ELSE locked_until END WHERE id=?').run(Date.now() + 15 * 60_000, user.id);
      error('invalid_credentials', 401);
    }
    if (user.status !== 'active') error('account_disabled', 403);
    return sessionFor(user,request.body.password);
  });
  app.get('/v1/me', { preHandler: authenticated }, async request => {
    expireJobs(db); return { user: publicUser(db, db.prepare('SELECT * FROM users WHERE id=?').get(request.account.id)) };
  });
  app.post('/v1/auth/logout', { preHandler: authenticated }, async request => {
    db.prepare('DELETE FROM sessions WHERE token_hash=?').run(request.sessionHash); return { ok: true };
  });
  app.get('/v1/me/ledger', { preHandler: authenticated }, async request => ({ items: db.prepare('SELECT delta,balance_after AS balanceAfter,kind,reason,created_at AS createdAt FROM credit_ledger WHERE user_id=? ORDER BY rowid DESC LIMIT 50').all(request.account.id) }));

  // Reserve one credit before work; only a successful, idempotent completion consumes it.
  app.post('/v1/generations', { preHandler: authenticated, schema: { body: object({ requestKey: uuid }) } }, async request => transaction(db, () => {
    expireJobs(db);
    const old = db.prepare('SELECT * FROM generations WHERE user_id=? AND request_key=?').get(request.account.id, request.body.requestKey);
    if (old) return { jobId: old.id, state: old.state };
    const active = db.prepare("SELECT id FROM generations WHERE user_id=? AND state='reserved'").get(request.account.id);
    if (active) error('generation_busy', 409);
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(request.account.id);
    if (user.credits < 1) error('credits_exhausted', 409);
    const now = Date.now(), id = randomUUID();
    db.prepare("INSERT INTO generations VALUES(?,?,?,'reserved',?,?,NULL)").run(id, user.id, request.body.requestKey, now, now + 2 * 3600_000);
    return { jobId: id, state: 'reserved' };
  }));
  app.post('/v1/generations/:id/finish', { preHandler: authenticated, schema: {
    params: object({ id: uuid }), body: object({ success: { type: 'boolean' } })
  } }, async request => transaction(db, () => {
    expireJobs(db);
    const job = db.prepare('SELECT * FROM generations WHERE id=? AND user_id=?').get(request.params.id, request.account.id);
    if (!job) error('generation_not_found', 404);
    if (db.prepare('SELECT job_id FROM report_runs WHERE job_id=?').get(job.id)) error('workflow_v2_required',409);
    if (job.state === 'completed') return { charged: true, user: publicUser(db, db.prepare('SELECT * FROM users WHERE id=?').get(request.account.id)) };
    if (job.state === 'cancelled' && !request.body.success) return { charged: false, user: publicUser(db, request.account) };
    if (job.state !== 'reserved') error('generation_expired', 409);
    if (request.body.success) {
      const updated = db.prepare('UPDATE users SET credits=credits-1 WHERE id=? AND credits>=1').run(request.account.id);
      if (updated.changes !== 1) error('credits_exhausted', 409);
      const user = db.prepare('SELECT * FROM users WHERE id=?').get(request.account.id);
      db.prepare("INSERT INTO credit_ledger VALUES(?,?,?,?,'generation',?,?,?,?)").run(randomUUID(), user.id, -1, user.credits, user.id, job.id, '成功生成一批补练', Date.now());
      db.prepare("UPDATE generations SET state='completed',completed_at=? WHERE id=?").run(Date.now(), job.id);
    } else db.prepare("UPDATE generations SET state='cancelled' WHERE id=?").run(job.id);
    return { charged: request.body.success, user: publicUser(db, db.prepare('SELECT * FROM users WHERE id=?').get(request.account.id)) };
  }));

  app.get('/v1/admin/users', { preHandler: administrator }, async request => {
    const q = String(request.query.q ?? '').slice(0, 32).replace(/[\\%_]/g, '\\$&');
    const page = Math.max(1, Math.min(100000, Number.parseInt(request.query.page, 10) || 1));
    const pattern = `%${q}%`;
    return { page, total: db.prepare("SELECT COUNT(*) AS n FROM users WHERE username LIKE ? ESCAPE '\\'").get(pattern).n,
      items: db.prepare("SELECT * FROM users WHERE username LIKE ? ESCAPE '\\' ORDER BY created_at DESC,id LIMIT 30 OFFSET ?").all(pattern, (page - 1) * 30).map(user => publicUser(db, user)) };
  });
  app.get('/v1/admin/users/:id/ledger', { preHandler: administrator, schema: { params: object({ id: uuid }) } }, async request => ({
    items: db.prepare(`SELECT l.delta,l.balance_after AS balanceAfter,l.reason,l.kind,l.created_at AS createdAt,u.username AS actor
      FROM credit_ledger l LEFT JOIN users u ON u.id=l.actor_id WHERE l.user_id=? ORDER BY l.rowid DESC LIMIT 100`).all(request.params.id)
  }));
  app.post('/v1/admin/users/:id/credits', { preHandler: administrator, schema: {
    params: object({ id: uuid }), body: object({ amount: { type: 'integer', minimum: 1, maximum: 100000 },
      reason: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' }, requestKey: uuid })
  } }, async request => transaction(db, () => {
    const { amount, reason, requestKey } = request.body;
    const prior = db.prepare("SELECT * FROM credit_ledger WHERE kind='admin_grant' AND reference=?").get(requestKey);
    if (prior && (prior.user_id !== request.params.id || prior.delta !== amount || prior.actor_id !== request.account.id || prior.reason !== reason)) error('idempotency_conflict', 409);
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(request.params.id);
    if (!user) error('user_not_found', 404);
    if (user.status !== 'active') error('account_inactive', 409);
    if (!prior) {
      if (user.credits + amount > 1000000) error('credit_limit', 409);
      db.prepare('UPDATE users SET credits=credits+? WHERE id=?').run(amount, user.id);
      db.prepare("INSERT INTO credit_ledger VALUES(?,?,?,?,'admin_grant',?,?,?,?)").run(randomUUID(), user.id, amount, user.credits + amount, request.account.id, requestKey, reason, Date.now());
    }
    return { user: publicUser(db, db.prepare('SELECT * FROM users WHERE id=?').get(user.id)), duplicate: !!prior };
  }));
  app.post('/v1/admin/users/:id/deactivate', { preHandler: administrator, schema: {
    params: object({ id: uuid }), body: object({ confirmUsername: username,
      reason: { type:'string',minLength:1,maxLength:200,pattern:'\\S' },requestKey:uuid })
  } }, async request => transaction(db,()=>{
    const {requestKey,confirmUsername,reason}=request.body;
    const target=db.prepare('SELECT * FROM users WHERE id=?').get(request.params.id);
    if(!target)error('user_not_found',404);
    if(target.role!=='user'||target.id===request.account.id)error('protected_account',403);
    if(confirmUsername!==target.username)error('username_confirmation_mismatch',409);
    const prior=db.prepare('SELECT * FROM account_audit WHERE request_key=?').get(requestKey);
    if(prior&&(prior.actor_id!==request.account.id||prior.target_id!==target.id||prior.action!=='deactivate_user'||prior.reason!==reason))error('idempotency_conflict',409);
    if(prior)return {user:publicUser(db,target),duplicate:true};
    if(target.status==='active'){
      db.prepare("UPDATE users SET status='disabled' WHERE id=? AND role='user'").run(target.id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);
      db.prepare("UPDATE generations SET state='cancelled' WHERE user_id=? AND state='reserved'").run(target.id);
    }
    if(!prior)db.prepare("INSERT INTO account_audit VALUES(?,?,?,'deactivate_user',?,?,?)").run(randomUUID(),request.account.id,target.id,requestKey,reason,Date.now());
    return {user:publicUser(db,db.prepare('SELECT * FROM users WHERE id=?').get(target.id)),duplicate:!!prior};
  }));
  const lifecycleBody=object({confirmUsername:username,reason:{type:'string',minLength:1,maxLength:200,pattern:'\\S'},requestKey:uuid});
  app.post('/v1/admin/users/:id/restore',{preHandler:administrator,schema:{params:object({id:uuid}),body:lifecycleBody}},async request=>transaction(db,()=>{
    const {requestKey,confirmUsername,reason}=request.body;
    const target=db.prepare('SELECT * FROM users WHERE id=?').get(request.params.id);
    if(!target)error('user_not_found',404);
    if(target.role!=='user'||target.id===request.account.id)error('protected_account',403);
    if(confirmUsername!==target.username)error('username_confirmation_mismatch',409);
    const prior=db.prepare('SELECT * FROM account_audit WHERE request_key=?').get(requestKey);
    if(prior&&(prior.actor_id!==request.account.id||prior.target_id!==target.id||prior.action!=='restore_user'||prior.reason!==reason))error('idempotency_conflict',409);
    if(prior)return {user:publicUser(db,target),duplicate:true};
    if(target.status!=='disabled')error('account_not_disabled',409);
    db.prepare("UPDATE users SET status='active',failed_logins=0,locked_until=0 WHERE id=? AND role='user'").run(target.id);
    // Restore credentials and balance, never resurrect old sessions or generation reservations.
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);
    db.prepare("UPDATE generations SET state='cancelled' WHERE user_id=? AND state='reserved'").run(target.id);
    db.prepare("INSERT INTO account_audit VALUES(?,?,?,'restore_user',?,?,?)").run(randomUUID(),request.account.id,target.id,requestKey,reason,Date.now());
    return {user:publicUser(db,db.prepare('SELECT * FROM users WHERE id=?').get(target.id)),duplicate:false};
  }));
  app.post('/v1/admin/users/:id/delete',{preHandler:administrator,schema:{params:object({id:uuid}),body:object({confirmUsername:username,confirmDelete:{type:'boolean',const:true}})}},async request=>{
    const result=transaction(db,()=>{
      const target=db.prepare('SELECT * FROM users WHERE id=?').get(request.params.id);
      // Retrying a deletion of the same UUID is harmless; a newly registered name has a different UUID.
      if(!target)return {deleted:true,alreadyDeleted:true};
      if(target.role!=='user'||target.id===request.account.id)error('protected_account',403);
      if(request.body.confirmUsername!==target.username)error('username_confirmation_mismatch',409);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);
      db.prepare('DELETE FROM generations WHERE user_id=?').run(target.id);
      db.prepare('DELETE FROM credit_ledger WHERE user_id=? OR actor_id=?').run(target.id,target.id);
      db.prepare('DELETE FROM account_audit WHERE target_id=? OR actor_id=?').run(target.id,target.id);
      db.prepare("DELETE FROM users WHERE id=? AND role='user'").run(target.id);
      return {deleted:true,alreadyDeleted:false};
    });
    // Do not retain a tombstone or a deletion audit containing the deleted user's identifiers.
    // Historical backup files are separate and are not edited by this account action.
    try{db.exec('PRAGMA wal_checkpoint(TRUNCATE);');}catch{/* A busy checkpoint cannot undo a committed deletion. */}
    return result;
  });
  app.get('/v1/admin/users/:id/account-audit',{preHandler:administrator,schema:{params:object({id:uuid})}},async request=>({
    items:db.prepare(`SELECT a.action,a.reason,a.created_at AS createdAt,u.username AS actor FROM account_audit a
      JOIN users u ON u.id=a.actor_id WHERE a.target_id=? ORDER BY a.rowid DESC LIMIT 100`).all(request.params.id)
  }));
  app.post('/v1/admin/users/:id/password',{preHandler:administrator,config:{rateLimit:{max:10,timeWindow:'15 minutes'}},schema:{
    params:object({id:uuid}),body:object({confirmUsername:username,newPassword:password,currentPassword:password,
      requestKey:uuid},['confirmUsername','newPassword','requestKey'])
  }},async request=>{
    const {confirmUsername,newPassword,currentPassword,requestKey}=request.body;
    const target=db.prepare('SELECT * FROM users WHERE id=?').get(request.params.id);
    if(!target)error('user_not_found',404);
    if(confirmUsername!==target.username)error('username_confirmation_mismatch',409);
    const self=target.id===request.account.id;
    // Administrator targets, including oneself, require proof of the acting admin's password.
    if(target.role==='admin'){
      if(!currentPassword)error('current_password_required',400);
      if(!await verifyAccountPassword(currentPassword,request.account))error('current_password_incorrect',403);
    }
    const actorHash=request.account.password_hash;
    const actorPlain=request.account.password_plain;
    const existing=db.prepare('SELECT * FROM account_audit WHERE request_key=?').get(requestKey);
    if(existing){
      if(existing.actor_id!==request.account.id||existing.target_id!==target.id||existing.action!=='reset_password')error('idempotency_conflict',409);
      return {ok:true,self,duplicate:true,reauthenticate:self};
    }
    return transaction(db,()=>{
      // The expensive hashing runs outside the write transaction. Recheck the session,
      // role and hashes so a concurrent freeze, reset or deletion cannot be bypassed.
      readSession(request);
      if(request.account.role!=='admin')error('admin_required',403);
      if(request.account.password_hash!==actorHash||request.account.password_plain!==actorPlain)error('session_expired',401);
      const current=db.prepare('SELECT * FROM users WHERE id=?').get(target.id);
      if(!current)error('user_not_found',404);
      const prior=db.prepare('SELECT * FROM account_audit WHERE request_key=?').get(requestKey);
      if(prior){
        if(prior.actor_id!==request.account.id||prior.target_id!==target.id||prior.action!=='reset_password')error('idempotency_conflict',409);
        return {ok:true,self,duplicate:true,reauthenticate:self};
      }
      if(current.password_hash!==target.password_hash||current.password_plain!==target.password_plain||current.role!==target.role)error('password_change_conflict',409);
      db.prepare("UPDATE users SET password_hash='',password_plain=?,failed_logins=0,locked_until=0 WHERE id=?").run(newPassword,target.id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);
      db.prepare("UPDATE generations SET state='cancelled' WHERE user_id=? AND state='reserved'").run(target.id);
      db.prepare("INSERT INTO account_audit VALUES(?,?,?,'reset_password',?,?,?)").run(randomUUID(),request.account.id,target.id,requestKey,self?'管理员修改本人密码':'管理员重设账号密码',Date.now());
      return {ok:true,self,duplicate:false,reauthenticate:self};
    });
  });
  app.post('/v1/admin/users/:id/password/view',{preHandler:administrator,config:{rateLimit:{max:20,timeWindow:'15 minutes'}},schema:{
    params:object({id:uuid}),body:object({currentPassword:password,requestKey:uuid})
  }},async request=>{
    const actor={...request.account};
    if(!await verifyAccountPassword(request.body.currentPassword,actor))error('current_password_incorrect',403);
    return transaction(db,()=>{
      readSession(request);
      if(request.account.role!=='admin')error('admin_required',403);
      if(request.account.password_hash!==actor.password_hash||request.account.password_plain!==actor.password_plain)error('session_expired',401);
      const target=db.prepare('SELECT * FROM users WHERE id=?').get(request.params.id);
      if(!target)error('user_not_found',404);
      const prior=db.prepare('SELECT * FROM account_audit WHERE request_key=?').get(request.body.requestKey);
      if(prior&&(prior.actor_id!==actor.id||prior.target_id!==target.id||prior.action!=='view_password'))error('idempotency_conflict',409);
      if(!prior)db.prepare("INSERT INTO account_audit VALUES(?,?,?,'view_password',?,?,?)").run(randomUUID(),actor.id,target.id,request.body.requestKey,'管理员查看账号密码',Date.now());
      return {available:typeof target.password_plain==='string',password:target.password_plain??null};
    });
  });
  for (const [route, file, type] of [['/admin', 'index.html', 'text/html; charset=utf-8'], ['/admin/app.js', 'app.js', 'text/javascript; charset=utf-8'], ['/admin/style.css', 'style.css', 'text/css; charset=utf-8']]) {
    app.get(route, async (_request, reply) => reply.type(type).send(await readFile(new URL(`../public/${file}`, import.meta.url))));
  }
  return app;
}
