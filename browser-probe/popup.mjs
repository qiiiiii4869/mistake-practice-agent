import { zhixueProbe } from './probe.mjs';

const $ = id => document.getElementById(id);
let tabId, latest, sessionSummary = {}, teachingClasses = [], currentSubjects = [], busy = false;
const sourceTabValue = new URL(location.href).searchParams.get('sourceTab');
const sourceTabId = sourceTabValue && /^\d+$/.test(sourceTabValue) ? Number(sourceTabValue) : null;
const messages = {
  open_authenticated_zhixue_tab: '请在已登录的智学网教师页面点击扩展。',
  teacher_session_required: '未识别到教师登录。请确认当前账号并刷新智学网页面。',
  academic_schema_changed: '学期接口结构与已核对版本不同，请保存错误诊断。',
  exam_list_schema_changed: '考试列表结构变化，请保存错误诊断。',
  request_failed: '请求未完成，可能是接口、跨域或网络限制，请保存错误诊断。',
  session_expired: '登录已过期，请在智学网重新登录。',
  roster_student_ids_missing_or_duplicated: '已读到名单，但学生 ID 字段需要适配，请保存错误诊断。',
  teaching_scope_schema_changed: '任教信息结构与已核对版本不同，请保存错误诊断。',
  no_teaching_scope: '当前学期没有返回可识别的任教班级和学科，请保存错误诊断。',
  no_authorized_exam_subjects: '这场考试没有返回与你任教学科相符的科目，请换一场考试或保存错误诊断。',
  class_outside_teaching_scope: '任教范围已变化，请重新读取考试。',
  subject_outside_teaching_scope: '学科与当前任教班级不匹配，请重新读取考试。',
  class_roster_schema_changed: '班级单科成绩接口返回了不同的数据结构，请保存错误诊断。',
  question_number_or_full_score_mismatch: '有学生的题号或满分与同卷记录不同，已标记失败，请保存诊断。',
  download_failed: '数据已读取，但文件下载未完成。请保存错误诊断并检查浏览器下载状态。',
};
function fill(id, rows, placeholder) {
  const select = $(id);
  select.replaceChildren(new Option(placeholder, ''));
  for (const row of rows) select.add(new Option(row.name, row.id));
  if (rows.length === 1) select.value = rows[0].id;
  select.disabled = rows.length <= 1;
}
function showError(result) {
  const code = result.summary?.error || result.summary?.question_records?.failures?.[0]?.code || 'unknown_error';
  $('status').textContent = messages[code] || `此步骤未通过：${code}。请保存错误诊断，不能据此认定数据可用。`;
  $('diagnostic').hidden = false;
}
async function invoke(command) {
  const tab = sourceTabId !== null ? await chrome.tabs.get(sourceTabId)
    : (await chrome.tabs.query({active:true,currentWindow:true}))[0];
  if (!tab?.url || new URL(tab.url).origin !== 'https://www.zhixue.com') throw new Error('open_authenticated_zhixue_tab');
  if (tabId !== undefined && tab.id !== tabId) throw new Error('open_authenticated_zhixue_tab');
  tabId = tab.id;
  const [injected] = await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:zhixueProbe,args:[command]});
  if (!injected?.result?.summary) throw new Error('extension_execution_failed');
  const incoming = injected.result.summary;
  const endpoints = [...(sessionSummary.endpoints || []), ...(incoming.endpoints || [])].slice(-80);
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== 'not_verified' && key !== 'endpoints') sessionSummary[key] = value;
  }
  if (incoming.status !== 'failed') delete sessionSummary.error;
  sessionSummary.endpoints = endpoints;
  sessionSummary.stage = command.action;
  latest = {...injected.result, summary: structuredClone(sessionSummary)};
  if (!latest.ok) showError(latest);
  return latest;
}
async function guarded(task) {
  if (busy) return;
  busy = true;
  $('connect').disabled = true;
  $('export').disabled = true;
  for (const id of ['exam','subject','class']) $(id).disabled = true;
  try { await task(); }
  catch (error) {
    const code = ['open_authenticated_zhixue_tab','download_failed'].includes(error.message) ? error.message : 'extension_execution_failed';
    latest = {ok:false,summary:{...sessionSummary,status:'failed',error:code}};
    showError(latest);
  } finally {
    $('connect').disabled = false;
    for (const id of ['exam','subject','class']) $(id).disabled = $(id).options.length <= 2;
    $('export').disabled = !$('class').value;
    busy = false;
  }
}
async function save(name, value) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));
  try {
    const id = await chrome.downloads.download({url,filename:`zhixue-auto-export/${name}`,saveAs:false,conflictAction:'uniquify'});
    for(let attempt=0;attempt<120;attempt++) {
      const [download] = await chrome.downloads.search({id});
      if(download?.state==='complete') return id;
      if(download?.state==='interrupted') throw new Error('download_failed');
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    throw new Error('download_failed');
  } finally { URL.revokeObjectURL(url); }
}

function displayScope() {
  $('scope').textContent = teachingClasses.map(row => `${row.name}：${row.subjects.map(subject => subject.name || subject.code).join('、')}`).join('；');
  $('scope').hidden = false;
}
function applyClasses() {
  const subject = currentSubjects.find(row => row.id === $('subject').value);
  const classes = subject ? teachingClasses.filter(row => row.subjects.some(item => item.code === subject.code)) : [];
  fill('class',classes,'请选择任教班级');
  $('status').textContent = classes.length === 1
    ? `已自动选中任教班级“${classes[0].name}”和“${subject.name}”，可以开始自动读取。`
    : classes.length ? '请选择需要测试的任教班级。' : '当前学科未匹配到任教班级，请保存错误诊断。';
}
async function loadExam() {
  fill('subject',[],'正在读取任教学科');fill('class',[],'先选择学科');
  currentSubjects = [];
  if (!$('exam').value) return;
  $('status').textContent='正在匹配这场考试与你的任教学科……';
  const result=await invoke({action:'subjects',examId:$('exam').value});
  if(!result.ok)return;
  currentSubjects=result.subjects;
  teachingClasses=result.teachingClasses;
  displayScope();
  fill('subject',currentSubjects,'请选择任教学科');
  if ($('subject').value) applyClasses();
  else $('status').textContent='已过滤到你的任教学科，请选择。';
}
$('connect').addEventListener('click',()=>guarded(async()=>{
  sessionSummary={};
  $('diagnostic').hidden=true;
  teachingClasses=[];currentSubjects=[];
  $('selection').hidden=true;$('scope').hidden=true;
  fill('exam',[],'请选择考试');fill('subject',[],'先选择考试');fill('class',[],'先选择学科');
  $('status').textContent='正在验证教师会话并读取最新学期的考试……';
  $('result').hidden=true;
  const result=await invoke({action:'connect'});
  if(!result.ok)return;
  teachingClasses=result.teachingClasses;
  displayScope();
  fill('exam',result.options,'请选择考试');fill('subject',[],'先选择考试');fill('class',[],'先选择学科');
  $('selection').hidden=false;
  $('status').textContent=`教师会话已确认，读取到 ${result.options.length} 场考试。请选择需要测试的考试。`;
  if ($('exam').value) await loadExam();
}));
$('exam').addEventListener('change',()=>guarded(loadExam));
$('subject').addEventListener('change',()=>guarded(async()=>{applyClasses();}));
$('class').addEventListener('change',()=>{$('export').disabled=!$('class').value;});
$('export').addEventListener('click',()=>guarded(async()=>{
  $('result').hidden=true;
  $('status').textContent='正在读取全班逐题结果，请保持测试页和智学网页面打开……';
  const runId=crypto.randomUUID();
  let polling=true, pollBusy=false;
  const timer=setInterval(async()=>{
    if(!polling||pollBusy||tabId===undefined)return;
    pollBusy=true;
    try {
      const [response]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:zhixueProbe,args:[{action:'progress',runId}]});
      const progress=response?.result;
      if(polling&&progress?.total) $('status').textContent=`正在读取：${progress.processed} / ${progress.total} 人，成功 ${progress.succeeded}，没扫或无原卷 ${progress.unavailable || 0}，失败 ${progress.failed}。`;
    } catch { /* Actual export returns its own error; polling never determines success. */ }
    finally {pollBusy=false;}
  },1000);
  let result;
  try {
    result=await invoke({action:'export',fullClass:true,runId,examId:$('exam').value,subjectId:$('subject').value,classId:$('class').value});
  } finally {polling=false;clearInterval(timer);}
  $('status').textContent='读取已结束，正在保存验证报告和全班结果……';
  await save('verification-full.json',{ok:result.ok,summary:result.summary});
  if(result.data)await save('student-class.json',result);
  const q=result.summary.question_records;
  if(!result.ok){showError(result);return;}
  $('status').textContent='全班逐题结果已读取，浏览器已确认两个文件下载完成。';
  const counts=result.summary.result_counts;
  $('result').textContent=`班级名单：${result.summary.roster.student_count} 人\n已导出：${q.exported_students} 人 / ${q.question_count} 条逐题记录\n没扫：${q.not_scanned_students || 0} 人，无原卷：${q.no_original_paper_students || 0} 人（单独保留，不判对错）\n全对 ${counts.correct}，全错 ${counts.incorrect}，部分得分 ${counts.partial_credit}\n题号与满分：${q.exported_students ? '已读取学生一致' : '暂无已扫描数据'}\n试卷照片：教师另行上传后按题号关联`;
  $('result').hidden=false;
}));
$('diagnostic').addEventListener('click',async()=>{
  if(latest)await save('diagnostic.json',{ok:latest.ok,summary:latest.summary});
});
