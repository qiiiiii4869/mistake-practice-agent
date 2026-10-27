import React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAccount, accountError, type AccountUser } from './AccountGate';

interface Users {items:AccountUser[];total:number;page:number}
interface Entry {delta:number;balanceAfter:number;kind:string;reason:string;createdAt:number;actor:string|null}
interface Grant {user:AccountUser;amount:number;reason:string;requestKey:string}
interface AccountAudit {action:string;reason:string;createdAt:number;actor:string}
type LifecycleAction='restore'|'delete';
const date=(value:number)=>new Date(value).toLocaleString('zh-CN',{hour12:false});

export function AdminWorkspace(){
  const account=useAccount();
  const [query,setQuery]=React.useState('');
  const [filter,setFilter]=React.useState('');
  const [page,setPage]=React.useState(1);
  const [users,setUsers]=React.useState<Users>({items:[],total:0,page:1});
  const [selected,setSelected]=React.useState<AccountUser|null>(null);
  const [amount,setAmount]=React.useState('10');
  const [reason,setReason]=React.useState('');
  const [pending,setPending]=React.useState<Grant|null>(null);
  const [ledger,setLedger]=React.useState<{user:AccountUser;items:Entry[]}|null>(null);
  const [audit,setAudit]=React.useState<{user:AccountUser;items:AccountAudit[]}|null>(null);
  const [cancelUser,setCancelUser]=React.useState<AccountUser|null>(null);
  const [confirmName,setConfirmName]=React.useState('');
  const [cancelReason,setCancelReason]=React.useState('');
  const [pendingCancel,setPendingCancel]=React.useState<{user:AccountUser;requestKey:string;confirmUsername:string;reason:string}|null>(null);
  const [lifecycle,setLifecycle]=React.useState<{user:AccountUser;action:LifecycleAction}|null>(null);
  const [lifecycleName,setLifecycleName]=React.useState('');
  const [lifecycleReason,setLifecycleReason]=React.useState('');
  const [deleteConfirmed,setDeleteConfirmed]=React.useState(false);
  const [pendingLifecycle,setPendingLifecycle]=React.useState<{user:AccountUser;action:LifecycleAction;requestKey:string;confirmUsername:string;reason:string}|null>(null);
  const [passwordUser,setPasswordUser]=React.useState<AccountUser|null>(null);
  const [newPassword,setNewPassword]=React.useState('');
  const [confirmPassword,setConfirmPassword]=React.useState('');
  const [currentPassword,setCurrentPassword]=React.useState('');
  const passwordRequest=React.useRef<string|null>(null);
  const [viewPasswordUser,setViewPasswordUser]=React.useState<AccountUser|null>(null);
  const [viewAdminPassword,setViewAdminPassword]=React.useState('');
  const [revealedPassword,setRevealedPassword]=React.useState<string|null>(null);
  const [unavailablePassword,setUnavailablePassword]=React.useState(false);
  React.useEffect(()=>{
    if(account.view!=='admin'){setRevealedPassword(null);setViewAdminPassword('');setViewPasswordUser(null);setNewPassword('');setConfirmPassword('');setCurrentPassword('');setPasswordUser(null);}
  },[account.view]);
  React.useEffect(()=>{
    if(revealedPassword===null)return;const timer=window.setTimeout(()=>setRevealedPassword(null),30000);return()=>clearTimeout(timer);
  },[revealedPassword]);
  const [busy,setBusy]=React.useState(false);
  const [loading,setLoading]=React.useState(false);
  const [message,setMessage]=React.useState('');
  const [error,setError]=React.useState(false);
  const version=React.useRef(0);
  const submitting=React.useRef(false);
  function notice(text:string,failed=false){setMessage(text);setError(failed);}
  async function load(q=filter,p=page){
    const request=++version.current;setLoading(true);
    try{const result=await invoke<Users>('account_admin_users',{query:q,page:p});if(request===version.current)setUsers(result);}
    catch(err){if(request===version.current)notice(accountError(err),true);}
    finally{if(request===version.current)setLoading(false);}
  }
  React.useEffect(()=>{if(account.view==='admin'&&account.user.role==='admin')void load();return()=>{version.current++;};},[account.view,account.user.id,account.user.role,filter,page]);
  React.useEffect(()=>{account.setWorkBusy(busy);return()=>account.setWorkBusy(false);},[busy,account.setWorkBusy]);
  async function showLedger(user:AccountUser){
    try{const result=await invoke<{items:Entry[]}>('account_admin_ledger',{userId:user.id});setLedger({user,items:result.items});}
    catch(err){notice(accountError(err),true);}
  }
  async function showAudit(user:AccountUser){
    try{const result=await invoke<{items:AccountAudit[]}>('account_admin_audit',{userId:user.id});setAudit({user,items:result.items});}
    catch(err){notice(accountError(err),true);}
  }
  async function deactivate(event:React.FormEvent){
    event.preventDefault();if(!cancelUser||submitting.current||confirmName!==cancelUser.username||!cancelReason.trim())return;
    const operation=pendingCancel??{user:cancelUser,requestKey:crypto.randomUUID(),confirmUsername:confirmName,reason:cancelReason.trim()};
    setPendingCancel(operation);submitting.current=true;setBusy(true);
    try{
      await invoke('account_admin_deactivate',{userId:operation.user.id,confirmUsername:operation.confirmUsername,reason:operation.reason,requestKey:operation.requestKey});
      setPendingCancel(null);setCancelUser(null);notice(`已冻结 ${operation.user.username}，原有登录已失效，次数流水保留。`);
      await Promise.all([load(),showAudit(operation.user)]);
    }catch(err){notice(`${accountError(err)} 请重试这一笔冻结操作。`,true);}
    finally{submitting.current=false;setBusy(false);}
  }
  function startLifecycle(user:AccountUser,action:LifecycleAction){
    setPasswordUser(null);setNewPassword('');setConfirmPassword('');setCurrentPassword('');setSelected(null);setCancelUser(null);setLifecycle({user,action});setLifecycleName('');setLifecycleReason('');setDeleteConfirmed(false);
  }
  async function submitLifecycle(event:React.FormEvent){
    event.preventDefault();if(!lifecycle||submitting.current||lifecycleName!==lifecycle.user.username||(lifecycle.action==='delete'?!deleteConfirmed:!lifecycleReason.trim()))return;
    const operation=pendingLifecycle??{...lifecycle,requestKey:crypto.randomUUID(),confirmUsername:lifecycleName,reason:lifecycleReason.trim()};
    setPendingLifecycle(operation);submitting.current=true;setBusy(true);
    try{
      const args=operation.action==='delete'?{userId:operation.user.id,confirmUsername:operation.confirmUsername,confirmDelete:true}:{userId:operation.user.id,confirmUsername:operation.confirmUsername,reason:operation.reason,requestKey:operation.requestKey};
      await invoke(operation.action==='delete'?'account_admin_delete':'account_admin_restore',args);
      setPendingLifecycle(null);setLifecycle(null);
      if(operation.action==='delete'){
        if(ledger?.user.id===operation.user.id)setLedger(null);if(audit?.user.id===operation.user.id)setAudit(null);
        notice('用户已彻底删除，其云端账号、会话、次数和操作记录已清除。');await load();
      }else{notice(`已恢复 ${operation.user.username}，可用原密码重新登录，剩余次数保留。`);await Promise.all([load(),showAudit(operation.user)]);}
    }catch(err){notice(`${accountError(err)} 可以重试同一笔操作。`,true);}
    finally{submitting.current=false;setBusy(false);}
  }
  async function grant(event:React.FormEvent){
    event.preventDefault();if(!selected||submitting.current)return;
    const count=Number(amount);if(!Number.isSafeInteger(count)||count<1||count>100000||!reason.trim()){notice('请输入 1～100000 的整数次数，并填写操作备注。',true);return;}
    const operation=pending??{user:selected,amount:count,reason:reason.trim(),requestKey:crypto.randomUUID()};
    setPending(operation);submitting.current=true;setBusy(true);
    try{
      const result=await invoke<{user:AccountUser;duplicate:boolean}>('account_admin_grant',{userId:operation.user.id,amount:operation.amount,reason:operation.reason,requestKey:operation.requestKey});
      setPending(null);setSelected(null);setReason('');notice(`已为 ${operation.user.username} 添加 ${operation.amount} 次，余额 ${result.user.credits} 次。`);
      await Promise.all([load(),showLedger(operation.user),account.refresh()]);
    }catch(err){notice(`${accountError(err)} 请重试这一笔，同一笔不会重复添加。`,true);}
    finally{submitting.current=false;setBusy(false);}
  }
  function openPassword(user:AccountUser){
    setViewPasswordUser(null);setViewAdminPassword('');setRevealedPassword(null);
    setSelected(null);setCancelUser(null);setLifecycle(null);setPasswordUser(user);
    setNewPassword('');setConfirmPassword('');setCurrentPassword('');passwordRequest.current=null;
  }
  async function viewPassword(event:React.FormEvent){
    event.preventDefault();if(!viewPasswordUser||submitting.current)return;submitting.current=true;setBusy(true);setRevealedPassword(null);setUnavailablePassword(false);
    try{
      const result=await invoke<{available:boolean;password:string|null}>('account_admin_view_password',{userId:viewPasswordUser.id,currentPassword:viewAdminPassword,requestKey:crypto.randomUUID()});
      setViewAdminPassword('');setRevealedPassword(result.password);setUnavailablePassword(!result.available);await showAudit(viewPasswordUser);
    }catch(err){notice(accountError(err),true);}
    finally{submitting.current=false;setBusy(false);}
  }
  async function changePassword(event:React.FormEvent){
    event.preventDefault();if(!passwordUser||submitting.current)return;
    if(newPassword!==confirmPassword){notice('两次新密码不一致。',true);return;}
    passwordRequest.current??=crypto.randomUUID();submitting.current=true;setBusy(true);
    try{
      const result=await invoke<{self:boolean}>('account_admin_password',{userId:passwordUser.id,confirmUsername:passwordUser.username,newPassword,currentPassword:currentPassword||null,requestKey:passwordRequest.current});
      setNewPassword('');setConfirmPassword('');setCurrentPassword('');passwordRequest.current=null;setPasswordUser(null);
      if(result.self){account.passwordChanged();return;}
      notice(`已为 ${passwordUser.username} 设置新密码，原有登录已失效。`);await showAudit(passwordUser);
    }catch(err){notice(accountError(err),true);}
    finally{setBusy(false);submitting.current=false;}
  }
  if(account.user.role!=='admin')return <main><div className="notice error" role="alert">此账号没有管理员权限。</div></main>;
  return <main className="admin-workspace" aria-label="用户与次数管理">
    <section className="intro"><span className="eyebrow">ACCOUNTS & USAGE</span><h1>用户与使用次数</h1><p>已以管理员 {account.user.username} 登录。成功生成一批补练计 1 次，失败不扣次。</p><p className="help">注册仅创建普通用户。管理员身份只能在服务器端授权，管理页不能冻结、恢复或删除管理员。</p></section>
    <form className="admin-search" onSubmit={event=>{event.preventDefault();setPage(1);setFilter(query.trim());if(page===1&&filter===query.trim())void load();}}><label className="sr-only" htmlFor="admin-user-query">搜索用户名</label><input id="admin-user-query" value={query} onChange={e=>setQuery(e.target.value)} maxLength={32} placeholder="搜索用户名" disabled={busy}/><button type="submit" disabled={busy||loading}>查找用户</button><button type="button" className="secondary" disabled={busy||loading} onClick={()=>void load()}>刷新列表</button></form>
    <section className="card" aria-label="注册用户列表"><div className="table-scroll"><table><thead><tr><th>用户名</th><th>账号</th><th>剩余次数</th><th>正在使用</th><th>注册时间</th><th>管理</th></tr></thead><tbody>{users.items.map(user=><tr key={user.id}><td>{user.username}</td><td>{user.role==='admin'?'管理员':user.status==='active'?'正常':'已冻结'}</td><td className="admin-credit">{user.credits}</td><td>{user.reserved?`${user.reserved} 次预占`:'—'}</td><td>{date(user.createdAt)}</td><td><div className="admin-row-actions"><button className="small" disabled={busy||!!pending||!!pendingCancel||!!pendingLifecycle||user.status!=='active'} onClick={()=>{setPasswordUser(null);setNewPassword('');setConfirmPassword('');setCurrentPassword('');setLifecycle(null);setCancelUser(null);setSelected(user);setReason('');}}>添加次数</button><button className="secondary small" disabled={busy} onClick={()=>void showLedger(user)}>查看流水</button><button className="secondary small" disabled={busy} onClick={()=>void showAudit(user)}>账号记录</button><button className="secondary small" disabled={busy||!!pending||!!pendingCancel||!!pendingLifecycle} onClick={()=>openPassword(user)}>设置密码</button><button className="secondary small" disabled={busy||!!pending||!!pendingCancel||!!pendingLifecycle} onClick={()=>{setPasswordUser(null);setNewPassword('');setConfirmPassword('');setCurrentPassword('');setViewPasswordUser(user);setViewAdminPassword('');setRevealedPassword(null);setUnavailablePassword(false);}}>查看密码</button>{user.role==='user'&&user.status==='active'&&<button className="secondary small danger" disabled={busy||!!pending||!!pendingCancel||!!pendingLifecycle} onClick={()=>{setPasswordUser(null);setNewPassword('');setConfirmPassword('');setCurrentPassword('');setLifecycle(null);setSelected(null);setCancelUser(user);setConfirmName('');setCancelReason('');}}>冻结用户</button>}{user.role==='user'&&user.status==='disabled'&&<button className="secondary small" disabled={busy||!!pending||!!pendingCancel||!!pendingLifecycle} onClick={()=>startLifecycle(user,'restore')}>恢复用户</button>}{user.role==='user'&&<button className="secondary small danger" disabled={busy||!!pending||!!pendingCancel||!!pendingLifecycle} onClick={()=>startLifecycle(user,'delete')}>删除用户</button>}</div></td></tr>)}</tbody></table></div>{!loading&&!users.items.length&&<p>没有找到匹配的用户。</p>}{loading&&<p aria-live="polite">正在读取用户…</p>}<div className="admin-pagination"><button className="secondary small" disabled={busy||loading||page<=1} onClick={()=>setPage(page-1)}>上一页</button><span>第 {users.page} 页 · 共 {users.total} 位用户</span><button className="secondary small" disabled={busy||loading||page*30>=users.total} onClick={()=>setPage(page+1)}>下一页</button></div></section>
    {selected&&<section className="card" aria-label="添加用户次数"><div className="card-heading"><h2>为 {selected.username} 添加次数</h2><button className="secondary small" disabled={busy||!!pending} onClick={()=>setSelected(null)}>收起</button></div><form className="admin-grant" onSubmit={event=>void grant(event)}><label>增加次数<input type="number" min={1} max={100000} step={1} required disabled={busy||!!pending} value={amount} onChange={e=>setAmount(e.target.value)}/></label><label>操作备注<input required maxLength={200} disabled={busy||!!pending} placeholder="例如：线下收款后充值 10 次" value={reason} onChange={e=>setReason(e.target.value)}/></label><button type="submit" disabled={busy}>{busy?'正在添加…':pending?'重试添加':'确认添加'}</button></form><p className="help">每次添加都会记录操作人、时间、备注和余额。请求异常时重试同一笔，不会重复入账。</p></section>}
    {ledger&&<section className="card" aria-label="用户次数流水"><h2>{ledger.user.username} 的次数流水</h2><div className="table-scroll"><table><thead><tr><th>时间</th><th>变动</th><th>变动后余额</th><th>原因</th><th>操作人</th></tr></thead><tbody>{ledger.items.map((item,index)=><tr key={index}><td>{date(item.createdAt)}</td><td>{item.delta>0?`+${item.delta}`:item.delta}</td><td>{item.balanceAfter}</td><td>{item.reason}</td><td>{item.actor??'—'}</td></tr>)}</tbody></table></div>{!ledger.items.length&&<p>暂无记录。</p>}</section>}
    {cancelUser&&<section className="card confirm-panel" aria-label="确认冻结用户"><div className="card-heading"><h2>冻结普通用户 {cancelUser.username}</h2><button className="secondary small" disabled={busy||!!pendingCancel} onClick={()=>setCancelUser(null)}>取消冻结</button></div><p>冻结后该用户将无法登录，已有登录立即失效，进行中的生成预占会释放。剩余次数和流水保留供核对；不能冻结管理员。</p><form className="admin-grant" onSubmit={event=>void deactivate(event)}><label>输入要冻结的用户名<input required value={confirmName} maxLength={32} disabled={busy||!!pendingCancel} onChange={e=>setConfirmName(e.target.value)}/></label><label>冻结原因<input required value={cancelReason} maxLength={200} disabled={busy||!!pendingCancel} onChange={e=>setCancelReason(e.target.value)}/></label><button type="submit" disabled={busy||confirmName!==cancelUser.username||!cancelReason.trim()}>{busy?'正在冻结…':pendingCancel?'重试冻结':'确认冻结普通用户'}</button></form></section>}
    {audit&&<section className="card" aria-label="账号操作记录"><h2>{audit.user.username} 的账号记录</h2><div className="table-scroll"><table><thead><tr><th>时间</th><th>操作</th><th>原因</th><th>操作人</th></tr></thead><tbody>{audit.items.map((item,index)=><tr key={index}><td>{date(item.createdAt)}</td><td>{item.action==='deactivate_user'?'冻结普通用户':item.action==='restore_user'?'恢复普通用户':item.action==='reset_password'?'设置新密码':item.action==='view_password'?'查看用户密码':'迁移管理员'}</td><td>{item.reason}</td><td>{item.actor}</td></tr>)}</tbody></table></div>{!audit.items.length&&<p>暂无账号操作记录。</p>}</section>}
    {lifecycle&&<section className="card confirm-panel" aria-label={lifecycle.action==='delete'?'确认彻底删除用户':'确认恢复用户'}><div className="card-heading"><h2>{lifecycle.action==='delete'?'彻底删除':'恢复'}普通用户 {lifecycle.user.username}</h2><button className="secondary small" disabled={busy||!!pendingLifecycle} onClick={()=>setLifecycle(null)}>取消操作</button></div><p>{lifecycle.action==='delete'?'将从当前云端数据库删除账号、密码摘要、登录会话、剩余次数、生成记录、次数流水及账号操作记录，删除后不能通过“恢复”找回。历史备份和用户电脑上的本地资料不在此次删除范围。':'恢复后可以使用原用户名和密码重新登录，原有次数与流水保留；旧登录不会恢复。'}</p><form className="admin-grant" onSubmit={event=>void submitLifecycle(event)}><label>输入目标用户名<input required value={lifecycleName} maxLength={32} disabled={busy||!!pendingLifecycle} onChange={e=>setLifecycleName(e.target.value)}/></label>{lifecycle.action==='restore'&&<label>恢复原因<input required maxLength={200} value={lifecycleReason} disabled={busy||!!pendingLifecycle} onChange={e=>setLifecycleReason(e.target.value)}/></label>}<button type="submit" disabled={busy||lifecycleName!==lifecycle.user.username||(lifecycle.action==='delete'?!deleteConfirmed:!lifecycleReason.trim())}>{busy?'正在处理…':pendingLifecycle?'重试操作':lifecycle.action==='delete'?'确认彻底删除用户':'确认恢复用户'}</button></form>{lifecycle.action==='delete'&&<label><input type="checkbox" checked={deleteConfirmed} disabled={busy||!!pendingLifecycle} onChange={e=>setDeleteConfirmed(e.target.checked)}/> 我确认永久删除该用户在当前云端数据库中的全部信息</label>}</section>}
    {passwordUser&&<section className="card" aria-label="设置用户密码"><div className="card-heading"><h2>为 {passwordUser.username} 设置新密码{passwordUser.id===account.user.id?'（本人）':''}</h2><button className="secondary small" disabled={busy} onClick={()=>{setPasswordUser(null);setNewPassword('');setConfirmPassword('');setCurrentPassword('');}}>取消修改密码</button></div><p>密码按明文方式保存。旧哈希记录在用户登录或重设密码后转换。设置新密码后，该账号所有登录将失效，进行中的预占会释放；账号状态与次数不变。</p><form className="fields" onSubmit={event=>void changePassword(event)}>{passwordUser.role==='admin'&&<label>你当前的管理员密码<input type="password" autoComplete="current-password" minLength={10} maxLength={128} required disabled={busy} value={currentPassword} onChange={e=>setCurrentPassword(e.target.value)}/></label>}<label>新密码<input type="password" autoComplete="new-password" required minLength={10} maxLength={128} disabled={busy} value={newPassword} onChange={e=>{passwordRequest.current=null;setNewPassword(e.target.value);}}/></label><label>确认新密码<input type="password" autoComplete="new-password" required minLength={10} maxLength={128} disabled={busy} value={confirmPassword} onChange={e=>setConfirmPassword(e.target.value)}/></label><div className="actions"><button type="submit" disabled={busy}>{busy?'正在修改…':'确认设置新密码'}</button></div></form></section>}
    {viewPasswordUser&&<section className="card" aria-label="查看用户密码"><div className="card-heading"><h2>查看 {viewPasswordUser.username} 的密码</h2><button className="secondary small" disabled={busy} onClick={()=>{setViewPasswordUser(null);setViewAdminPassword('');setRevealedPassword(null);setUnavailablePassword(false);}}>关闭密码查看</button></div><p>请输入你当前的管理员密码验证身份。查看操作会留记录，显示的密码 30 秒后自动隐藏。</p><form className="fields" onSubmit={event=>void viewPassword(event)}><label>验证管理员密码<input type="password" required autoComplete="current-password" minLength={10} maxLength={128} value={viewAdminPassword} disabled={busy} onChange={e=>setViewAdminPassword(e.target.value)}/></label><div className="actions"><button type="submit" disabled={busy}>验证并查看密码</button></div></form>{revealedPassword!==null&&<label>用户当前密码<input type="text" readOnly autoComplete="off" value={revealedPassword}/></label>}{unavailablePassword&&<p className="notice">该账号仍是旧哈希记录，无法还原原密码。用户成功登录一次或管理员设置新密码后即可查看。</p>}</section>}
    {message&&<p className={`notice ${error?'error':'passed'}`} role="status" aria-live="polite">{message}</p>}
  </main>;
}
