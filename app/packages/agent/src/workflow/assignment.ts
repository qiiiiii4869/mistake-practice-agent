import { analyze } from '../../../core/src/index.ts';
import type { ContentItem, FrozenInput, KnowledgeFact, StudentAssignment, StudentTargets } from './types.ts';
import { normalize } from './validators.ts';
import {usableFact,usableItem} from './minimumChecks.ts';

export function mergeFacts(facts: KnowledgeFact[],minimum=false): KnowledgeFact[] {
  const merged = new Map<string,KnowledgeFact>();
  for (const fact of facts.filter(f=>usableFact(f,minimum))) {
    const key = JSON.stringify([normalize(fact.completeStatement),normalize(fact.context??''),fact.conditions.map(normalize).sort()]);
    const prior = merged.get(key);
    if (!prior) { merged.set(key,structuredClone(fact)); continue; }
    prior.sourceNumbers = [...new Set([...prior.sourceNumbers,...fact.sourceNumbers])];
    prior.unitIds = [...new Set([...prior.unitIds,...fact.unitIds])];
    prior.evidenceRefs = [...prior.evidenceRefs,...fact.evidenceRefs].filter((e,i,a) => a.findIndex(x => x.documentId === e.documentId && x.page === e.page && x.text === e.text) === i);
    if(minimum)prior.evidenceRefs=prior.evidenceRefs.slice(0,6);
    if (prior.evidenceRefs.length) prior.sourceMode = 'library';
  }
  return [...merged.values()];
}
export function selectTargets(input: FrozenInput, facts: KnowledgeFact[]): StudentTargets[] {
  const analysis = analyze(input.workspace);
  const personal=input.assignmentVersion==='personal-coverage-v1';
  const performance=new Map<string,{lossStudents:number;eligibleStudents:number}>();
  // Count actual lost points, including partial credit even when the teacher
  // excludes partial-credit questions from recommendations. Missing papers
  // and unscored records must never be counted as correct classmates.
  if(personal)for(const student of input.workspace.students.filter(s=>s.availability==='scored'))for(const q of student.questions){
    if(q.fullScore<=0)continue;const p=performance.get(q.number)??{lossStudents:0,eligibleStudents:0};
    p.eligibleStudents++;if(q.score<q.fullScore)p.lossStudents++;performance.set(q.number,p);
  }
  return analysis.students.map(student => {
    const original = input.workspace.students.find(s => s.id === student.id)!;
    const weak = student.weakQuestions.filter(n=>!input.testScope||input.testScope.questionNumbers.includes(n)).sort((a,b) => {
      const loss = (n: string) => { const q = original.questions.find(q => q.number === n)!; return q.fullScore > 0 ? 1 - q.score / q.fullScore : 0; };
      return (personal?(performance.get(a)?.lossStudents??Infinity)-(performance.get(b)?.lossStudents??Infinity):0)
        || loss(b) - loss(a) || a.localeCompare(b,'en',{ numeric: true });
    });
    let ordered = [...new Set(weak.flatMap(n => facts.filter(f => f.sourceNumbers.includes(n)).map(f => f.factId)))];
    if(personal){
      const first:string[]=[],used=new Set<string>(),covered=new Set<string>();
      const add=(fact:KnowledgeFact)=>{used.add(fact.factId);first.push(fact.factId);for(const n of fact.sourceNumbers)covered.add(n);};
      // Cover a different wrong original before supplementing an already
      // covered one. A shared fact may cover several originals at once.
      for(const n of weak){if(covered.has(n))continue;const fact=facts.find(f=>f.sourceNumbers.includes(n)&&!used.has(f.factId));if(fact)add(fact);}
      // Supplement one fact per original per round, preserving personal order.
      let added=true;while(added){added=false;for(const n of weak){const fact=facts.find(f=>f.sourceNumbers.includes(n)&&!used.has(f.factId));if(fact){add(fact);added=true;}}}
      ordered=first;
    }
    return { localStudentId: student.id, rawWeakNumbers: weak, selectedTargets: ordered.slice(0,input.settings.maxItems), excludedTargets: ordered.slice(input.settings.maxItems),
      ...(personal?{questionPriorities:weak.map(number=>{const q=original.questions.find(q=>q.number===number)!,p=performance.get(number)!;return {number,...p,lossRate:1-q.score/q.fullScore};})}:{}),
      ...(input.testScope?{outOfScopeNumbers:student.weakQuestions.filter(n=>!input.testScope!.questionNumbers.includes(n))}:{}) };
  });
}
export function assignStudents(input: FrozenInput, targets: StudentTargets[], items: ContentItem[], facts: KnowledgeFact[]): StudentAssignment[] {
  return targets.map(target => {
    const student = input.workspace.students.find(s => s.id === target.localStudentId)!;
    const chosen: ContentItem[] = [];
    let used = 0;
    const personal=input.assignmentVersion==='personal-coverage-v1';
    const candidates=target.selectedTargets.flatMap(factId=>{
      const item = items.find(i => i.mode === input.mode && i.factId === factId && usableItem(i,input.validationLevel==='minimum'));
      return item?[item]:[];
    });
    const costOf=(item:ContentItem)=>item.mode==='dictation'?item.parts.filter(p=>p.type==='blank').length:1;
    const add=(item:ContentItem)=>{const cost=costOf(item);if(chosen.includes(item)||used+cost>input.settings.maxItems)return false;used+=cost;chosen.push(item);return true;};
    if(personal)for(const number of target.rawWeakNumbers){
      const covers=(item:ContentItem)=>facts.find(f=>f.factId===item.factId)?.sourceNumbers.includes(number);
      if(chosen.some(covers))continue;
      // With real blank counts now known, prefer the cheaper available item
      // for this original so multi-blank items do not crowd out other originals.
      const item=candidates.filter(i=>covers(i)&&!chosen.includes(i)).sort((a,b)=>costOf(a)-costOf(b)).find(i=>used+costOf(i)<=input.settings.maxItems);
      if(item)add(item);
    }
    for (const item of candidates) {
      if(personal){add(item);continue;}
      // Legacy frozen tasks retain their exact historical assignment order.
      const cost = item.mode === 'dictation' ? item.parts.filter(p => p.type === 'blank').length : 1;
      if (used + cost > input.settings.maxItems) continue;
      used += cost; chosen.push(item);
    }
    const uncoveredTargets = target.selectedTargets.filter(id => !chosen.some(i => i.factId === id));
    // Missing recognition/facts remain visible even though no target ID could be made.
    const uncoveredNumbers = personal?target.rawWeakNumbers.filter(n=>!chosen.some(i=>facts.find(f=>f.factId===i.factId)?.sourceNumbers.includes(n))):target.rawWeakNumbers.filter(n => !facts.some(f => f.sourceNumbers.includes(n))
      || target.selectedTargets.some(id => facts.find(f => f.factId === id)?.sourceNumbers.includes(n) && uncoveredTargets.includes(id)));
    const coverage = target.selectedTargets.length ? (target.selectedTargets.length - uncoveredTargets.length) / target.selectedTargets.length : 0;
    const status: StudentAssignment['status'] = student.availability !== 'scored' ? 'unavailable' : !target.rawWeakNumbers.length ? 'no_targets'
      : input.validationLevel==='minimum' ? 'ready'
      : chosen.length > 0 && coverage >= input.settings.coverageThreshold && !uncoveredNumbers.some(n => !facts.some(f => f.sourceNumbers.includes(n))) ? 'ready' : 'partial';
    return { ...structuredClone(target), itemIds: chosen.map(i => i.itemId), uncoveredTargets, uncoveredNumbers, coverage, status };
  });
}
