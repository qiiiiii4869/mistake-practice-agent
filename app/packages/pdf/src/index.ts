import { assemble, type AgentBatch, type StudentPractice } from '../../agent/src/index.ts';
import { validateBatch } from '../../agent/src/storage.ts';
import type { Workspace } from '../../core/src/index.ts';
import { typstContent } from './math.ts';
export { latexToTypst, typstContent } from './math.ts';

export interface PdfSource { filename:string; typst:string; studentIds:string[] }
export interface ExportOptions { layout:'individual'|'class'; includeAnswers:boolean; demoPreview?:boolean }
const literal=(value:string)=>`#text(${JSON.stringify(value)})`;
const heading=(value:string,level=2)=>`#heading(level: ${level}, [${literal(value)}])\n`;
function studentPages(workspace:Workspace,student:StudentPractice,answers:boolean):string {
  let content=heading(`${student.name||'未命名学生'} · ${answers?'参考答案与解析':'个人补练'}`,1);
  content+=`${literal(`${workspace.exam.name} / ${workspace.exam.className} / ${workspace.exam.subjectName}`)}\n#v(3mm)\n`;
  if(student.availability!=='scored')return content+literal('本场没扫或无原卷，没有逐题判断，不安排自动补练。')+'\n';
  if(!student.variants.length)content+=literal(student.uncoveredNumbers.length?'本场尚无可用的已审核补练题，请教师补充。':'本场暂无纳入补练的薄弱题。')+'\n';
  if(student.uncoveredNumbers.length)content+=`#block(fill: rgb("fff5e8"), inset: 8pt, width: 100%)[${literal(`待教师补充：原第 ${student.uncoveredNumbers.join('、')} 题尚未覆盖。`)}]\n`;
  for(const [index,variant] of student.variants.entries()){
    content+=heading(`${index+1}. 原第 ${variant.sourceNumbers.join('、')} 题的补练`);
    if(answers){
      content+=`#strong[答案] ${typstContent(variant.answer)}\n\n#strong[解析] ${typstContent(variant.explanation)}\n\n`;
      content+=`${literal(`知识点：${variant.knowledgePoints.join('、')}`)}\n\n`;
    }else{
      content+=`${typstContent(variant.stem)}\n\n`;
      variant.options.forEach((option,i)=>{content+=`${literal(`${String.fromCharCode(65+i)}. `)}${typstContent(option)}\n\n`;});
    }
    const citations=[...new Set(variant.sourceIndexes.map(i=>`${variant.evidence[i].name} 第 ${variant.evidence[i].page} 页`))];
    content+=`#text(size: 8pt, fill: rgb("64736c"))[${literal(`依据：${citations.join('；')}`)}]\n`;
    if(!answers)content+='#v(18mm)\n';
  }
  return content;
}
function document(workspace:Workspace,students:StudentPractice[],options:ExportOptions):string {
  const demo=options.demoPreview===true;
  let source=`#set page(paper: "a4", margin: (x: 19mm, y: 18mm), numbering: "1", footer: context align(center, text(size: 8pt, fill: rgb("64736c"), [错题补练 · #counter(page).display("1")])))\n`;
  source+='#set text(font: ("Noto Sans SC", "Microsoft YaHei", "SimSun"), size: 10.5pt, lang: "zh")\n#set par(leading: 0.65em, justify: true)\n#set heading(numbering: none)\n';
  if(demo)source+='#set page(header: align(center, text(size: 9pt, fill: red)[仅供排版验证 / 离线演示 / 不可分发]))\n';
  const pages:string[]=[];
  for(const student of students){
    pages.push(studentPages(workspace,student,false));
    if(options.includeAnswers&&student.variants.length)pages.push(studentPages(workspace,student,true));
  }
  return source+pages.join('\n#pagebreak()\n');
}
export function buildPdfSources(workspace:Workspace,batch:AgentBatch,options:ExportOptions):PdfSource[] {
  if(batch.variants.some(v=>v.review==='pending'))throw new Error('pdf_unreviewed');
  if(batch.variants.some(v=>v.review==='approved'&&!v.passed))throw new Error('pdf_failed_self_check');
  validateBatch(batch,workspace);
  const students=assemble(workspace,batch,options.demoPreview===true);
  if(!students.length)throw new Error('pdf_no_students');
  if(!students.some(s=>s.variants.length))throw new Error('pdf_no_approved_exercises');
  if(options.layout==='class')return [{filename:options.demoPreview?'demo-class.pdf':'class-practice.pdf',typst:document(workspace,students,options),studentIds:students.map(s=>s.id)}];
  return students.map((s,i)=>({filename:`${options.demoPreview?'demo-':''}student-${String(i+1).padStart(3,'0')}.pdf`,typst:document(workspace,[s],options),studentIds:[s.id]}));
}
