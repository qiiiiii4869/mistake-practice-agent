import { KnowledgeWorkspace } from './KnowledgeWorkspace';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { errorMessage, type ConnectionReport, type LoginStatus } from '../../../packages/zhixue/src';
import './styles.css';
import { ScoreWorkspace } from './ScoreWorkspace';
import { AccountGate, useAccount } from './AccountGate';
import { AdminWorkspace } from './AdminWorkspace';

function App() {
  const {setWorkBusy}=useAccount();
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
  return <main>
    <header><div className="brand">错题智能推送 <span>AGENT</span></div><div className="stage">阶段 4 · 离线出题与审核</div></header>
    <nav className="section-nav" aria-label="功能入口"><a href="#exam-students">考试与学生信息</a><a href="#paper-review">上传空白卷</a><a href="#agent-review">出题与审核</a><a href="#knowledge-library">知识库</a></nav>
    <section className="intro"><span className="eyebrow">数据接入 / 智学网</span><h1>先读取考试与学生，再安排补练。</h1><p>登录智学网后，选择某次考试、学科和班级，读取全班学生名单及逐题得分。</p></section>
    <section className="steps" aria-label="验证步骤"><div><b>01</b><span>教师登录智学网</span></div><div><b>02</b><span>选择考试、学科与班级</span></div><div><b>03</b><span>读取学生与逐题得分</span></div></section>
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
    <ScoreWorkspace report={report} loginOpen={login.open} parentBusy={busy} onBusy={setBusy}/>
    <KnowledgeWorkspace/>
    <footer>每场考试单独处理，学生与得分只保存在本机。上传空白卷后，点击“生成结果”启动 Agent 读取、核对、知识库检索和出题；最终结果需教师审核。<br/>本次只读取得分，不采集作答选项，暂不提供错误选项分布。</footer>
  </main>;
}

function WorkspaceRouter(){
  const account=useAccount();
  return <><div hidden={account.view!=='teaching'}><App/></div>{account.user.role==='admin'&&<div hidden={account.view!=='admin'}><AdminWorkspace/></div>}</>;
}
createRoot(document.getElementById('root')!).render(<AccountGate><WorkspaceRouter /></AccountGate>);
