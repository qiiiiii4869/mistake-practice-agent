import type { ExerciseItem, FrozenInput, InvokeModel, KnowledgeFact, SourceUnit,ValidationAttempt } from '../types.ts';
import { exerciseSolveFailure, validateExercise,validationReason } from '../validators.ts';

export async function generateExercise(fact: KnowledgeFact, input: FrozenInput, units: SourceUnit[], invoke: InvokeModel,
  phases: { generating(): Promise<void>; solving(): Promise<void>; validating(): Promise<void> },report:(failure:ValidationAttempt)=>void=()=>{}): Promise<ExerciseItem | null> {
  const originals = units.filter(u => fact.unitIds.includes(u.unitId)).map(u => ({ stem: u.stem, material: u.material, options: u.options }));
  for (let attempt = 1; attempt <= 2; attempt++) {
    let stage:ValidationAttempt['stage']='exercise';
    try {
      await phases.generating();
      const value = await invoke('exercise',{ fact: { knowledgePoint: fact.knowledgePoint, statement: fact.completeStatement, context:fact.context??'',conditions: fact.conditions },
        originals, difficulty: input.settings.difficulty, attempt });
      const item = validateExercise(value,fact,units,`exercise-${fact.factId}`,attempt);
      await phases.solving();
      stage='solve';
      const result = await invoke('solve',{ question: { type: item.type, stem: item.stem, options: item.options, material: item.material },
        target: { knowledgePoint: fact.knowledgePoint, conditions: fact.conditions }, originals });
      await phases.validating();
      const failure=exerciseSolveFailure(result,item);
      item.checks.independent = failure===null;
      if(failure)report({factId:fact.factId,sourceNumbers:fact.sourceNumbers,stage,attempt,reason:failure});
      item.status = item.checks.independent && item.checks.scope ? 'passed' : 'failed';
      if (item.status === 'passed' || attempt === 2) return item;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'workflow_invalid_output') throw error;
      report({factId:fact.factId,sourceNumbers:fact.sourceNumbers,stage,attempt,reason:validationReason(error)});
    }
  }
  return null;
}
