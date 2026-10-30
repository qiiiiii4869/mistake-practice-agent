import type {Workspace} from '../../core/src/index.ts';

function weekOf(value:string):number|null{
 const found=value.normalize('NFKC').match(/第\s*([0-9一二三四五六七八九十两〇零]+)\s*周/);if(!found)return null;
 const text=found[1];if(/^\d+$/.test(text)){const n=Number(text);return Number.isSafeInteger(n)&&n>0&&n<=100?n:null;}
 const digits:Record<string,number>={'零':0,'〇':0,'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9};
 if(Object.hasOwn(digits,text))return digits[text]||null;
 const m=text.match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/);return m?(m[1]?digits[m[1]]:1)*10+(m[2]?digits[m[2]]:0):null;
}
// Missing metadata is not proof of a match. Reject only explicit contradictory weeks.
export function paperExamMatch(workspace:Workspace){
 const examWeek=weekOf(workspace.exam.name),paperWeeks=[...new Set((workspace.paper?.pages??[]).flatMap(p=>{const n=weekOf(p.name);return n===null?[]:[n];}))];
 return {examWeek,paperWeeks,mismatch:examWeek!==null&&paperWeeks.some(n=>n!==examWeek)};
}
export function assertPaperExamMatch(workspace:Workspace){if(paperExamMatch(workspace).mismatch)throw new Error('workflow_paper_exam_mismatch');}
