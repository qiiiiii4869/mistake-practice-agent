const $ = id => document.getElementById(id);
const apiBase = new URL('./',window.location.href);
let adminId='',passwordUser=null,passwordKey=null,passwordBusy=false;
let viewUser=null,viewTimer=null;
let token = '', page = 1, selected = null, pendingGrant = null, cancelSelected = null, pendingCancel = null, lifecycle = null, pendingLifecycle = null;
const messages = {current_password_required:'请输入你当前的管理员密码。',current_password_incorrect:'当前管理员密码不正确。',password_change_conflict:'该账号密码或权限已变化，请刷新后重试。',account_not_disabled:'该账号当前未冻结，请刷新列表。', account_inactive:'这个账号已冻结，不能添加次数。',protected_account:'管理员账号受保护，不能冻结、恢复或删除。',username_confirmation_mismatch:'输入的用户名与要冻结的账号不一致。', invalid_credentials:'用户名或密码不正确，请重试。', account_disabled:'账号已停用。', admin_required:'此账号没有管理员权限。', session_expired:'登录已过期，请重新登录。', session_required:'请先登录。', rate_limited:'操作较频繁，请稍后重试。', invalid_input:'请检查用户名、密码、次数和备注的格式。', credit_limit:'余额超过上限，请减少添加次数。', idempotency_conflict:'这次操作内容已发生变化，请重新选择用户。' };
function message(text, failed = false) { $('message').textContent = text; $('message').className = failed ? 'error' : ''; }
function signedOut() { clearViewPassword(); clearPassword(); passwordUser=null; passwordKey=null; token=''; selected=null; pendingGrant=null;cancelSelected=null;pendingCancel=null;lifecycle=null;pendingLifecycle=null;$('lifecycle-panel').hidden=true; $('login-panel').hidden=false; $('dashboard').hidden=true; $('logout').hidden=true; $('users').replaceChildren(); $('ledger').replaceChildren();$('audit').replaceChildren(); $('grant-panel').hidden=true; $('ledger-panel').hidden=true;$('deactivate-panel').hidden=true;$('audit-panel').hidden=true; }
async function api(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
  const response = await fetch(new URL(path.replace(/^\//,''),apiBase), { method: body ? 'POST' : 'GET', credentials:'omit', cache:'no-store',
    signal:controller.signal, headers:{...(body?{'content-type':'application/json'}:{}),...(token?{authorization:`Bearer ${token}`}:{})}, ...(body?{body:JSON.stringify(body)}:{}) });
  let data;
  try { data = await response.json(); } catch { throw new Error('管理服务返回内容异常，请稍后重试。'); }
  if (!response.ok) { if (response.status === 401 && token) signedOut(); throw new Error(messages[data.error] ?? '请求未完成，请稍后重试。'); }
  return data;
  } catch (error) {
    if(controller.signal.aborted)throw new Error('连接管理服务超时，请检查本机账号服务后重试。');
    if(error instanceof TypeError)throw new Error('连接不上管理服务，请检查本机账号服务后重试。');
    throw error;
  } finally { clearTimeout(timer); }
}
function cell(row, text, className) { const td=document.createElement('td'); td.textContent=String(text); if(className)td.className=className; row.append(td); return td; }
function date(value) { return new Date(value).toLocaleString('zh-CN', {hour12:false}); }
async function loadUsers() {
  const result=await api(`/v1/admin/users?q=${encodeURIComponent($('query').value.trim())}&page=${page}`);
  $('users').replaceChildren(); $('empty').hidden=result.items.length>0;
  for (const user of result.items) {
    const row=document.createElement('tr'); cell(row,user.username); cell(row,user.role==='admin'?'管理员':user.status==='active'?'正常':'已冻结'); cell(row,user.credits,'balance'); cell(row,user.reserved?`${user.reserved} 次预占`:'—'); cell(row,date(user.createdAt));
    const actions=cell(row,'','actions');
    const grant=document.createElement('button'); grant.textContent='添加次数'; grant.className='small'; grant.onclick=()=>{ if(pendingGrant||pendingCancel||pendingLifecycle){message('上一笔操作尚未确认，请先重试完成。',true);return;} selected=user; $('grant-title').textContent=`为 ${user.username} 添加次数`; $('grant-panel').hidden=false; $('reason').value=''; $('grant-panel').scrollIntoView({behavior:'smooth',block:'center'}); };
    grant.disabled=user.status!=='active';
    const ledger=document.createElement('button'); ledger.textContent='查看流水'; ledger.className='secondary small'; ledger.onclick=()=>loadLedger(user).catch(err=>message(err.message,true));
    const audit=document.createElement('button');audit.textContent='账号记录';audit.className='secondary small';audit.onclick=()=>loadAudit(user).catch(err=>message(err.message,true));
    actions.append(grant,ledger,audit);
    const setPassword=document.createElement('button');setPassword.textContent='设置密码';setPassword.className='secondary small';setPassword.onclick=()=>openPassword(user);actions.append(setPassword);
    const viewPassword=document.createElement('button');viewPassword.textContent='查看密码';viewPassword.className='secondary small';viewPassword.onclick=()=>openViewPassword(user);actions.append(viewPassword);
    if(user.role==='user'&&user.status==='active'){
      const cancel=document.createElement('button');cancel.textContent='冻结用户';cancel.className='secondary small';cancel.onclick=()=>{
        if(pendingGrant||pendingCancel||pendingLifecycle){message('上一笔操作尚未确认，请先重试完成。',true);return;}
        cancelSelected=user;$('deactivate-title').textContent=`冻结普通用户 ${user.username}`;$('confirm-username').value='';$('deactivate-reason').value='';$('deactivate-panel').hidden=false;$('deactivate-panel').scrollIntoView({behavior:'smooth',block:'center'});
      };actions.append(cancel);
    }
    if(user.role==='user'){
      if(user.status==='disabled'){const restore=document.createElement('button');restore.textContent='恢复用户';restore.className='secondary small';restore.onclick=()=>startLifecycle(user,'restore');actions.append(restore);}
      const remove=document.createElement('button');remove.textContent='删除用户';remove.className='secondary small';remove.onclick=()=>startLifecycle(user,'delete');actions.append(remove);
    }
    $('users').append(row);
  }
  $('page-info').textContent=`第 ${page} 页 · 共 ${result.total} 位用户`; $('prev').disabled=page<=1; $('next').disabled=page*30>=result.total;
}
async function loadLedger(user) {
  const result=await api(`/v1/admin/users/${user.id}/ledger`); $('ledger-title').textContent=`${user.username} 的次数流水`; $('ledger').replaceChildren();
  for(const item of result.items){const row=document.createElement('tr'); cell(row,date(item.createdAt)); cell(row,item.delta>0?`+${item.delta}`:item.delta); cell(row,item.balanceAfter); cell(row,item.reason); cell(row,item.actor??'—'); $('ledger').append(row);}
  if(!result.items.length){const row=document.createElement('tr');const td=cell(row,'暂无记录');td.colSpan=5;$('ledger').append(row);}
  $('ledger-panel').hidden=false;
}
async function loadAudit(user){
  const result=await api(`/v1/admin/users/${user.id}/account-audit`);$('audit-title').textContent=`${user.username} 的账号记录`;$('audit').replaceChildren();
  for(const item of result.items){const row=document.createElement('tr');cell(row,date(item.createdAt));cell(row,item.action==='deactivate_user'?'冻结普通用户':item.action==='restore_user'?'恢复普通用户':item.action==='reset_password'?'设置新密码':item.action==='view_password'?'查看用户密码':'迁移管理员');cell(row,item.reason);cell(row,item.actor);$('audit').append(row);}
  if(!result.items.length){const row=document.createElement('tr');cell(row,'暂无账号操作记录').colSpan=4;$('audit').append(row);}
  $('audit-panel').hidden=false;
}
$('login-form').onsubmit=async event=>{
  event.preventDefault(); const button=event.submitter; button.disabled=true;
  try{const data=new FormData(event.currentTarget); const result=await api('/v1/auth/login',{username:data.get('username'),password:data.get('password')}); $('login-form').reset();
    token=result.token; if(result.user.role!=='admin'){await api('/v1/auth/logout',{});signedOut();throw new Error(messages.admin_required);}
    adminId=result.user.id;$('admin-name').textContent=result.user.username; $('login-panel').hidden=true;$('dashboard').hidden=false;$('logout').hidden=false;page=1;await loadUsers();message('已登录，选择用户即可添加次数。');
  }catch(err){message(err.message,true);}finally{button.disabled=false;}
};
$('logout').onclick=async()=>{try{await api('/v1/auth/logout',{});}catch{}signedOut();message('已退出管理控制台。');};
$('search-form').onsubmit=event=>{event.preventDefault();page=1;loadUsers().catch(err=>message(err.message,true));};
$('prev').onclick=()=>{page--;loadUsers().catch(err=>message(err.message,true));};
$('next').onclick=()=>{page++;loadUsers().catch(err=>message(err.message,true));};
$('close-grant').onclick=()=>{if(!pendingGrant)$('grant-panel').hidden=true;else message('这笔操作还没有确认，请点击重试。',true);};
$('grant-form').onsubmit=async event=>{
  event.preventDefault();if(!selected)return;
  const amount=Number($('amount').value),reason=$('reason').value.trim();if(!Number.isSafeInteger(amount)||amount<1||amount>100000||!reason)return;
  if(!pendingGrant)pendingGrant={user:selected,body:{amount,reason,requestKey:crypto.randomUUID()}};
  $('grant-submit').disabled=true;$('amount').disabled=true;$('reason').disabled=true;
  try{const current=pendingGrant;const result=await api(`/v1/admin/users/${current.user.id}/credits`,current.body);pendingGrant=null;
    $('grant-panel').hidden=true;message(`已为 ${current.user.username} 添加 ${current.body.amount} 次，余额 ${result.user.credits} 次。`);await loadUsers();await loadLedger(current.user);
  }catch(err){message(`${err.message} 可点击“重试添加”，同一笔不会重复入账。`,true);}
  finally{$('grant-submit').disabled=false;$('grant-submit').textContent=pendingGrant?'重试添加':'确认添加';$('amount').disabled=!!pendingGrant;$('reason').disabled=!!pendingGrant;}
};
$('close-deactivate').onclick=()=>{if(!pendingCancel)$('deactivate-panel').hidden=true;else message('这笔冻结还没有确认，请先重试。',true);};
$('deactivate-form').onsubmit=async event=>{
  event.preventDefault();if(!cancelSelected||$('deactivate-submit').disabled)return;
  const confirmUsername=$('confirm-username').value,reason=$('deactivate-reason').value.trim();
  if(confirmUsername!==cancelSelected.username){message('输入的用户名与要冻结的账号不一致。',true);return;}if(!reason)return;
  pendingCancel??={user:cancelSelected,body:{confirmUsername,reason,requestKey:crypto.randomUUID()}};
  $('deactivate-submit').disabled=true;$('confirm-username').disabled=true;$('deactivate-reason').disabled=true;
  try{const operation=pendingCancel;await api(`/v1/admin/users/${operation.user.id}/deactivate`,operation.body);pendingCancel=null;cancelSelected=null;$('deactivate-panel').hidden=true;
    message(`已冻结 ${operation.user.username}，原有登录已失效，次数流水保留。`);await loadUsers();await loadAudit(operation.user);
  }catch(err){message(`${err.message} 可重试这一笔冻结操作。`,true);}
  finally{$('deactivate-submit').disabled=false;$('deactivate-submit').textContent=pendingCancel?'重试冻结':'确认冻结普通用户';$('confirm-username').disabled=!!pendingCancel;$('deactivate-reason').disabled=!!pendingCancel;}
};
function startLifecycle(user,action){
  if(pendingGrant||pendingCancel||pendingLifecycle){message('上一笔操作尚未确认，请先重试。',true);return;}
  lifecycle={user,action};$('grant-panel').hidden=true;$('deactivate-panel').hidden=true;
  $('lifecycle-title').textContent=`${action==='delete'?'彻底删除':'恢复'}普通用户 ${user.username}`;
  $('lifecycle-help').textContent=action==='delete'?'将删除当前云端数据库中的账号、密码摘要、会话、次数余额、生成记录、次数流水和账号操作记录。删除后不能恢复；历史备份与用户电脑上的本地资料不在此范围。':'恢复原用户名、密码和剩余次数；用户需要重新登录，旧登录不会恢复。';
  $('lifecycle-name').value='';$('restore-reason').value='';$('delete-check').checked=false;
  $('restore-reason-label').hidden=action==='delete';$('restore-reason').required=action==='restore';$('delete-check-label').hidden=action!=='delete';
  $('lifecycle-submit').textContent=action==='delete'?'确认彻底删除用户':'确认恢复用户';$('lifecycle-panel').hidden=false;$('lifecycle-panel').scrollIntoView({behavior:'smooth',block:'center'});
}
$('close-lifecycle').onclick=()=>{if(pendingLifecycle){message('这笔操作尚未确认，请重试。',true);return;}$('lifecycle-panel').hidden=true;lifecycle=null;};
$('lifecycle-form').onsubmit=async event=>{
  event.preventDefault();if(!lifecycle||$('lifecycle-submit').disabled)return;
  const confirmUsername=$('lifecycle-name').value,reason=$('restore-reason').value.trim();
  if(confirmUsername!==lifecycle.user.username){message('输入的用户名与目标账号不一致。',true);return;}
  if(lifecycle.action==='delete'?!$('delete-check').checked:!reason){message('请完成删除确认或填写恢复原因。',true);return;}
  pendingLifecycle??={...lifecycle,body:lifecycle.action==='delete'?{confirmUsername,confirmDelete:true}:{confirmUsername,reason,requestKey:crypto.randomUUID()}};
  for(const id of ['lifecycle-submit','lifecycle-name','restore-reason','delete-check'])$(id).disabled=true;
  try{
    const operation=pendingLifecycle;await api(`/v1/admin/users/${operation.user.id}/${operation.action}`,operation.body);
    pendingLifecycle=null;lifecycle=null;$('lifecycle-panel').hidden=true;
    if(operation.action==='delete'){
      $('ledger').replaceChildren();$('audit').replaceChildren();$('ledger-title').textContent='次数流水';$('audit-title').textContent='账号操作记录';$('ledger-panel').hidden=true;$('audit-panel').hidden=true;
      $('grant-title').textContent='添加次数';$('deactivate-title').textContent='冻结普通用户';selected=null;cancelSelected=null;
      message('用户已彻底删除，其云端账号、会话、次数和操作记录已清除。');await loadUsers();
    }else{message(`已恢复 ${operation.user.username}，可用原密码重新登录，剩余次数保留。`);await loadUsers();await loadAudit(operation.user);}
  }catch(err){message(`${err.message} 可以重试同一笔操作。`,true);}
  finally{for(const id of ['lifecycle-submit','lifecycle-name','restore-reason','delete-check'])$(id).disabled=!!pendingLifecycle&&id!=='lifecycle-submit';if(pendingLifecycle)$('lifecycle-submit').textContent='重试操作';}
};
function clearPassword(){
  for(const id of ['admin-current-password','admin-new-password','admin-confirm-password'])$(id).value='';
  $('password-panel').hidden=true;
}
function openPassword(user){
  if(pendingGrant||pendingCancel||pendingLifecycle||passwordBusy){message('请先完成当前操作。',true);return;}
  clearViewPassword();clearPassword();passwordUser=user;passwordKey=null;
  $('password-title').textContent=`为 ${user.username} 设置新密码${user.id===adminId?'（本人）':''}`;
  $('current-password-label').hidden=user.role!=='admin';$('admin-current-password').required=user.role==='admin';
  $('password-panel').hidden=false;$('password-panel').scrollIntoView({behavior:'smooth',block:'center'});
}
$('close-password').onclick=()=>{if(passwordBusy)return;clearPassword();passwordUser=null;passwordKey=null;};
$('admin-new-password').oninput=()=>{passwordKey=null;};
$('password-form').onsubmit=async event=>{
  event.preventDefault();if(!passwordUser||passwordBusy)return;
  if($('admin-new-password').value!==$('admin-confirm-password').value){message('两次新密码不一致。',true);return;}
  const target=passwordUser;passwordKey??=crypto.randomUUID();passwordBusy=true;
  for(const id of ['password-submit','admin-current-password','admin-new-password','admin-confirm-password','logout'])$(id).disabled=true;
  try{
    const body={confirmUsername:target.username,newPassword:$('admin-new-password').value,requestKey:passwordKey};
    if(target.role==='admin')body.currentPassword=$('admin-current-password').value;
    const result=await api(`/v1/admin/users/${target.id}/password`,body);
    clearPassword();passwordUser=null;passwordKey=null;
    if(result.self){signedOut();message('密码已修改，请使用新密码重新登录。');}
    else{message(`已为 ${target.username} 设置新密码，原有登录已失效。`);await loadAudit(target);}
  }catch(err){message(err.message,true);}
  finally{passwordBusy=false;for(const id of ['password-submit','admin-current-password','admin-new-password','admin-confirm-password','logout'])$(id).disabled=false;}
};
function clearViewPassword(){
  clearTimeout(viewTimer);viewTimer=null;viewUser=null;
  $('view-admin-password').value='';$('view-password-result').value='';$('view-password-result-label').hidden=true;$('view-password-unavailable').hidden=true;$('view-password-panel').hidden=true;
}
function openViewPassword(user){
  if(passwordBusy||pendingGrant||pendingCancel||pendingLifecycle){message('请先完成当前操作。',true);return;}
  clearPassword();clearViewPassword();viewUser=user;$('view-password-title').textContent=`查看 ${user.username} 的密码`;$('view-password-panel').hidden=false;$('view-password-panel').scrollIntoView({behavior:'smooth',block:'center'});
}
$('close-view-password').onclick=()=>clearViewPassword();
$('view-password-form').onsubmit=async event=>{
  event.preventDefault();if(!viewUser||$('view-password-submit').disabled)return;
  const target=viewUser;clearTimeout(viewTimer);$('view-password-result').value='';$('view-password-result-label').hidden=true;$('view-password-unavailable').hidden=true;$('view-password-submit').disabled=true;
  try{
    const result=await api(`/v1/admin/users/${target.id}/password/view`,{currentPassword:$('view-admin-password').value,requestKey:crypto.randomUUID()});
    $('view-admin-password').value='';
    if(viewUser?.id!==target.id)return;
    if(result.available){$('view-password-result').value=result.password;$('view-password-result-label').hidden=false;viewTimer=setTimeout(()=>{$('view-password-result').value='';$('view-password-result-label').hidden=true;},30000);}
    else $('view-password-unavailable').hidden=false;
    await loadAudit(target);
  }catch(err){message(err.message,true);}finally{$('view-password-submit').disabled=false;}
};
