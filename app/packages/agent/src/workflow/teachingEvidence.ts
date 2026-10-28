import type { FrozenInput, KnowledgeEvidence } from './types.ts';

export interface QuestionAggregate {
  questionIds:string[];earnedScore:number;possibleScore:number;participantCount:number;lossCount:number;
  scoreRate:number|null;lossRate:number|null;
}
// Only original scores are evidence. Zero scores participate; unavailable pupils do not.
export function aggregateQuestions(input:FrozenInput,questionIds:string[]):QuestionAggregate {
  const known=new Set(input.students.filter(s=>s.availability==='scored').flatMap(s=>s.questions.map(q=>q.number)));
  const ids=[...new Set(questionIds)];
  if(ids.some(id=>!known.has(id)))throw new Error('workflow_unknown_source');
  let earnedScore=0,possibleScore=0;const participants=new Set<string>(),losses=new Set<string>();
  for(const student of input.students){
    if(student.availability!=='scored')continue;
    for(const q of student.questions){
      if(!ids.includes(q.number)||q.fullScore<=0||q.result==='not_scored')continue;
      earnedScore+=q.score;possibleScore+=q.fullScore;participants.add(student.id);
      if(q.score<q.fullScore)losses.add(student.id);
    }
  }
  return {questionIds:ids,earnedScore,possibleScore,participantCount:participants.size,lossCount:losses.size,
    scoreRate:possibleScore>0?earnedScore/possibleScore:null,lossRate:participants.size?losses.size/participants.size:null};
}
export interface KnowledgeMapping {knowledgePointId:string;questionIds:string[];status:'reliable'|'uncertain'}
export function buildTeachingEvidence(input:FrozenInput,mappings:KnowledgeMapping[]){
  const all=[...new Set(input.students.filter(s=>s.availability==='scored').flatMap(s=>s.questions.map(q=>q.number)))];
  const grouped=new Map<string,Set<string>>();
  for(const mapping of mappings){
    if(!mapping.knowledgePointId.trim()||!mapping.questionIds.length||!['reliable','uncertain'].includes(mapping.status)||mapping.questionIds.some(id=>!all.includes(id)))throw new Error('workflow_invalid_mapping');
    if(mapping.status!=='reliable')continue;
    const group=grouped.get(mapping.knowledgePointId)??new Set<string>();
    mapping.questionIds.forEach(id=>group.add(id));grouped.set(mapping.knowledgePointId,group);
  }
  const evidence:KnowledgeEvidence[]=[...grouped].map(([knowledgePointId,ids],i)=>{
    const totals=aggregateQuestions(input,[...ids]);
    return {evidenceId:`evidence-${i+1}`,knowledgePointId,questionIds:totals.questionIds,earnedScore:totals.earnedScore,
      possibleScore:totals.possibleScore,participantCount:totals.participantCount,lossCount:totals.lossCount,mappingStatus:'machine',
      limitations:['知识点映射为机器推断。','只有整题得分，不能断言具体知识点或小问的个人错因。',
        ...(ids.size<2||totals.participantCount<5?['证据有限。']:[])]};
  });
  const mapped=[...new Set(evidence.flatMap(e=>e.questionIds))];
  const scored=input.students.find(s=>s.availability==='scored')?.questions??[];
  const full=(ids:string[])=>scored.filter(q=>ids.includes(q.number)&&q.fullScore>0&&q.result!=='not_scored').reduce((sum,q)=>sum+q.fullScore,0);
  return {evidence,mappedQuestionCount:mapped.length,totalQuestionCount:all.length,
    mappedPossibleScore:full(mapped),totalPossibleScore:full(all),unmappedQuestionIds:all.filter(id=>!mapped.includes(id))};
}
