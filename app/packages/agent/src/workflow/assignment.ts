import { analyze } from '../../../core/src/index.ts';
import type { ContentItem, FrozenInput, KnowledgeFact, StudentAssignment, StudentTargets } from './types.ts';
import { factPassed, normalize } from './validators.ts';

export function mergeFacts(facts: KnowledgeFact[]): KnowledgeFact[] {
  const merged = new Map<string,KnowledgeFact>();
  for (const fact of facts.filter(factPassed)) {
    const key = JSON.stringify([normalize(fact.completeStatement),normalize(fact.context??''),fact.conditions.map(normalize).sort()]);
    const prior = merged.get(key);
    if (!prior) { merged.set(key,structuredClone(fact)); continue; }
    prior.sourceNumbers = [...new Set([...prior.sourceNumbers,...fact.sourceNumbers])];
    prior.unitIds = [...new Set([...prior.unitIds,...fact.unitIds])];
    prior.evidenceRefs = [...prior.evidenceRefs,...fact.evidenceRefs].filter((e,i,a) => a.findIndex(x => x.documentId === e.documentId && x.page === e.page && x.text === e.text) === i);
    if (prior.evidenceRefs.length) prior.sourceMode = 'library';
  }
  return [...merged.values()];
}
export function selectTargets(input: FrozenInput, facts: KnowledgeFact[]): StudentTargets[] {
  const analysis = analyze(input.workspace);
  return analysis.students.map(student => {
    const original = input.workspace.students.find(s => s.id === student.id)!;
    const weak = student.weakQuestions.filter(n=>!input.testScope||input.testScope.questionNumbers.includes(n)).sort((a,b) => {
      const loss = (n: string) => { const q = original.questions.find(q => q.number === n)!; return q.fullScore > 0 ? 1 - q.score / q.fullScore : 0; };
      return loss(b) - loss(a) || a.localeCompare(b,'en',{ numeric: true });
    });
    const ordered = [...new Set(weak.flatMap(n => facts.filter(f => f.sourceNumbers.includes(n)).map(f => f.factId)))];
    return { localStudentId: student.id, rawWeakNumbers: weak, selectedTargets: ordered.slice(0,input.settings.maxItems), excludedTargets: ordered.slice(input.settings.maxItems),
      ...(input.testScope?{outOfScopeNumbers:student.weakQuestions.filter(n=>!input.testScope!.questionNumbers.includes(n))}:{}) };
  });
}
export function assignStudents(input: FrozenInput, targets: StudentTargets[], items: ContentItem[], facts: KnowledgeFact[]): StudentAssignment[] {
  return targets.map(target => {
    const student = input.workspace.students.find(s => s.id === target.localStudentId)!;
    const chosen: ContentItem[] = [];
    let used = 0;
    for (const factId of target.selectedTargets) {
      const item = items.find(i => i.mode === input.mode && i.factId === factId && i.status === 'passed');
      if (!item) continue;
      const cost = item.mode === 'dictation' ? item.parts.filter(p => p.type === 'blank').length : 1;
      if (used + cost > input.settings.maxItems) continue;
      used += cost; chosen.push(item);
    }
    const uncoveredTargets = target.selectedTargets.filter(id => !chosen.some(i => i.factId === id));
    // Missing recognition/facts remain visible even though no target ID could be made.
    const uncoveredNumbers = target.rawWeakNumbers.filter(n => !facts.some(f => f.sourceNumbers.includes(n))
      || target.selectedTargets.some(id => facts.find(f => f.factId === id)?.sourceNumbers.includes(n) && uncoveredTargets.includes(id)));
    const coverage = target.selectedTargets.length ? (target.selectedTargets.length - uncoveredTargets.length) / target.selectedTargets.length : 0;
    const status: StudentAssignment['status'] = student.availability !== 'scored' ? 'unavailable' : !target.rawWeakNumbers.length ? 'no_targets'
      : chosen.length > 0 && coverage >= input.settings.coverageThreshold && !uncoveredNumbers.some(n => !facts.some(f => f.sourceNumbers.includes(n))) ? 'ready' : 'partial';
    return { ...structuredClone(target), itemIds: chosen.map(i => i.itemId), uncoveredTargets, uncoveredNumbers, coverage, status };
  });
}
