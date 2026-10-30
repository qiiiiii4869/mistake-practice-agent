import {analyze} from '../../../core/src/index.ts';
import {invalid,list,object,sourceText,text} from './validators.ts';
import type {FrozenInput,InvokeModel,RecognitionCheck,RecognitionReason,SourceUnit,WorkflowRun,ModelResponse} from './types.ts';

interface Question{number:string;stem:string;confidence:'high'|'low';warnings:string[]}
interface Reading{questions:Question[];warnings:string[];valid:boolean;attempt:number}

function absentTranscription(value:string,number:string):boolean{
  const body=value.trim();if(!body||/^[_＿—–-]+$/.test(body))return true;
  // Narrow provider metadata forms, not a heuristic for biological content.
  const compact=body.replace(/\s/g,'').replace(/[。.]$/,'');
  return compact===`图片中未找到题号${number}的正文`
    ||compact===`图示和表格区域全部跳过，未读取到题号${number}的题干及各小问正文`;
}

export function transcriptionKey(value:string):string{
  // Normalize typography, never remove words, signs, units or numeric values.
  const key=value.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹₀-₉]/gu,c=>`${'⁰¹²³⁴⁵⁶⁷⁸⁹'.includes(c)?'^':'_'}(${c.normalize('NFKC')})`)
    .normalize('NFKC').replace(/\r\n?/g,'\n').replace(/(?<=\d)[ \t]+(?=\d)/g,'<digit-gap>').replace(/[“”]/g,'"').replace(/[‘’]/g,"'")
    .replace(/，/g,',').replace(/。/g,'.').replace(/；/g,';').replace(/[：∶]/g,':')
    .replace(/(^|[\s。；;])([A-H])[.、:)]\s*/g,'$1$2.').replace(/[_＿]{2,}/g,'__').replace(/\s/g,'');
  // Diagram placement has no meaning in this text-only workflow. Only a
  // two-ratio interval explicitly followed by “之间” normalizes its range mark;
  // scalar minus signs, values, inequality signs and diagram labels stay distinct.
  return key.replace(/如(?:上|下)?图所示/g,'如图所示')
    .replace(/(\d+(?:\.\d+)?:\d+(?:\.\d+)?)[~\-–—](\d+(?:\.\d+)?:\d+(?:\.\d+)?)(?=之间)/g,'$1~$2');
}
function questionKey(number:string,stem:string):string{
  const id=number.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  // The known printed item number may be repeated at the start by OCR.
  // A numbered heading is formatting; a decimal/scientific quantity is not.
  const heading=new RegExp(`^\\s*(?:第\\s*${id}\\s*题[：:、.]?\\s*|${id}[.．]\\s+(?=[^\\s\\d]))`);
  return transcriptionKey(stem.replace(heading,''));
}
function parse(value:unknown,allNumbers:string[],attempt:number):Reading{
  const v=object(value),warnings=list(v.warnings===undefined?[]:v.warnings,100,true).map(w=>sourceText(w,2000));
  const questions:Question[]=list(v.questions,100,true).flatMap(q=>{
    const x=object(q),number=text(x.number,40);
    // An extra printed question outside this exam is never renumbered or used.
    if(!allNumbers.includes(number))return [];
    try{
    if(!['high','low'].includes(String(x.confidence)))return invalid();
    // Some providers enumerate absent question numbers as low-confidence,
    // empty placeholders. They are not printed duplicates on another page.
    if(x.confidence==='low'){
      const raw=x.paragraphs===undefined?x.stem:Array.isArray(x.paragraphs)&&x.paragraphs.every(p=>typeof p==='string')?x.paragraphs.join('\n'):null;
      if(typeof raw==='string'&&absentTranscription(raw,number))return [];
    }
    // Body paragraphs exclude graphic captions and table regions. Legacy
    // responses may still use stem; never compare two contradictory versions.
    const stem=x.paragraphs===undefined?sourceText(x.stem):sourceText(list(x.paragraphs,80).map(v=>sourceText(v,8000)).join('\n'));
    if(x.paragraphs!==undefined&&x.stem!==undefined&&questionKey(number,sourceText(x.stem))!==questionKey(number,stem))return invalid();
    return [{number,stem,confidence:x.confidence as 'high'|'low',
      warnings:x.warnings===undefined?[]:list(x.warnings,20,true).map(w=>sourceText(w,2000))}];
    }catch(error){if(!(error instanceof Error)||error.message!=='workflow_invalid_output')throw error;
      // Blank low-confidence placeholders and a malformed known item isolate
      // that number; they must not erase reliable neighbors on this page.
      return [{number,stem:'',confidence:'low',warnings:['本题文字读取不完整或返回结构异常']}];
    }
  });
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
  return reading.valid&&found.length>0&&!!found[0].stem.trim()&&(found.length===1||keepFirst.includes(number))&&found[0].confidence==='high'&&!warningsFor(reading,number).length;
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
  const allNumbers=analyze(input.workspace).audit.questionNumbers,numbers=input.testScope?.questionNumbers??allNumbers;
  const records=new Map<string,{unit:SourceUnit;verified:boolean;conflict:boolean}>();
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
        if(x.length===y.length&&questionKey(number,x[0].stem)===questionKey(number,y[0].stem))return [x[0],y[0]];
      }return null;
    };
    // One extra request per page, targeted to unresolved question numbers,
    // preserving the existing 3P budget and independence of all transcriptions.
    const unresolved=numbers.filter(n=>!pair(n));
    if(unresolved.length)reads.push(await read(3,unresolved));
    for(const number of numbers){
      const matched=pair(number),observed=reads.flatMap(r=>matching(r,number));
      const accepted=matched?.[0]??observed.find(q=>q.stem.trim());
      const present=!!accepted;
      report({sourceNumbers:[number],pageIndex:pageIndex+1,status:matched?'usable':present?'isolated':'missing',
        reason:matched?(matched[0].stem===matched[1].stem?'matched':'format_only'):reason(reads,number,keepFirst),
        readings:reads.map(r=>({attempt:r.attempt,matches:matching(r,number).length,confidence:matching(r,number)[0]?.confidence??'missing',warningCount:warningsFor(r,number).length,valid:r.valid}))});
      // A malformed item's empty fallback is diagnostic-only. It cannot enter
      // SourceUnit (which correctly requires text), or poison another page.
      if(!accepted)continue;
      const unit:SourceUnit={unitId:`unit-${number}`,sourceNumbers:[number],pageIds:[page.id],stem:accepted.stem,material:'',options:[],
        availability:matched?'usable':'isolated',alignmentStatus:matched?'recognized_by_machine':'ambiguous'};
      const previous=records.get(number);
      if(!previous){records.set(number,{unit,verified:!!matched,conflict:false});continue;}
      // Apply the same two-read evidence standard across pages. An unverified
      // detection/absence message on another page is not a second source and
      // cannot revoke the accepted transcription. Its diagnostic remains above.
      if(!matched)continue;
      if(!previous.verified){records.set(number,{unit,verified:true,conflict:false});continue;}
      previous.unit.pageIds.push(page.id);
      if(questionKey(number,previous.unit.stem)!==questionKey(number,accepted.stem))previous.conflict=true;
      if(previous.conflict){previous.unit.availability='isolated';previous.unit.alignmentStatus='ambiguous';}
    }
  }
  return [...records.values()].map(record=>record.unit);
}

// Re-parse already saved responses only. This diagnostic never invokes a model,
// creates a generation job, changes the original run, or promotes it to success.
export async function recheckSavedRecognition(input:FrozenInput,run:WorkflowRun,load:(callId:string)=>Promise<ModelResponse|null>){
 if(input.contentHash!==run.contentHash||input.mode!==run.mode)throw new Error('workflow_stale_run');
 const queues=new Map<string,typeof run.calls>();
 for(const call of run.calls.filter(c=>c.stage==='recognize'&&c.status==='completed')){
  const list=queues.get(call.scopeId)??[];list.push(call);queues.set(call.scopeId,list);
 }
 let replayed=0;const checks:RecognitionCheck[]=[];
 const units=await recognizeWorkflowUnits(input,async(stage,data)=>{
  if(stage!=='recognize')throw new Error('workflow_saved_recognition_missing');
  const call=queues.get(String(data.pageId))?.shift();if(!call)throw new Error('workflow_saved_recognition_missing');
  const response=await load(call.callId);if(!response)throw new Error('workflow_result_missing');replayed++;return structuredClone(response.value);
 },input.recognitionPolicy?.keepFirstNumbers??[],c=>checks.push(c));
 const numbers=input.testScope?.questionNumbers??analyze(input.workspace).audit.questionNumbers;
 return {replayed,usableNumbers:units.filter(u=>u.availability==='usable').flatMap(u=>u.sourceNumbers),
  unresolvedNumbers:numbers.filter(n=>!units.some(u=>u.availability==='usable'&&u.sourceNumbers.includes(n))),checks};
}
