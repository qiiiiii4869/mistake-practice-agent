import React from 'react';
import {invoke} from '@tauri-apps/api/core';
import {analyze,type Workspace} from '../../../packages/core/src';
import {freezeInput,runWorkflow,SqliteWorkflowStore,type TaskSummary,type StoredTask,type GenerationMode,type WorkflowRun,type WorkflowState} from '../../../packages/agent/src/workflow';
import {cloudWorkflowPorts,type CloudModelStatus} from '../../../packages/agent/src/workflow/live';
import {failureMessages,validationMessages,recognitionMessages} from '../../../packages/agent/src/workflow/diagnostics';
import {partitionValidationAttempts} from '../../../packages/agent/src/workflow/teachingAdvice';
import {renderPaperFiles} from './renderPaperFiles';
import {useAccount} from './AccountGate';
import type {KnowledgeLibrary} from '../../../packages/knowledge/src';

const stages:Partial<Record<WorkflowState,string>>={preflight:'预检',authorizing:'云端授权',rendering:'准备试卷',recognizing:'独立识题与核对',aligning:'题号对齐',
  extracting:'提炼知识句',retrieving:'检索可选资料',verifyingFacts:'事实核验',merging:'合并知识点',selectingTargets:'选择个人目标',clozing:'生成听写',validatingCloze:'独立盲填',
  generatingExercises:'生成补练',solving:'独立解题',validatingExercise:'题目校验',assembling:'个人分配',aggregatingEvidence:'统计教学证据',writingGuidance:'教学建议',validatingGuidance:'建议检查'};
export function workflowMessage(error:unknown):string{
  const code=error instanceof Error?error.message:String(error);
  return ({model_unconfigured:'云端尚未配置模型 Key，请由管理员保存云端配置。',account_service_failed:'账号服务器尚未支持新工作流接口，请先部署新版服务。',
    pdf_runtime_missing:'本机缺少 PDF 导出组件或系统中文字体，请使用包含导出组件的新版程序。',pdf_content_incomplete:'部分内容或教师报告未完成，尚不能导出全班文件。',
    pdf_export_busy:'已有 PDF 正在导出，请等待或停止当前导出。',pdf_cancelled:'已停止 PDF 导出，已有生成内容保留，可重试。',pdf_qa_failed:'PDF 检查未通过，尚未发布文件，可重试导出。',
    pdf_compile_failed:'PDF 编译失败，生成内容保留，可重试导出。',pdf_font_or_layout_warning:'PDF 字体或版式存在问题，尚未发布文件。',pdf_runtime_unavailable:'PDF 导出组件无法启动，请重新安装完整程序。',
    pdf_export_timeout:'PDF 导出超过时限，已有进度保留，可重试。',pdf_bridge_failed:'PDF 导出中断，生成内容保留，请查看导出记录后重试。',
    account_network_failed:'账号服务连接失败；本机 Key 会清除，云端预占最迟到期释放。',model_auth_failed:'模型服务拒绝了云端 Key，请管理员更新配置。',
    credits_exhausted:'当前账号没有可用次数，不能领取模型授权。',generation_busy:'账号已有活动任务，请结束或等待原任务到期。',
    model_quota_exhausted:'模型服务余额或额度耗尽，已停止并清理本机 Key。',workflow_lease_expired:'任务授权已失效，已停止并清理本机 Key。',
    workflow_budget_exceeded:'达到本批调用或 Token 上限，已停止。',workflow_budget_estimate_exceeded:'后续处理预计超过剩余调用上限，已暂停新增请求；已完成进度保留。',
    workflow_batch_input_exceeded:'原题或资料文字过长，当前无法在请求长度上限内处理；已暂停并保留进度。',
    workflow_request_timeout:'模型请求超时，停止后续调用；该请求的用量可能未知。',workflow_cancelled:'已停止内容测试。',
    paper_required:'请先上传空白卷并确认不含学生姓名。',storage_conflict:'考试版本已变化，请重新打开测试入口。',workflow_invalid_scope:'请选择当前考试内的 1～6 个测试题号。',
    paper_document_failed:'本机无法展开试卷文件，尚未调用模型。请先检查文件能否正常打开，或另存为 PDF 后重试。',
    paper_document_limit:'试卷展开后超过页数或大小限制，请压缩文件或拆分后重试。',paper_word_unsupported:'此 Word 包含不支持的图形或外部资源，请另存为 PDF。',
    agent_cancelled:'已停止本机试卷处理，尚未调用模型。',
    workflow_storage_failed:'任务保存失败，已停止后续调用；重开后可从最后一次成功写入的位置恢复。',workflow_storage_unavailable:'无法访问本机任务库，请重试。',
    workflow_storage_conflict:'任务已被其他窗口更新，请刷新任务列表。',workflow_busy:'本账号已有任务正在执行，请先停止原任务。',workflow_lease_lost:'本机执行权已失效，已停止后续请求。',
    workflow_storage_corrupt:'保存的任务或调用结果校验失败，已拒绝恢复。',workflow_result_missing:'已完成调用的本机结果缺失，已停止，避免重复调用。',
    workflow_unknown_call_requires_decision:'有请求结果未知。请先查看已保存结果；确认可能重复产生模型费用后，再选择重试未知请求。',
    workflow_stale_run:'任务与当前输入、版本或模型配置不同，请新建测试，旧结果仍保留。',workflow_deadline:'原任务时间预算已结束，已保存内容仍可查看。',
    workflow_resume_service_unavailable:'云端尚未支持恢复用量核对，请先更新账号服务；已保存结果仍可查看。',
    workflow_diagnostic_write_failed:'任务已结束，Key 已清理，但匿名诊断保存失败；当前结果仍可查看，请保留此页面。',
    workflow_invalid_output:'模型输出未通过结构检查。',model_output_truncated:'模型输出被截断，已停止，请缩小测试范围。',
    workflow_invalid_question_scope:'原题号范围与已导入成绩不一致，或存在重复题号；尚未调用模型，请刷新考试后重试。',
    account_invalid_response:'账号服务返回格式不符合当前版本，请检查服务版本。',invalid_model_request:'试卷或生成请求未通过本机检查，尚未发送该次模型请求。',
    workflow_failed:'生成在准备阶段未完成，请查看本机任务记录定位具体原因。',
    model_privacy_blocked:'题干或资料包含学生姓名，已拦截模型请求。',invalid_input:'测试参数不符合限制，请核对题号与页数。',
    model_network_failed:'模型连接失败，已停止本批调用。',workflow_release_pending:'本机 Key 已清理，但云端预占释放尚未确认。'} as Record<string,string>)[code]??`本次未完成（${/^[a-z_]+$/.test(code)?code:'请求失败'}）。`;
}
export function CloudWorkflowPanel({workspace,revision,locked,onBusy}:{workspace:Workspace;revision:number;locked:boolean;onBusy:(value:boolean)=>void}){
  const account=useAccount(),numbers=analyze(workspace).audit.questionNumbers;
  const [status,setStatus]=React.useState<CloudModelStatus|null>(null),[modelKey,setModelKey]=React.useState(''),[mode,setMode]=React.useState<GenerationMode>('dictation');
  const [selected,setSelected]=React.useState(()=>analyze(workspace).questions.find(q=>q.weakStudents>0)?.number??numbers[0]??'');
  const [pages,setPages]=React.useState('1'),[keepFirst,setKeepFirst]=React.useState(''),[busy,setBusy]=React.useState(false),[blank,setBlank]=React.useState(false);
  const [result,setResult]=React.useState<WorkflowRun|null>(null),[message,setMessage]=React.useState('先检查云端模型配置，再选择少量题号测试。');
  const [pendingJob,setPendingJob]=React.useState<string|null>(null);
  const [tasks,setTasks]=React.useState<TaskSummary[]>([]),[restored,setRestored]=React.useState<StoredTask|null>(null),[retryUnknown,setRetryUnknown]=React.useState(false);
  const controller=React.useRef<AbortController|null>(null),store=React.useMemo(()=>new SqliteWorkflowStore(invoke,account.user.id),[account.user.id]);
  const disabled=locked||busy;
  const validationGroups=result?partitionValidationAttempts(result):{unresolved:[],resolved:[]};
  const refresh=async()=>{try{const value=await invoke<CloudModelStatus>('workflow_model_status');setStatus(value);
    const pending=await invoke<{jobId:string|null}>('workflow_pending').catch(()=>({jobId:null}));setPendingJob(pending.jobId);return value;
    }catch(error){setMessage(workflowMessage(error));return null;}};
  const refreshTasks=async()=>{try{setTasks(await store.list());}catch(error){setMessage(workflowMessage(error));}};
  React.useEffect(()=>{void refresh();void refreshTasks();return()=>controller.current?.abort();},[store]);
  React.useEffect(()=>{if(!controller.current){setResult(null);setRestored(null);setBlank(false);setSelected(analyze(workspace).questions.find(q=>q.weakStudents>0)?.number??'');}},[workspace]);
  async function viewTask(runId:string){setBusy(true);onBusy(true);try{const task=await store.task(runId);if(!task)throw new Error('workflow_run_not_found');
    setRestored(task);setResult(task.run);setMode(task.input.mode);setSelected(task.input.testScope?.questionNumbers.join('、')??'');setRetryUnknown(false);
    setMessage(task.run?.state==='contentReady'||task.run?.state==='partial'?'已读取本机保存结果，没有领取 Key 或调用模型。':'已读取未结束任务，可查看已保存内容；继续时沿用原调用账本和预算。');
  }catch(error){setMessage(workflowMessage(error));}finally{setBusy(false);onBusy(false);}}
  async function configure(){setBusy(true);onBusy(true);try{const value=await invoke<CloudModelStatus>('workflow_configure_cloud_model',{modelKey:modelKey.trim()});setStatus(value);setMessage('已保存到云端受限文件；普通客户端无需输入 Key。');}
    catch(error){setMessage(workflowMessage(error));}finally{setModelKey('');setBusy(false);onBusy(false);}}
  async function inspectPaper(){
    if(controller.current)return;const signal=new AbortController();controller.current=signal;setBusy(true);onBusy(true);
    try{if(!workspace.paper?.pages.length)throw new Error('paper_required');
      const rendered=await renderPaperFiles(workspace.paper,numbers,setMessage,signal.signal);
      setMessage(`本机试卷展开成功：${rendered.pages.length} 页。没有调用模型、领取 Key 或预占次数。`);
    }catch(error){setMessage(workflowMessage(error));}
    finally{controller.current=null;setBusy(false);onBusy(false);}
  }
  async function run(resuming=false){
    if(controller.current)return;const signal=new AbortController();controller.current=signal;setBusy(true);onBusy(true);setResult(null);
    try{
      if(!resuming&&!blank)throw new Error('paper_required');
      if(resuming&&(!restored||restored.context.workspaceRevision!==revision))throw new Error('workflow_stale_run');
      const configured=await refresh();if(!configured?.configured)throw new Error('model_unconfigured');
      const chosen=selected.split(/[,，、\s]+/).filter(Boolean),pageNumbers=pages.split(/[,，、\s]+/).filter(Boolean).map(Number);
      if(!chosen.length||chosen.length>6||new Set(chosen).size!==chosen.length||chosen.some(n=>!numbers.includes(n)))throw new Error('workflow_invalid_scope');
      if(!pageNumbers.length||pageNumbers.some(n=>!Number.isInteger(n)||n<1||n>30)||new Set(pageNumbers).size!==pageNumbers.length)throw new Error('invalid_input');
      const library=await invoke<KnowledgeLibrary>('list_knowledge');
      let input;
      if(resuming){input=restored!.input;if(input.knowledgeRevision!==String(library.revision))throw new Error('workflow_stale_run');}
      else{if(!workspace.paper)throw new Error('paper_required');
        const paper=await renderPaperFiles(workspace.paper,numbers,setMessage,signal.signal);
        if(pageNumbers.some(n=>n>paper.pages.length))throw new Error('invalid_input');
        input=await freezeInput({ownerId:account.user.id,workspace:{...workspace,paper:{pages:pageNumbers.map(n=>paper.pages[n-1]),questions:[]}},mode,
          knowledgeRevision:String(library.revision),testScope:{questionNumbers:chosen},recognitionPolicy:{keepFirstNumbers:keepFirst.split(/[,，、\s]+/).filter(Boolean)}});}
      const requestKey=resuming?restored!.run?.runId??'':crypto.randomUUID();
      const ports=cloudWorkflowPorts({invoke,requestKey,revision,modelConfigVersion:configured.modelConfigVersion??'unknown',store,resumeCloud:resuming?restored?.run?.cloud:undefined,
        keepFirstNumbers:keepFirst.split(/[,，、\s]+/).filter(Boolean),onProgress:stage=>setMessage(`正在${stages[stage]??stage}…`)});
      const run=await runWorkflow({input,ports,runId:requestKey,signal:signal.signal,resume:resuming,retryUnknownCalls:resuming&&retryUnknown,taskContext:{workspaceRevision:revision}});setResult(run);
      const saved=await store.task(requestKey);setRestored(saved);void refreshTasks();
      const passed=run.items.filter(item=>item.status==='passed').length;
      setMessage(run.errorCode?workflowMessage(run.errorCode):run.state==='contentReady'?`测试内容已生成并校验，有效条目 ${passed} 个；任务已结束，本机 Key 已清理。`:`已有 ${passed} 个有效条目，部分个人目标未覆盖，请查看失败摘要；任务已结束，本机 Key 已清理。`);
    }catch(error){setMessage(workflowMessage(error));}
    finally{controller.current=null;setBusy(false);onBusy(false);void account.refresh();void refreshTasks();}
  }
  return <section className="card" aria-label="云端模型双模式测试">
    <div className="card-heading"><h2>云端模型 · 双模式内容测试</h2><span className="badge">{status?.configured?'云端已配置':'待配置'}</span></div>
    <p className="help">服务器核验账号和可用次数后，下发 Key 到 Rust 内存，本机直连 DeepSeek。任务结束、失败、取消或授权失效会清理 Key，不写入本机文件。</p>
    <p className="notice">当前仅测试识题和听写／补练，不生成教师建议。教师报告在整场考试处理结束后，结合全班逐题正确率、知识点映射和成绩分布统一生成。测试尚未交付新版 PDF，结束后释放预占，不扣成功次数；真实模型调用仍消耗服务商额度。</p>
    <button className="secondary small" disabled={disabled} onClick={()=>void refresh()}>检查云端模型</button>
    <button className="secondary small" disabled={disabled} onClick={()=>void inspectPaper()}>检查本机试卷文件</button>
    <details><summary>本机已保存任务（{tasks.length}）</summary><p className="help">按软件账号隔离保存，重开仍保留；查看结果不会调用模型。旧考试或设置改变后可查看旧结果，不能混入当前任务。</p>
      <button className="secondary small" disabled={disabled} onClick={()=>void refreshTasks()}>刷新本机任务</button>
      {tasks.map(t=><div key={t.runId}><span>{t.examName} · {t.mode==='dictation'?'听写':'补练'} · {t.state??'已创建'} · 调用 {t.callCount} 次 · 未知 {t.unknownCalls} 次 </span><button className="secondary small" disabled={disabled} onClick={()=>void viewTask(t.runId)}>查看保存结果</button></div>)}
    </details>
    {restored?.run&&!['contentReady','partial'].includes(restored.run.state)&&<div className="notice" aria-label="恢复已保存任务">
      <p>恢复原任务 {restored.run.runId.slice(0,8)}；当前已知用量和未知请求预留均保留，不重置预算。</p>
      {restored.run.calls.some(c=>c.status!=='completed')&&<label><input type="checkbox" aria-label="确认重试未知模型请求" checked={retryUnknown} onChange={e=>setRetryUnknown(e.target.checked)} disabled={disabled}/> 已知未知请求可能已经计费，仍选择重试；不自动重复。</label>}
      <button disabled={disabled||restored.context.workspaceRevision!==revision} onClick={()=>void run(true)}>继续已保存任务</button>
      {restored.context.workspaceRevision!==revision&&<p>当前考试或设置已变化，只能查看原任务，请新建测试。</p>}
    </div>}
    {pendingJob&&<div className="notice"><p>账号有未结束的云端任务。若上次测试已中断，可释放预占后重试。</p><button className="secondary small" disabled={disabled} onClick={async()=>{
      setBusy(true);onBusy(true);try{await invoke('workflow_end',{jobId:pendingJob,outcome:'cancelled'});setPendingJob(null);setMessage('已清理本机凭证并释放未完成任务。');await account.refresh();}
      catch(error){setMessage(workflowMessage(error));}finally{setBusy(false);onBusy(false);}
    }}>释放未完成云端任务</button></div>}
    {account.user.role==='admin'&&<details><summary>管理员：配置云端模型 Key</summary>
      <p className="help">仅管理员首次设置或轮换时使用，通过 HTTPS 保存到服务器受限文件，保存后清空此输入。</p>
      <label>云端模型 Key<input type="password" autoComplete="off" aria-label="云端模型 Key" value={modelKey} disabled={disabled} onChange={e=>setModelKey(e.target.value)}/></label>
      <button className="secondary small" disabled={disabled||!modelKey.trim()} onClick={()=>void configure()}>保存云端模型配置</button>
    </details>}
    <div className="fields"><label>生成内容<select aria-label="双模式生成内容" value={mode} disabled={disabled} onChange={e=>setMode(e.target.value as GenerationMode)}><option value="dictation">知识点听写</option><option value="exercise">补练出题</option></select></label>
      <label>测试原题号<input aria-label="测试原题号" value={selected} disabled={disabled} onChange={e=>setSelected(e.target.value)}/></label>
      <label>展开后的试卷页码<input aria-label="测试试卷页码" value={pages} disabled={disabled} onChange={e=>setPages(e.target.value)}/></label>
    </div>
    <p className="help">默认一道题、第 1 页；可填逗号分隔的 1～6 个原题号及所需页码。其余题目不在本次测试范围，教师证据仅代表已映射部分。</p>
    <p className="help">只读取题干与各小问正文。图示、表格及其中的标签和数据不读取；依赖图表的小问跳过，其余文字知识点仍可生成。</p>
    <details><summary>重复题号规则</summary><label>已确认只保留第一次的题号<input aria-label="保留首次重复题号" value={keepFirst} disabled={disabled} onChange={e=>setKeepFirst(e.target.value)}/></label><p className="help">默认隔离歧义题。仅在已明确排除后一道同号题时填写，例如 5；不改变其他题号。</p></details>
    <label><input type="checkbox" checked={blank} disabled={disabled} aria-label="测试空白卷无学生姓名" onChange={e=>setBlank(e.target.checked)}/> 本次发送的是不含学生姓名的空白卷</label>
    <div className="actions"><button disabled={disabled||!blank||!selected.trim()} onClick={()=>void run()}>开始真实内容测试</button>{busy&&controller.current&&<button className="secondary" onClick={()=>controller.current?.abort()}>停止内容测试</button>}</div>
    <p className="notice" role="status" data-testid="workflow-cloud-message">{message}</p>
    {result&&<div aria-label="真实内容测试结果">
      <p>状态：{result.state==='contentReady'?'内容已就绪':result.state==='partial'?'部分完成':result.state}；有效条目 {result.items.filter(i=>i.status==='passed').length} 个；未通过目标 {new Set(result.assignments.flatMap(a=>a.uncoveredTargets)).size} 个；未建立知识目标的原题 {new Set(result.assignments.flatMap(a=>a.rawWeakNumbers.filter(n=>!result.facts.some(f=>f.sourceNumbers.includes(n))))).size} 道；调用 {result.calls.length} 次；已知用量 {result.calls.reduce((n,c)=>n+(c.usage??0),0)} Token；未知用量请求 {result.calls.filter(c=>c.usage===null).length} 次。</p>
      <p className="help">同一道原题可对应多个知识点。部分完成表示仍有个人目标未覆盖；下方通过的条目仍可查看。匿名诊断按任务保存在本机，不含姓名、题干、答案或 Key。</p>
      {result.items.map(item=><article className={`agent-variant ${item.status==='passed'?'':'flagged'}`} key={item.itemId}><b>原第 {item.sourceNumbers.join('、')} 题 · {result.facts.find(f=>f.factId===item.factId)?.knowledgePoint} · {item.status==='passed'?'机器检查通过':'检查未通过'}</b>
        {item.mode==='dictation'?<>{item.context&&<p className="help">背景与适用条件：{item.context}</p>}<p>{item.parts.map(p=>p.type==='text'?p.text:'________').join('')}</p>{item.authoring==='deterministic'&&<p className="help">由已核验知识句直接挖空，仍经独立盲填检查。</p>}<details><summary>听写答案与纠错</summary><p>{item.parts.flatMap(p=>p.type==='blank'?[p.answer]:[]).join('；')}</p><p>{item.correction}</p></details></>
          :<><p>{item.material}</p><p>{item.stem}</p><ul>{item.options.map(o=><li key={o.id}>{o.id}．{o.text}</li>)}</ul><details><summary>补练答案与解析</summary><p>{item.answer.join('；')}</p><p>{item.explanation}</p><p>评分点：{item.rubric.join('；')}</p></details></>}
      </article>)}
      <h3>本次测试统计</h3><p>知识映射：{result.evidence.mappedQuestions}/{result.evidence.totalQuestions} 题，{result.evidence.mappedFullScore}/{result.evidence.totalFullScore} 分。这里只列统计依据，不是整场教师报告。</p>
      <p className="help">讲评重点按全班每题正确率结合该题知识点确定。正确率＝全对人数÷有效作答人数；部分得分单列，没扫／无原卷不计入。得分率仅作辅助。</p>
      <details><summary>全班逐题正确率与知识点依据</summary><div className="table-scroll"><table><thead><tr><th>原题</th><th>全对／有效人数</th><th>正确率</th><th>部分得分</th><th>全错</th><th>对应知识点</th></tr></thead><tbody>{result.evidence.questions.map(q=><tr key={q.questionNumber}><td>{q.questionNumber}</td><td>{q.correctCount}/{q.participantCount}</td><td>{q.correctRate===null?'无数据':`${(q.correctRate*100).toFixed(1)}%`}</td><td>{q.partialCount}</td><td>{q.incorrectCount}</td><td>{q.knowledgePointIds.map(id=>result.facts.find(f=>f.factId===id)?.knowledgePoint).join('、')||'未映射'}</td></tr>)}</tbody></table></div></details>
      {!result.teacherReport&&<p className="notice">本次为局部内容测试，未调用教师建议模型。整场教师报告会综合全卷、全班统计，最后统一生成。</p>}
      {result.teacherReport&&<section aria-label="整场班级综合教师报告"><h3>整场班级综合教师报告</h3>
        <p>{result.teacherReport.overview}</p><p>有效计分 {result.evidence.classOverview.scoredCount} 人；均分 {result.evidence.classOverview.meanScore?.toFixed(1)??'无数据'}；中位数 {result.evidence.classOverview.medianScore?.toFixed(1)??'无数据'}；标准差 {result.evidence.classOverview.standardDeviation?.toFixed(1)??'无数据'}。</p>
        <ul>{result.teacherReport.priorities.map(a=><li key={a.adviceId}><b>{a.focus}</b><p>{a.classroomAction}</p><p>{a.followUp}</p></li>)}</ul>
        <h4>按成绩分布安排巩固</h4>{result.teacherReport.groupActions.map(a=>{const b=result.evidence.classOverview.scoreBands.find(b=>b.bandId===a.bandId);return <p key={a.bandId}>{b?`得分率${b.minRate*100}%～${b.includeMax?'':'低于'}${b.maxRate*100}%（${b.studentCount}人）：`:''}{a.action}</p>;})}
        <p>{result.teacherReport.followUp}</p><p className="help">{result.teacherReport.limitations.join('；')}</p>
      </section>}
      <details><summary>本机个人分配与未覆盖项</summary><table><thead><tr><th>学生</th><th>状态</th><th>有效条目</th><th>目标覆盖</th><th>未覆盖知识点／原题</th></tr></thead><tbody>{result.assignments.map(a=><tr key={a.localStudentId}><td>{workspace.students.find(s=>s.id===a.localStudentId)?.name}</td><td>{a.status}</td><td>{a.itemIds.length}</td><td>{a.selectedTargets.length?`${a.selectedTargets.length-a.uncoveredTargets.length}/${a.selectedTargets.length}`:'—'}</td><td>{[...a.uncoveredTargets.map(id=>result.facts.find(f=>f.factId===id)?.knowledgePoint??'未命名目标'),...a.uncoveredNumbers.map(n=>`原第${n}题`)].join('；')||'—'}</td></tr>)}</tbody></table></details>
      {result.skipped.length>0&&<details open><summary>失败与跳过摘要</summary><ul>{result.skipped.map((s,i)=><li key={i}>原第 {s.sourceNumbers.join('、')} 题：{failureMessages[s.reason]??s.reason}{s.reason==='item_validation_failed'&&'（不是整道原题都未生成）'}</li>)}</ul>
        {result.recognitionChecks.filter(c=>c.status!=='usable').length>0&&<ul>{result.recognitionChecks.filter(c=>c.status!=='usable').map((c,i)=><li key={i}>第 {c.pageIndex} 页 · 原第 {c.sourceNumbers.join('、')} 题：{recognitionMessages[c.reason]}（已读取 {c.readings.length} 次）</li>)}</ul>}
        {validationGroups.unresolved.length>0&&<ul>{validationGroups.unresolved.map((v,i)=><li key={i}>原第 {v.sourceNumbers.join('、')} 题 · {result.facts.find(f=>f.factId===v.factId)?.knowledgePoint??'知识点'} · 第 {v.attempt} 轮：{validationMessages[v.reason]}</li>)}</ul>}
      </details>}
      {validationGroups.resolved.length>0&&<details><summary>已修复的校验记录（{validationGroups.resolved.length}）</summary><p className="help">以下检查后续已通过；仍有未覆盖内容时，以上方失败摘要为准。</p><ul>{validationGroups.resolved.map((v,i)=><li key={i}>原第 {v.sourceNumbers.join('、')} 题 · {result.facts.find(f=>f.factId===v.factId)?.knowledgePoint??'知识点'} · 第 {v.attempt} 轮：{validationMessages[v.reason]}（后续已通过）</li>)}</ul></details>}
    </div>}
  </section>;
}
