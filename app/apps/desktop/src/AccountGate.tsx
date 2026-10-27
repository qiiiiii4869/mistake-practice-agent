import React from 'react';
import { invoke } from '@tauri-apps/api/core';

export interface AccountUser {id:string;username:string;role:'user'|'admin';status:string;credits:number;reserved:number;available:number;createdAt:number}
interface AccountContextValue {user:AccountUser;refresh:()=>Promise<void>;setWorkBusy:(busy:boolean)=>void;view:'teaching'|'admin';setView:(view:'teaching'|'admin')=>void;passwordChanged:()=>void}
const AccountContext=React.createContext<AccountContextValue|null>(null);
export function useAccount(){const value=React.useContext(AccountContext);if(!value)throw new Error('account_required');return value;}
export function accountError(error:unknown):string{
  const code=error instanceof Error?error.message:String(error);
  return ({username_taken:'这个用户名已被注册，请换一个或直接登录。',invalid_credentials:'用户名或密码不正确，请重新输入。',
    invalid_input:'用户名需为 3～32 位字母、数字或下划线，密码需为 10～128 位。',account_disabled:'这个账号已停用，请联系管理员。',
    session_required:'请登录后继续使用。',session_expired:'登录已过期，请重新登录。',rate_limited:'操作较频繁，请稍后再试。',
    account_server_unconfigured:'账号服务尚未配置，请联系管理员获取配置好的程序。',account_network_failed:'暂时连接不上账号服务器，请检查网络后重试。',
    credits_exhausted:'剩余次数不足，请联系管理员添加次数。',generation_busy:'账号有一批生成任务尚未结束，请先处理上次任务。',
    generation_expired:'这次生成预占已过期，请联系管理员核对本次结果。',generation_empty:'没有生成可用的补练题，本次不扣次数。',
    account_work_in_progress:'当前任务尚未结束，请完成后退出。',account_busy:'账号信息正在更新，请稍后重试。',
    generation_not_found:'没有找到这次生成任务，请联系管理员。',server_busy:'服务器正忙，请稍后重试。',
    admin_required:'此账号没有管理员权限。',credit_limit:'次数余额超过上限，请减少添加数量。',idempotency_conflict:'这笔操作的内容不一致，请联系管理员核对。',user_not_found:'没有找到这个用户，请刷新列表。',
    account_inactive:'这个账号已冻结，不能继续添加次数。',protected_account:'管理员账号受保护，不能冻结、恢复或删除。',username_confirmation_mismatch:'输入的用户名与目标账号不一致。',account_not_disabled:'该账号当前未冻结，请刷新用户列表。',
    current_password_required:'修改管理员密码需要输入你当前的管理员密码。',current_password_incorrect:'当前管理员密码不正确。',password_change_conflict:'该账号密码或权限已经变更，请刷新后重试。',
    account_invalid_response:'服务器返回的账号信息不完整，请稍后重试。'} as Record<string,string>)[code]??'账号操作未完成，请稍后重试。';
}

export function AccountGate({children}:{children:React.ReactNode}){
  const [config,setConfig]=React.useState<{configured:boolean;server:string|null}|null>(null);
  const [user,setUser]=React.useState<AccountUser|null>(null);
  const [checking,setChecking]=React.useState(true);
  const [register,setRegister]=React.useState(false);
  const [username,setUsername]=React.useState('');
  const [password,setPassword]=React.useState('');
  const [confirm,setConfirm]=React.useState('');
  const [busy,setBusy]=React.useState(false);
  const [workBusy,setWorkBusy]=React.useState(false);
  const [view,setView]=React.useState<'teaching'|'admin'>('teaching');
  const accountId=React.useRef<string|null>(null);
  const [error,setError]=React.useState('');
  const [loginNotice,setLoginNotice]=React.useState('');
  const [blocked,setBlocked]=React.useState(false);
  const refreshing=React.useRef(false);
  const acceptAccount=React.useCallback((next:AccountUser|null)=>{
    if(next?.id!==accountId.current){setView(next?.role==='admin'?'admin':'teaching');accountId.current=next?.id??null;}
    if(next?.role!=='admin')setView('teaching');
    setUser(next);
  },[]);
  const refresh=React.useCallback(async()=>{
    if(refreshing.current)return;refreshing.current=true;
    try{const next=await invoke<AccountUser|null>('account_me');acceptAccount(next);setBlocked(false);setError('');}
    catch(err){const code=String(err);if(code==='account_busy')return;
      if(['session_required','session_expired','account_disabled'].includes(code))acceptAccount(null);
      else setBlocked(true);setError(accountError(err));
    }finally{refreshing.current=false;setChecking(false);}
  },[acceptAccount]);
  React.useEffect(()=>{void invoke<{configured:boolean;server:string|null}>('account_config').then(next=>{setConfig(next);return refresh();}).catch(err=>{setError(accountError(err));setChecking(false);});},[refresh]);
  React.useEffect(()=>{if(!user)return;const timer=window.setInterval(()=>void refresh(),45000);const listener=()=>void refresh();window.addEventListener('account-changed',listener);return()=>{clearInterval(timer);window.removeEventListener('account-changed',listener);};},[user?.id,refresh]);
  async function submit(event:React.FormEvent){
    event.preventDefault();if(register&&password!==confirm){setError('两次输入的密码不一致。');return;}
    setBusy(true);setError('');
    try{const next=await invoke<AccountUser>('account_sign_in',{username:username.trim(),password,register});setPassword('');setConfirm('');setBlocked(false);acceptAccount(next);}
    catch(err){setError(accountError(err));}finally{setBusy(false);}
  }
  async function logout(){setBusy(true);try{await invoke('account_sign_out');acceptAccount(null);setBlocked(false);setPassword('');setConfirm('');setError('');}catch(err){setError(accountError(err));}finally{setBusy(false);}}
  if(checking)return <main className="auth-loading" role="status">正在连接账号服务…</main>;
  if(user)return <AccountContext.Provider value={{user,refresh,setWorkBusy,view,setView,passwordChanged:()=>{acceptAccount(null);setWorkBusy(false);setError('');setBlocked(false);setLoginNotice('密码已修改，请使用新密码重新登录。');}}}>
    <div className="account-toolbar"><div><span className="account-avatar" aria-hidden="true">{user.username.slice(0,1).toUpperCase()}</span><b>{user.username}</b>{user.role==='admin'&&<span className="badge success">管理员</span>}<span className="account-balance">剩余 <strong>{user.credits}</strong> 次{user.reserved>0?` · ${user.reserved} 次处理中`:''}</span></div><div>{user.role==='admin'&&<><button className={`small ${view==='admin'?'':'secondary'}`} disabled={busy||workBusy} onClick={()=>setView('admin')}>管理用户与次数</button><button className={`small ${view==='teaching'?'':'secondary'}`} disabled={busy||workBusy} onClick={()=>setView('teaching')}>教学工作台</button></>}<button className="secondary small" disabled={busy} onClick={()=>void refresh()}>刷新次数</button><button className="secondary small" disabled={busy||workBusy} onClick={()=>void logout()}>退出登录</button></div></div>
    {error&&<div className="account-warning notice error" role="alert">{error}{blocked&&<button className="secondary small" onClick={()=>void refresh()}>重新连接</button>}</div>}
    <div hidden={blocked} key={user.id}>{children}</div>
  </AccountContext.Provider>;
  return <div className="auth-screen"><div className="auth-brand"><span className="auth-logo" aria-hidden="true">习</span><span>错题智能推送 <small>AGENT</small></span></div><div className="auth-layout">
    <section className="auth-intro"><span className="eyebrow">为每一位学生，安排下一步。</span><h1>让错题，成为<br/>进步的起点。</h1><p>从逐题得分到专属补练，<br/>把更多时间留给教学。</p><div className="auth-flow" aria-label="补练流程"><div><span>01</span><b>读懂失分</b><small>连接考试与逐题成绩</small></div><div><span>02</span><b>生成补练</b><small>结合试卷与知识库出题</small></div><div><span>03</span><b>教师把关</b><small>审核后导出学生练习</small></div></div><div className="auth-footnote">账号与使用次数由服务器管理<br/>学生成绩和教学资料保存在当前电脑</div></section>
    <section className="auth-card" aria-label="软件账号登录注册"><div className="auth-tabs"><button type="button" aria-pressed={!register} className={!register?'active':''} disabled={busy} onClick={()=>{setRegister(false);setConfirm('');setError('');}}>登录</button><button type="button" aria-pressed={register} className={register?'active':''} disabled={busy} onClick={()=>{setRegister(true);setError('');}}>注册账号</button></div><h2>{register?'开始你的教学工作台':'欢迎回来'}</h2><p>{register?'创建软件账号，开启专属教学空间。':'登录后，继续你的补练计划。'}</p>
      <form onSubmit={event=>void submit(event)}><label>用户名<input aria-label="软件用户名" autoComplete="username" pattern="[a-zA-Z0-9_]{3,32}" minLength={3} maxLength={32} placeholder="3～32 位字母、数字或下划线" required value={username} disabled={busy} onChange={e=>setUsername(e.target.value)}/></label>
        <label>密码<input aria-label="软件密码" type="password" autoComplete={register?'new-password':'current-password'} minLength={10} maxLength={128} placeholder={register?'设置至少 10 位密码':'输入你的密码'} required value={password} disabled={busy} onChange={e=>setPassword(e.target.value)}/></label>
        {register&&<label>确认密码<input aria-label="确认软件密码" type="password" autoComplete="new-password" minLength={10} maxLength={128} placeholder="再次输入密码" required value={confirm} disabled={busy} onChange={e=>setConfirm(e.target.value)}/></label>}
        {loginNotice&&<div className="notice passed" role="status">{loginNotice}</div>}
        {error&&<div className="notice error" role="alert">{error}</div>}
        {config&&!config.configured&&<div className="notice" role="status">账号服务尚未配置，请联系管理员。</div>}
        <button className="auth-submit" type="submit" disabled={busy||!config?.configured}>{busy?'正在连接…':register?'注册并进入工作台':'登录工作台'}<span aria-hidden="true">↗</span></button>
      </form><div className="auth-account-note">{register?'新账号初始为 0 次，由管理员为你添加次数。':'忘记密码或需要添加次数？请联系管理员。'}<br/>成功生成一批补练计 1 次，失败不扣次。</div>
    </section></div><div className="auth-bottom">教师的判断，始终在最后一关。</div></div>;
}
