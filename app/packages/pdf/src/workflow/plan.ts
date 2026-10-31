import type { FrozenInput,WorkflowRun,ExportProfile,StudentAssignment } from '../../../agent/src/workflow/types.ts';
import { assertFrozen,digest } from '../../../agent/src/workflow/input.ts';
import { assignStudents,selectTargets } from '../../../agent/src/workflow/assignment.ts';
import { teachingEvidence } from '../../../agent/src/workflow/teachingEvidence.ts';
import { templateClassTeachingReport,validateClassTeachingReport } from '../../../agent/src/workflow/teachingAdvice.ts';
import { validateCloze,validateExercise,factPassed,validateFacts,validateFactCheck,validateEvidence,validateUnits } from '../../../agent/src/workflow/validators.ts';
import { typstContent } from '../math.ts';
import {assertAnonymous} from '../../../agent/src/index.ts';
import {biologySourceNames} from '../../../knowledge/src/biology.ts';
import {minimumFacts,minimumCloze,minimumExercise,usableFact,validateMinimumReport} from '../../../agent/src/workflow/minimumChecks.ts';

export const PDF_TEMPLATE_VERSION='workflow-pdf-v1';
export type PageRole='practice'|'answers'|'teacher';
export interface PdfBlock {
  id:string;ownerId:string|null;role:PageRole;kind:'title'|'heading'|'text'|'question'|'answer'|'chart'|'space'|'tableHeader'|'tableRow';
  text:string;itemId?:string;blankIds?:string[];parts?:({text:string}|{gap:number})[];
  chart?:{label:string;value:number;maximum:number}[];spaceMm?:number;newPage?:boolean;
  cells?:string[];
}
export interface PlannedDocument {id:string;filename:string;role:'student'|'teacher';ownerIds:string[];blocks:PdfBlock[]}
export interface DocumentPlan {
  schemaVersion:1;runId:string;contentHash:string;profileHash:string;exportHash:string;templateVersion:string;
  mode:'dictation'|'exercise';layout:'individual'|'combined';includeAnswers:boolean;synthetic:boolean;
  revision:number;documents:PlannedDocument[];studentCount:number;estimatedPages:number;
  budget:{maxPages:number;maxBytes:number;maxPagePixels:number;timeoutMs:number};
}
function fail(code:string):never{throw new Error(code);}
const same=async(a:unknown,b:unknown)=>await digest(a)===await digest(b);
const compact=(s:string)=>s.replace(/\s/g,'');

export async function validateExportContent(input:FrozenInput,run:WorkflowRun,profile:ExportProfile,synthetic=false){
  const minimum=input.validationLevel==='minimum';
  await assertFrozen(input);
  assertAnonymous({facts:run.facts,items:run.items,report:run.teacherReport},input.workspace.students.map(s=>s.name));
  if(!['mock','real'].includes(run.executionMode))fail('pdf_invalid_execution_mode');
  if(run.contentHash!==input.contentHash||run.mode!==input.mode||run.workflowVersion!==input.workflowVersion||run.promptVersion!==input.promptVersion
    ||profile.runId!==run.runId)fail('pdf_stale_content');
  const {exportId:_id,exportHash:_hash,...settings}=profile;
  if(await digest({contentHash:input.contentHash,...settings})!==profile.exportHash)fail('pdf_stale_profile');
  if(profile.templateVersion!=='report-template-v1'||typeof profile.includeAnswers!=='boolean'||profile.printSettings.duplex!==false||!['individual','combined'].includes(profile.layout))fail('pdf_invalid_profile');
  if(run.executionMode==='mock'&&!synthetic)fail('pdf_mock_not_exportable');
    if(run.state!=='contentReady'||input.testScope||!run.teacherReport)fail('pdf_content_incomplete');
  const factIds=new Set<string>(),itemIds=new Set<string>();
  validateUnits(run.units,input);
  for(const fact of run.facts){
    (minimum?minimumFacts:validateFacts)({facts:[fact]});validateFactCheck(fact.factCheck);validateEvidence(fact.evidenceRefs);
    if(factIds.has(fact.factId)||!usableFact(fact,minimum)||!fact.sourceNumbers.length||!fact.unitIds.length
      ||fact.unitIds.some(id=>!run.units.some(u=>u.unitId===id))
      ||fact.sourceNumbers.some(n=>!run.units.some(u=>fact.unitIds.includes(u.unitId)&&u.sourceNumbers.includes(n))))fail('pdf_invalid_fact');factIds.add(fact.factId);
  }
  for(const item of run.items){
    const fact=run.facts.find(f=>f.factId===item.factId);if(!fact||itemIds.has(item.itemId)||item.mode!==run.mode)fail('pdf_invalid_item');
    itemIds.add(item.itemId);
    if(minimum?(item.status!=='draft'||item.checks.independent||item.checks.scope):(item.status!=='passed'||!Object.values(item.checks).every(v=>v===true)))fail('pdf_invalid_item');
    const checked=minimum?(item.mode==='dictation'?minimumCloze(item,fact,item.itemId,item.attempts):minimumExercise(item,fact,item.itemId,item.attempts))
      :item.mode==='dictation'?validateCloze(item,fact,item.itemId,item.attempts):validateExercise(item,fact,run.units,item.itemId,item.attempts);
    if(!await same(checked.sourceNumbers,item.sourceNumbers))fail('pdf_invalid_item');
  }
  const targets=selectTargets(input,run.facts),assignments=assignStudents(input,targets,run.items,run.facts);
  if(!await same(targets,run.targets)||!await same(assignments,run.assignments)||!minimum&&assignments.some(a=>a.status==='partial'))fail('pdf_invalid_assignment');
  const evidence=teachingEvidence(input,run.facts);
  if(!await same(evidence,run.evidence))fail('pdf_invalid_evidence');
  const report=run.teacherReport!;
  if(minimum)validateMinimumReport(report);
  else if(report.generatedBy==='template'){
    if(!await same(report,templateClassTeachingReport(evidence)))fail('pdf_invalid_teacher_report');
  }else{
    const checked=validateClassTeachingReport({overview:report.overview,followUp:report.followUp,groupActions:report.groupActions,
      advice:report.priorities.map(a=>({evidenceIds:a.evidenceIds,focus:a.focus,classroomAction:a.classroomAction,followUp:a.followUp}))},evidence);
    if(!await same(report,checked))fail('pdf_invalid_teacher_report');
  }
  return assignments;
}

// Split ordinary prose without cutting a supported formula or changing its text.
function chunks(value:string,limit=200):string[]{
  const tokens=value.match(/\$\$[\s\S]+?\$\$|\$[^$\n]+?\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]|[^$\\]+|[\s\S]/g)??[];
  const result:string[]=[];let current='';
  for(const token of tokens){
    if(token.startsWith('$')||/^\\[([]/.test(token)){if(current.length+token.length>limit&&current){result.push(current);current='';}current+=token;continue;}
    for(const char of token){current+=char;if(current.length>=limit){result.push(current);current='';}}
  }if(current)result.push(current);return result;
}
const percentage=(v:number|null)=>v===null?'暂无有效数据':`${(v*100).toFixed(1)}%`;
const number=(v:number|null)=>v===null?'暂无有效数据':Number(v.toFixed(2)).toString();

export async function buildDocumentPlan(input:FrozenInput,run:WorkflowRun,profile:ExportProfile,options:{syntheticPreview?:boolean;revision?:number;sourceNames?:Record<string,string>}={}):Promise<DocumentPlan>{
  options={...options,sourceNames:{...biologySourceNames,...options.sourceNames}};
  const assignments=await validateExportContent(input,run,profile,options.syntheticPreview),revision=options.revision??0;
  if(Object.values(options.sourceNames??{}).some(s=>typeof s!=='string'||s.length>256||/[\\/]/.test(s)))fail('pdf_invalid_source_name');
  assertAnonymous(options.sourceNames??{},input.workspace.students.map(s=>s.name));
  if(!Number.isInteger(revision)||revision<0||revision>2)fail('pdf_invalid_revision');
  const documents:PlannedDocument[]=[],studentDocs:PlannedDocument[]=[];
  let sequence=0;
  const block=(doc:PlannedDocument,ownerId:string|null,role:PageRole,kind:PdfBlock['kind'],text:string,extra:Partial<PdfBlock>={})=>{
    if(input.validationLevel==='minimum'&&kind==='title')text+=' · 宽松草稿（未经严格核验）';
    typstContent(text);const value={id:`b${++sequence}`,ownerId,role,kind,text,...extra};doc.blocks.push(value);return value;
  };
  const prose=(doc:PlannedDocument,ownerId:string|null,role:PageRole,text:string,extra:Partial<PdfBlock>={})=>{
    chunks(text,revision===2?120:200).forEach((text,index)=>block(doc,ownerId,role,'text',text,{...extra,...(index?{newPage:false,blankIds:undefined}:{})}));
  };
  const addStudent=(doc:PlannedDocument,assignment:StudentAssignment)=>{
    const student=input.workspace.students.find(s=>s.id===assignment.localStudentId)!;
    const items=assignment.itemIds.map(id=>run.items.find(i=>i.itemId===id)!);
    const title=run.mode==='dictation'?'知识点听写':'个性化补练';
    block(doc,student.id,'practice','title',`${student.name||'未命名学生'} · ${title}`,{newPage:true});
    prose(doc,student.id,'practice',`${input.workspace.exam.name} / ${input.workspace.exam.className} / ${input.workspace.exam.subjectName}`);
    const blanks=items.reduce((n,i)=>n+(i.mode==='dictation'?i.parts.filter(p=>p.type==='blank').length:0),0);
    prose(doc,student.id,'practice',run.mode==='dictation'?`本份共 ${blanks} 空，请根据知识句独立完成。`:
      `本份共 ${items.length} 题，参考用时 ${items.reduce((n,i)=>n+(i.mode==='exercise'?i.estimatedMinutes:0),0)} 分钟（仅为估算）。`);
    if(assignment.status==='unavailable')prose(doc,student.id,'practice',`本场${student.availability==='not_scanned'?'没扫':student.availability==='no_original_paper'?'无原卷':'暂无有效逐题成绩'}，不作错题判断，不安排自动补练。`);
    else if(!items.length)prose(doc,student.id,'practice',input.validationLevel==='minimum'&&assignment.rawWeakNumbers.length?'本次暂无可用练习草稿，不能据此认定没有失分目标。':'本场没有纳入的失分知识目标。');
    if(input.validationLevel==='minimum'&&assignment.uncoveredNumbers.length)prose(doc,student.id,'practice',`尚无草稿对应的原题：${assignment.uncoveredNumbers.join('、')}。本份只列本次可用内容。`);
    if(input.assignmentVersion==='personal-coverage-v1'&&items.length){
      const covered=assignment.rawWeakNumbers.filter(n=>items.some(i=>run.facts.find(f=>f.factId===i.factId)?.sourceNumbers.includes(n)));
      const unique=(assignment.questionPriorities??[]).filter(p=>p.lossStudents===1&&p.eligibleStudents>1&&covered.includes(p.number)).map(p=>p.number);
      prose(doc,student.id,'practice',`本次已覆盖原题：${covered.join('、')}。先覆盖不同错题，再补充考点。`);
      if(unique.length)prose(doc,student.id,'practice',`在有逐题成绩的学生中，仅本人失分且本次已安排的原题：${unique.join('、')}。`);
      if(input.validationLevel!=='minimum'&&assignment.uncoveredNumbers.length)prose(doc,student.id,'practice',`本次尚未覆盖原题：${assignment.uncoveredNumbers.join('、')}（数量上限或可用内容限制）。`);
    }
    items.forEach((item,index)=>{
      const source=input.assignmentVersion==='personal-coverage-v1'?` · 对应原题 ${run.facts.find(f=>f.factId===item.factId)!.sourceNumbers.filter(n=>assignment.rawWeakNumbers.includes(n)).join('、')}`:'';
      block(doc,student.id,'practice','heading',`${index+1}. ${item.mode==='dictation'?'知识句':({single_choice:'单项选择',multiple_choice:'多项选择',short_answer:'简答',calculation:'计算'}[item.type])}${source}`,{itemId:item.itemId,newPage:revision>=1&&index>0});
      if(item.mode==='dictation'&&item.context)prose(doc,student.id,'practice',`背景：${item.context}`,{itemId:item.itemId});
      if(item.mode==='dictation'){
        let parts:({text:string}|{gap:number})[]=[],blankIds:string[]=[],length=0,partNumber=0;
        const flush=()=>{if(!parts.length)return;if(partNumber++)block(doc,student.id,'practice','heading',`${index+1}. 知识句（续）`,{itemId:item.itemId});
          block(doc,student.id,'practice','question',parts.flatMap(p=>'text'in p?[p.text]:[]).join(''),{itemId:item.itemId,blankIds,parts});parts=[];blankIds=[];length=0;};
        for(const p of item.parts){
          if(p.type==='blank'){if(length>160)flush();parts.push({gap:Math.min(48,Math.max(16,[...p.answer].length*3.5))});blankIds.push(p.blankId);length+=20;}
          else for(const piece of chunks(p.text,150)){if(length+piece.length>180)flush();parts.push({text:piece});length+=piece.length;}
        }flush();
      }else{
        if(item.material)chunks(item.material,180).forEach((text,j)=>prose(doc,student.id,'practice',`${j?'材料（续）：':'材料：'}${text}`,{itemId:item.itemId}));
        const choiceText=item.options.map(o=>`${o.id}. ${o.text}`).join('\n');
        if(item.stem.length+choiceText.length<500)block(doc,student.id,'practice','question',item.stem+(choiceText?'\n'+choiceText:''),{itemId:item.itemId});
        else{chunks(item.stem,180).forEach((text,j)=>prose(doc,student.id,'practice',`${j?'题干（续）：':''}${text}`,{itemId:item.itemId}));
          item.options.forEach(o=>chunks(o.text,180).forEach((text,j)=>prose(doc,student.id,'practice',`${o.id}${j?'（续）':''}. ${text}`,{itemId:item.itemId})));}
        block(doc,student.id,'practice','space','作答区',{itemId:item.itemId,spaceMm:item.type==='calculation'?38:item.type==='short_answer'?28:10});
      }
    });
    if(profile.includeAnswers&&items.length){
      block(doc,student.id,'answers','title',`${student.name||'未命名学生'} · 参考答案与说明`,{newPage:true});
      items.forEach((item,index)=>{
        block(doc,student.id,'answers','heading',`${index+1}. 原题对应：${item.sourceNumbers.join('、')}`,{itemId:item.itemId});
        if(item.mode==='dictation')item.parts.filter(p=>p.type==='blank').forEach((p,j)=>prose(doc,student.id,'answers',`第 ${j+1} 空：${p.answer}；可接受表述：${p.acceptedAnswers.join(' / ')}`,{itemId:item.itemId,blankIds:[p.blankId]}));
        else{
          prose(doc,student.id,'answers',`参考答案：${item.answer.join('、')}`,{itemId:item.itemId});
          prose(doc,student.id,'answers',`解析：${item.explanation}`,{itemId:item.itemId});
          item.rubric.forEach((r,j)=>prose(doc,student.id,'answers',`评分点 ${j+1}：${r}`,{itemId:item.itemId}));
        }
        if(item.mode==='dictation'&&item.correction)prose(doc,student.id,'answers',`复习提示：${item.correction}`,{itemId:item.itemId});
        const fact=run.facts.find(f=>f.factId===item.factId)!;
        prose(doc,student.id,'answers',`知识点：${fact.knowledgePoint}。来源：原第 ${item.sourceNumbers.join('、')} 题${fact.evidenceRefs.map(e=>`；${options.sourceNames?.[e.documentId]??`资料 ${e.documentId}`} 第 ${e.page} 页`).join('')}。`,{itemId:item.itemId});
      });
    }
  };
  if(profile.layout==='combined'){
    const doc:PlannedDocument={id:'class',filename:'class-practice.pdf',role:'student',ownerIds:assignments.map(a=>a.localStudentId),blocks:[]};
    assignments.forEach(a=>addStudent(doc,a));studentDocs.push(doc);
  }else assignments.forEach((a,i)=>{const doc:PlannedDocument={id:`student-${i+1}`,filename:`student-${String(i+1).padStart(3,'0')}.pdf`,role:'student',ownerIds:[a.localStudentId],blocks:[]};addStudent(doc,a);studentDocs.push(doc);});
  documents.push(...studentDocs);
  const doc:PlannedDocument={id:'teacher',filename:'teacher-report.pdf',role:'teacher',ownerIds:[],blocks:[]};documents.push(doc);
  const e=run.evidence,c=e.classOverview,r=run.teacherReport!;
  block(doc,null,'teacher','title','整场班级教学建议报告');
  prose(doc,null,'teacher',`${input.workspace.exam.name} / ${input.workspace.exam.className} / ${input.workspace.exam.subjectName}`);
  block(doc,null,'teacher','heading','班级概况与成绩分布');
  prose(doc,null,'teacher',`名单 ${c.rosterCount} 人；有效计分 ${c.scoredCount} 人；没扫 ${c.notScannedCount} 人；无原卷 ${c.noOriginalPaperCount} 人；不可判分 ${c.notScorableCount} 人。满分 ${number(c.fullScore)}，均分 ${number(c.meanScore)}，中位数 ${number(c.medianScore)}，最高 ${number(c.maxScore)}，最低 ${number(c.minScore)}，总体标准差 ${number(c.standardDeviation)}。真实零分参与统计，缺失成绩不按零分处理。`);
  block(doc,null,'teacher','chart','得分率区间人数（仅描述本场得分率）',{chart:c.scoreBands.map(b=>({label:`${Math.round(b.minRate*100)}-${Math.round(b.maxRate*100)}%${b.includeMax?'（含上界）':'（不含上界）'}`,value:b.studentCount,maximum:Math.max(1,c.scoredCount)}))});
  prose(doc,null,'teacher',r.overview);
  block(doc,null,'teacher','heading','全班逐题正确率与知识映射');
  prose(doc,null,'teacher',`知识映射 ${e.mappedQuestions}/${e.totalQuestions} 题，分值覆盖 ${e.mappedFullScore}/${e.totalFullScore}；未映射题：${e.unmappedNumbers.join('、')||'无'}。全对人数/有效人数为正确率，部分得分单列。`);
  const header=['原题','全对/有效','正确率及人数','知识点 / 得分率'];block(doc,null,'teacher','tableHeader',header.join(''),{cells:header});
  for(const q of e.questions){const names=q.knowledgePointIds.map(id=>run.facts.find(f=>f.factId===id)?.knowledgePoint??'未映射').join('、')||'尚未映射';
    chunks(names,160).forEach((part,index)=>{const cells=[`${q.questionNumber}${index?'（续）':''}`,index?'见上行':`${q.correctCount}/${q.participantCount}`,
      index?'见上行':`${percentage(q.correctRate)}\n部分 ${q.partialCount} / 全错 ${q.incorrectCount}`,`${part}${index?'':`\n得分率 ${percentage(q.scoreRate)}`}`];
      block(doc,null,'teacher','tableRow',cells.join(''),{cells});});}
  block(doc,null,'teacher','heading','优先讲评与课堂安排');
  for(const a of r.priorities){prose(doc,null,'teacher',a.focus);for(const id of a.evidenceIds){const row=e.rows.find(x=>x.evidenceId===id)!;prose(doc,null,'teacher',`统计依据：${row.knowledgePoint}；有效人数 ${row.participantCount}，失分人数 ${row.lossCount}；${row.questionStats.map(q=>`原第 ${q.questionNumber} 题全对 ${q.correctCount}/${q.participantCount}，正确率 ${percentage(q.correctRate)}`).join('；')}。`);}prose(doc,null,'teacher',`课堂安排：${a.classroomAction}`);prose(doc,null,'teacher',`后续观察：${a.followUp}`);}
  block(doc,null,'teacher','heading','分组巩固与统一后续检查');
  for(const a of r.groupActions){const b=c.scoreBands.find(b=>b.bandId===a.bandId)!;prose(doc,null,'teacher',`${Math.round(b.minRate*100)}-${Math.round(b.maxRate*100)}% 区间，${b.studentCount} 人，平均得分率 ${percentage(b.meanScoreRate)}：${a.action}`);}
  prose(doc,null,'teacher',r.followUp);
  block(doc,null,'teacher','heading','范围与局限');
  prose(doc,null,'teacher',[...r.limitations,...(e.unmappedNumbers.length?['知识证据不足，报告仅覆盖已映射范围，不能视为全面知识诊断。']:[])].join('\n'));
  // Headings are deliberately short and stay with the following semantic block.
  const estimatedPages=documents.reduce((n,d)=>n+Math.max(1,Math.ceil(d.blocks.length/10)),0)+assignments.length*(profile.includeAnswers?2:1);
  const body={schemaVersion:1 as const,runId:run.runId,contentHash:input.contentHash,profileHash:profile.exportHash,templateVersion:PDF_TEMPLATE_VERSION,
    mode:run.mode,layout:profile.layout,includeAnswers:profile.includeAnswers,synthetic:run.executionMode==='mock',revision,documents,studentCount:assignments.length,estimatedPages,
    budget:{maxPages:Math.min(1200,Math.max(40,estimatedPages*4)),maxBytes:300*1024*1024,maxPagePixels:4_000_000,timeoutMs:Math.min(3600_000,60_000+estimatedPages*12_000)}};
  return {...body,exportHash:await digest(body)};
}

const literal=(s:string)=>`#text(${JSON.stringify(s)})`;
export function renderDocument(plan:DocumentPlan,doc:PlannedDocument):string{
  const lines=[`#set page(paper:"a4", margin:(x:18mm,y:19mm), footer:context align(center, text(size:10.5pt)[第 #counter(page).display("1") 页]))`,
    '#set text(font:("Microsoft YaHei","Cambria Math"),size:11pt,lang:"zh")',
    '#set par(leading:0.7em,justify:false)',
    '#set heading(numbering:none)',
    '#let checked(id, body) = block(width:100%, breakable:false)[#layout(size => context {let dim=measure(body,width:size.width); let pos=here().position(); metadata((id:id,page:pos.page,x:pos.x/1pt,y:pos.y/1pt,width:dim.width/1pt,height:dim.height/1pt)); body})]',
  ];
  if(plan.synthetic)lines.push('#set page(header:align(center,text(size:10.5pt)[合成数据排版验收 / 不可分发]))');
  const rowBody=(b:PdfBlock)=>`#grid(columns:(0.6fr,0.9fr,1.8fr,3fr),gutter:6pt,..(${b.cells!.map(c=>`[${typstContent(c)}]`).join(',')},))`;
  for(let index=0;index<doc.blocks.length;index++){const b=doc.blocks[index];
    if(b.newPage)lines.push('#pagebreak(weak:true)');
    if(b.kind==='tableHeader'){
      if(plan.revision>0)lines.push('#pagebreak(weak:true)');
      const rows:PdfBlock[]=[];while(doc.blocks[index+1]?.kind==='tableRow')rows.push(doc.blocks[++index]);
      lines.push(`#table(columns:(1fr,),stroke:(bottom:0.4pt),inset:6pt,table.header[#checked(${JSON.stringify(b.id)},[${rowBody(b)}])],${rows.map(r=>`[#checked(${JSON.stringify(r.id)},[${rowBody(r)}])]`).join(',')})\n#v(8pt)`);continue;
    }
    let body='';
    if(b.kind==='title')body=`#heading(level:1, outlined:true, [#block(width:100%)[#align(center,text(size:17pt,weight:"bold",${JSON.stringify(b.text)}))]])`;
    else if(b.kind==='heading')body=`#text(size:12pt,weight:"bold",${JSON.stringify(b.text)})`;
    else if(b.parts)body=b.parts.map(p=>'text'in p?typstContent(p.text):`#box(width:${p.gap}mm)[#line(length:100%,stroke:0.6pt)]`).join('');
    else if(b.chart)body=literal(b.text)+'\n\n'+b.chart.map(row=>`${literal(`${row.label}：${row.value} 人`)} #box(width:65mm,height:2mm)[#rect(width:${row.value/row.maximum*65}mm,height:2mm,fill:black,stroke:none)]`).join('\n\n');
    else if(b.kind==='space')body=`${literal(b.text)}\n#v(${b.spaceMm}mm)\n#line(length:100%,stroke:0.4pt)`;
    else body=typstContent(b.text);
    // Inline fractions and scripts can extend beyond a text line's nominal
    // ascent/descent. Reserve real vertical space before recording bounds.
    if(/\$|\\[([]/.test(expectedText(b)))body=`#block(width:100%,inset:(top:8pt,bottom:8pt))[${body}]`;
    if(b.kind==='heading')lines.push(`#block(sticky:true,above:9pt,below:4pt)[#checked(${JSON.stringify(b.id)}, [${body}])]`);
    else lines.push(`#checked(${JSON.stringify(b.id)}, [${body}])\n#v(${b.kind==='title'?10:6}pt)`);
  }
  return lines.join('\n');
}

export function expectedText(block:PdfBlock):string{
  if(block.chart)return block.text+block.chart.map(r=>`${r.label}：${r.value} 人`).join('');
  return block.parts?block.parts.flatMap(p=>'text'in p?[p.text]:[]).join(''):block.text;
}
export const normalizedPdfText=compact;
