"""Real local account API and admin UI with an isolated temporary database; no student/model data."""
import json
import os
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path
from socket import socket
from subprocess import Popen, run, DEVNULL
from tempfile import TemporaryDirectory
from threading import Thread
from time import sleep, monotonic
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from urllib.parse import urlencode
from playwright.sync_api import sync_playwright, expect
from check_desktop_ui import ROOT, MOCK, QuietHandler


def main():
    with TemporaryDirectory(prefix='mistake-account-ui-') as temporary:
        with socket() as listener:
            listener.bind(('127.0.0.1', 0))
            api_port = listener.getsockname()[1]
        origin=f'http://127.0.0.1:{api_port}'
        env={**os.environ,'HOST':'127.0.0.1','PORT':str(api_port),'DATABASE_PATH':str(Path(temporary)/'accounts.sqlite')}
        process=Popen(['node','src/index.mjs'],cwd=ROOT/'server',env=env,stdout=DEVNULL,stderr=DEVNULL)
        server=ThreadingHTTPServer(('127.0.0.1',0),partial(QuietHandler,directory=str(ROOT/'app/apps/desktop/dist')))
        Thread(target=server.serve_forever,daemon=True).start()
        def api(path,body=None,token=None):
            request=Request(origin+path,data=json.dumps(body).encode() if body is not None else None,
                headers={**({'content-type':'application/json'} if body is not None else {}),**({'authorization':'Bearer '+token} if token else {})})
            try:
                with urlopen(request,timeout=10) as result:return json.load(result)
            except HTTPError as error:
                raise RuntimeError(json.load(error)['error']) from None
        try:
            deadline=monotonic()+15
            while True:
                try:api('/health');break
                except Exception:
                    if monotonic()>deadline:raise
                    sleep(.1)
            password='Synthetic-test-only-42!'
            api('/v1/auth/register',{'username':'console_owner','password':password})
            run(['node','src/admin.mjs','promote','console_owner'],cwd=ROOT/'server',env=env,check=True,capture_output=True)
            with sync_playwright() as p:
                browser=p.chromium.launch(channel='msedge',headless=True)
                page=browser.new_page(viewport={'width':1200,'height':900});errors=[]
                page.on('pageerror',lambda error:errors.append(str(error)))
                session={'token':None}
                sign_ins={'count':0}
                def ipc(command,args):
                    try:
                        if command=='account_config':return {'value':{'configured':True,'server':origin}}
                        if command=='account_me':return {'value':api('/v1/me',token=session['token'])['user'] if session['token'] else None}
                        if command=='account_sign_in':
                            sign_ins['count']+=1
                            value=api('/v1/auth/register' if args['register'] else '/v1/auth/login',{'username':args['username'],'password':args['password']})
                            session['token']=value['token'];return {'value':value['user']}
                        if command=='account_sign_out':api('/v1/auth/logout',{},session['token']);session['token']=None;return {'value':None}
                        if command=='account_admin_users':return {'value':api('/v1/admin/users?'+urlencode({'q':args['query'],'page':args['page']}),token=session['token'])}
                        if command=='account_admin_ledger':return {'value':api('/v1/admin/users/'+args['userId']+'/ledger',token=session['token'])}
                        if command=='account_admin_grant':return {'value':api('/v1/admin/users/'+args['userId']+'/credits',{'amount':args['amount'],'reason':args['reason'],'requestKey':args['requestKey']},session['token'])}
                        if command=='account_admin_deactivate':return {'value':api('/v1/admin/users/'+args['userId']+'/deactivate',{'confirmUsername':args['confirmUsername'],'reason':args['reason'],'requestKey':args['requestKey']},session['token'])}
                        if command=='account_admin_audit':return {'value':api('/v1/admin/users/'+args['userId']+'/account-audit',token=session['token'])}
                        if command=='account_admin_restore':return {'value':api('/v1/admin/users/'+args['userId']+'/restore',{'confirmUsername':args['confirmUsername'],'reason':args['reason'],'requestKey':args['requestKey']},session['token'])}
                        if command=='account_admin_delete':return {'value':api('/v1/admin/users/'+args['userId']+'/delete',{'confirmUsername':args['confirmUsername'],'confirmDelete':args['confirmDelete']},session['token'])}
                        return {'value':None}
                    except Exception as error:return {'error':str(error)}
                page.expose_function('accountTestInvoke',ipc)
                page.add_init_script(MOCK+r"""
window.testStored={revision:0,snapshot:null};
const prior=window.__TAURI_INTERNALS__.invoke;
window.__TAURI_INTERNALS__.invoke=async(command,args={})=>{
 if(!command.startsWith('account_'))return prior(command,args);
 const result=await window.accountTestInvoke(command,args);
 if(result.error)throw result.error;return result.value;
};
""")
                page.goto(f'http://127.0.0.1:{server.server_port}/')
                expect(page.get_by_role('heading',name='欢迎回来')).to_be_visible()
                expect(page.get_by_role('button',name='登录智学网',exact=True)).to_have_count(0)
                (ROOT/'tmp').mkdir(exist_ok=True)
                page.screenshot(path=str(ROOT/'tmp/account-login-ui.png'))
                page.get_by_role('button',name='注册账号',exact=True).click()
                page.get_by_label('软件用户名',exact=True).fill('teacher_test')
                page.get_by_label('软件密码',exact=True).fill(password)
                page.get_by_label('确认软件密码',exact=True).fill(password+'different')
                page.get_by_role('button',name='注册并进入工作台',exact=True).click()
                expect(page.get_by_role('alert')).to_contain_text('两次输入的密码不一致')
                page.get_by_label('确认软件密码',exact=True).fill(password)
                page.get_by_role('button',name='注册并进入工作台',exact=True).click()
                expect(page.get_by_role('button',name='登录智学网',exact=True)).to_be_visible()
                expect(page.locator('.account-balance')).to_contain_text('0')
                expect(page.get_by_role('button',name='管理用户与次数')).to_have_count(0)
                print('PASS: login gate, password confirmation, real registration, zero initial credits and ordinary-user admin exclusion.')
                admin=browser.new_page(viewport={'width':1280,'height':900})
                admin.on('pageerror',lambda error:errors.append(str(error)))
                admin.goto(origin+'/admin')
                admin.get_by_label('管理员用户名',exact=True).fill('teacher_test')
                admin.get_by_label('密码',exact=True).fill(password)
                admin.get_by_role('button',name='登录管理控制台').click()
                expect(admin.get_by_role('status')).to_contain_text('没有管理员权限')
                admin.get_by_label('管理员用户名',exact=True).fill('console_owner')
                admin.get_by_label('密码',exact=True).fill(password)
                admin.get_by_role('button',name='登录管理控制台').click()
                expect(admin.get_by_role('heading',name='用户与使用次数',exact=True)).to_be_visible()
                admin.get_by_label('搜索用户名').fill('teacher_test')
                admin.get_by_role('button',name='查找用户').click()
                expect(admin.locator('#users tr')).to_have_count(1)
                admin.get_by_role('button',name='添加次数',exact=True).click()
                admin.get_by_label('增加次数').fill('2')
                admin.get_by_label('操作备注').fill('合成账号测试加次')
                admin.get_by_role('button',name='确认添加',exact=True).click()
                expect(admin.get_by_role('status')).to_contain_text('余额 2 次')
                expect(admin.locator('#ledger')).to_contain_text('+2')
                admin.screenshot(path=str(ROOT/'tmp/account-admin-ui.png'))
                page.get_by_role('button',name='刷新次数',exact=True).click()
                expect(page.locator('.account-balance')).to_contain_text('2')
                page.get_by_role('button',name='退出登录',exact=True).click()
                page.get_by_role('button',name='登录',exact=True).click()
                page.get_by_label('软件用户名',exact=True).fill('teacher_test')
                page.get_by_label('软件密码',exact=True).fill('Wrong-test-password-42!')
                page.get_by_role('button',name='登录工作台',exact=True).click()
                expect(page.get_by_role('alert')).to_contain_text('用户名或密码不正确')
                page.get_by_label('软件密码',exact=True).fill(password)
                page.get_by_role('button',name='登录工作台',exact=True).click()
                expect(page.locator('.account-balance')).to_contain_text('2')
                print('PASS: actual admin login, non-admin rejection, user search, manual credit grant, audit history, desktop refresh and logout/relogin persistence.')
                page.get_by_role('button',name='退出登录',exact=True).click()
                page.get_by_label('软件用户名',exact=True).fill('console_owner')
                page.get_by_label('软件密码',exact=True).fill(password)
                before_sign_in=sign_ins['count']
                page.get_by_role('button',name='登录工作台',exact=True).click()
                expect(page.get_by_role('heading',name='用户与使用次数',exact=True)).to_be_visible()
                expect(page.get_by_role('button',name='登录管理控制台')).to_have_count(0)
                expect(page.get_by_label('软件密码',exact=True)).to_have_count(0)
                page.get_by_role('button',name='教学工作台',exact=True).click()
                expect(page.get_by_role('button',name='登录智学网',exact=True)).to_be_visible()
                page.get_by_role('button',name='管理用户与次数',exact=True).click()
                expect(page.get_by_role('heading',name='用户与使用次数',exact=True)).to_be_visible()
                assert sign_ins['count']==before_sign_in+1
                page.get_by_label('搜索用户名',exact=True).fill('teacher_test')
                page.get_by_role('button',name='查找用户',exact=True).click()
                rows=page.get_by_role('region',name='注册用户列表',exact=True).locator('tbody tr')
                expect(rows).to_have_count(1)
                rows.get_by_role('button',name='添加次数',exact=True).click()
                page.get_by_label('增加次数',exact=True).fill('1')
                page.get_by_label('操作备注',exact=True).fill('单次登录管理工作台测试')
                page.get_by_role('button',name='确认添加',exact=True).click()
                expect(page.get_by_role('status')).to_contain_text('余额 3 次')
                expect(page.get_by_role('region',name='用户次数流水')).to_contain_text('+1')
                assert sign_ins['count']==before_sign_in+1
                page.screenshot(path=str(ROOT/'tmp/account-admin-integrated-ui.png'))
                print('PASS: one software login identifies the administrator, opens management directly, switches workspaces and grants credits using the same session; no second login.')
                rows.get_by_role('button',name='冻结用户',exact=True).click()
                confirm=page.get_by_role('region',name='确认冻结用户',exact=True)
                confirm.get_by_label('输入要冻结的用户名',exact=True).fill('wrong_user')
                confirm.get_by_label('冻结原因',exact=True).fill('桌面冻结测试')
                expect(confirm.get_by_role('button',name='确认冻结普通用户')).to_be_disabled()
                confirm.get_by_label('输入要冻结的用户名',exact=True).fill('teacher_test')
                confirm.get_by_role('button',name='确认冻结普通用户').click()
                expect(page.get_by_role('status')).to_contain_text('已冻结 teacher_test')
                expect(rows).to_contain_text('已冻结')
                expect(rows.get_by_role('button',name='添加次数',exact=True)).to_be_disabled()
                expect(page.get_by_role('region',name='账号操作记录')).to_contain_text('桌面冻结测试')
                rows.get_by_role('button',name='恢复用户',exact=True).click()
                restore=page.get_by_role('region',name='确认恢复用户',exact=True)
                restore.get_by_label('输入目标用户名',exact=True).fill('teacher_test')
                restore.get_by_label('恢复原因',exact=True).fill('桌面恢复测试')
                restore.get_by_role('button',name='确认恢复用户',exact=True).click()
                expect(page.get_by_role('status')).to_contain_text('已恢复 teacher_test')
                expect(rows.get_by_role('button',name='冻结用户',exact=True)).to_be_visible()
                expect(rows.get_by_role('button',name='添加次数',exact=True)).to_be_enabled()
                restored=api('/v1/auth/login',{'username':'teacher_test','password':password})
                assert restored['user']['credits']==3
                rows.get_by_role('button',name='删除用户',exact=True).click()
                deletion=page.get_by_role('region',name='确认彻底删除用户',exact=True)
                deletion.get_by_label('输入目标用户名',exact=True).fill('wrong_user')
                deletion.get_by_label('我确认永久删除该用户在当前云端数据库中的全部信息').check()
                expect(deletion.get_by_role('button',name='确认彻底删除用户',exact=True)).to_be_disabled()
                deletion.get_by_label('输入目标用户名',exact=True).fill('teacher_test')
                deletion.get_by_role('button',name='确认彻底删除用户',exact=True).click()
                expect(page.get_by_role('status')).to_contain_text('用户已彻底删除')
                expect(rows).to_have_count(0)
                expect(page.get_by_role('region',name='用户次数流水')).to_have_count(0)
                expect(page.get_by_role('region',name='账号操作记录')).to_have_count(0)
                page.get_by_label('搜索用户名',exact=True).fill('console_owner')
                page.get_by_role('button',name='查找用户',exact=True).click()
                expect(rows).to_contain_text('console_owner')
                expect(rows.get_by_role('button',name='冻结用户',exact=True)).to_have_count(0)
                expect(rows.get_by_role('button',name='恢复用户',exact=True)).to_have_count(0)
                expect(rows.get_by_role('button',name='删除用户',exact=True)).to_have_count(0)
                api('/v1/auth/register',{'username':'browser_cancel','password':password})
                admin.get_by_label('搜索用户名',exact=True).fill('browser_cancel')
                admin.get_by_role('button',name='查找用户').click()
                expect(admin.locator('#users tr')).to_have_count(1)
                expect(admin.locator('#users')).to_contain_text('browser_cancel')
                admin.get_by_role('button',name='冻结用户',exact=True).click()
                admin.get_by_label('输入要冻结的用户名',exact=True).fill('browser_cancel')
                admin.get_by_label('冻结原因',exact=True).fill('独立网页冻结测试')
                admin.get_by_role('button',name='确认冻结普通用户').click()
                expect(admin.get_by_role('status')).to_contain_text('已冻结 browser_cancel')
                expect(admin.locator('#users')).to_contain_text('已冻结')
                expect(admin.locator('#audit')).to_contain_text('独立网页冻结测试')
                admin.get_by_role('button',name='恢复用户',exact=True).click()
                admin.get_by_label('输入目标用户名',exact=True).fill('browser_cancel')
                admin.get_by_label('恢复原因',exact=True).fill('独立网页恢复测试')
                admin.get_by_role('button',name='确认恢复用户',exact=True).click()
                expect(admin.get_by_role('status')).to_contain_text('已恢复 browser_cancel')
                expect(admin.get_by_role('button',name='冻结用户',exact=True)).to_be_visible()
                admin.get_by_role('button',name='删除用户',exact=True).click()
                admin.get_by_label('输入目标用户名',exact=True).fill('browser_cancel')
                admin.get_by_label('我确认永久删除该用户在当前云端数据库中的全部信息').check()
                admin.get_by_role('button',name='确认彻底删除用户',exact=True).click()
                expect(admin.get_by_role('status')).to_contain_text('用户已彻底删除')
                expect(admin.locator('#users tr')).to_have_count(0)
                assert api('/v1/auth/register',{'username':'browser_cancel','password':password})['user']['role']=='user'
                print('PASS: desktop and independent admin page deactivate ordinary accounts only after username confirmation, disable credit grants and show auditable reasons; admin accounts have no deactivation control.')
                print('PASS: freeze/restore/delete controls preserve password and credits on restore, require permanent deletion confirmation, clear displayed records, permit re-registration and protect admin accounts.')
                admin.get_by_role('button',name='退出登录',exact=True).click()
                expect(admin.get_by_role('button',name='登录管理控制台')).to_be_visible()
                admin.clock.install()
                stalled=[]
                admin.route('**/v1/auth/login',lambda route: stalled.append(route))
                admin.get_by_label('管理员用户名',exact=True).fill('console_owner')
                admin.get_by_label('密码',exact=True).fill(password)
                admin.get_by_role('button',name='登录管理控制台').click()
                expect(admin.get_by_role('button',name='登录管理控制台')).to_be_disabled()
                admin.clock.fast_forward(16000)
                expect(admin.get_by_role('status')).to_contain_text('连接管理服务超时')
                expect(admin.get_by_role('button',name='登录管理控制台')).to_be_enabled()
                for route in stalled:
                    route.abort('timedout')
                admin.unroute_all(behavior='wait')
                print('PASS: a stalled admin API times out, explains the error and enables retry instead of waiting indefinitely.')
                assert not errors,errors
                browser.close()
        finally:
            server.shutdown();process.terminate();process.wait(timeout=10)

if __name__=='__main__':main()
