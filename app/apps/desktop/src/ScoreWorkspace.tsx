import { AgentWorkspace } from './AgentWorkspace';
import { PaperWorkspace } from './PaperWorkspace';
import React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { analyze, dataErrorMessage, parseExportText, validateSettings, validateWorkspace, workspaceFromExport,
  type StoredWorkspace, type TeacherSettings, type Workspace } from '../../../packages/core/src';
import { errorMessage, type ConnectionReport, type ExamSubject, type SubjectReport, type TeachingClass } from '../../../packages/zhixue/src';

interface Props { report: ConnectionReport | null; loginOpen: boolean; parentBusy: boolean; onBusy: (busy: boolean) => void }
export function ScoreWorkspace({ report, loginOpen, parentBusy, onBusy }: Props) {
  const [stored, setStored] = React.useState<StoredWorkspace>({ revision: 0, snapshot: null });
  const [ready, setReady] = React.useState(false);
  const [working, setWorking] = React.useState(false);
  const [message, setMessage] = React.useState('正在检查本机当前考试…');
  const [examId, setExamId] = React.useState('');
  const [subjectId, setSubjectId] = React.useState('');
  const [classId, setClassId] = React.useState('');
  const [subjects, setSubjects] = React.useState<ExamSubject[]>([]);
  const [classes, setClasses] = React.useState<TeachingClass[]>([]);
  const [candidate, setCandidate] = React.useState<Workspace | null>(null);
  const [confirmClear, setConfirmClear] = React.useState(false);
  const [settings, setSettings] = React.useState<TeacherSettings | null>(null);
  const requestVersion = React.useRef(0);
  const snapshot = stored.snapshot;
  const analysis = React.useMemo(() => snapshot ? analyze(snapshot) : null, [snapshot]);
  const locked = !ready || working || parentBusy || candidate !== null || confirmClear;

  React.useEffect(() => {
    let active = true;
    invoke<StoredWorkspace>('load_workspace').then(value => {
      const normalized = value.snapshot ? validateWorkspace(value.snapshot) : null;
      if (active) {
        setStored({ revision: value.revision, snapshot: normalized }); setSettings(normalized?.settings ?? null);
        setReady(true); setMessage(normalized ? '已恢复本机当前考试。' : '本机暂无考试。可读取全班成绩，或导入扩展导出的两个 JSON 文件。');
      }
    }).catch(error => { if (active) setMessage(`恢复本地数据失败，已暂停写入。${dataErrorMessage(error)}`); });
    return () => { active = false; };
  }, []);

  async function chooseExam(id: string) {
    const version = ++requestVersion.current;
    setExamId(id); setSubjects([]); setSubjectId(''); setClasses([]); setClassId('');
    if (!id) return;
    setWorking(true); onBusy(true); setMessage('正在匹配考试与你的任教学科…');
    try {
      const result = await invoke<SubjectReport>('read_subjects', { examId: id });
      if (version !== requestVersion.current) return;
      if (!result.ok) throw result.summary.error ?? 'no_authorized_exam_subjects';
      const choices = result.subjects ?? [], scopes = result.teachingClasses ?? [];
      setSubjects(choices); setClasses(scopes);
      if (choices.length === 1) {
        setSubjectId(choices[0].id);
        const matching = scopes.filter(c => c.subjects.some(s => s.code === choices[0].code));
        if (matching.length === 1) setClassId(matching[0].id);
      }
      setMessage('请确认考试、学科和班级，再读取全班逐题得分。');
    } catch (error) { if (version === requestVersion.current) setMessage(errorMessage(String(error))); }
    finally { if (version === requestVersion.current) { setWorking(false); onBusy(false); } }
  }

  React.useEffect(() => {
    ++requestVersion.current;
    setExamId(''); setSubjectId(''); setClassId(''); setSubjects([]); setClasses([]);
    if (report?.ok && report.options.length === 1) void chooseExam(report.options[0].id);
  }, [report]);

  function chooseSubject(id: string) {
    setSubjectId(id); setClassId('');
    const code = subjects.find(s => s.id === id)?.code;
    const matching = classes.filter(c => c.subjects.some(s => s.code === code));
    if (matching.length === 1) setClassId(matching[0].id);
  }

  async function persist(next: Workspace | null) {
    setWorking(true); onBusy(true);
    try {
      const normalized = next ? validateWorkspace(next) : null;
      const saved = await invoke<StoredWorkspace>('save_workspace', { expectedRevision: stored.revision, snapshot: normalized });
      const restored = saved.snapshot ? validateWorkspace(saved.snapshot) : null;
      setStored({ revision: saved.revision, snapshot: restored }); setSettings(restored?.settings ?? null);
      setCandidate(null); setConfirmClear(false);
      setMessage(restored ? '当前考试已校验并保存到本机。' : '本机当前考试已清除，扩展原始下载文件和智学网登录态仍保留。');
      return true;
    } catch (error) { setMessage(`${dataErrorMessage(error)} 请核对本机状态后再试。`); return false; }
    finally { setWorking(false); onBusy(false); }
  }

  async function accept(next: Workspace) {
    if (snapshot) { setCandidate(next); setMessage('新数据已通过校验。确认后将替换本机当前考试。'); }
    else await persist(next);
  }

  async function readClass() {
    const exam = report?.options.find(e => e.id === examId), subject = subjects.find(s => s.id === subjectId), teachingClass = classes.find(c => c.id === classId);
    if (!exam || !subject || !teachingClass) return;
    setWorking(true); onBusy(true); setMessage('正在读取全班逐题得分，请保持智学网窗口打开…');
    let polling = true, pending = false;
    const timer = window.setInterval(async () => {
      if (pending || !polling) return;
      pending = true;
      try {
        const p = await invoke<{ total: number; processed: number; succeeded: number; unavailable: number; failed: number } | null>('probe_progress');
        if (polling && p?.total) setMessage(`正在读取 ${p.processed} / ${p.total} 人：成功 ${p.succeeded}，没扫或无原卷 ${p.unavailable}，失败 ${p.failed}。`);
      } catch { /* Counts never establish export success. */ }
      finally { pending = false; }
    }, 1000);
    try {
      const raw = await invoke<unknown>('read_class_scores', { examId, subjectId, classId });
      polling = false; clearInterval(timer);
      if (raw && typeof raw === 'object' && 'ok' in raw && raw.ok === false && 'summary' in raw) {
        const failed = raw as { summary?: { error?: unknown } };
        if (typeof failed.summary?.error === 'string') {
          setMessage(`${errorMessage(failed.summary.error)} 本次没有保存全班成绩。`);
          return;
        }
      }
      const next = workspaceFromExport(raw, 'zhixue_webview', { id: exam.id, name: exam.name, subjectId: subject.id,
        subjectName: subject.name, classId: teachingClass.id, className: teachingClass.name });
      await accept(next);
    } catch (error) { setMessage(`${dataErrorMessage(error)} 本次没有保存全班成绩。`); }
    finally { polling = false; clearInterval(timer); setWorking(false); onBusy(false); }
  }

  async function importFiles(event: React.ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])]; event.target.value = '';
    if (!files.length) return;
    if (files.length !== 2) { setMessage('请同时选择 student-class 和 verification-full 两个 JSON 文件。'); return; }
    setWorking(true); onBusy(true);
    try {
      if (files.some(f => f.size > 16 * 1024 * 1024)) throw new Error('file_too_large');
      const values = await Promise.all(files.map(async f => parseExportText(await f.text())));
      const isData = (v: unknown) => v !== null && typeof v === 'object' && 'data' in v;
      const datasets = values.filter(isData), verifications = values.filter(v => !isData(v));
      if (datasets.length !== 1 || verifications.length !== 1) throw new Error('verification_summary_mismatch');
      await accept(workspaceFromExport(datasets[0], 'chrome_extension', {}, verifications[0]));
    } catch (error) { setMessage(`${dataErrorMessage(error)} 本机当前考试保持原样。`); }
    finally { setWorking(false); onBusy(false); }
  }

  const subjectCode = subjects.find(s => s.id === subjectId)?.code;
  const matchingClasses = classes.filter(c => c.subjects.some(s => s.code === subjectCode));
  return <>
    <section className="card" id="exam-students" aria-label="全班成绩接入">
      <div className="card-heading"><h2>选择考试，读取学生信息</h2><span className="muted">仅处理当前一场考试</span></div>
      {report?.ok && report.options.length > 0 ? <>
        <div className="fields">
          <label>选择考试<select aria-label="选择考试" value={examId} disabled={locked} onChange={e => void chooseExam(e.target.value)}><option value="">请选择考试</option>{report.options.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}</select></label>
          <label>选择学科<select aria-label="选择学科" value={subjectId} disabled={locked || !subjects.length} onChange={e => chooseSubject(e.target.value)}><option value="">请选择学科</option>{subjects.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <label>选择班级<select aria-label="选择班级" value={classId} disabled={locked || !matchingClasses.length} onChange={e => setClassId(e.target.value)}><option value="">请选择班级</option>{matchingClasses.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        </div>
        <div className="actions"><button disabled={locked || !loginOpen || !classId || !subjectId || !examId} onClick={() => void readClass()}>读取全班逐题得分</button></div>
      </> : <p>请先在上方登录智学网并点击“读取考试列表”，然后在这里选择考试、学科与班级。学生姓名、名单和逐题得分会一起读取；也可使用下方扩展文件导入。</p>}
      <label className={`file-input ${locked ? 'disabled' : ''}`}>导入扩展导出文件<input type="file" accept=".json,application/json" multiple disabled={locked} aria-label="导入扩展导出文件" onChange={e => void importFiles(e)} /></label>
      <p className="help">同时选择 student-class 与同次导出的 verification-full 文件。只接受完整全班得分，不接收答案图片或作答原文。</p>
      <p className="notice" aria-live="polite" data-testid="workspace-message">{message}</p>
      {candidate && <div className="confirm-panel" role="region" aria-label="确认替换考试"><b>替换本机当前考试？</b><p>当前：{snapshot?.exam.name}；新数据：{candidate.exam.name}，共 {candidate.students.length} 人。当前考试、试卷照片、题干、出题审核及设置将被替换，不建立历史记录。</p><div className="actions"><button disabled={working} onClick={() => void persist(candidate)}>确认替换并保存</button><button className="secondary" disabled={working} onClick={() => { setCandidate(null); setMessage('已取消替换，当前考试保留。'); }}>保留当前考试</button></div></div>}
    </section>
    {snapshot && analysis && <section className="card" aria-label="本机当前考试">
      <div className="card-heading"><h2>{snapshot.exam.name}</h2><span className="badge success">已保存到本机</span></div>
      <p>{snapshot.exam.className} · {snapshot.exam.subjectName} · {snapshot.source.kind === 'zhixue_webview' ? '内置窗口读取' : 'Chrome 扩展导入'}</p>
      <div className="metrics"><div><b>{analysis.audit.rosterCount}</b><span>名单人数</span></div><div><b>{analysis.audit.exportedCount}</b><span>可分析学生</span></div><div><b>{analysis.audit.questionRecords}</b><span>逐题记录</span></div><div><b>{analysis.audit.notScannedCount} / {analysis.audit.noPaperCount}</b><span>没扫 / 无原卷</span></div></div>
      <p className="help">没扫、无原卷学生不判对错，也不进入每题统计分母。失分用于选题，不能直接认定错因。</p>
      {settings && <details><summary>本场教师设置</summary><div className="fields settings">
        <label>每道错题变式数<input aria-label="每道错题变式数" type="number" min="1" max="10" value={settings.variantsPerQuestion} onChange={e => setSettings({ ...settings, variantsPerQuestion: Number(e.target.value) })} disabled={locked}/></label>
        <label>每人题数上限<input aria-label="每人题数上限" type="number" min="1" max="100" value={settings.maxQuestionsPerStudent} onChange={e => setSettings({ ...settings, maxQuestionsPerStudent: Number(e.target.value) })} disabled={locked}/></label>
        <label>部分得分纳入<select aria-label="部分得分纳入" value={String(settings.includePartialCredit)} disabled={locked} onChange={e => setSettings({ ...settings, includePartialCredit: e.target.value === 'true' })}><option value="true">纳入</option><option value="false">不纳入</option></select></label>
        <label>得分率低于此百分比<input aria-label="得分率低于此百分比" type="number" min="0" max="100" value={settings.partialCreditThreshold} disabled={locked || !settings.includePartialCredit} onChange={e => setSettings({ ...settings, partialCreditThreshold: Number(e.target.value) })}/></label>
        <label>补练难度<select aria-label="补练难度" value={settings.difficulty} disabled={locked} onChange={e => setSettings({ ...settings, difficulty: e.target.value as TeacherSettings['difficulty'] })}><option value="basic">基础</option><option value="same">同级</option><option value="advanced">提高</option></select></label>
      </div><p className="help">全错始终计入；部分得分仅在“纳入”且得分率严格低于阈值时计入。保存设置会清除本场旧出题与审核结果，之后需重新生成。</p><button className="secondary small" disabled={locked} onClick={() => {
        try { const checked = validateSettings(settings); void persist({ ...snapshot, settings: checked, practice: undefined }); }
        catch (error) { setMessage(dataErrorMessage(error)); }
      }}>保存设置并重算</button></details>}
      <h3>按题统计</h3><div className="table-scroll"><table><thead><tr><th>题号</th><th>满分</th><th>失分率</th><th>全错</th><th>部分得分</th><th>纳入补练人数</th></tr></thead><tbody>{analysis.questions.map(q => <tr key={q.number}><td>{q.number}</td><td>{q.fullScore}</td><td>{q.fullScore ? `${(q.lostRate * 100).toFixed(1)}%` : '不计分'}</td><td>{q.incorrectStudents}</td><td>{q.partialStudents}</td><td>{q.weakStudents}</td></tr>)}</tbody></table></div>
      <details open aria-label="学生名单与逐题得分"><summary>学生名单与逐题得分（{analysis.students.length} 人）</summary><div className="table-scroll"><table><thead><tr><th>学生</th><th>状态</th><th>逐题得分合计</th><th>失分</th><th>纳入补练题号</th><th>逐题明细</th></tr></thead><tbody>{analysis.students.map((s, i) => <tr key={s.id}><td>{s.name || `学生 ${i + 1}`}</td><td>{s.availability === 'scored' ? '已读取' : s.availability === 'not_scanned' ? '没扫' : '无原卷'}</td><td>{s.availability === 'scored' ? Number(snapshot.students.find(student=>student.id===s.id)!.questions.reduce((total,q)=>total+q.score,0).toFixed(2)) : '—'}</td><td>{s.availability === 'scored' ? Number(s.lostPoints.toFixed(2)) : '—'}</td><td>{s.availability === 'scored' ? s.weakQuestions.join('、') || '暂无' : '不判对错'}</td><td>{s.availability === 'scored' ? <details><summary>查看逐题得分</summary><ul>{snapshot.students.find(student=>student.id===s.id)!.questions.map(q=><li key={q.number}>第 {q.number} 题：{q.score} / {q.fullScore} · {q.result==='correct'?'全对':q.result==='incorrect'?'全错':q.result==='partial_credit'?'部分得分':'不计分'}</li>)}</ul></details> : '无逐题记录'}</td></tr>)}</tbody></table></div></details>
      <div className="actions"><button className="secondary small danger" disabled={locked} onClick={() => setConfirmClear(true)}>清除当前考试</button></div>
      {confirmClear && <div className="confirm-panel" role="region" aria-label="确认清除考试"><b>清除本机当前考试及教师设置？</b><p>这会清除程序保存的本场学生、得分、试卷照片、题干及出题审核结果。下载目录中的扩展文件和智学网登录态仍保留。</p><div className="actions"><button className="danger" disabled={working} onClick={() => void persist(null)}>确认清除</button><button className="secondary" disabled={working} onClick={() => setConfirmClear(false)}>取消清除</button></div></div>}
    </section>}
    {snapshot && analysis && <PaperWorkspace paper={snapshot.paper} numbers={analysis.audit.questionNumbers} locked={locked} onBusy={onBusy}
      save={async paper => { await persist({ ...snapshot, paper, practice: undefined }); }}/>}
    {snapshot && <AgentWorkspace key={stored.revision} workspace={snapshot} revision={stored.revision} locked={locked} onBusy={onBusy} save={practice=>persist({...snapshot,practice})}/>}
  </>;
}
