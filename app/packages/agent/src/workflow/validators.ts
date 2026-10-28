import type { ClozeItem, EvidenceRef, ExerciseItem, FactCandidate, FrozenInput, KnowledgeFact, SourceUnit,ValidationReason } from './types.ts';
import { typstContent } from '../../../pdf/src/math.ts';
import {acceptedTermAliases} from './answerAliases.ts';

export class WorkflowValidationError extends Error{
  reason:ValidationReason;
  constructor(reason:ValidationReason){super('workflow_invalid_output');this.reason=reason;}
}
export const invalid = (reason:ValidationReason='invalid_structure'): never => { throw new WorkflowValidationError(reason); };
export const validationReason=(error:unknown):ValidationReason=>error instanceof WorkflowValidationError?error.reason:'invalid_structure';
export const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string,unknown> : invalid();
export function text(v: unknown, max = 8000, allowEmpty = false): string {
  const value=sourceText(v,max,allowEmpty);
  try { typstContent(value); } catch { return invalid('unsupported_formula'); }
  return value;
}
// Original material is data for analysis, not yet generated PDF content.
// Renderability is checked on generated content, not on raw OCR transcription.
export function sourceText(v:unknown,max=20000,allowEmpty=false):string{
  if (typeof v !== 'string' || v.length > max || (!allowEmpty && !v.trim()) || /(?:https?:\/\/|data:|javascript:|<\s*(?:script|iframe|img)\b)/i.test(v)) return invalid();
  return v;
}
export function list(v: unknown, max: number, allowEmpty = false): unknown[] {
  if (!Array.isArray(v) || v.length > max || (!allowEmpty && !v.length)) return invalid();
  return v;
}
export const strings = (v: unknown, max = 20, allowEmpty = false): string[] => list(v,max,allowEmpty).map(x => text(x,2000));
export const normalize = (v: string): string => v.normalize('NFKC').replace(/\s/g,'').toLocaleLowerCase('en-US');
export const specificClozeAnswer=(answer:string)=>!['形成','发生','产生','进行','可以','能够','影响','控制','决定','呈现','具有','表现','说明'].includes(normalize(answer));
export function validateUnits(value: unknown, input: FrozenInput): SourceUnit[] {
  const numbers = new Set(input.workspace.students.flatMap(s => s.questions.map(q => q.number)));
  const pageIds = new Set(input.workspace.paper?.pages.map(p => p.id));
  const ids = new Set<string>(), seen = new Set<string>();
  return list(value,80,true).map(v => {
    const u = object(v), unitId = text(u.unitId,100), sourceNumbers = strings(u.sourceNumbers,80), pages = strings(u.pageIds,30);
    if (ids.has(unitId) || sourceNumbers.some(n => !numbers.has(n) || seen.has(n)) || new Set(sourceNumbers).size !== sourceNumbers.length
      || pages.some(p => !pageIds.has(p)) || !['usable','isolated'].includes(String(u.availability))
      || !['recognized_by_machine','ambiguous'].includes(String(u.alignmentStatus))
      || (u.availability === 'usable' && u.alignmentStatus !== 'recognized_by_machine')) return invalid();
    ids.add(unitId); sourceNumbers.forEach(n => seen.add(n));
    return { unitId, sourceNumbers, pageIds: pages, stem: sourceText(u.stem), material: sourceText(u.material,16000,true),
      options: list(u.options,10,true).map(o=>sourceText(o,3000)), availability: u.availability as SourceUnit['availability'], alignmentStatus: u.alignmentStatus as SourceUnit['alignmentStatus'] };
  });
}
export function validateEvidence(value: unknown): EvidenceRef[] {
  return list(value,6,true).map(v => {
    const e = object(v);
    if (!Number.isSafeInteger(e.page) || Number(e.page) < 1) return invalid();
    return { documentId: text(e.documentId,100), page: Number(e.page), text: text(e.text,8000) };
  });
}
export function validateFacts(value: unknown): FactCandidate[] {
  return list(object(value).facts,3,true).map(v => {
    const f = object(v), completeStatement = text(f.completeStatement), candidateAnswers = strings(f.candidateAnswers,4);
    if (candidateAnswers.some(a => !completeStatement.includes(a) || normalize(a) === normalize(completeStatement))) return invalid();
    const conditions=strings(f.conditions,10,true),providedContext=f.context===undefined?'':text(f.context,6000,true);
    // Conditions are immutable supporting text, not optional instructions that
    // disappear when only the cloze sentence is sent to the blind solver.
    const missing=conditions.filter(c=>!normalize(completeStatement+providedContext).includes(normalize(c)));
    const context=providedContext+(missing.length?`${providedContext?'\n':''}适用条件：${missing.join('；')}。`:'');
    return { knowledgePoint: text(f.knowledgePoint,300), completeStatement, conditions, candidateAnswers,...(context?{context}:{}) };
  });
}
export function validateFactCheck(value: unknown): KnowledgeFact['factCheck'] {
  const v = object(value);
  if ([v.accurate,v.supported,v.inScope].some(x => typeof x !== 'boolean')) return invalid();
  return { accurate: v.accurate as boolean, supported: v.supported as boolean, inScope: v.inScope as boolean };
}
export function factPassed(fact: KnowledgeFact): boolean {
  return fact.factCheck.accurate && fact.factCheck.supported && fact.factCheck.inScope;
}
export function validateCloze(value: unknown, fact: KnowledgeFact, itemId: string, attempts: number): ClozeItem {
  const v = object(value), blanks = new Set<string>();
  const parts = list(v.parts,20).map(raw => {
    const p = object(raw);
    if (p.type === 'text') return { type: 'text' as const, text: text(p.text,8000,true) };
    if (p.type !== 'blank') return invalid();
    const blankId = text(p.blankId,100), answer = text(p.answer,300), providedAnswers = strings(p.acceptedAnswers,10);
    // The exact restoration word is always a valid answer. A model may list
    // only its equivalent wording; keep it without discarding the authored gap.
    const acceptedAnswers=[...new Set([answer,...providedAnswers].flatMap(acceptedTermAliases))];
    if(blanks.has(blankId))return invalid('duplicate_blank_id');
    if(!specificClozeAnswer(answer))return invalid('non_specific_blank');
    if(!fact.candidateAnswers.includes(answer)&&(!fact.completeStatement.includes(answer)||[...answer.trim()].length<2
      ||normalize(answer)===normalize(fact.completeStatement)||/^[\p{P}\p{Z}]+$/u.test(answer)))return invalid('answer_not_candidate');
    if(fact.conditions.some(c=>c.includes(answer)))return invalid('condition_removed');
    blanks.add(blankId);
    return { type: 'blank' as const, blankId, answer, acceptedAnswers };
  });
  const restored = parts.map(p => p.type === 'text' ? p.text : p.answer).join('');
  const context=fact.context??'';
  const visible = context+parts.filter(p => p.type === 'text').map(p => p.text).join('');
  if(restored!==fact.completeStatement)return invalid('statement_not_restored');
  if(parts.some((p,index)=>{if(p.type!=='blank')return false;const next=parts[index+1];
    const before=parts.slice(0,index).map(part=>part.type==='text'?part.text:part.answer).join('');
    return (next?.type==='text'&&/^等(?:物质|产物|实例|例子|成分|因素|对象|性状|现象|结构|过程|生物)/.test(next.text))
      ||/(?:^|[，；。])(?:例如|比如|如)[^，；。]*$/.test(before);
  }))return invalid('non_specific_blank');
  if(blanks.size<1||blanks.size>2)return invalid('invalid_blank_count');
  if(normalize(visible).length<3)return invalid('insufficient_context');
  if(parts.some(p=>p.type==='blank'&&p.acceptedAnswers.some(a=>normalize(visible).includes(normalize(a)))))return invalid('answer_visible');
  return { itemId, mode: 'dictation', factId: fact.factId, sourceNumbers: [...fact.sourceNumbers], parts,
    ...(context?{context}:{}),
    correction: text(v.correction,2000,true), attempts, checks: { structure: true, independent: false, scope: factPassed(fact) }, status: 'failed' };
}
export function blindFillPassed(value: unknown, item: ClozeItem): boolean {
  return blindFillFailure(value,item)===null;
}
export function blindFillFailure(value:unknown,item:ClozeItem):ValidationReason|null{
  const v = object(value);
  if (typeof v.ambiguous !== 'boolean' || typeof v.missingConditions !== 'boolean') return invalid();
  const answers = list(v.answers,2).map(a => { const p = object(a); return { blankId: text(p.blankId,100), value: text(p.value,2000) }; });
  const blanks = item.parts.filter(p => p.type === 'blank');
  if(v.ambiguous)return 'blind_fill_ambiguous';
  if(v.missingConditions)return 'blind_fill_missing_conditions';
  if(answers.length!==blanks.length||new Set(answers.map(a=>a.blankId)).size!==answers.length||!blanks.every(b=>answers.some(a=>a.blankId===b.blankId)))return 'blind_fill_mapping';
  return blanks.every(b=>answers.some(a=>a.blankId===b.blankId&&b.acceptedAnswers.some(ok=>normalize(ok)===normalize(a.value))))?null:'blind_fill_answer_mismatch';
}
export function validateExercise(value: unknown, fact: KnowledgeFact, units: SourceUnit[], itemId: string, attempts: number): ExerciseItem {
  const v = object(value), kind = v.type;
  if (!['single_choice','multiple_choice','short_answer','calculation'].includes(String(kind))) return invalid('unsupported_exercise_type');
  const stem = text(v.stem), material = text(v.material,16000,true), answer = strings(v.answer,10), rubric = strings(v.rubric,10);
  const options = list(v.options,10,true).map(o => { const p = object(o); return { id: text(p.id,10), text: text(p.text,2000) }; });
  const choice = kind === 'single_choice' || kind === 'multiple_choice';
  if (new Set(options.map(o => o.id)).size !== options.length || new Set(options.map(o => normalize(o.text))).size !== options.length
    || new Set(answer.map(normalize)).size !== answer.length || (choice && (options.length < 2 || answer.some(a => !options.some(o => o.id === a))))
    || (kind === 'single_choice' && answer.length !== 1) || (!choice && options.length > 0)) return invalid('invalid_options');
  if(/如图|见图|下图/.test(stem+material))return invalid('missing_diagram');
  if(units.some(u=>normalize(u.stem)===normalize(stem)))return invalid('original_copied');
  if(!Number.isFinite(v.estimatedMinutes)||Number(v.estimatedMinutes)<=0||Number(v.estimatedMinutes)>60)return invalid('invalid_duration');
  let numericAnswer: ExerciseItem['numericAnswer'];
  if (kind === 'calculation') {
    const n = object(v.numericAnswer);
    if (typeof n.value !== 'number' || !Number.isFinite(n.value)) return invalid('invalid_numeric_answer');
    numericAnswer = { value: n.value, unit: text(n.unit,100,true) };
    // Numeric and displayed answers must agree; no model-chosen tolerance.
    if (answer.length !== 1 || normalize(answer[0]) !== normalize(`${n.value}${numericAnswer.unit}`)) return invalid('invalid_numeric_answer');
  }
  return { itemId, mode: 'exercise', factId: fact.factId, sourceNumbers: [...fact.sourceNumbers], type: kind as ExerciseItem['type'],
    stem, material, answer, rubric, options, explanation: text(v.explanation), estimatedMinutes: Number(v.estimatedMinutes),
    ...(numericAnswer ? { numericAnswer } : {}), attempts, checks: { structure: true, independent: false, scope: factPassed(fact) }, status: 'failed' };
}
export function exerciseSolvePassed(value: unknown, item: ExerciseItem): boolean {
  return exerciseSolveFailure(value,item)===null;
}
export function exerciseSolveFailure(value:unknown,item:ExerciseItem):ValidationReason|null{
  const v = object(value);
  if ([v.complete,v.inScope,v.tooSimilar].some(b => typeof b !== 'boolean')) return invalid();
  if(!v.complete)return 'solve_incomplete';if(!v.inScope)return 'solve_out_of_scope';if(v.tooSimilar)return 'solve_too_similar';
  if (item.type === 'calculation') {
    const n = object(v.numericAnswer), expected = item.numericAnswer!;
    return typeof n.value === 'number' && Number.isFinite(n.value) && normalize(text(n.unit,100,true)) === normalize(expected.unit)
      && Math.abs(n.value - expected.value) <= 1e-9 * Math.max(1,Math.abs(expected.value))?null:'solve_numeric_mismatch';
  }
  if (item.type === 'short_answer') {
    // Conservative explicit scoring-point match; no semantic equivalence claim.
    const keyPoints = strings(v.keyPoints,10).map(normalize);
    return item.rubric.every(point => keyPoints.includes(normalize(point))) && v.contradiction === false?null:'solve_scoring_mismatch';
  }
  const answer = strings(v.answer,10).map(normalize).sort(), expected = item.answer.map(normalize).sort();
  return answer.length === expected.length && answer.every((a,i) => a === expected[i])?null:'solve_answer_mismatch';
}
