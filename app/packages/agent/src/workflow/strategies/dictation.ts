import type { ClozeItem, InvokeModel, KnowledgeFact,ValidationAttempt,ValidationReason } from '../types.ts';
import { reviewBlindFill, validateCloze,validationReason,object,list,specificClozeAnswer } from '../validators.ts';
import {answerFormat} from '../answerAliases.ts';

export function deterministicCloze(fact:KnowledgeFact,itemId:string,attempt:number,avoidAnswers:string[]=[]):ClozeItem|null{
  const words=avoidAnswers.length?[...new Intl.Segmenter('zh-CN',{granularity:'word'}).segment(fact.completeStatement)]
    .filter(s=>s.isWordLike&&[...s.segment].length>=2&&!['发生','产生','进行','可以','能够','之间','过程','通过','发生在','可产生','影响','控制','决定','呈现','具有','表现','说明','共同','一定'].includes(s.segment)).map(s=>s.segment).reverse()
    .sort((a,b)=>Number(fact.knowledgePoint.includes(b))-Number(fact.knowledgePoint.includes(a))):[];
  // Keep a fixed number/quantifier on the page rather than asking the blind
  // solver to guess it. This changes the gap, never the checked statement.
  const core=(answer:string)=>answer.match(/^(?:[一二三四五六七八九十两]+|\d+)(?:种|个|对)(.+)$/)?.[1];
  const candidates=fact.candidateAnswers.flatMap(a=>core(a)?[core(a)!,a]:[a]);
  for(const answer of [...new Set([...candidates,...words])].filter(a=>specificClozeAnswer(a)&&!avoidAnswers.includes(a)
    &&(!avoidAnswers.some(avoid=>avoid.includes(a)||a.includes(avoid))||avoidAnswers.some(avoid=>core(avoid)===a)))){
    const at=fact.completeStatement.indexOf(answer);if(at<0)continue;
    try{return {...validateCloze({parts:[{type:'text',text:fact.completeStatement.slice(0,at)},
      {type:'blank',blankId:'b1',answer,acceptedAnswers:[answer]},
      {type:'text',text:fact.completeStatement.slice(at+answer.length)}],correction:'依据完整知识句复习，注意概念和适用条件。'},fact,itemId,attempt),authoring:'deterministic'};}
    catch(error){if(!(error instanceof Error)||error.message!=='workflow_invalid_output')throw error;}
  }return null;
}

// Retain one authored knowledge gap when a second gap removes a condition or
// exposes an answer. Restore every other gap as literal text, then run the
// complete validator again; broken reconstruction/duplicate IDs are not repaired.
function singleModelBlank(value:unknown,fact:KnowledgeFact,itemId:string,attempt:number,avoidAnswers:string[]):ClozeItem|null{
  const v=object(value),parts=list(v.parts,20).map(object);
  const blanks=parts.filter(p=>p.type==='blank');
  if(blanks.length!==2||new Set(blanks.map(p=>p.blankId)).size!==2
    ||parts.some(p=>!['text','blank'].includes(String(p.type)))
    ||parts.map(p=>p.type==='text'?p.text:p.answer).join('')!==fact.completeStatement)return null;
  for(let index=0;index<parts.length;index++){
    const target=parts[index];if(target.type!=='blank'||typeof target.answer!=='string'||avoidAnswers.includes(target.answer))continue;
    try{return {...validateCloze({parts:parts.map((p,i)=>p.type==='blank'&&i!==index?{type:'text',text:p.answer}:p),
      correction:'依据完整知识句复习，注意概念和适用条件。'},fact,itemId,attempt),authoring:'deterministic'};}
    catch(error){if(!(error instanceof Error)||error.message!=='workflow_invalid_output')throw error;}
  }return null;
}

export async function generateDictation(fact: KnowledgeFact, invoke: InvokeModel,
  phases: { generating(): Promise<void>; validating(): Promise<void> },report:(failure:ValidationAttempt)=>void=()=>{}): Promise<ClozeItem | null> {
  const context:{repair:{reason:ValidationReason;avoidAnswers:string[]}|null}={repair:null};
  for (let attempt = 1; attempt <= 2; attempt++) {
    let stage:ValidationAttempt['stage']='cloze';
    try {
      await phases.generating();
      let item:ClozeItem|null,generated:unknown;
      const directions=fact.candidateAnswers.filter(a=>answerFormat(a)==='change_direction');
      try{
        // A change-direction target has a precise minimal blank. Keep the
        // surrounding measured quantity visible instead of asking a model to
        // remove compound phrases such as "proportion decreases".
        item=!context.repair&&directions.length?deterministicCloze({...fact,candidateAnswers:[...directions,...fact.candidateAnswers.filter(a=>!directions.includes(a))]},`cloze-${fact.factId}`,attempt):null;
        if(!item){generated=await invoke('cloze',{statement:fact.completeStatement,context:fact.context??'',conditions:fact.conditions,candidateAnswers:fact.candidateAnswers,attempt,repair:context.repair});
          item={...validateCloze(generated,fact,`cloze-${fact.factId}`,attempt),authoring:'model'};}
      }catch(error){
        if(!(error instanceof Error)||error.message!=='workflow_invalid_output')throw error;
        report({factId:fact.factId,sourceNumbers:fact.sourceNumbers,stage,attempt,reason:validationReason(error)});
        context.repair={reason:validationReason(error),avoidAnswers:context.repair?.avoidAnswers??[]};
        item=['answer_visible','condition_removed'].includes(validationReason(error))
          ?singleModelBlank(generated,fact,`cloze-${fact.factId}`,attempt,context.repair.avoidAnswers):null;
        item??=deterministicCloze(fact,`cloze-${fact.factId}`,attempt,context.repair.avoidAnswers);
        if(!item)continue;
      }
      if(context.repair?.avoidAnswers.length&&item.parts.some(p=>p.type==='blank'&&context.repair!.avoidAnswers.includes(p.answer))){
        report({factId:fact.factId,sourceNumbers:fact.sourceNumbers,stage,attempt,reason:'repair_not_applied'});
        item=deterministicCloze(fact,`cloze-${fact.factId}`,attempt,context.repair.avoidAnswers);
        if(!item)continue;
      }
      await phases.validating();
      stage='blindFill';
      // A distinct request contains neither answers, accepted alternatives, correction nor full fact.
      const parts = item.parts.map(p => p.type === 'text' ? { type: p.type, text: p.text } : { type: p.type, blankId: p.blankId });
      const sentence=item.parts.map(p=>p.type==='text'?p.text:`【填空${p.blankId}】`).join('');
      const answerFormats=item.parts.flatMap(p=>p.type==='blank'?[{blankId:p.blankId,kind:answerFormat(p.answer)}]:[]);
      const review=reviewBlindFill(await invoke('blindFill',{ parts,sentence,context:item.context??'',answerFormats }),item),failure=review.reason;
      item.checks.independent = failure===null;
      if(failure){report({factId:fact.factId,sourceNumbers:fact.sourceNumbers,stage,attempt,reason:failure});context.repair={reason:failure,avoidAnswers:review.avoidAnswers};}
      item.status = item.checks.independent && item.checks.scope ? 'passed' : 'failed';
      if (item.status === 'passed' || attempt === 2) return item;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'workflow_invalid_output') throw error;
      report({factId:fact.factId,sourceNumbers:fact.sourceNumbers,stage,attempt,reason:validationReason(error)});
    }
  }
  return null;
}
