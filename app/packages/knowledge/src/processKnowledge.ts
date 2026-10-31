import {normalizePage,validateDocument,type BankQuestion,type KnowledgeDocument,type ProcessedKnowledge} from './index.ts';
import {searchBiology} from './biology.ts';

export const KNOWLEDGE_PROCESSOR_VERSION='knowledge-processor-v1' as const;
export type ImportKind='auto'|'question_bank'|'reference';
type Entry={number:string;start:number;end:number;lines:string[]};
const heading=(line:string)=>line.match(/^\s*第\s*([0-9０-９]{1,3})\s*题\s*[：:、.．]?\s*(.*)$/)
  ??line.match(/^\s*([0-9０-９]{1,3})[.．、]\s*(?![0-9０-９])(.+)$/);
const answerHeading=/^\s*(?:[一二三四五六七八九十]+[、.．]\s*)?(?:【|\[)?(?:参考答案(?:与解析|及解析)?|答案(?:与|及)解析|试题解析|参考解析|答案解析)(?:】|\])?\s*[：:]?\s*$/;
const newPaper=/^\s*(?:第[一二三四五六七八九十0-9]+[套卷]|试卷[一二三四五六七八九十0-9]+|.{0,35}(?:模拟试卷|测试卷|练习卷))\s*[：:]?\s*$/;
const marker=/【\s*(参考答案|答案|解析|分析|详解)\s*】\s*[：:]?|^\s*(参考答案|答案|解析|分析|详解)\s*[：:]\s*/gm;
function sections(body:string,initial:'stem'|'answer'='stem'){
 const result={stem:'',answer:'',explanation:''};let last=0,part:keyof typeof result=initial;
 for(const m of body.matchAll(marker)){result[part]+=body.slice(last,m.index);part=/答案/.test(m[1]??m[2])?'answer':'explanation';last=m.index!+m[0].length;}
 result[part]+=body.slice(last);for(const k of Object.keys(result)as(keyof typeof result)[])result[k]=normalizePage(result[k]);return result;
}
function options(body:string){
 const found=[...body.matchAll(/(?:^|\n|[ \t])([A-HＡ-Ｈ])[.．、)）]\s*/g)];
 if(found.length<2)return {stem:body,options:[]};
 const seen=new Set<string>();if(found.some(m=>{const n=m[1].normalize('NFKC');if(seen.has(n))return true;seen.add(n);return false;}))return {stem:body,options:[]};
 return {stem:body.slice(0,found[0].index).trim(),options:found.map((m,i)=>({label:m[1].normalize('NFKC'),text:body.slice(m.index!+m[0].length,found[i+1]?.index??body.length).trim()}))};
}

// A deterministic first-import pass, not an LLM or a claim of scientific review.
// Numbering and source pages are preserved. Ambiguous answer links stay absent.
export function processKnowledge(input:KnowledgeDocument,kind:ImportKind='auto'):KnowledgeDocument{
 const doc=validateDocument(input),questions:BankQuestion[]=[],warnings:string[]=[];
 if(kind==='reference')return {...doc,processed:{version:KNOWLEDGE_PROCESSOR_VERSION,kind:'reference',questions:[],warnings:[]}};
 let current:Entry|null=null,answer:Entry|null=null,inAnswers=false,group:BankQuestion[]=[],pending:Entry[]=[];
 let table:{numbers:string[];page:number;line:string}|null=null;
 const seenPaperTitles=new Set<string>();
 const pageRange=(start:number,end:number)=>Array.from({length:end-start+1},(_,i)=>start+i);
 const attach=()=>{
  for(const entry of pending){const matches=group.filter(q=>q.number===entry.number);if(matches.length!==1){warnings.push(`题号${entry.number}的答案无法唯一对应，保留原文待核对`);for(const q of matches)q.warnings.push('文末答案题号重复，未自动关联');continue;}
   const q=matches[0],s=sections(entry.lines.join('\n'),'answer');
   if(q.answer&&s.answer&&q.answer!==s.answer){q.warnings.push('题后与文末答案不一致，保留题后答案待核对');continue;}
   q.answer=q.answer||s.answer;q.explanation=q.explanation||s.explanation;
   if(s.answer||s.explanation)q.answerPages=[...new Set([...q.answerPages,...pageRange(entry.start,entry.end)])];
  }pending=[];
 };
 const flushAnswer=()=>{if(answer){pending.push(answer);answer=null;}};
 const flush=()=>{
  if(!current)return;const s=sections(current.lines.join('\n')),parts=options(s.stem);
  if(parts.stem){const q:BankQuestion={id:`q-${questions.length+1}`,number:current.number,pageStart:current.start,pageEnd:current.end,
   stem:parts.stem,options:parts.options,answer:s.answer,explanation:s.explanation,answerPages:s.answer||s.explanation?pageRange(current.start,current.end):[],knowledgePoints:[],knowledgeNotes:[],taskPatterns:[],type:parts.options.length?'choice':/[？?]|_{2,}|回答|填空|判断|下列/.test(parts.stem)?'non_choice':'unknown',difficulty:'unrated',warnings:[]};questions.push(q);group.push(q);}
  current=null;if(questions.length>10000)throw new Error('knowledge_processing_limit');
 };
 for(const page of doc.pages)for(const original of page.text.split('\n')){
  const line=original.trim();if(!line)continue;
  if(/^第?\s*\d+\s*页(?:[，,、· /]*共\s*\d+\s*页)?\s*$/.test(line))continue;
  if(newPaper.test(line)){if(seenPaperTitles.has(line))continue;seenPaperTitles.add(line);flush();flushAnswer();attach();group=[];inAnswers=false;continue;}
  if(table){const match=line.match(/^答案\s*[：:]?\s*(.+)$/);if(match){
    flush();flushAnswer();inAnswers=true;const answers=match[1].split(/[\s,，;；]+/).filter(Boolean);
    if(answers.length===table.numbers.length&&answers.every(a=>/^[A-H]{1,8}$/.test(a)))table.numbers.forEach((number,i)=>pending.push({number,start:table!.page,end:page.number,lines:[answers[i]]}));
    else warnings.push('答案表列数或格式不匹配，未按位置猜测答案');table=null;continue;
   }if(current)current.lines.push(table.line);table=null;}
  const tableHeader=line.match(/^题号\s*[：:]?\s*((?:\d{1,3}\s+)+\d{1,3})\s*$/);
  if(tableHeader){table={numbers:tableHeader[1].trim().split(/\s+/),page:page.number,line};continue;}
  if(answerHeading.test(line)){flush();flushAnswer();inAnswers=true;continue;}
  // Common compact answer rows: 1.A 2.B; never infer positional correspondence.
  const row=[...line.matchAll(/([0-9]{1,3})[.．、]\s*([A-H]{1,8})(?=\s|[,，;；]|[0-9]{1,3}[.．、]|$)/g)];
  if(inAnswers&&row.length>1){flushAnswer();for(const m of row)pending.push({number:m[1],start:page.number,end:page.number,lines:[m[2]]});continue;}
  const m=heading(line);
  if(m){const number=m[1].normalize('NFKC');
   if(inAnswers){flushAnswer();answer={number,start:page.number,end:page.number,lines:[m[2]]};}
   else{flush();current={number,start:page.number,end:page.number,lines:[m[2]]};}continue;
  }
  if(inAnswers){if(answer){answer.lines.push(line);answer.end=page.number;}}
  else if(current){current.lines.push(line);current.end=page.number;}
 }
 flush();flushAnswer();attach();
 const likely=questions.some(q=>q.type!=='unknown'||q.answer||q.explanation);
 if(kind==='auto'&&!likely)return {...doc,processed:{version:KNOWLEDGE_PROCESSOR_VERSION,kind:'reference',questions:[],warnings:['未检测到明确题目，按普通资料建立索引']}};
 if(!questions.length)warnings.push('未找到可可靠分开的题号，原文仍已保存并可检索');
 for(const q of questions){
  if(!q.answer)q.warnings.push('未识别到答案');
  if(!q.explanation)q.warnings.push('未识别到解析');
  q.knowledgePoints=searchBiology([q.stem,...q.options.map(o=>o.text),q.explanation].join('\n').slice(0,45000),3).map(c=>c.title);
  // These are verbatim explanation candidates, not verified scientific facts.
  // Never promote a distractor or a merely selected option into a knowledge note.
  q.knowledgeNotes=q.explanation.split(/(?<=[。；;！!])|\n/).map(s=>s.trim()).filter(s=>s.length>=8&&s.length<=500&&!/选项|故选|[A-H]\s*(?:项)?\s*(?:正确|错误)|不正确|不成立|错误的|不合理/.test(s)&&/是|在|由|通过|导致|因此|遵循|用于|需要|能够|使/.test(s)).slice(0,6);
  const tasks:[RegExp,string][]=[[/场所|结构|名称|属于|是什么|称为|物质/,'基础识别'],[/原因|为什么|说明|解释|机制/,'关系解释'],[/如果|若|突然|停止|增加|降低|处理后|敲除/,'条件变化'],[/计算|概率|比例|几种|多少|分离比/,'数量与概率'],[/设计|对照|实验方案|检测指标|验证/,'实验与证据'],[/图|表|曲线|条带|序列/,'图表信息任务（图未读取）']];
  q.taskPatterns=tasks.filter(([pattern])=>pattern.test(q.stem)).map(([,label])=>label);
  if(!q.knowledgePoints.length)q.warnings.push('考点待补充');
  if(q.stem.length>20000||q.answer.length>10000||q.explanation.length>30000)throw new Error('knowledge_processing_limit');
 }
 if(doc.pages.some(p=>!p.text))warnings.push('部分页无文字层，未读取图片内容');
 const processed:ProcessedKnowledge={version:KNOWLEDGE_PROCESSOR_VERSION,kind:'question_bank',questions,warnings:[...new Set(warnings)].slice(0,100)};
 return {...doc,processed};
}
