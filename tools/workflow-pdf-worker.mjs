// PDF.js and the same local canvas implementation it uses for Node rendering.
// This worker never contacts a service and handles one file/page at a time.
import {parentPort,workerData} from 'node:worker_threads';
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {expectedText} from '../app/packages/pdf/src/workflow/plan.ts';
const require=createRequire(new URL('../app/package.json',import.meta.url));
const canvas=require('@napi-rs/canvas');
for(const name of ['DOMMatrix','ImageData','Path2D'])globalThis[name]??=canvas[name];
globalThis.fetch=()=>Promise.reject(new Error('pdf_network_forbidden'));
const root=dirname(require.resolve('pdfjs-dist/package.json'));
const pdfjs=await import(pathToFileURL(join(root,'legacy/build/pdf.mjs')).href);
const normalize=s=>s.replace(/\s/g,'').replaceAll('−','-');
const errors=[];
const error=(code,page,block)=>errors.push({code,page,...(block?{blockId:block}:{})});
const hash=b=>createHash('sha256').update(b).digest('hex');
function plainParts(s){return s.split(/\$\$[\s\S]+?\$\$|\$[^$\n]+?\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]/g).map(normalize).filter(Boolean);}
function mathTokens(s){return [...s.matchAll(/\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$|\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]/g)].flatMap(m=>{
  let value=m[1]??m[2]??m[3]??m[4];
  const symbols={alpha:'α',beta:'β',gamma:'γ',delta:'δ',Delta:'Δ',theta:'θ',lambda:'λ',mu:'μ',sigma:'σ',omega:'ω',Omega:'Ω',pi:'π',times:'×',cdot:'⋅',le:'≤',leq:'≤',ge:'≥',geq:'≥',neq:'≠',ne:'≠',pm:'±',infty:'∞',rightarrow:'→',to:'→',leftrightarrow:'↔'};
  value=value.replace(/\\([A-Za-z]+)/g,(_,name)=>symbols[name]??(['frac','sqrt','mathrm','left','right'].includes(name)?'':name));
  return [...value].filter(c=>/[\p{L}\p{N}α-ωΑ-Ω=+×≤≥≠±∞→↔]/u.test(c));
});}
async function check(){
  const {filename,document:doc,metadata,renderDir,budget,foreignNames=[]}=workerData;
  const bytes=await readFile(filename);if(bytes.length>budget.maxBytes)throw new Error('pdf_size_limit');
  const task=pdfjs.getDocument({data:new Uint8Array(bytes),isEvalSupported:false,useSystemFonts:false,disableFontFace:true,
    cMapUrl:join(root,'cmaps')+'/',standardFontDataUrl:join(root,'standard_fonts')+'/',fontExtraProperties:true,stopAtErrors:true});
  const pdf=await task.promise,pages=[],seen=new Set(),seenOnPage=new Set(),bounds=[],fonts=new Set();
  try{
    if(pdf.numPages<1||pdf.numPages>budget.maxPages)throw new Error('pdf_page_limit');
    for(let pageNumber=1;pageNumber<=pdf.numPages;pageNumber++){
      const page=await pdf.getPage(pageNumber),viewport=page.getViewport({scale:1});
      if(Math.abs(viewport.width-595.276)>1||Math.abs(viewport.height-841.89)>1)error('not_a4',pageNumber);
      const content=await page.getTextContent({disableNormalization:true});
      const texts=content.items.filter(i=>'str'in i).map(i=>{
        const t=pdfjs.Util.transform(viewport.transform,i.transform),height=Math.hypot(t[2],t[3]);
        return {str:i.str,x:t[4],y:t[5]-height,width:i.width,height,baseline:t[5],font:i.fontName};
      });
      if(texts.some(t=>/[\uFFFD\u0000\u25a1]/.test(t.str)))error('missing_glyph',pageNumber);
      for(const t of texts)if(t.x<0||t.y<0||t.x+t.width>viewport.width+1||t.y+t.height>viewport.height+1)error('text_outside_page',pageNumber);
      const onPage=metadata.filter(m=>m.page===pageNumber),owners=new Set(),roles=new Set();
      for(const m of onPage){
        const b=doc.blocks.find(b=>b.id===m.id);if(!b||seenOnPage.has(`${m.id}:${pageNumber}`)||(seen.has(m.id)&&b.kind!=='tableHeader')){error('unexpected_or_duplicate_block',pageNumber,m.id);continue;}
        seen.add(m.id);seenOnPage.add(`${m.id}:${pageNumber}`);owners.add(b.ownerId);roles.add(b.role);
        if(![m.x,m.y,m.width,m.height].every(Number.isFinite)||m.x<49||m.y<50||m.x+m.width>viewport.width-49+2||m.y+m.height>viewport.height-49+2)error('block_outside_margins',pageNumber,b.id);
        const inBlock=texts.filter(t=>t.x+t.width>m.x-2&&t.x<m.x+m.width+2&&t.baseline>=m.y-2&&t.baseline<=m.y+m.height+2);
        const actual=normalize(inBlock.map(t=>t.str).join('')),expected=expectedText(b),math=mathTokens(expected);
        if(math.length){
          for(const fragment of plainParts(expected))if(!actual.includes(fragment))error('missing_block_text',pageNumber,b.id);
          const remaining=[...actual.normalize('NFKC')];for(const token of math.flatMap(t=>[...t.normalize('NFKC')])){const at=remaining.indexOf(token);if(at<0){error('missing_math_token',pageNumber,b.id);break;}remaining.splice(at,1);}
        }else if(actual!==normalize(expected))error('block_text_mismatch',pageNumber,b.id);
        if(inBlock.some(t=>t.height<10.4)&&b.kind!=='question'&&!math.length)error('font_too_small',pageNumber,b.id);
        bounds.push({blockId:b.id,page:pageNumber,ownerId:b.ownerId,role:b.role,x:m.x,y:m.y,width:m.width,height:m.height});
      }
      if(!onPage.length)error('unexpected_blank_page',pageNumber);
      if(owners.size!==1||roles.size!==1)error('mixed_owner_or_role',pageNumber);
      const body=texts.filter(t=>t.y>=49&&t.y<viewport.height-42);
      for(const t of body)if(t.str.trim()&&!onPage.some(m=>t.x+t.width>m.x-2&&t.x<m.x+m.width+2&&t.baseline>=m.y-2&&t.baseline<=m.y+m.height+2))error('unplanned_body_text',pageNumber);
      for(const a of onPage)for(const b of onPage)if(a.id<b.id&&Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x)>2&&Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y)>1)error('overlapping_blocks',pageNumber,a.id);
      const fullText=texts.map(t=>t.str).join('');for(const name of foreignNames)if(name&&fullText.includes(name))error('foreign_student_identity',pageNumber);
      const rendered=page.getViewport({scale:2}),width=Math.ceil(rendered.width),height=Math.ceil(rendered.height);
      if(width*height>budget.maxPagePixels)throw new Error('pdf_pixel_limit');
      const surface=canvas.createCanvas(width,height),context=surface.getContext('2d');
      await page.render({canvasContext:context,viewport:rendered,background:'white'}).promise;
      for(const t of texts){const font=page.commonObjs.get(t.font);if(font?.name)fonts.add(font.name);else error('font_inspection_failed',pageNumber);}
      const pixels=context.getImageData(0,0,width,height).data;let ink=0;
      for(let p=0;p<pixels.length;p+=4)if(pixels[p]+pixels[p+1]+pixels[p+2]<600)ink++;
      if(ink<100)error('blank_render',pageNumber);
      for(const m of onPage){let count=0;const x0=Math.max(0,Math.floor(m.x*2)),x1=Math.min(width,Math.ceil((m.x+m.width)*2));
        for(let y=Math.max(0,Math.floor(m.y*2));y<Math.min(height,Math.ceil((m.y+m.height+3)*2));y++)for(let x=x0;x<x1;x++){
          const p=(y*width+x)*4;if(pixels[p]+pixels[p+1]+pixels[p+2]<600)count++;
        }if(count<3)error('block_not_rendered',pageNumber,m.id);
      }
      const png=await surface.encode('png');if(renderDir){await mkdir(renderDir,{recursive:true});await writeFile(join(renderDir,`page-${String(pageNumber).padStart(3,'0')}.png`),png);}
      pages.push({page:pageNumber,width:viewport.width,height:viewport.height,pixels:width*height,renderSha256:hash(png),inkPixels:ink,
        ownerId:[...owners][0]??null,role:[...roles][0]??null,blockIds:onPage.map(m=>m.id),checks:{opened:true,a4:!errors.some(e=>e.page===pageNumber&&e.code==='not_a4'),rendered:true,layoutAndText:!errors.some(e=>e.page===pageNumber)}});
      surface.width=1;surface.height=1;page.cleanup();
    }
    for(const b of doc.blocks)if(!seen.has(b.id))error('missing_planned_block',null,b.id);
    return {checkerVersion:'pdfjs-layout-raster-v1',pdfjsVersion:pdfjs.version,sha256:hash(bytes),size:bytes.length,pages,bounds,
      actualFonts:[...fonts],outlineCount:(await pdf.getOutline())?.length??0,errors,passed:!errors.length};
  }finally{await task.destroy();}
}
try{parentPort.postMessage({result:await check()});}catch(error){if(process.env.MISTAKE_PDF_DEBUG==='1')console.error(error.stack);parentPort.postMessage({error:/^[a-z_]+$/.test(error.message)?error.message:'pdf_open_or_render_failed'});}
