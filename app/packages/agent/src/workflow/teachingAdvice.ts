import type { FrozenInput, TeachingAdvice } from './types.ts';
import {aggregateQuestions,buildTeachingEvidence,type KnowledgeMapping} from './teachingEvidence.ts';

// Deterministic fallback. Statistical fields are program-owned, never model prose.
export function buildTeachingReport(input:FrozenInput,mappings:KnowledgeMapping[],maxAdvice=5){
  if(!Number.isSafeInteger(maxAdvice)||maxAdvice<1||maxAdvice>5)throw new Error('workflow_invalid_advice_limit');
  const mapped=buildTeachingEvidence(input,mappings);
  const numbers=[...new Set(input.students.filter(s=>s.availability==='scored').flatMap(s=>s.questions.map(q=>q.number)))];
  const questions=numbers.map(number=>aggregateQuestions(input,[number]));
  const advice:TeachingAdvice[]=mapped.evidence.filter(e=>e.possibleScore>0&&e.lossCount>0)
    .sort((a,b)=>a.earnedScore/a.possibleScore-b.earnedScore/b.possibleScore||b.lossCount-a.lossCount||a.evidenceId.localeCompare(b.evidenceId))
    .slice(0,maxAdvice).map((e,i)=>({adviceId:`advice-${i+1}`,evidenceIds:[e.evidenceId],priority:i+1,
      focus:'复核该知识点相关原题的适用条件、材料信息和解答步骤。',
      classroomAction:'对照原题梳理条件，让学生说明判断依据；先核实困难所在，再安排讲评。',
      followUp:'用同一目标的短时检查收集新作答，再判断是否改善；本报告未采集后续作答。',
      limitations:[...e.limitations],validationStatus:'fallback'}));
  return {schemaVersion:2 as const,contentHash:input.contentHash,mode:input.mode,generationMethod:'deterministic' as const,
    scoredStudents:input.students.filter(s=>s.availability==='scored').length,
    unavailableStudents:input.students.filter(s=>s.availability!=='scored').length,
    studentsWithLossTargets:input.rawWeakQuestions.filter(s=>s.availability==='scored'&&s.numbers.length>0).length,
    questionEvidence:questions,...mapped,advice,
    notices:[...(mapped.evidence.length?[]:['知识点证据不足，当前仅提供原题成绩概况，不作知识点掌握诊断。']),
      '统计来自本场原始考试，不代表新补练后的效果。','没有学生作答选项，不推断错选项或个人错误原因。']};
}
