import {object,list,sourceText} from './validators.ts';
import type {FrozenInput,InvokeModel,SourceUnit} from './types.ts';

export const SEGMENTATION_INSTRUCTION='先定位本页实际印刷的大题号，返回printedNumbers字符串数组；questions按真实题号逐题独立输出。number只能来自卷面实际印刷题号，不按数组位置、章节或缺号猜测、补号、顺延。paragraphs首段保留印刷的大题号（如14.），遇到下一个大题号立即结束上一题；“三、非选择题”等栏目标题不是题干，也不能将其后整题并入上一选择题。（1）（2）、①②仍属于当前大题，不另立大题号。跨页只转录本页可见正文，不补写缺失内容；本页没有的题不输出空占位项。定向补读时分别输出所要求的相邻题，不能合并。';

function printedNumber(raw:unknown):string{
 return String(raw??'').normalize('NFKC').trim().replace(/^第\s*/,'').replace(/\s*题[：:]?$/,'').replace(/[.、]$/,'').trim();
}
const section=/^[一二三四五六七八九十]+[、.．]\s*(?:单项选择题|多项选择题|非选择题|选择题|填空题|简答题|实验题|解答题)\s*(?:[（(].*[)）])?\s*$/;

// Split only at an explicit printed main heading. Never manufacture a missing
// number from order or subject matter; decimals, subquestions and table rows
// are not main headings. A section title terminates the preceding item.
export function segmentResponse(value:unknown,numbers:string[]){
 const raw=object(value),questions:Record<string,unknown>[]=[];
 for(const value of list(raw.questions,100,true)){
  const q=object(value),body=Array.isArray(q.paragraphs)?q.paragraphs:typeof q.stem==='string'?q.stem.split(/\r?\n/):[];
  let number=printedNumber(q.number),paragraphs:string[]=[];
  const flush=()=>{if(number&&paragraphs.length)questions.push({...q,number,paragraphs,stem:undefined});paragraphs=[];};
  for(const paragraph of body){if(typeof paragraph!=='string')continue;
   for(const line of paragraph.split(/\r?\n/)){
    const text=line.trim();if(!text)continue;
    if(section.test(text)){flush();number='';continue;}
    const normalized=text.normalize('NFKC');
    const heading=normalized.match(/^第\s*(\d+)\s*题(?:[：:、.]|\s|$)/)
      ??normalized.match(/^(\d+)[.、](?!\d)\s*(?=\S)/);
    if(heading){flush();number=heading[1];}
    if(number)paragraphs.push(line);
   }
  }
  flush();
 }
 return {...raw,questions:questions.filter(q=>numbers.includes(String(q.number))),
  printedNumbers:Array.isArray(raw.printedNumbers)?[...new Set(raw.printedNumbers.map(printedNumber).filter(n=>numbers.includes(n)))]:[]};
}

export async function recognizeMinimumSegments(input:FrozenInput,numbers:string[],invoke:InvokeModel,absent:(text:string,number:string)=>boolean):Promise<SourceUnit[]>{
 const pages=input.workspace.paper?.pages??[],records=new Map<string,SourceUnit>();
 const observed=new Map<string,string[]>(),inventory=new Map<string,string[]>();
 const accept=(raw:ReturnType<typeof segmentResponse>,pageId:string,replace=false,scope=numbers)=>{
  const seen=new Set<string>();
  for(const q of raw.questions){
   const number=String(q.number);if(!scope.includes(number)||seen.has(number))continue;
   const stem=(q.paragraphs as string[]).join('\n');if(!stem.trim()||absent(stem,number))continue;
   sourceText(stem);seen.add(number);
   const old=records.get(number);
   if(!old||replace)records.set(number,{unitId:`unit-${number}`,sourceNumbers:[number],pageIds:[pageId],stem,material:'',options:[],availability:'usable',alignmentStatus:'recognized_by_machine'});
   else if(!input.recognitionPolicy?.keepFirstNumbers.includes(number)&&stem.length>old.stem.length){old.stem=stem;old.pageIds=[pageId];}
  }
  return [...seen];
 };
 for(const page of pages){
  const raw=segmentResponse(await invoke('recognize',{pageId:page.id,segmentation:input.segmentationVersion}),numbers);
  inventory.set(page.id,raw.printedNumbers);observed.set(page.id,accept(raw,page.id));
 }
 // One bounded repair read per implicated page, grouped across missing items.
 // Use printed inventory first; otherwise use pages holding immediate neighbors.
 const planned=new Map<string,Set<string>>();
 for(const [i,number]of numbers.entries()){
  if(records.has(number))continue;
  const printed=pages.filter(p=>inventory.get(p.id)?.includes(number));
  const neighbors=[numbers[i-1],numbers[i+1]].filter((n):n is string=>!!n);
  const candidates=printed.length?printed:pages.filter(p=>observed.get(p.id)?.some(n=>neighbors.includes(n)));
  for(const page of candidates.length?candidates:pages.filter(p=>!observed.get(p.id)?.length)){
   const scope=planned.get(page.id)??new Set<string>();scope.add(number);
   for(const n of neighbors)if(observed.get(page.id)?.includes(n))scope.add(n);
   planned.set(page.id,scope);
  }
 }
 for(const [pageId,scope]of planned){
  const focusNumbers=numbers.filter(n=>scope.has(n));
  const raw=segmentResponse(await invoke('recognize',{pageId,focusNumbers,segmentation:input.segmentationVersion}),numbers);
  accept(raw,pageId,true,focusNumbers);
 }
 return [...records.values()];
}
