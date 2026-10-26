import type { Workspace } from '../../core/src/index.ts';
import type { AgentBatch, Annotation, Variant, SubjectConfig } from './index.ts';

// No runtime dependency on core: persistence validation is also used by core.
export function practiceKey(w: Workspace): string {
  const e=w.exam,s=w.settings;
  return JSON.stringify({exam:[e.id,e.name,e.subjectId,e.subjectName,e.classId,e.className],source:[w.source.kind,w.source.finishedAt],
    settings:[s.variantsPerQuestion,s.maxQuestionsPerStudent,s.includePartialCredit,s.partialCreditThreshold,s.difficulty],
    paper:(w.paper?.questions??[]).map(q=>[q.number,q.pageId,q.stem,q.confirmed]),students:w.students.map(student=>[student.id,student.availability,
      student.questions.filter(q=>q.result==='incorrect'||(q.result==='partial_credit'&&s.includePartialCredit&&q.score/q.fullScore*100<s.partialCreditThreshold)).map(q=>q.number)])});
}
export function validateBatch(value: unknown,w: Workspace): AgentBatch {
  const bad=():never=>{throw new Error('invalid_practice');};
  const obj=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:bad();
  const txt=(v:unknown,max=20000):string=>typeof v==='string'&&v.trim()&&[...v].length<=max?v:bad();
  const arr=(v:unknown,max:number):unknown[]=>Array.isArray(v)&&v.length<=max?v:bad();
  const integer=(v:unknown,max:number,min=0):number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=max?v:bad();
  const bool=(v:unknown):boolean=>typeof v==='boolean'?v:bad();
  const strarr=(v:unknown,max:number):string[]=>{const a=arr(v,max).map(v=>txt(v,300));return a.length?a:bad();};
  const kinds=['choice','text','diagram','shared_material','listening','writing','practical'];
  const nums=new Set(w.students.find(s=>s.availability==='scored')!.questions.map(q=>q.number));
  const numbers=(v:unknown):string[]=>{const a=strarr(v,1000);if(a.some(n=>!nums.has(n))||new Set(a).size!==a.length)bad();return a;};
  const annotation=(value:unknown):Annotation=>{
    const a=obj(value);if(!kinds.includes(String(a.kind)))return bad();
    const group=a.materialGroup===null?null:txt(a.materialGroup,100);
    if(a.kind==='shared_material'&&!group)return bad();
    return {kind:a.kind as Annotation['kind'],materialGroup:group,keywords:strarr(a.keywords,5),knowledgePoints:strarr(a.knowledgePoints,10)};
  };
  const batch=obj(value);
  if(batch.schemaVersion!==1||!['mock','real'].includes(String(batch.mode))||batch.inputKey!==practiceKey(w))return bad();
  if(new TextEncoder().encode(JSON.stringify(value)).length>6*1024*1024)return bad();
  const rawSubject=obj(batch.subject);
  if(rawSubject.subject!==(w.exam.subjectName.trim()||'通用学科')||!['math','physics','chemistry','biology','geography','chinese','english','history','politics','general'].includes(String(rawSubject.id))
    ||rawSubject.formula!=='latex'||rawSubject.diagram!=='text_only'||rawSubject.sharedMaterial!=='whole_group'
    ||JSON.stringify(rawSubject.unsupported)!==JSON.stringify(['listening','writing','practical']))return bad();
  const subject:SubjectConfig={id:String(rawSubject.id),subject:String(rawSubject.subject),formula:'latex',diagram:'text_only',sharedMaterial:'whole_group',
    commonDiagrams:bool(rawSubject.commonDiagrams),commonMaterials:bool(rawSubject.commonMaterials),unsupported:['listening','writing','practical']};
  const annotations=arr(batch.annotations,1000).map(value=>{const a=obj(value);const number=txt(a.number,40);if(!nums.has(number))bad();return {number,annotation:annotation(a.annotation)};});
  if(new Set(annotations.map(a=>a.number)).size!==annotations.length)return bad();
  const variants=arr(batch.variants,10000).map((value):Variant=>{
    const v=obj(value),c=obj(v.check);
    const evidence=arr(v.evidence,6).map(value=>{const e=obj(value);const documentId=txt(e.documentId,64);if(!/^[a-f0-9]{64}$/.test(documentId))bad();
      return {documentId,name:txt(e.name,300),page:integer(e.page,1000,1),ordinal:integer(e.ordinal,100000,1),text:txt(e.text,2000)};});
    if(!evidence.length)return bad();
    const sourceNumbers=numbers(v.sourceNumbers);
    if(sourceNumbers.some(n=>!w.paper?.questions.some(q=>q.number===n&&q.confirmed)))return bad();
    const sourceIndexes=arr(v.sourceIndexes,6).map(v=>integer(v,evidence.length-1));
    if(!sourceIndexes.length||new Set(sourceIndexes).size!==sourceIndexes.length)return bad();
    const check={answer:txt(c.answer,10000),complete:bool(c.complete),inScope:bool(c.inScope),tooSimilar:bool(c.tooSimilar),explanation:txt(c.explanation)};
    const passed=bool(v.passed),answer=txt(v.answer,10000),stem=txt(v.stem);
    const equivalent=(a:string,b:string)=>a.normalize('NFKC').replace(/\s/g,'').toUpperCase()===b.normalize('NFKC').replace(/\s/g,'').toUpperCase();
    if(passed&&(!equivalent(answer,check.answer)||!check.complete||!check.inScope||check.tooSimilar||w.paper?.questions.some(q=>sourceNumbers.includes(q.number)&&equivalent(q.stem,stem))))return bad();
    if(!['pending','approved','rejected'].includes(String(v.review))||(v.review==='approved'&&!passed))return bad();
    return {id:txt(v.id,200),stem,options:arr(v.options,10).map(v=>txt(v,3000)),answer,explanation:txt(v.explanation),knowledgePoints:strarr(v.knowledgePoints,10),sourceIndexes,
      sourceNumbers,evidence,check,passed,attempts:integer(v.attempts,2,1),review:v.review as Variant['review']};
  });
  if(new Set(variants.map(v=>v.id)).size!==variants.length)return bad();
  const skipped=arr(batch.skipped,1000).map(value=>{const s=obj(value);return {numbers:numbers(s.numbers),reason:txt(s.reason,300)};});
  const calls=obj(batch.calls);
  return {schemaVersion:1,mode:batch.mode as AgentBatch['mode'],inputKey:practiceKey(w),subject,annotations,variants,skipped,
    calls:{annotate:integer(calls.annotate,50000),generate:integer(calls.generate,50000),solve:integer(calls.solve,50000)}};
}
