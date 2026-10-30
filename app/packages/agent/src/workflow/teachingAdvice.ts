import type { ClassTeachingReport,EvidenceSummary, TeachingAdvice,WorkflowRun } from './types.ts';
import { factPassed,invalid, list, object, strings, text } from './validators.ts';

function narrative(value:unknown,max=2000):string{
  const valueText=text(value,max);
  if(/[\d%％]|[零一二三四五六七八九十百千万两]+(?:人|名|成|道|分)|全班都|确定不会|证明.*不会|已经掌握|已经提高|教学失败|错选|错误选项|学生认为|导致失分/.test(valueText))return invalid();
  return valueText;
}

export function priorityEvidence(evidence: EvidenceSummary,correctRateThreshold=0.6) {
  if(!Number.isFinite(correctRateThreshold)||correctRateThreshold<=0||correctRateThreshold>1)throw new Error('workflow_invalid_settings');
  const weak=(row:EvidenceSummary['rows'][number])=>row.questionStats.filter(q=>q.correctRate!==null&&q.correctRate<correctRateThreshold)
    .sort((a,b)=>a.correctRate!-b.correctRate!||(b.participantCount-b.correctCount)-(a.participantCount-a.correctCount));
  return evidence.rows.filter(e=>weak(e).length>0)
    .sort((a,b)=>{const x=weak(a)[0],y=weak(b)[0];return x.correctRate!-y.correctRate!
      ||(y.participantCount-y.correctCount)-(x.participantCount-x.correctCount)||a.evidenceId.localeCompare(b.evidenceId);}).slice(0,5);
}
export function validateAdvice(value: unknown, evidence: EvidenceSummary): TeachingAdvice[] {
  const selected = priorityEvidence(evidence), seen = new Set<string>();
  const advice = list(object(value).advice,5,selected.length === 0).map((v,i) => {
    const a = object(v), evidenceIds = strings(a.evidenceIds,5);
    if (Object.keys(a).some(k => !['evidenceIds','focus','classroomAction','followUp'].includes(k))
      || new Set(evidenceIds).size !== evidenceIds.length || evidenceIds.some(id => !selected.some(e => e.evidenceId === id) || seen.has(id))) return invalid();
    evidenceIds.forEach(id => seen.add(id));
    const focus = text(a.focus,1000), classroomAction = text(a.classroomAction,2000), followUp = text(a.followUp,2000);
    if (/[\d%％]|[零一二三四五六七八九十百千万两]+(?:人|名|成|道|分)|全班都|确定不会|证明.*不会|已经掌握|已经提高|教学失败|错选|错误选项|学生认为|导致失分/.test(focus + classroomAction + followUp)
      || !evidenceIds.every(id => focus.includes(selected.find(e => e.evidenceId === id)!.knowledgePoint))) return invalid();
    return { adviceId: `advice-${i+1}`, evidenceIds, priority: i+1, focus, classroomAction, followUp,
      limitations: [...new Set(evidenceIds.flatMap(id => selected.find(e => e.evidenceId === id)!.limitations))],
      validationStatus: 'passed' as const, generatedBy: 'model' as const };
  });
  if (selected.some(e => !seen.has(e.evidenceId))) return invalid();
  return advice;
}
export function templateAdvice(evidence: EvidenceSummary): TeachingAdvice[] {
  const selected = priorityEvidence(evidence);
  if (!selected.length) return [{ adviceId: 'advice-overview', evidenceIds: [], priority: 1,
    focus: !evidence.mappedQuestions?'知识点证据不足，暂不形成知识点掌握结论。'
      :evidence.questions.some(q=>q.correctRate!==null&&q.correctRate<0.6&&!q.knowledgePointIds.length)?'存在正确率偏低且尚未完成知识点映射的原题，需结合原卷核查。'
      :'本次已映射原题的全班正确率均未低于优先规则阈值，暂不据此推断薄弱知识点。',
    classroomAction: '结合原题表现进行讲评，核查未映射题目的材料与知识目标。',
    followUp: '通过后续课堂提问或短练习收集独立证据，再判断是否需要加强。',
    limitations: ['没有后测数据，不能判断教学改善。', ...(evidence.unmappedNumbers.length ? ['存在未映射原题。'] : [])],
    validationStatus: 'passed', generatedBy: 'template' }];
  return selected.map((e,i) => ({ adviceId: `advice-${i+1}`, evidenceIds: [e.evidenceId], priority: i+1,
    focus: `${e.knowledgePoint}相关原题的全班正确率偏低，建议重点讲评并核实。`,
    classroomAction: '对照原题梳理核心概念和适用条件，请学生解释条件变化对结论的影响。',
    followUp: '结合本批对应练习开展短时检索，再用独立检查题观察能否说明依据。',
    limitations: [...e.limitations], validationStatus: 'passed', generatedBy: 'template' }));
}

export function teachingReportInput(evidence:EvidenceSummary){
  return {reportKind:'whole_exam_class_report',classOverview:evidence.classOverview,questions:evidence.questions,
    knowledgeMap:evidence.rows.map(e=>({knowledgePointId:e.knowledgePointId,knowledgePoint:e.knowledgePoint,questionNumbers:e.questionNumbers})),
    evidence:priorityEvidence(evidence),mapping:{mappedQuestions:evidence.mappedQuestions,totalQuestions:evidence.totalQuestions,
      mappedFullScore:evidence.mappedFullScore,totalFullScore:evidence.totalFullScore,unmappedNumbers:evidence.unmappedNumbers}};
}
function limitations(evidence:EvidenceSummary):string[]{
  return ['基于本场原始成绩、逐题正确率及机器知识映射；不把补练生成结果当作新的学生作答。',
    '成绩分组仅为本次得分率区间描述，不直接等同于学生能力或确定的知识缺陷。',
    '没有后测数据，不能判断教学改善。',...(evidence.unmappedNumbers.length?['存在未映射原题，知识点诊断仅代表已映射范围。']:[])];
}
export function validateClassTeachingReport(value:unknown,evidence:EvidenceSummary):ClassTeachingReport{
  const v=object(value);
  if(Object.keys(v).some(k=>!['overview','advice','groupActions','followUp'].includes(k)))return invalid();
  const seen=new Set<string>(),bands=evidence.classOverview.scoreBands.filter(b=>b.studentCount>0);
  const groupActions=list(v.groupActions,4,bands.length===0).map(raw=>{
    const a=object(raw),bandId=text(a.bandId,40);
    if(Object.keys(a).some(k=>!['bandId','action'].includes(k))||!bands.some(b=>b.bandId===bandId)||seen.has(bandId))return invalid();
    seen.add(bandId);return {bandId,action:narrative(a.action)};
  });
  if(bands.some(b=>!seen.has(b.bandId)))return invalid();
  return {overview:narrative(v.overview),priorities:validateAdvice({advice:v.advice},evidence),groupActions,followUp:narrative(v.followUp),
    generatedBy:'model',mappingStatus:evidence.unmappedNumbers.length?'partial':'complete',limitations:limitations(evidence)};
}
export function templateClassTeachingReport(evidence:EvidenceSummary):ClassTeachingReport{
  return {overview:!evidence.mappedQuestions?'全班成绩分布与逐题正确率已汇总，但知识点映射证据不足，暂不形成完整知识诊断。'
    :priorityEvidence(evidence).length?'结合全班总分分布与各题正确率，优先讲评相关题表现偏弱的知识目标，并针对不同得分区间安排巩固。'
    :'全班成绩分布与逐题正确率已汇总，当前规则下未发现优先讲评的低正确率已映射知识目标，可结合分布安排分层巩固。',
    priorities:templateAdvice(evidence),groupActions:evidence.classOverview.scoreBands.filter(b=>b.studentCount>0).map(b=>({bandId:b.bandId,
      action:b.minRate<0.6?'先核查基础概念与审题条件，配合有步骤提示的短练习，再检查能否独立解释。':b.minRate<0.85?'围绕低正确率题的易混条件开展对比例题和限时巩固，检查关键步骤是否完整。':'安排迁移与条件变化任务，要求解释推理依据，并对局部失分知识点作针对性检查。'})),
    followUp:'在统一讲评后安排独立短测，按相同知识目标重新汇总正确率与分组表现，再决定后续教学安排。',
    generatedBy:'template',mappingStatus:evidence.unmappedNumbers.length?'partial':'complete',limitations:limitations(evidence)};
}
export function partitionValidationAttempts(run:WorkflowRun){
  const passed=new Set(run.items.filter(i=>i.status==='passed').map(i=>i.factId));
  const resolved=(v:WorkflowRun['validationAttempts'][number])=>v.stage==='verifyFact'?run.facts.some(f=>f.factId===v.factId&&factPassed(f)):passed.has(v.factId);
  return {unresolved:run.validationAttempts.filter(v=>!resolved(v)),resolved:run.validationAttempts.filter(resolved)};
}
