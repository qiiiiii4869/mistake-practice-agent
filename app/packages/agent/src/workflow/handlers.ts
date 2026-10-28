import {assertAnonymous} from '../index.ts';
import {assertCheckpointSafe,type Json} from './checkpoint.ts';
import type {HandlerContext,StageHandler} from './runner.ts';
import type {Stage} from './machine.ts';
import type {KnowledgeFact,ClozeItem,ExerciseItem} from './types.ts';
import {selectTargets,assignContent,type KnowledgeTarget,type FrozenSelection,type VerifiedPoolItem} from './assignment.ts';
import {buildTeachingEvidence,type KnowledgeMapping} from './teachingEvidence.ts';
import {buildTeachingReport} from './teachingAdvice.ts';
import {parseCloze,checkBlindFill,blindFillRequest,parseExercise,checkExercise,independentSolveRequest,type AnswerComparison} from './validators.ts';

// These are trusted application adapters, not model-selected functions. There are
// no default adapters that invent recognized questions, verified facts, PDFs or payment.
export interface WorkflowAdapters {
  preflight?:StageHandler;authorizing?:StageHandler;rendering?:StageHandler;recognizing?:StageHandler;aligning?:StageHandler;
  extracting?:StageHandler;retrieving?:StageHandler;verifyingFacts?:StageHandler;exporting?:StageHandler;validatingPdf?:StageHandler;settling?:StageHandler;
  model?:(stage:'cloze'|'blind_fill'|'exercise'|'solve',data:Json,signal:AbortSignal)=>Promise<{value:Json;usage:number|null}>;
  comparison?:(item:ExerciseItem,independent:Json)=>AnswerComparison|undefined;
}
function fail(code='workflow_stage_data_invalid'):never{throw new Error(code);}
const obj=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:fail();
const text=(v:unknown,max=20000):string=>typeof v==='string'&&v.trim()&&v.length<=max?v:fail();
const array=(v:unknown,max=1000):unknown[]=>Array.isArray(v)&&v.length<=max?v:fail();
const strings=(v:unknown,max=80)=>array(v,max).map(x=>text(x,300));
function json(value:unknown):Json {assertCheckpointSafe(value);return structuredClone(value) as Json;}
function output(ctx:HandlerContext,stage:Stage){const result=ctx.outputs[stage];if(!result)fail('workflow_stage_dependency_missing');return obj(result.value);}
function facts(ctx:HandlerContext,stage:Stage):KnowledgeFact[]{
  const seen=new Set<string>();
  const known=new Set(ctx.input.students.filter(s=>s.availability==='scored').flatMap(s=>s.questions.map(q=>q.number)));
  const value=array(output(ctx,stage).facts,240).map(raw=>{
    const v=obj(raw),factId=text(v.factId,100),sourceNumbers=strings(v.sourceNumbers);
    if(seen.has(factId)||!sourceNumbers.length||new Set(sourceNumbers).size!==sourceNumbers.length||sourceNumbers.some(n=>!known.has(n)))fail();seen.add(factId);
    if(!['library','paper'].includes(String(v.sourceMode))||!['pending','verified','isolated'].includes(String(v.factCheck)))fail();
    const evidenceRefs=strings(v.evidenceRefs,100);
    if(v.sourceMode==='library'&&(ctx.input.knowledgeRevision===0||!evidenceRefs.length))fail('workflow_evidence_missing');
    return {factId,sourceNumbers,knowledgePoint:text(v.knowledgePoint,300),completeStatement:text(v.completeStatement),conditions:strings(v.conditions,30),
      evidenceRefs,sourceMode:v.sourceMode as KnowledgeFact['sourceMode'],factCheck:v.factCheck as KnowledgeFact['factCheck']};
  });
  assertAnonymous(value,ctx.input.students.map(s=>s.name));return value;
}
const selected=(ctx:HandlerContext)=>{
  const v=output(ctx,'selectingTargets');
  const targets=v.targets as unknown as KnowledgeTarget[],selection=v.selection as unknown as FrozenSelection[];
  if(!Array.isArray(targets)||!Array.isArray(selection))fail();
  if(JSON.stringify(selection)!==JSON.stringify(selectTargets(ctx.input,targets)))fail('workflow_stale_selection');
  return {targets,selection,ids:new Set(selection.flatMap(s=>s.targetIds))};
};
function clozes(ctx:HandlerContext,stage:Stage):ClozeItem[]{
  const known=new Map(facts(ctx,'merging').map(f=>[f.factId,f]));
  return array(output(ctx,stage).items,240).map(raw=>{
    const v=obj(raw),fact=known.get(text(v.factId,100));if(!fact)fail();
    return parseCloze({itemId:v.itemId,factId:v.factId,sourceNumbers:v.sourceNumbers,parts:v.parts,correction:v.correction},fact,ctx.input.students.map(s=>s.name));
  });
}
const mappings=(ctx:HandlerContext):KnowledgeMapping[]=>facts(ctx,'merging').filter(f=>f.factCheck==='verified').map(f=>({knowledgePointId:f.factId,questionIds:f.sourceNumbers,status:'reliable'}));
async function digest(value:unknown){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)));return [...new Uint8Array(bytes)].map(n=>n.toString(16).padStart(2,'0')).join('');}

export function createWorkflowHandlers(adapters:WorkflowAdapters,maxCallTokens:number):Partial<Record<Stage,StageHandler>>{
  if(!Number.isSafeInteger(maxCallTokens)||maxCallTokens<1)fail('workflow_invalid_budget');
  const names=(ctx:HandlerContext)=>ctx.input.students.map(s=>s.name);
  const invoke=async(ctx:HandlerContext,stage:Parameters<NonNullable<WorkflowAdapters['model']>>[0],data:unknown)=>{
    if(!adapters.model)fail('workflow_service_missing');
    assertAnonymous(data,names(ctx));const safe=json(data);
    const requestHash=await digest({contentHash:ctx.input.contentHash,mode:ctx.input.mode,stage,promptVersion:ctx.input.promptVersion,data:safe});
    const value=await ctx.callModel(`${stage}:${requestHash.slice(0,48)}`,requestHash,maxCallTokens,()=>adapters.model!(stage,safe,ctx.signal));
    assertAnonymous(value,names(ctx));return value;
  };
  const boundary=(stage:keyof Omit<WorkflowAdapters,'model'|'comparison'>):StageHandler=>async ctx=>{
    if(stage==='retrieving'&&ctx.input.knowledgeRevision===0)return {value:{matches:[]}};
    const handler=adapters[stage];if(!handler)fail('workflow_service_missing');
    if(stage==='preflight'){
      if(!ctx.input.paperFiles.length)fail('workflow_paper_required');
      if(!ctx.input.rawWeakQuestions.some(s=>s.availability==='scored'&&s.numbers.length))fail('workflow_no_loss_targets');
    }
    const result=await handler(ctx);assertCheckpointSafe(result);
    if(stage==='preflight'&&obj(result.value).ready!==true)fail('workflow_preflight_failed');
    // Fact verification must be a separate stage; extraction cannot self-approve.
    if(stage==='extracting'){
      const raw=obj(result.value);const next=array(raw.facts,240).map(f=>({...obj(f),factCheck:'pending',sourceMode:'paper',evidenceRefs:[]}));
      const units=array(output(ctx,'aligning').units,80).map(obj);
      const recognized=new Set(units.filter(u=>u.availability==='recognized_by_machine'&&obj(u.recognitionChecks).alignmentStatus==='aligned').flatMap(u=>strings(u.sourceNumbers)));
      if(next.some(f=>strings(obj(f).sourceNumbers).some(n=>!recognized.has(n))))fail('workflow_unaligned_fact');
      const candidate={...ctx,outputs:{...ctx.outputs,extracting:{value:json({facts:next})}}};facts(candidate,'extracting');
      return {value:json({facts:next})};
    }
    if(stage==='retrieving'){
      const known=new Set(facts(ctx,'extracting').map(f=>f.factId)),seen=new Set<string>();
      const matches=array(obj(result.value).matches,240).map(raw=>{
        const v=obj(raw),factId=text(v.factId,100);if(!known.has(factId)||seen.has(factId))fail();seen.add(factId);
        const refs=array(v.refs,6).map(rawRef=>{const r=obj(rawRef),documentId=text(r.documentId,64);
          if(!/^[a-f0-9]{64}$/.test(documentId)||!Number.isSafeInteger(r.page)||Number(r.page)<1||!Number.isSafeInteger(r.ordinal)||Number(r.ordinal)<1)fail();
          return {id:`${documentId}:${r.page}:${r.ordinal}`,documentId,page:Number(r.page),ordinal:Number(r.ordinal),text:text(r.text,2000)};
        });assertAnonymous(refs,names(ctx));return {factId,refs};
      });return {value:json({matches})};
    }
    if(stage==='verifyingFacts'){
      const extracted=facts(ctx,'extracting'),decisions=array(obj(result.value).decisions,240),ids=new Set<string>();
      const checked=extracted.map(f=>{
        const matches=decisions.filter(d=>obj(d).factId===f.factId);if(matches.length!==1)fail();
        const d=obj(matches[0]);if(ids.has(f.factId)||[d.accurate,d.inScope,d.conditionsComplete].some(x=>typeof x!=='boolean'))fail();ids.add(f.factId);
        const referenced=strings(d.supportedEvidenceRefs,6),sourceMatches=array(output(ctx,'retrieving').matches,240).map(obj);
        const available=sourceMatches.filter(m=>m.factId===f.factId).flatMap(m=>array(m.refs,6).map(r=>text(obj(r).id,100)));
        if(referenced.some(id=>!available.includes(id)))fail('workflow_evidence_missing');
        return {...f,sourceMode:referenced.length?'library' as const:'paper' as const,evidenceRefs:referenced,factCheck:d.accurate&&d.inScope&&d.conditionsComplete?'verified' as const:'isolated' as const};
      });
      if(decisions.length!==checked.length)fail();return {value:json({facts:checked})};
    }
    if(stage==='validatingPdf'){
      const assignments=array(output(ctx,'assembling').assignments,100).map(obj);
      if(assignments.length!==ctx.input.students.length)fail('workflow_assignment_incomplete');
      if(!result.pdf)fail('workflow_pdf_unverified');
      return {...result,pdf:{...result.pdf,coveragePassed:result.pdf.coveragePassed&&assignments.every(a=>a.status!=='partial')}};
    }
    return result;
  };
  const handlers:Partial<Record<Stage,StageHandler>>={};
  for(const stage of ['preflight','authorizing','rendering','recognizing','aligning','extracting','retrieving','verifyingFacts','exporting','validatingPdf','settling'] as const)handlers[stage]=boundary(stage);
  handlers.merging=async ctx=>{
    // Exact statements and conditions only; a shared name is not semantic identity.
    const merged=new Map<string,KnowledgeFact>();
    for(const f of facts(ctx,'verifyingFacts')){
      if(f.factCheck!=='verified')continue;
      const key=JSON.stringify([f.completeStatement,f.conditions]);const old=merged.get(key);
      if(old){old.sourceNumbers=[...new Set([...old.sourceNumbers,...f.sourceNumbers])];old.evidenceRefs=[...new Set([...old.evidenceRefs,...f.evidenceRefs])];if(f.sourceMode==='library')old.sourceMode='library';}
      else merged.set(key,structuredClone(f));
    }return {value:json({facts:[...merged.values()]})};
  };
  handlers.selectingTargets=async ctx=>{
    const targets:KnowledgeTarget[]=facts(ctx,'merging').map(f=>({targetId:f.factId,sourceNumbers:f.sourceNumbers,priority:0,cost:1}));
    return {value:json({targets,selection:selectTargets(ctx.input,targets)})};
  };
  handlers.clozing=async ctx=>{
    if(ctx.input.mode!=='dictation')fail('workflow_mode_mismatch');
    const {ids}=selected(ctx),items:ClozeItem[]=[],isolated:string[]=[];
    for(const fact of facts(ctx,'merging').filter(f=>ids.has(f.factId))){
      const raw=await invoke(ctx,'cloze',{fact,maximumBlanks:1});
      try{const item=parseCloze(raw,fact,names(ctx));if(items.some(i=>i.itemId===item.itemId)||item.parts.filter(p=>p.type==='blank').length!==1)fail('workflow_invalid_content');items.push(item);}
      catch(e){if(!(e instanceof Error)||!/^workflow_(invalid_content|cloze_reconstruction|answer_leak)$/.test(e.message))throw e;isolated.push(fact.factId);}
    }return {value:json({items,isolated})};
  };
  handlers.validatingCloze=async ctx=>{
    const items:ClozeItem[]=[];
    for(const item of clozes(ctx,'clozing')){
      const raw=await invoke(ctx,'blind_fill',blindFillRequest(item));
      try{items.push(checkBlindFill(item,raw,names(ctx)));}catch(e){if(!(e instanceof Error)||e.message!=='workflow_invalid_content')throw e;items.push({...item,status:'isolated'});}
    }return {value:json({items})};
  };
  handlers.generatingExercises=async ctx=>{
    if(ctx.input.mode!=='exercise')fail('workflow_mode_mismatch');const {ids}=selected(ctx),items:ExerciseItem[]=[],isolated:string[]=[];
    for(const fact of facts(ctx,'merging').filter(f=>ids.has(f.factId))){
      const raw=await invoke(ctx,'exercise',{fact,subject:ctx.input.examIdentity.subjectName,difficulty:ctx.input.contentSettings.difficulty,maximumQuestions:1,textOnly:true});
      try{const item=parseExercise(raw,[fact],[],names(ctx));if(items.some(i=>i.itemId===item.itemId)||item.questionCount!==1)fail('workflow_invalid_content');items.push(item);}
      catch(e){if(!(e instanceof Error)||!/^workflow_(invalid_content|missing_material)$/.test(e.message))throw e;isolated.push(fact.factId);}
    }return {value:json({items,isolated})};
  };
  handlers.solving=async ctx=>{
    const items=array(output(ctx,'generatingExercises').items,240),solutions:{itemId:string;response:Json}[]=[];
    for(const raw of items){const v=obj(raw);const item=parseExercise({itemId:v.itemId,type:v.type,targetIds:v.targetIds,sourceNumbers:v.sourceNumbers,stem:v.stem,options:v.options,materialRefs:v.materialRefs,answer:v.answer,rubric:v.rubric,explanation:v.explanation,estimatedMinutes:v.estimatedMinutes,questionCount:v.questionCount},facts(ctx,'merging'),[],names(ctx));
      solutions.push({itemId:item.itemId,response:await invoke(ctx,'solve',independentSolveRequest(item,[]))});}
    return {value:json({solutions})};
  };
  handlers.validatingExercise=async ctx=>{
    const rawItems=array(output(ctx,'generatingExercises').items,240),solutions=array(output(ctx,'solving').solutions,240),items:ExerciseItem[]=[];
    // Original stems must come from the alignment adapter; absent data cannot pass originality checks.
    const originals=array(output(ctx,'aligning').units,80).map(u=>text(obj(u).stem));
    for(const raw of rawItems){const v=obj(raw),item=parseExercise({itemId:v.itemId,type:v.type,targetIds:v.targetIds,sourceNumbers:v.sourceNumbers,stem:v.stem,options:v.options,materialRefs:v.materialRefs,answer:v.answer,rubric:v.rubric,explanation:v.explanation,estimatedMinutes:v.estimatedMinutes,questionCount:v.questionCount},facts(ctx,'merging'),[],names(ctx));
      const found=solutions.filter(s=>obj(s).itemId===item.itemId);if(found.length!==1)fail();const response=json(obj(found[0]).response);
      try{items.push(checkExercise(item,response,originals,names(ctx),adapters.comparison?.(item,response)));}
      catch(e){if(!(e instanceof Error)||e.message!=='workflow_invalid_content')throw e;items.push({...item,status:'isolated'});}
    }return {value:json({items})};
  };
  handlers.assembling=async ctx=>{
    const {targets,selection}=selected(ctx);const values=array(output(ctx,ctx.input.mode==='dictation'?'validatingCloze':'validatingExercise').items,240);
    const items:VerifiedPoolItem[]=values.map(raw=>{
      const v=obj(raw),checks=obj(v.checks);return {itemId:text(v.itemId,100),targetIds:ctx.input.mode==='dictation'?[text(v.factId,100)]:strings(v.targetIds),sourceNumbers:strings(v.sourceNumbers),
        cost:ctx.input.mode==='dictation'?array(v.parts,20).filter(p=>obj(p).type==='blank').length:Number(v.questionCount),
        dedupeKey:ctx.input.mode==='dictation'?JSON.stringify(v.parts):JSON.stringify([v.type,v.stem]),verified:v.status==='verified'&&Object.values(checks).length>0&&Object.values(checks).every(x=>x===true)};
    });return {value:json({assignments:assignContent(ctx.input,targets,selection,{mode:ctx.input.mode,contentHash:ctx.input.contentHash,items})})};
  };
  handlers.aggregatingEvidence=async ctx=>({value:json(buildTeachingEvidence(ctx.input,mappings(ctx)))});
  handlers.writingGuidance=async ctx=>({value:json(buildTeachingReport(ctx.input,mappings(ctx)))});
  handlers.validatingGuidance=async ctx=>{
    const expected=buildTeachingReport(ctx.input,mappings(ctx));
    if(JSON.stringify(output(ctx,'writingGuidance'))!==JSON.stringify(expected))fail('workflow_guidance_evidence_mismatch');
    return {value:json(expected)};
  };
  return handlers;
}
