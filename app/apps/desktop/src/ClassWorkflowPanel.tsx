import React from 'react';
import {invoke} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import {analyze,type Workspace} from '../../../packages/core/src';
import {freezeInput,runWorkflow,SqliteWorkflowStore,type GenerationMode,type StoredTask,type TaskSummary} from '../../../packages/agent/src/workflow';
import {cloudWorkflowPorts,type CloudModelStatus} from '../../../packages/agent/src/workflow/live';
import type {KnowledgeLibrary} from '../../../packages/knowledge/src';
import {failureMessages} from '../../../packages/agent/src/workflow/diagnostics';
import {renderPaperFiles} from './renderPaperFiles';
import {workflowMessage} from './CloudWorkflowPanel';
import {useAccount} from './AccountGate';

interface Delivery {state:string;folder:string;exportId:string;runId:string;fileCount:number;settlementStatus:string}
type SavedExport=Awaited<ReturnType<SqliteWorkflowStore['listExports']>>[number];
export function ClassWorkflowPanel({workspace,revision,locked,onBusy}:{workspace:Workspace;revision:number;locked:boolean;onBusy:(busy:boolean)=>void}){
 const account=useAccount(),store=React.useMemo(()=>new SqliteWorkflowStore(invoke,account.user.id),[account.user.id]);
 const [mode,setMode]=React.useState<GenerationMode>('dictation'),[maxItems,setMaxItems]=React.useState(16),[difficulty,setDifficulty]=React.useState(workspace.settings.difficulty);
 const [layout,setLayout]=React.useState<'individual'|'combined'>('individual'),[answers,setAnswers]=React.useState(true);
 const [busy,setBusy]=React.useState(false),[message,setMessage]=React.useState('按本场失分目标生成全班材料，学生练习与教师报告分别保存。');
 const [tasks,setTasks]=React.useState<TaskSummary[]>([]),[task,setTask]=React.useState<StoredTask|null>(null),[exports,setExports]=React.useState<SavedExport[]>([]);
 const [delivery,setDelivery]=React.useState<Delivery|null>(null),[retryUnknown,setRetryUnknown]=React.useState(false);
 const controller=React.useRef<AbortController|null>(null),activeRun=React.useRef<string|null>(null);
 const disabled=locked||busy,run=task?.run;
 const refresh=async()=>{try{setTasks(await store.list());}catch(error){setMessage(workflowMessage(error));}};
 const show=async(runId:string)=>{const value=await store.task(runId);if(!value)throw new Error('workflow_run_not_found');setTask(value);setRetryUnknown(false);setMode(value.input.mode);setMaxItems(value.input.settings.maxItems);setDifficulty(value.input.settings.difficulty);setExports(await store.listExports(runId));return value;};
 React.useEffect(()=>{void refresh();let closed=false,off:(()=>void)|undefined;
  void listen<{runId:string;progress:{stage:string;filename:string|null}}>('workflow-export-progress',event=>{
   if(event.payload.runId!==activeRun.current)return;
   const stage=event.payload.progress.stage;
   setMessage(({compiling:'正在生成 PDF',checking:'正在逐页检查 PDF',reflowing:'正在调整分页并重新检查',publishing:'正在保存已通过检查的文件',verified:'PDF 已检查完成'} as Record<string,string>)[stage]??'正在处理 PDF…');
  }).then(fn=>{if(closed)fn();else off=fn;}).catch(()=>{});
  return()=>{closed=true;off?.();controller.current?.abort();};
 },[store]);
 const exported=async(runId:string,exportId?:string)=>{
  activeRun.current=runId;setMessage(exportId?'正在重试上次 PDF 导出，不重新出题…':'请选择保存位置，随后检查并导出学生练习与教师报告…');
  const value=await invoke<Delivery|null>('workflow_pdf_export',{runId,layout,includeAnswers:answers,exportId:exportId??null});
  setExports(await store.listExports(runId));
  if(value){setDelivery(value);setMessage(`已保存 ${value.fileCount} 份 PDF，包含独立教师报告。本次尚未结算次数。`);}
  else setMessage('已取消选择保存位置；生成结果保存在本机，可稍后导出。');
 };
 const withBusy=async(action:()=>Promise<void>)=>{
  if(controller.current)return;const abort=new AbortController();controller.current=abort;setBusy(true);onBusy(true);
  try{await action();}catch(error){setMessage(workflowMessage(error));
   if(activeRun.current){try{await show(activeRun.current);}catch{}}
  }finally{controller.current=null;activeRun.current=null;setBusy(false);onBusy(false);void refresh();void account.refresh();}
 };
 async function generate(resuming=false){await withBusy(async()=>{
  setDelivery(null);
  const available=await invoke<{available:boolean}>('workflow_pdf_status');if(!available.available)throw new Error('pdf_runtime_missing');
  const status=await invoke<CloudModelStatus>('workflow_model_status');if(!status.configured)throw new Error('model_unconfigured');
  const library=await invoke<KnowledgeLibrary>('list_knowledge');let input;
  if(resuming){
   if(!task?.run||task.input.testScope||task.context.workspaceRevision!==revision||task.input.knowledgeRevision!==String(library.revision))throw new Error('workflow_stale_run');
   input=task.input;
  }else{
   if(!workspace.paper?.pages.length)throw new Error('paper_required');
   setMessage('正在本机准备整份试卷…');
   const paper=await renderPaperFiles(workspace.paper,analyze(workspace).audit.questionNumbers,setMessage,controller.current!.signal);
   input=await freezeInput({ownerId:account.user.id,workspace:{...workspace,paper:{pages:paper.pages,questions:[]}},mode,knowledgeRevision:String(library.revision),settings:{maxItems,difficulty}});
  }
  const runId=resuming?task!.run!.runId:crypto.randomUUID();activeRun.current=runId;
  const labels:Record<string,string>={preflight:'检查生成条件',authorizing:'连接生成服务',recognizing:'读取整份试卷',aligning:'核对原题',extracting:'提炼知识点',retrieving:'检索可选资料',verifyingFacts:'核对知识句',clozing:'生成听写',validatingCloze:'独立盲填检查',generatingExercises:'生成补练题',solving:'独立解题',validatingExercise:'核对题目',assembling:'分配个人练习',aggregatingEvidence:'计算全班统计',writingGuidance:'生成独立教师报告',validatingGuidance:'检查教师报告'};
  const ports=cloudWorkflowPorts({invoke,requestKey:runId,revision,modelConfigVersion:status.modelConfigVersion??'unknown',store,exportLayout:layout,
   resumeCloud:resuming?task?.run?.cloud:undefined,onProgress:stage=>setMessage(`正在${labels[stage]??'处理生成任务'}…`)});
  const result=await runWorkflow({input,ports,runId,signal:controller.current!.signal,resume:resuming,retryUnknownCalls:resuming&&retryUnknown,taskContext:{workspaceRevision:revision}});
  await show(runId);setRetryUnknown(false);
  if(result.state==='contentReady'&&!result.errorCode&&!controller.current!.signal.aborted)await exported(runId);
  else setMessage(result.errorCode?workflowMessage(result.errorCode):'部分内容未通过检查，已保存结果与未覆盖项，尚未导出或结算次数。');
 });}
 const canExport=!!run&&run.state==='contentReady'&&run.executionMode==='real'&&!task?.input.testScope;
 return <section className="card" aria-label="全班练习与教师报告">
  <div className="card-heading"><h2>生成学生练习与教师报告</h2><span className="badge">全班 {workspace.students.length} 人</span></div>
  <p className="help">一次处理本场所有原题，按每位学生的实际失分分配练习，并生成一份独立教师报告。没有知识库也可继续。请使用不含学生姓名的空白试卷。</p>
  <div className="fields">
   <label>内容模式<select aria-label="全班内容模式" disabled={disabled} value={mode} onChange={e=>{const next=e.target.value as GenerationMode;setMode(next);setMaxItems(next==='dictation'?16:5);}}><option value="dictation">知识点听写</option><option value="exercise">变式补练</option></select></label>
   <label>{mode==='dictation'?'每人最多空数':'每人最多题数'}<input aria-label="全班每人数量上限" type="number" min="1" max={mode==='dictation'?24:10} disabled={disabled} value={maxItems} onChange={e=>setMaxItems(Number(e.target.value))}/></label>
   <label>难度<select aria-label="全班生成难度" disabled={disabled} value={difficulty} onChange={e=>setDifficulty(e.target.value as typeof difficulty)}><option value="basic">基础</option><option value="same">同级</option><option value="advanced">提高</option></select></label>
   <label>PDF 组织方式<select aria-label="全班导出方式" disabled={disabled} value={layout} onChange={e=>setLayout(e.target.value as typeof layout)}><option value="individual">每位学生一份</option><option value="combined">全班合订一份</option></select></label>
   <label><input aria-label="全班附答案页" type="checkbox" disabled={disabled} checked={answers} onChange={e=>setAnswers(e.target.checked)}/>附独立答案页</label>
  </div>
  <p className="help">数量是上限，错题少就少安排；教师报告始终单独导出。当前生成消耗模型额度，次数结算尚未启用。</p>
  <div className="actions"><button disabled={disabled} onClick={()=>void generate()}>生成并导出 PDF</button><button className="secondary" disabled={!busy} onClick={()=>{controller.current?.abort();void invoke('workflow_pdf_cancel').catch(()=>{});}}>停止本次处理</button>
   {canExport&&<button className="secondary" disabled={disabled} onClick={()=>void withBusy(()=>exported(run!.runId))}>导出已有结果 PDF</button>}
  </div>
  <p role="status" className="notice" data-testid="class-workflow-message">{message}</p>
  {run&&<div aria-label="全班生成结果"><p>{task?.input.workspace.exam.name} · {task?.input.workspace.students.length} 人</p><p>状态：{({contentReady:'内容已就绪',partial:'部分完成',failed:'生成失败',cancelled:'已停止',recoverable:'待恢复'} as Record<string,string>)[run.state]??'处理中'}；有效条目 {run.items.filter(i=>i.status==='passed').length} 个；未覆盖目标 {run.assignments.reduce((sum,a)=>sum+a.uncoveredTargets.length,0)} 个；未覆盖原题 {new Set(run.assignments.flatMap(a=>a.uncoveredNumbers)).size} 道。</p>
   {!!task?.input.testScope&&<p>此为单题测试结果，不能作为全班 PDF 导出。</p>}
   <p>教师报告：{run.teacherReport?'已生成，导出时独立保存':'尚未完成'}</p>
   {!!run.skipped.length&&<details open><summary>失败与未覆盖原题</summary><ul>{run.skipped.map((s,i)=><li key={i}>原第 {s.sourceNumbers.join('、')} 题：{failureMessages[s.reason]??'此项未通过检查'}</li>)}</ul></details>}
   {!['contentReady','partial','failed'].includes(run.state)&&!task?.input.testScope&&<div>
    <label><input type="checkbox" aria-label="全班允许重试未知请求" checked={retryUnknown} onChange={e=>setRetryUnknown(e.target.checked)} disabled={disabled}/>允许重试未知请求（可能重复消耗模型额度）</label>
    <button className="secondary" disabled={disabled||run.calls.some(c=>c.status!=='completed')&&!retryUnknown} onClick={()=>void generate(true)}>继续已保存任务</button>
   </div>}
  </div>}
  {delivery&&<p className="notice passed">保存位置：{delivery.folder}</p>}
  {exports.map(e=><div key={e.profile.exportId}><span>PDF：{e.state==='verified'?'已通过检查并保存':e.state==='failed'?'导出失败，可重试':e.state==='cancelled'?'导出已停止':e.state==='exporting'?'上次导出未结束，可继续':'待导出'} {e.folder??''}</span>
   {e.state!=='verified'&&e.staging&&<button className="secondary small" disabled={disabled} onClick={()=>void withBusy(()=>exported(run!.runId,e.profile.exportId))}>重试 PDF 导出</button>}
  </div>)}
  <details><summary>本机历史任务（{tasks.length}）</summary><button className="secondary small" disabled={disabled} onClick={()=>void refresh()}>刷新历史任务</button>
   {tasks.map(t=><div key={t.runId}>{t.examName} · {t.mode==='dictation'?'听写':'补练'} <button className="secondary small" disabled={disabled} onClick={()=>void withBusy(async()=>{await show(t.runId);setDelivery(null);setMessage('已读取本机任务，未调用模型。');})}>打开历史结果</button></div>)}
  </details>
 </section>;
}
