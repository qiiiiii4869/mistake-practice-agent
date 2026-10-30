// TEMPORARY: user requested the lowest content checks in the original workflow.
// Only enough structure to save, assign and render is required. Skipped checks
// stay false and generated material is labelled draft, never verified.
import type {FactCandidate,KnowledgeFact,ClozeItem,ExerciseItem,ContentItem,ClassTeachingReport,EvidenceSummary} from './types.ts';
import {object,list,text,sourceText,invalid} from './validators.ts';
import {templateClassTeachingReport} from './teachingAdvice.ts';

export const usableFact=(fact:KnowledgeFact,minimum=false)=>minimum&&fact.reviewStatus==='unchecked'||fact.factCheck.accurate&&fact.factCheck.supported&&fact.factCheck.inScope;
export const usableItem=(item:ContentItem,minimum=false)=>item.status==='passed'||minimum&&item.status==='draft';
export function minimumFacts(value:unknown):FactCandidate[]{
 const values=list(object(value).facts,20,true),facts:FactCandidate[]=[];
 for(const raw of values){try{
  const v=object(raw),statement=text(v.completeStatement);
  const candidates=Array.isArray(v.candidateAnswers)?v.candidateAnswers.filter(a=>typeof a==='string'&&a.trim()).slice(0,4).map(a=>text(a,300)):[];
  // Candidate text no longer needs exact substring matching at extraction.
  facts.push({knowledgePoint:typeof v.knowledgePoint==='string'&&v.knowledgePoint.trim()?text(v.knowledgePoint,300):'相关知识',completeStatement:statement,
   candidateAnswers:candidates,conditions:Array.isArray(v.conditions)?v.conditions.filter(c=>typeof c==='string').slice(0,10).map(c=>text(c,2000)):[],
   ...(typeof v.context==='string'&&v.context?{context:text(v.context,6000)}:{})});
 }catch(error){if(!(error instanceof Error)||error.message!=='workflow_invalid_output')throw error;}}
 return facts.slice(0,3);
}
export function minimumCloze(value:unknown,fact:KnowledgeFact,itemId:string,attempts:number):ClozeItem{
 const v=object(value);let sequence=0;
 const parts=list(v.parts,20).map(raw=>{
  const p=object(raw);if(p.type==='text')return {type:'text' as const,text:text(p.text??'',8000,true)};
  if(p.type!=='blank')return invalid();const answer=text(p.answer,300),blankId=`b${++sequence}`;
  return {type:'blank' as const,blankId,answer,acceptedAnswers:[...new Set([answer,...(Array.isArray(p.acceptedAnswers)?p.acceptedAnswers.filter(a=>typeof a==='string').slice(0,9).map(a=>text(a,300)):[])])]};
 });
 if(sequence===0||sequence>8)return invalid('invalid_blank_count');
 return {itemId,mode:'dictation',factId:fact.factId,sourceNumbers:[...fact.sourceNumbers],parts,correction:typeof v.correction==='string'?text(v.correction,2000,true):'',
  ...(fact.context?{context:fact.context}:{}),attempts,authoring:'model',status:'draft',checks:{structure:true,independent:false,scope:false}};
}
export function minimumExercise(value:unknown,fact:KnowledgeFact,itemId:string,attempts:number):ExerciseItem{
 const v=object(value),type=['single_choice','multiple_choice','short_answer','calculation'].includes(String(v.type))?v.type as ExerciseItem['type']:'short_answer';
 const array=(a:unknown)=>Array.isArray(a)?a.filter(x=>typeof x==='string').slice(0,10).map(x=>text(x,3000)):[];
 return {itemId,mode:'exercise',factId:fact.factId,sourceNumbers:[...fact.sourceNumbers],type,stem:text(v.stem),material:typeof v.material==='string'?text(v.material,16000,true):'',
  options:Array.isArray(v.options)?v.options.slice(0,10).map((o,i)=>({id:String(object(o).id??String.fromCharCode(65+i)),text:text(object(o).text,2000)})):[],
  answer:array(v.answer),rubric:array(v.rubric),explanation:typeof v.explanation==='string'?text(v.explanation,10000,true):'',estimatedMinutes:typeof v.estimatedMinutes==='number'&&v.estimatedMinutes>0?v.estimatedMinutes:2,
  ...(v.numericAnswer&&typeof object(v.numericAnswer).value==='number'?{numericAnswer:{value:object(v.numericAnswer).value as number,unit:sourceText(object(v.numericAnswer).unit??'',100,true)}}:{}),
  attempts,status:'draft',checks:{structure:true,independent:false,scope:false}};
}
export function minimumReport(value:unknown,evidence:EvidenceSummary):ClassTeachingReport{
 const v=object(value),base=templateClassTeachingReport(evidence);
 const readable=(raw:unknown,fallback:string)=>typeof raw==='string'&&raw.trim()?text(raw,8000):fallback;
 const advice=Array.isArray(v.advice)?v.advice.map(object):[];
 return {...base,overview:readable(v.overview,base.overview),followUp:readable(v.followUp,base.followUp),generatedBy:'model',
  priorities:base.priorities.map(a=>{const found=advice.find(p=>Array.isArray(p.evidenceIds)&&a.evidenceIds.some(id=>(p.evidenceIds as unknown[]).includes(id)))??{};
   return {...a,focus:readable(found.focus,a.focus),classroomAction:readable(found.classroomAction,a.classroomAction),followUp:readable(found.followUp,a.followUp),validationStatus:'draft',generatedBy:found.focus?'model':'template'};}),
  groupActions:base.groupActions.map(a=>{const found=Array.isArray(v.groupActions)?v.groupActions.map(object).find(p=>p.bandId===a.bandId):undefined;return {...a,action:readable(found?.action,a.action)};}),
  limitations:[...base.limitations,'宽松草稿：未进行事实、独立作答或报告内容严格核验。']};
}
export function validateMinimumReport(value:ClassTeachingReport):void{
 text(value.overview,8000);text(value.followUp,8000);
 if(!Array.isArray(value.priorities)||!Array.isArray(value.groupActions)||!Array.isArray(value.limitations))return invalid();
 for(const advice of value.priorities){if(advice.validationStatus!=='draft')return invalid();text(advice.focus,8000);text(advice.classroomAction,8000);text(advice.followUp,8000);}
}
