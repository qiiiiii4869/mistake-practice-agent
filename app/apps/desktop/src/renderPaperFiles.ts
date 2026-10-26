import type { Paper, PaperPage } from '../../../packages/paper/src';
import { validatePaper } from '../../../packages/paper/src';

export const PDF_PREFIX='data:application/pdf;base64,';
export const WORD_PREFIX='data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,';
const check=(signal?:AbortSignal)=>{if(signal?.aborted)throw new Error('agent_cancelled');};
function bytes(data:string){return Uint8Array.from(atob(data.slice(data.indexOf(',')+1)),c=>c.charCodeAt(0));}
function canvasPage(canvas:HTMLCanvasElement,name:string):PaperPage{
  return {id:crypto.randomUUID(),name,data:canvas.toDataURL('image/jpeg',0.88)};
}
// Bound declared expansion before handing an OOXML archive to the renderer.
function checkZip(data:Uint8Array){
  const view=new DataView(data.buffer,data.byteOffset,data.byteLength);let end=-1;
  for(let i=data.length-22;i>=Math.max(0,data.length-65557);i--)if(view.getUint32(i,true)===0x06054b50){end=i;break;}
  if(end<0)throw new Error('paper_document_failed');
  const count=view.getUint16(end+10,true);let offset=view.getUint32(end+16,true),total=0;
  if(count>2000||count===0||offset>=end)throw new Error('paper_document_limit');
  for(let i=0;i<count;i++){
    if(offset+46>end||view.getUint32(offset,true)!==0x02014b50)throw new Error('paper_document_failed');
    const size=view.getUint32(offset+24,true),compressed=view.getUint32(offset+20,true);
    total+=size;if(total>32*1024*1024||size>16*1024*1024||size>Math.max(compressed,1)*300)throw new Error('paper_document_limit');
    offset+=46+view.getUint16(offset+28,true)+view.getUint16(offset+30,true)+view.getUint16(offset+32,true);
  }
}
async function wordPages(data:Uint8Array,name:string,signal?:AbortSignal):Promise<PaperPage[]>{
  checkZip(data);
  const [{default:JSZip},{renderAsync},{toCanvas}]=await Promise.all([import('jszip'),import('docx-preview'),import('html-to-image')]);
  const zip=await JSZip.loadAsync(data);
  if(!zip.file('word/document.xml'))throw new Error('paper_document_failed');
  for(const [path,file] of Object.entries(zip.files)){
    check(signal);
    if(/vbaProject|embeddings\/|word\/(?:charts|diagrams)\/|altChunk|\.html?$|\.svg$|\.wmf$|\.emf$/i.test(path))throw new Error('paper_word_unsupported');
    if(path.endsWith('.rels')){
      const xml=await file.async('string');
      if(/TargetMode\s*=\s*["']External["']/i.test(xml))throw new Error('paper_word_unsupported');
    }
  }
  const host=document.createElement('div');host.style.cssText='position:fixed;left:-20000px;top:0;pointer-events:none;';
  const shadow=host.attachShadow({mode:'open'}),body=document.createElement('div');shadow.append(body);document.body.append(host);
  try{
    await renderAsync(data,body,body,{inWrapper:false,ignoreFonts:true,useBase64URL:true,renderAltChunks:false,renderComments:false,renderChanges:false});
    check(signal);await document.fonts.ready;
    await Promise.all([...body.querySelectorAll('img')].map(img=>img.decode()));
    const sections=[...body.querySelectorAll<HTMLElement>('section.docx')];
    if(!sections.length||sections.length>30)throw new Error('paper_document_limit');
    const pages:PaperPage[]=[];
    for(const section of sections){
      check(signal);
      const width=Math.ceil(section.getBoundingClientRect().width),height=Math.ceil(Math.max(section.scrollHeight,section.getBoundingClientRect().height));
      if(width<1||width>2000||height>12000||width*height>8_000_000)throw new Error('paper_document_limit');
      const canvas=await toCanvas(section,{width,height,pixelRatio:1.5,backgroundColor:'#ffffff',skipFonts:true,cacheBust:false});
      // Long flowing Word sections are split into overlapping readable pages.
      const sliceHeight=Math.round(width*1.414*1.5);
      for(let top=0;top<canvas.height;top+=sliceHeight-100){
        const slice=document.createElement('canvas');slice.width=canvas.width;slice.height=Math.min(sliceHeight,canvas.height-top);
        slice.getContext('2d')!.drawImage(canvas,0,top,slice.width,slice.height,0,0,slice.width,slice.height);
        pages.push(canvasPage(slice,`${name.slice(0,260)} · 第 ${pages.length+1} 页`));
        if(pages.length>30)throw new Error('paper_document_limit');if(top+sliceHeight>=canvas.height)break;
      }
    }
    return pages;
  }finally{host.remove();}
}
async function pdfPages(data:Uint8Array,name:string,signal?:AbortSignal):Promise<PaperPage[]>{
  // Share the locally bundled worker/CMaps configuration with knowledge PDFs.
  await import('./extractPdf');
  const {getDocument}=await import('pdfjs-dist');
  const task=getDocument({data,cMapUrl:new URL('./pdf-assets/cmaps/',document.baseURI).href,standardFontDataUrl:new URL('./pdf-assets/standard_fonts/',document.baseURI).href,useWasm:false,enableXfa:false,stopAtErrors:true});
  task.onPassword=()=>{void task.destroy();};
  try{
    const pdf=await task.promise;if(pdf.numPages>30)throw new Error('paper_document_limit');
    const pages:PaperPage[]=[];
    for(let n=1;n<=pdf.numPages;n++){
      check(signal);const page=await pdf.getPage(n),base=page.getViewport({scale:1});
      const viewport=page.getViewport({scale:Math.min(2,1800/Math.max(base.width,base.height))});
      const canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
      await page.render({canvas,viewport,background:'#ffffff'}).promise;
      pages.push(canvasPage(canvas,`${name.slice(0,260)} · 第 ${n} 页`));page.cleanup();
    }
    return pages;
  }finally{await task.destroy();}
}
export async function renderPaperFiles(paper:Paper,numbers:string[],progress:(s:string)=>void,signal?:AbortSignal):Promise<Paper>{
  const pages:PaperPage[]=[];
  for(const source of paper.pages){
    check(signal);progress(`正在本机展开空白卷：${source.name}…`);
    try{
      if(source.data.startsWith(PDF_PREFIX))pages.push(...await pdfPages(bytes(source.data),source.name,signal));
      else if(source.data.startsWith(WORD_PREFIX))pages.push(...await wordPages(bytes(source.data),source.name,signal));
      else pages.push(source);
    }catch(error){
      if(error instanceof Error&&['agent_cancelled','paper_document_failed','paper_document_limit','paper_word_unsupported'].includes(error.message))throw error;
      throw new Error('paper_document_failed');
    }
    if(pages.length>30)throw new Error('paper_document_limit');
  }
  check(signal);
  const ids=new Set(pages.map(p=>p.id));
  return validatePaper({pages,questions:paper.questions.filter(q=>ids.has(q.pageId))},numbers);
}
