import type { FrozenInput, StudentAssignment, WorkflowMode } from './types.ts';

export interface KnowledgeTarget {targetId:string;sourceNumbers:string[];priority:number;cost:number}
export interface FrozenSelection {localStudentId:string;targetIds:string[];excludedTargetIds:string[];rawWeakNumbers:string[];availability:string}
export interface VerifiedPoolItem {itemId:string;targetIds:string[];sourceNumbers:string[];cost:number;dedupeKey:string;verified:boolean}
export interface ContentPool {mode:WorkflowMode;contentHash:string;items:VerifiedPoolItem[]}
const fail=():never=>{throw new Error('workflow_invalid_assignment');};
function validateTargets(input:FrozenInput,targets:KnowledgeTarget[]){
  const seen=new Set<string>(),known=new Set(input.students.filter(s=>s.availability==='scored').flatMap(s=>s.questions.map(q=>q.number)));
  for(const t of targets){
    if(!t.targetId||seen.has(t.targetId)||!Number.isFinite(t.priority)||!Number.isSafeInteger(t.cost)||t.cost<1||!t.sourceNumbers.length
      ||new Set(t.sourceNumbers).size!==t.sourceNumbers.length||t.sourceNumbers.some(n=>!known.has(n)))fail();
    seen.add(t.targetId);
  }
}
// Freeze targets BEFORE failed candidates are removed. A failed target stays in coverage's denominator.
export function selectTargets(input:FrozenInput,targets:KnowledgeTarget[]):FrozenSelection[]{
  validateTargets(input,targets);
  const limit=input.mode==='dictation'?input.contentSettings.maxBlanks:input.contentSettings.maxExercises;
  return input.rawWeakQuestions.map(weak=>{
    const student=input.students.find(s=>s.id===weak.localStudentId)!;
    const candidates=targets.filter(t=>t.sourceNumbers.some(n=>weak.numbers.includes(n))).map(t=>{
      const questions=student.questions.filter(q=>weak.numbers.includes(q.number)&&t.sourceNumbers.includes(q.number));
      const severity=Math.max(...questions.map(q=>q.result==='incorrect'?2:1));
      const lost=Math.max(...questions.map(q=>q.fullScore>0?(q.fullScore-q.score)/q.fullScore:0));
      return {target:t,severity,lost};
    }).sort((a,b)=>b.severity-a.severity||b.lost-a.lost||b.target.priority-a.target.priority||a.target.targetId.localeCompare(b.target.targetId));
    let count=0;const targetIds:string[]=[],excludedTargetIds:string[]=[];
    for(const {target} of candidates){if(count+target.cost>limit){excludedTargetIds.push(target.targetId);continue;}targetIds.push(target.targetId);count+=target.cost;}
    return {localStudentId:student.id,targetIds,excludedTargetIds,rawWeakNumbers:[...weak.numbers],availability:student.availability};
  });
}
export function assignContent(input:FrozenInput,targets:KnowledgeTarget[],selection:FrozenSelection[],pool:ContentPool):StudentAssignment[]{
  validateTargets(input,targets);
  if(pool.mode!==input.mode||pool.contentHash!==input.contentHash)throw new Error('workflow_stale_pool');
  // Reject a changed target set or hand-edited selection instead of silently improving coverage.
  if(JSON.stringify(selection)!==JSON.stringify(selectTargets(input,targets)))throw new Error('workflow_stale_selection');
  const targetMap=new Map(targets.map(t=>[t.targetId,t]));const ids=new Set<string>();
  for(const item of pool.items){
    if(!item.itemId||ids.has(item.itemId)||!item.dedupeKey||!Number.isSafeInteger(item.cost)||item.cost<1||typeof item.verified!=='boolean'
      ||!item.targetIds.length||new Set(item.targetIds).size!==item.targetIds.length||!item.sourceNumbers.length
      ||item.targetIds.some(id=>!targetMap.has(id)||targetMap.get(id)!.sourceNumbers.some(n=>!item.sourceNumbers.includes(n)))
      ||item.sourceNumbers.some(n=>!item.targetIds.some(id=>targetMap.get(id)!.sourceNumbers.includes(n))))fail();
    ids.add(item.itemId);
  }
  const limit=input.mode==='dictation'?input.contentSettings.maxBlanks:input.contentSettings.maxExercises;
  return selection.map(s=>{
    const selected=new Set(s.targetIds),covered=new Set<string>(),dedupe=new Set<string>(),sourceCovered=new Set<string>(),itemIds:string[]=[];
    let count=0;
    if(s.availability==='scored')for(const item of pool.items){
      if(!item.verified||dedupe.has(item.dedupeKey)||count+item.cost>limit||!item.targetIds.some(id=>selected.has(id)&&!covered.has(id))
        ||item.targetIds.some(id=>!selected.has(id)))continue;
      itemIds.push(item.itemId);count+=item.cost;dedupe.add(item.dedupeKey);
      item.targetIds.forEach(id=>covered.add(id));item.sourceNumbers.filter(n=>s.rawWeakNumbers.includes(n)).forEach(n=>sourceCovered.add(n));
    }
    const uncoveredTargets=s.targetIds.filter(id=>!covered.has(id));const uncoveredSourceNumbers=s.rawWeakNumbers.filter(n=>!sourceCovered.has(n));
    const ratio=s.targetIds.length?covered.size/s.targetIds.length:0;
    const status=s.availability!=='scored'?'unavailable':!s.rawWeakNumbers.length?'no_targets':itemIds.length&&ratio>=input.contentSettings.minCoverage?'complete':'partial';
    return {localStudentId:s.localStudentId,selectedTargets:[...s.targetIds],itemIds,uncoveredTargets,uncoveredSourceNumbers,status};
  });
}
