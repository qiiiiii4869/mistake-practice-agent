"""Password reset UI uses disposable accounts and a temporary actual API/database."""
import json,os,sys
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path
from socket import socket
from subprocess import Popen,run,DEVNULL
from tempfile import TemporaryDirectory
from threading import Thread
from time import monotonic,sleep
from urllib.request import Request,urlopen
from urllib.error import HTTPError
from urllib.parse import urlencode
from playwright.sync_api import sync_playwright,expect
from check_desktop_ui import MOCK,QuietHandler,ROOT

def main():
 with TemporaryDirectory(prefix='mistake-password-ui-') as temp:
  with socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
  origin=f'http://127.0.0.1:{port}'
  env={**os.environ,'HOST':'127.0.0.1','PORT':str(port),'DATABASE_PATH':str(Path(temp)/'accounts.sqlite')}
  process=Popen(['node','src/index.mjs'],cwd=ROOT/'server',env=env,stdout=DEVNULL,stderr=DEVNULL)
  web=ThreadingHTTPServer(('127.0.0.1',0),partial(QuietHandler,directory=str(ROOT/'app/apps/desktop/dist')));Thread(target=web.serve_forever,daemon=True).start()
  def api(path,body=None,token=None):
   req=Request(origin+path,data=json.dumps(body).encode() if body is not None else None,headers={**({'content-type':'application/json'} if body is not None else {}),**({'authorization':'Bearer '+token} if token else {})})
   try:
    with urlopen(req,timeout=10) as response:return json.load(response)
   except HTTPError as error:raise RuntimeError(json.load(error)['error']) from None
  try:
   deadline=monotonic()+15
   while True:
    try:api('/health');break
    except Exception:
     if monotonic()>deadline:raise
     sleep(.1)
   old='Synthetic-old-password-42';new='Synthetic-user-new-84';owner_new='Synthetic-owner-new-99';browser_new='Synthetic-browser-new-77'
   teacher=api('/v1/auth/register',{'username':'teacher_test','password':old})
   api('/v1/auth/register',{'username':'console_owner','password':old})
   run(['node','src/admin.mjs','promote','console_owner'],cwd=ROOT/'server',env=env,check=True,capture_output=True)
   session={'token':None}
   def ipc(command,args):
    try:
     if command=='account_config':return {'value':{'configured':True,'server':origin}}
     if command=='account_me':return {'value':api('/v1/me',token=session['token'])['user'] if session['token'] else None}
     if command=='account_sign_in':
      result=api('/v1/auth/login',{'username':args['username'],'password':args['password']});session['token']=result['token'];return {'value':result['user']}
     if command=='account_admin_users':return {'value':api('/v1/admin/users?'+urlencode({'q':args['query'],'page':args['page']}),token=session['token'])}
     if command=='account_admin_audit':return {'value':api('/v1/admin/users/'+args['userId']+'/account-audit',token=session['token'])}
     if command=='account_admin_password':
      body={'confirmUsername':args['confirmUsername'],'newPassword':args['newPassword'],'requestKey':args['requestKey']}
      if args.get('currentPassword'):body['currentPassword']=args['currentPassword']
      result=api('/v1/admin/users/'+args['userId']+'/password',body,session['token'])
      if result['self']:session['token']=None
      return {'value':result}
     if command=='account_admin_view_password':return {'value':api('/v1/admin/users/'+args['userId']+'/password/view',{'currentPassword':args['currentPassword'],'requestKey':args['requestKey']},session['token'])}
     return {'value':None}
    except Exception as err:return {'error':str(err)}
   with sync_playwright() as p:
    browser=p.chromium.launch(channel='msedge',headless=True);page=browser.new_page(viewport={'width':1280,'height':900});errors=[]
    page.on('pageerror',lambda err:errors.append(str(err)));page.expose_function('passwordTestInvoke',ipc)
    page.add_init_script(MOCK+r"""
window.testStored={revision:0,snapshot:null};
const passwordPrior=window.__TAURI_INTERNALS__.invoke;
window.__TAURI_INTERNALS__.invoke=async(command,args={})=>{
 if(!command.startsWith('account_'))return passwordPrior(command,args);
 const result=await passwordTestInvoke(command,args);if(result.error)throw result.error;return result.value;
};
""")
    page.goto(f'http://127.0.0.1:{web.server_port}/');page.get_by_label('软件用户名',exact=True).fill('console_owner');page.get_by_label('软件密码',exact=True).fill(old);page.get_by_role('button',name='登录工作台',exact=True).click()
    expect(page.get_by_role('heading',name='用户与使用次数',exact=True)).to_be_visible()
    page.get_by_label('搜索用户名',exact=True).fill('teacher_test');page.get_by_role('button',name='查找用户',exact=True).click()
    rows=page.get_by_role('region',name='注册用户列表').locator('tbody tr');expect(rows).to_have_count(1);rows.get_by_role('button',name='设置密码').click()
    panel=page.get_by_role('region',name='设置用户密码');expect(panel.get_by_label('新密码',exact=True)).to_have_attribute('type','password')
    panel.get_by_label('新密码',exact=True).fill(new);panel.get_by_label('确认新密码',exact=True).fill(old);panel.get_by_role('button',name='确认设置新密码').click()
    expect(page.get_by_role('status')).to_contain_text('两次新密码不一致')
    panel.get_by_label('确认新密码',exact=True).fill(new);panel.get_by_role('button',name='确认设置新密码').click()
    expect(page.get_by_role('status')).to_contain_text('已为 teacher_test 设置新密码')
    assert api('/v1/auth/login',{'username':'teacher_test','password':new})['user']['role']=='user'
    try:api('/v1/me',token=teacher['token']);raise AssertionError('Old session still works')
    except RuntimeError:pass
    assert new not in page.locator('body').inner_text()
    rows.get_by_role('button',name='查看密码',exact=True).click()
    view=page.get_by_role('region',name='查看用户密码',exact=True)
    view.get_by_label('验证管理员密码',exact=True).fill(old);view.get_by_role('button',name='验证并查看密码',exact=True).click()
    expect(view.get_by_label('用户当前密码',exact=True)).to_have_value(new)
    view.get_by_role('button',name='关闭密码查看',exact=True).click();expect(page.get_by_label('用户当前密码',exact=True)).to_have_count(0)
    page.get_by_label('搜索用户名',exact=True).fill('console_owner');page.get_by_role('button',name='查找用户',exact=True).click();expect(rows).to_contain_text('console_owner');rows.get_by_role('button',name='设置密码').click()
    panel.get_by_label('你当前的管理员密码').fill('Wrong-password-42');panel.get_by_label('新密码',exact=True).fill(owner_new);panel.get_by_label('确认新密码',exact=True).fill(owner_new);panel.get_by_role('button',name='确认设置新密码').click();expect(page.get_by_role('status')).to_contain_text('当前管理员密码不正确')
    panel.get_by_label('你当前的管理员密码').fill(old);panel.get_by_role('button',name='确认设置新密码').click();expect(page.get_by_role('heading',name='欢迎回来')).to_be_visible();expect(page.get_by_role('status')).to_contain_text('密码已修改')
    page.get_by_label('软件用户名',exact=True).fill('console_owner');page.get_by_label('软件密码',exact=True).fill(owner_new);page.get_by_role('button',name='登录工作台',exact=True).click();expect(page.get_by_role('heading',name='用户与使用次数',exact=True)).to_be_visible()
    print('PASS: desktop resets and views an ordinary password after admin verification, hides on close, rejects invalid proof and requires new login after self change.')
    admin=browser.new_page();admin.on('pageerror',lambda err:errors.append(str(err)));admin.goto(origin+'/admin');admin.get_by_label('管理员用户名').fill('console_owner');admin.get_by_label('密码',exact=True).fill(owner_new);admin.get_by_role('button',name='登录管理控制台').click();expect(admin.get_by_role('heading',name='用户与使用次数')).to_be_visible()
    admin.get_by_label('搜索用户名').fill('console_owner');admin.get_by_role('button',name='查找用户').click();expect(admin.locator('#users tr')).to_have_count(1);admin.get_by_role('button',name='设置密码').click()
    admin.get_by_role('button',name='取消修改密码').click();admin.get_by_role('button',name='查看密码',exact=True).click()
    admin.get_by_label('验证管理员密码',exact=True).fill(owner_new);admin.get_by_role('button',name='验证并查看密码',exact=True).click();expect(admin.get_by_label('用户当前密码',exact=True)).to_have_value(owner_new)
    admin.get_by_role('button',name='关闭密码查看',exact=True).click();admin.get_by_role('button',name='设置密码').click()
    admin.get_by_label('你当前的管理员密码').fill(owner_new);admin.get_by_label('新密码',exact=True).fill(browser_new);admin.get_by_label('确认新密码',exact=True).fill(browser_new);admin.get_by_role('button',name='确认设置新密码').click()
    expect(admin.get_by_role('button',name='登录管理控制台')).to_be_visible();expect(admin.get_by_role('status')).to_contain_text('密码已修改')
    assert all(admin.locator('#'+name).input_value()=='' for name in ['admin-current-password','admin-new-password','admin-confirm-password'])
    assert api('/v1/auth/login',{'username':'console_owner','password':browser_new})['user']['role']=='admin'
    assert not errors,errors;print('PASS: independent admin page can change own password, clears sensitive fields, logs out and accepts the new password.');browser.close()
  finally:web.shutdown();web.server_close();process.terminate();process.wait(timeout=10)

if __name__=='__main__':main()
