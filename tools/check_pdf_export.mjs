// Produces synthetic, permanently watermarked layout fixtures only.
import { mkdir,writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve,join } from 'node:path';
import { exportFixture } from '../tests/pdf_export_fixture.mjs';
import { buildPdfSources } from '../app/packages/pdf/src/index.ts';

const compiler=process.argv[2];
if(!compiler)throw new Error('Usage: node tools/check_pdf_export.mjs /absolute/path/to/typst');
const output=resolve('tmp/pdf-export-check');await mkdir(output,{recursive:true});
const {workspace,batch}=await exportFixture();
const files=[...buildPdfSources(workspace,batch,{layout:'class',includeAnswers:true,demoPreview:true}),
  ...buildPdfSources(workspace,batch,{layout:'individual',includeAnswers:true,demoPreview:true})];
for(const file of files){
  const source=join(output,file.filename.replace(/\.pdf$/,'.typ'));await writeFile(source,file.typst,'utf8');
  const result=spawnSync(compiler,['compile','--root',output,source,join(output,file.filename)],{encoding:'utf8',windowsHide:true});
  if(result.status!==0)throw new Error(result.stderr||String(result.error));
  console.log(`PASS: ${file.filename}`);
}
