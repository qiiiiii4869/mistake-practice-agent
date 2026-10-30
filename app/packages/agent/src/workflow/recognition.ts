import {analyze} from '../../../core/src/index.ts';
import {invalid,list,object,sourceText,text} from './validators.ts';
import type {FrozenInput,InvokeModel,RecognitionCheck,RecognitionReason,SourceUnit} from './types.ts';

interface Question{number:string;stem:string;confidence:'high'|'low';warnings:string[]}
interface Reading{questions:Question[];warnings:string[];valid:boolean;attempt:number}

export function transcriptionKey(value:string):string{
  // Normalize typography, never remove words, signs, units or numeric values.
  const key=value.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹₀-₉]/gu,c=>`${'⁰¹²³⁴⁵⁶⁷⁸⁹'.includes(c)?'^':'_'}(${c.normalize('NFKC')})`)
    .normalize('NFKC').replace(/\r\n?/g,'\n').replace(/(?<=\d)[ \t]+(?=\d)/g,'<digit-gap>').replace(/[“”]/g,'"').replace(/[‘’]/g,"'")
    .replace(/，/g,',').replace(/。/g,'.').replace(/；/g,';').replace(/：/g,':')
    .replace(/(^|[\s。；;])([A-H])[.、:)]\s*/g,'$1$2.').replace(/[_＿]{2,}/g,'__').replace(/\s/g,'');
  // Diagram placement has no meaning in this text-only workflow. Only a
  // two-ratio interval explicitly followed by “之间” normalizes its range mark;
  // scalar minus signs, values, inequality signs and diagram labels stay distinct.
  return key.replace(/如(?:上|下)?图所示/g,'如图所示')
    .replace(/(\d+(?:\.\d+)?:\d+(?:\.\d+)?)[~\-–—](\d+(?:\.\d+)?:\d+(?:\.\d+)?)(?=之间)/g,'$1~$2');
}
function parse(value:unknown,allNumbers:string[],attempt:number):Reading{
  const v=object(value),warnings=list(v.warnings,100,true).map(w=>sourceText(w,2000));
  const questions=list(v.questions,100,true).map(q=>{
    const x=object(q);if(!['high','low'].includes(String(x.confidence)))return invalid();
    // Body paragraphs exclude graphic captions and table regions. Legacy
    // responses may still use stem; never compare two contradictory versions.
    const stem=x.paragraphs===undefined?sourceText(x.stem):sourceText(list(x.paragraphs,80).map(v=>sourceText(v,8000)).join('\n'));
    if(x.paragraphs!==undefined&&x.stem!==undefined&&transcriptionKey(sourceText(x.stem))!==transcriptionKey(stem))return invalid();
    return {number:text(x.number,40),stem,confidence:x.confidence as 'high'|'low',
      warnings:x.warnings===undefined?[]:list(x.warnings,20,true).map(w=>sourceText(w,2000))};
  });
  if(questions.some(q=>!allNumbers.includes(q.number)))return invalid();
  return {questions,warnings,valid:true,attempt};
}
function warningsFor(reading:Reading,number:string):string[]{
  return [...reading.questions.filter(q=>q.number===number).flatMap(q=>q.warnings),...reading.warnings.filter(w=>{
    // Ignore only warnings explicitly scoped to other questions. Unscoped
    // warnings remain blocking; guessing their scope would weaken validation.
    const refs=[...w.matchAll(/第\s*([0-9]+(?:[.．][0-9]+)*)\s*题/g)].map(m=>m[1].replace(/．/g,'.'));
    return !refs.length||[...w.matchAll(/第/g)].length!==refs.length||refs.includes(number);
  })];
}
function matching(reading:Reading,number:string){return reading.questions.filter(q=>q.number===number);}
function trusted(reading:Reading,number:string,keepFirst:string[]):boolean{
  const found=matching(reading,number);
  return reading.valid&&found.length>0&&(found.length===1||keepFirst.includes(number))&&found[0].confidence==='high'&&!warningsFor(reading,number).length;
}
function reason(readings:Reading[],number:string,keepFirst:string[]):RecognitionReason{
  if(readings.every(r=>!r.valid))return 'invalid_structure';
  if(readings.every(r=>!matching(r,number).length))return 'missing';
  if(!keepFirst.includes(number)&&readings.some(r=>matching(r,number).length>1))return 'duplicate_number';
  if(readings.some(r=>warningsFor(r,number).length))return 'warning';
  if(readings.some(r=>matching(r,number)[0]?.confidence==='low'))return 'low_confidence';
  if(readings.some(r=>!r.valid))return 'invalid_structure';
  return 'content_mismatch';
}
export async function recognizeWorkflowUnits(input:FrozenInput,invoke:InvokeModel,keepFirst:string[]=[],report:(check:RecognitionCheck)=>void=()=>{}):Promise<SourceUnit[]>{
  const allNumbers=analyze(input.workspace).audit.questionNumbers,numbers=input.testScope?.questionNumbers??allNumbers,records=new Map<string,SourceUnit>();
  for(const [pageIndex,page]of(input.workspace.paper?.pages??[]).entries()){
    const read=async(attempt:number,focusNumbers?:string[]):Promise<Reading>=>{
      try{return parse(await invoke('recognize',{pageId:page.id,...(focusNumbers?{focusNumbers}:{} )}),allNumbers,attempt);}
      catch(error){if(!(error instanceof Error)||error.message!=='workflow_invalid_output')throw error;return {questions:[],warnings:[],valid:false,attempt};}
    };
    const first=await read(1),second=await read(2),reads=[first,second];
    const pair=(number:string):[Question,Question]|null=>{
      for(let a=0;a<reads.length;a++)for(let b=a+1;b<reads.length;b++){
        if(!trusted(reads[a],number,keepFirst)||!trusted(reads[b],number,keepFirst))continue;
        const x=matching(reads[a],number),y=matching(reads[b],number);
        if(x.length===y.length&&transcriptionKey(x[0].stem)===transcriptionKey(y[0].stem))return [x[0],y[0]];
      }return null;
    };
    // One extra request per page, targeted to unresolved question numbers,
    // preserving the existing 3P budget and independence of all transcriptions.
    const unresolved=numbers.filter(n=>!pair(n));
    if(unresolved.length)reads.push(await read(3,unresolved));
    for(const number of numbers){
      const matched=pair(number),present=reads.some(r=>matching(r,number).length),accepted=matched?.[0]??reads.flatMap(r=>matching(r,number))[0];
      report({sourceNumbers:[number],pageIndex:pageIndex+1,status:matched?'usable':present?'isolated':'missing',
        reason:matched?(matched[0].stem===matched[1].stem?'matched':'format_only'):reason(reads,number,keepFirst),
        readings:reads.map(r=>({attempt:r.attempt,matches:matching(r,number).length,confidence:matching(r,number)[0]?.confidence??'missing',warningCount:warningsFor(r,number).length,valid:r.valid}))});
      if(!present)continue;
      const previous=records.get(number);
      if(previous){previous.pageIds.push(page.id);if(!matched||transcriptionKey(previous.stem)!==transcriptionKey(accepted.stem)){previous.availability='isolated';previous.alignmentStatus='ambiguous';}continue;}
      records.set(number,{unitId:`unit-${number}`,sourceNumbers:[number],pageIds:[page.id],stem:accepted.stem,material:'',options:[],
        availability:matched?'usable':'isolated',alignmentStatus:matched?'recognized_by_machine':'ambiguous'});
    }
  }
  return [...records.values()];
}
