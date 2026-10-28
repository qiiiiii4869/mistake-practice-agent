import { assertAnonymous } from '../index.ts';
import type { ClozeItem, ClozePart, KnowledgeFact, ExerciseItem } from './types.ts';

const fail=():never=>{throw new Error('workflow_invalid_content');};
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:fail();
const text=(v:unknown,max=20000):string=>typeof v==='string'&&v.trim()&&v.length<=max?v:fail();
const normalize=(v:string)=>v.normalize('NFKC').trim();
const keys=(v:Record<string,unknown>,fields:string[])=>{if(Object.keys(v).length!==fields.length||fields.some(k=>!Object.hasOwn(v,k)))fail();};
const list=(v:unknown,max:number):unknown[]=>Array.isArray(v)&&v.length<=max?v:fail();

// Accept model content only; never accept model-provided passed/checks/review flags.
export function parseCloze(value:unknown,fact:KnowledgeFact,names:string[]):ClozeItem{
  if(fact.factCheck!=='verified')throw new Error('workflow_unverified_fact');
  const v=object(value);keys(v,['itemId','factId','sourceNumbers','parts','correction']);assertAnonymous(v,names);
  if(v.factId!==fact.factId)fail();
  const sourceNumbers=list(v.sourceNumbers,80).map(n=>text(n,100));
  if(new Set(sourceNumbers).size!==sourceNumbers.length||JSON.stringify([...sourceNumbers].sort())!==JSON.stringify([...fact.sourceNumbers].sort()))fail();
  const blanks=new Set<string>();
  const parts:ClozePart[]=list(v.parts,20).map(raw=>{
    const p=object(raw);
    if(p.type==='text'){keys(p,['type','text']);return {type:'text',text:text(p.text)};}
    keys(p,['type','blankId','answer','acceptedAnswers']);if(p.type!=='blank')return fail();
    const blankId=text(p.blankId,100),answer=text(p.answer,1000);
    if(blanks.has(blankId)||['的','是','了','和','与','在'].includes(answer))fail();blanks.add(blankId);
    const acceptedAnswers=list(p.acceptedAnswers,10).map(a=>text(a,1000));
    if(!acceptedAnswers.some(a=>normalize(a)===normalize(answer)))fail();
    return {type:'blank',blankId,answer,acceptedAnswers};
  });
  if(blanks.size<1||blanks.size>2||!parts.some(p=>p.type==='text'))fail();
  if(parts.map(p=>p.type==='text'?p.text:p.answer).join('')!==fact.completeStatement)throw new Error('workflow_cloze_reconstruction');
  const visible=normalize(parts.filter(p=>p.type==='text').map(p=>p.text).join(''));
  if(parts.some(p=>p.type==='blank'&&p.acceptedAnswers.some(a=>visible.includes(normalize(a)))))throw new Error('workflow_answer_leak');
  return {itemId:text(v.itemId,100),factId:fact.factId,sourceNumbers,parts,correction:typeof v.correction==='string'&&v.correction.length<=10000?v.correction:fail(),
    checks:{structure:true,reconstruction:true,blindFill:false},status:'pending',attempts:1};
}
export function blindFillRequest(item:ClozeItem){
  return {itemId:item.itemId,parts:item.parts.map(p=>p.type==='text'?{type:p.type,text:p.text}:{type:p.type,blankId:p.blankId})};
}
export function checkBlindFill(item:ClozeItem,response:unknown,names:string[]):ClozeItem{
  const v=object(response);keys(v,['answers','ambiguous','missingConditions']);assertAnonymous(v,names);
  if(typeof v.ambiguous!=='boolean'||typeof v.missingConditions!=='boolean')fail();
  const blanks=item.parts.filter((p):p is Extract<ClozePart,{type:'blank'}>=>p.type==='blank');
  const answers=list(v.answers,2).map(raw=>{const a=object(raw);keys(a,['blankId','text']);return {blankId:text(a.blankId,100),text:text(a.text,1000)};});
  if(answers.length!==blanks.length||new Set(answers.map(a=>a.blankId)).size!==answers.length||answers.some(a=>!blanks.some(b=>b.blankId===a.blankId)))fail();
  const passed=!v.ambiguous&&!v.missingConditions&&blanks.every(b=>b.acceptedAnswers.some(a=>normalize(a)===normalize(answers.find(x=>x.blankId===b.blankId)!.text)));
  return {...item,checks:{...item.checks,blindFill:passed},status:passed&&item.checks.structure&&item.checks.reconstruction?'verified':'isolated'};
}

const choices=(answer:string,optionCount:number):string[]=>{
  const compact=answer.normalize('NFKC').toUpperCase().replace(/[\s,，、]/g,'');
  const result=[...compact];
  if(!result.length||new Set(result).size!==result.length||result.some(c=>c<'A'||c>String.fromCharCode(64+optionCount)))fail();
  return result.sort();
};
export function parseExercise(value:unknown,facts:KnowledgeFact[],availableMaterials:string[],names:string[]):ExerciseItem{
  const v=object(value);keys(v,['itemId','type','targetIds','sourceNumbers','stem','options','materialRefs','answer','rubric','explanation','estimatedMinutes','questionCount']);
  assertAnonymous(v,names);
  if(!['single_choice','multiple_choice','short_answer','calculation'].includes(String(v.type)))fail();
  const strings=(raw:unknown,max:number,len=100)=>list(raw,max).map(x=>text(x,len));
  const targetIds=strings(v.targetIds,20),sourceNumbers=strings(v.sourceNumbers,80),materialRefs=strings(v.materialRefs,10);
  if(!targetIds.length||!sourceNumbers.length||new Set(targetIds).size!==targetIds.length||new Set(sourceNumbers).size!==sourceNumbers.length
    ||targetIds.some(id=>!facts.some(f=>f.factId===id&&f.factCheck==='verified'))||new Set(materialRefs).size!==materialRefs.length||materialRefs.some(id=>!availableMaterials.includes(id)))fail();
  const expected=[...new Set(facts.filter(f=>targetIds.includes(f.factId)).flatMap(f=>f.sourceNumbers))].sort();
  if(JSON.stringify([...sourceNumbers].sort())!==JSON.stringify(expected))fail();
  const stem=text(v.stem),answer=text(v.answer,10000),options=strings(v.options,10,3000),rubric=strings(v.rubric,20,3000);
  if((/如图|下图|上图|图中|见图/.test([stem,...options].join(' '))&&!materialRefs.length)||/https?:\/\//i.test(JSON.stringify(v)))throw new Error('workflow_missing_material');
  const type=v.type as ExerciseItem['type'];
  if(type==='single_choice'||type==='multiple_choice'){
    if(options.length<2||new Set(options.map(normalize)).size!==options.length)fail();
    const selected=choices(answer,options.length);
    if(type==='single_choice'?selected.length!==1:selected.length<2)fail();
  }else if(options.length||!rubric.length)fail();
  if(!Number.isFinite(v.estimatedMinutes)||Number(v.estimatedMinutes)<=0||Number(v.estimatedMinutes)>120
    ||!Number.isSafeInteger(v.questionCount)||Number(v.questionCount)<1||Number(v.questionCount)>10)fail();
  return {itemId:text(v.itemId,100),type,targetIds,sourceNumbers,stem,options,materialRefs,answer,rubric,
    explanation:text(v.explanation),estimatedMinutes:Number(v.estimatedMinutes),questionCount:Number(v.questionCount),solveResult:null,
    checks:{structure:true,scope:false,independentSolve:false,conditions:false,originality:false},status:'pending',attempts:1};
}
export function independentSolveRequest(item:ExerciseItem,materials:{id:string;text:string}[]){
  if(item.materialRefs.some(id=>!materials.some(m=>m.id===id)))throw new Error('workflow_missing_material');
  return {itemId:item.itemId,type:item.type,stem:item.stem,options:[...item.options],materials:materials.filter(m=>item.materialRefs.includes(m.id)).map(m=>({id:m.id,text:m.text}))};
}
export type AnswerComparison = {kind:'number';unit:string;absoluteTolerance:number;relativeTolerance:number}
  |{kind:'rubric';coveredIndexes:number[];contradictions:boolean};
const numberWithUnit=(s:string):{value:number;unit:string}|null=>{
  const match=s.normalize('NFKC').trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*([^\d\r\n]*)$/);
  if(!match||!Number.isFinite(Number(match[1])))return null;
  return {value:Number(match[1]),unit:match[2].trim()};
};
export function checkExercise(item:ExerciseItem,response:unknown,originalStems:string[],names:string[],comparison?:AnswerComparison):ExerciseItem{
  const v=object(response);keys(v,['answer','explanation','complete','inScope','tooSimilar']);assertAnonymous(v,names);
  if([v.complete,v.inScope,v.tooSimilar].some(x=>typeof x!=='boolean'))fail();
  const answer=text(v.answer,10000),explanation=text(v.explanation);let matches=false;
  if(item.type==='single_choice'||item.type==='multiple_choice'){
    const a=choices(item.answer,item.options.length),b=choices(answer,item.options.length);
    matches=JSON.stringify(a)===JSON.stringify(b);
  }else if(item.type==='calculation'&&comparison?.kind==='number'){
    if(!Number.isFinite(comparison.absoluteTolerance)||!Number.isFinite(comparison.relativeTolerance)||comparison.absoluteTolerance<0||comparison.relativeTolerance<0)fail();
    const a=numberWithUnit(item.answer),b=numberWithUnit(answer);
    matches=!!a&&!!b&&a.unit===comparison.unit&&b.unit===comparison.unit&&Math.abs(a.value-b.value)<=Math.max(comparison.absoluteTolerance,Math.abs(a.value)*comparison.relativeTolerance);
  }else if(item.type==='short_answer'&&comparison?.kind==='rubric'){
    // The separate comparison verdict is not sent in the independent solver request.
    const ids=comparison.coveredIndexes;
    if(!Array.isArray(ids)||typeof comparison.contradictions!=='boolean')fail();
    matches=!comparison.contradictions&&new Set(ids).size===ids.length&&ids.length===item.rubric.length&&ids.every(i=>Number.isSafeInteger(i)&&i>=0&&i<item.rubric.length);
  }
  const same=(s:string)=>s.normalize('NFKC').replace(/\s/g,'');
  const original=!v.tooSimilar&&!originalStems.some(s=>same(s)===same(item.stem));
  const passed=item.checks.structure&&matches&&v.complete&&v.inScope&&original;
  return {...item,solveResult:{answer,explanation},checks:{structure:item.checks.structure,scope:v.inScope as boolean,independentSolve:matches,conditions:v.complete as boolean,originality:original},status:passed?'verified':'isolated'};
}
