import React from 'react';
import { BarChart3, ClipboardList, FileText, Wallet, GraduationCap, QrCode, ChevronRight } from 'lucide-react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { errorMessage, type ConnectionReport, type LoginStatus } from '../../../packages/zhixue/src';
import './styles.css';
import './soft-theme.css';
import { ScoreWorkspace } from './ScoreWorkspace';
import { AccountGate, useAccount } from './AccountGate';
import { AdminWorkspace } from './AdminWorkspace';

function App() {
  const {setWorkBusy,user}=useAccount();
  type Page = 'import'|'analysis'|'report'|'billing';
  function pageFromHash():Page {const value=window.location.hash.slice(1);return ['import','analysis','report','billing'].includes(value)?value as Page:'import';}
  const [page,setPage]=React.useState<Page>(pageFromHash);
  React.useEffect(()=>{const changed=()=>setPage(pageFromHash());window.addEventListener('hashchange',changed);return()=>window.removeEventListener('hashchange',changed);},[]);
  const [report, setReport] = React.useState<ConnectionReport | null>(null);
  const [login, setLogin] = React.useState<LoginStatus>({ open: false, host: null, captcha_60500: false });
  const [busy, setBusy] = React.useState(false);
  const [opening, setOpening] = React.useState(false);
  const [message, setMessage] = React.useState('点击“登录智学网”，在弹出的官方页面使用教师账号登录。');
  const [saved, setSaved] = React.useState<string | null>(null);
  React.useEffect(()=>{setWorkBusy(busy);return()=>setWorkBusy(false);},[busy,setWorkBusy]);

  React.useEffect(() => {
    let active = true;
    const update = async () => {
      try {
        const status = await invoke<LoginStatus>('login_status');
        if (active) setLogin(status);
      } catch { /* Status inspection never turns into a successful verification. */ }
    };
    void update();
    const timer = window.setInterval(() => void update(), 3000);
    return () => { active = false; clearInterval(timer); };
  }, []);

  async function openLogin() {
    setOpening(true);
    try {
      await invoke('open_login');
      setLogin({ open: true, host: 'www.zhixue.com', captcha_60500: false });
      setMessage('在智学网窗口完成登录后，回到这里点击“读取考试列表”。');
    } catch (error) { setMessage(errorMessage(String(error))); }
    finally { setOpening(false); }
  }

  async function connect() {
    setBusy(true); setReport(null); setSaved(null);
    setMessage('正在确认教师会话、任教范围与当前学期考试，最多等待两分钟…');
    try {
      const next = await invoke<ConnectionReport>('read_exam_list');
      setReport(next);
      setMessage(next.ok
        ? next.options.length ? '读取成功。已验证内置窗口的教师会话和考试列表。' : '教师会话已确认，但当前学期第一页未返回考试，数据通道还需继续核对。'
        : errorMessage(next.summary.error ?? 'probe_failed'));
    } catch (error) { setMessage(errorMessage(String(error))); }
    finally { setBusy(false); }
  }

  async function saveDiagnostic() {
    try { setSaved(await invoke<string>('save_diagnostic')); }
    catch (error) { setMessage(errorMessage(String(error))); }
  }

  const verified = report?.ok === true && report.summary.authentication === 'verified_teacher_session' && report.options.length > 0;
  const pages = [
    { id:'import' as const, label:'信息导入', icon:ClipboardList, description:'考试、学生与空白卷' },
    { id:'analysis' as const, label:'数据分析', icon:BarChart3, description:'班级与逐题统计' },
    { id:'report' as const, label:'生成报告', icon:FileText, description:'知识库与补练报告' },
    { id:'billing' as const, label:'充值中心', icon:Wallet, description:'生成次数与充值' },
  ];
  const current=pages.find(item=>item.id===page)!;
  function navigate(next:typeof page){setPage(next);window.location.hash=next;window.scrollTo({top:0,behavior:'auto'});}
  return <div className="workspace-shell">
    <aside className="workspace-sidebar"><div className="sidebar-brand"><span className="sidebar-logo"><GraduationCap size={20}/></span><div><b>错题app</b><small>教师工作台</small></div></div>
      <div className="sidebar-label">工作空间</div><nav className="workspace-nav" aria-label="功能入口">{pages.map(item=><button key={item.id} type="button" aria-current={page===item.id?'page':undefined} className={page===item.id?'active':''} onClick={()=>navigate(item.id)}><item.icon size={18} strokeWidth={1.8}/><span>{item.label}</span>{page===item.id&&<ChevronRight className="nav-arrow" size={15}/>}</button>)}</nav>
      <div className="sidebar-bottom"><span className="sidebar-dot"/>本机工作区</div>
    </aside>
    <main className="workspace-main"><div className="page-top"><div className="breadcrumb">教师工作台 <ChevronRight size={13}/> <strong>{current.label}</strong></div><span className="page-session">{user.username}</span></div>
    <div className="page-heading"><div><span className="page-kicker">{page==='import'?'WORKSPACE / IMPORT':page==='analysis'?'WORKSPACE / ANALYSIS':page==='report'?'WORKSPACE / REPORT':'ACCOUNT / CREDITS'}</span><h1>{current.label}</h1><p>{current.description}</p></div><span className="page-heading-icon"><current.icon size={23}/></span></div>
    <div hidden={page!=='import'}>
    <section className="card">
      <div className="card-heading"><h2>教师账号连接</h2><span className={`badge ${verified ? 'success' : ''}`}>{verified ? '验证通过' : busy ? '读取中' : '待验证'}</span></div>
      <p>点击登录按钮会弹出智学网官方登录页面，请在那里填写账号密码。登录完成后回到这里读取考试列表。</p>
      <div className="actions"><button onClick={() => void openLogin()} disabled={opening || busy} className="secondary">{opening ? '正在打开…' : login.open ? '返回智学网登录页' : '登录智学网'}</button><button onClick={() => void connect()} disabled={busy || opening || !login.open}>{busy ? '正在读取…' : '读取考试列表'}</button></div>
      <div className={`notice ${report && !report.ok ? 'error' : verified ? 'passed' : ''}`} role="status">{message}</div>
      <div className="window-status">登录窗口：{login.open ? `已打开 · ${login.host ?? '等待页面加载'}` : '未打开'}</div>
      {login.captcha_60500 && <div className="notice error">页面检测到 60500 提示。请保留此状态，内置登录尚未通过验证；可回退到 Chrome 扩展导入。</div>}
    </section>
    {report && !report.ok && <section className="card" aria-label="读取结果">
      <div className="card-heading"><h2>本次读取结果</h2><span className="muted">{report.options.length} 场考试 · {report.teachingClasses.length} 个任教班级</span></div>
      <details><summary>接口诊断（不含密码、Cookie 或会话令牌）</summary><div className="diagnostics">{report.summary.endpoints.map((endpoint, index) => <div key={index}><code>{endpoint.path}</code><span>{endpoint.http_status ?? '—'} · {endpoint.error ?? endpoint.status}</span></div>)}</div></details>
      <div className="actions"><button className="secondary small" onClick={() => void saveDiagnostic()}>保存匿名诊断</button></div>
      {saved && <p className="saved">诊断已保存：{saved}</p>}
    </section>}
    </div>
    <ScoreWorkspace report={report} loginOpen={login.open} parentBusy={busy} onBusy={setBusy} page={page} onPageChange={navigate}/>
    <div hidden={page!=='billing'}><section className="recharge-layout" aria-label="充值信息"><div className="recharge-details"><span className="recharge-label">账户次数</span><h2>生成次数</h2><div className="recharge-balance"><strong>{user.credits}</strong><span>次</span></div><p>当前可用 {user.available} 次{user.reserved>0?`，${user.reserved} 次处理中`:''}</p><div className="recharge-divider"/><h3>充值方式</h3><p>请联系管理员充值，到账后可在此查看余额。</p><div className="recharge-note">成功生成一批补练扣 1 次；失败不扣次。</div></div><div className="recharge-code"><div className="qr-placeholder"><QrCode size={52} strokeWidth={1.2}/><span>暂无收款二维码</span></div><b>扫码充值</b><p>充值完成后请联系管理员确认</p></div></section></div>
    <div className="workspace-footer">错题app <span>·</span> 教学资料保存在本机</div>
  </main></div>;
}

function WorkspaceRouter(){
  const account=useAccount();
  return <><div hidden={account.view!=='teaching'}><App/></div>{account.user.role==='admin'&&<div hidden={account.view!=='admin'}><AdminWorkspace/></div>}</>;
}
createRoot(document.getElementById('root')!).render(<AccountGate><WorkspaceRouter /></AccountGate>);
