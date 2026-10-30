import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export function sqliteProbeTransport(database,{now}={}){
  const child=spawn(fileURLToPath(new URL('./storage-check/target/debug/workflow_store_probe.exe',import.meta.url)),[resolve(database)],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const pending=[];let closed=false,finished=false;child.on('close',()=>{finished=true;});child.on('error',()=>pending.splice(0).forEach(p=>p.reject(new Error('workflow_storage_unavailable'))));
  child.stdin.on('error',()=>pending.splice(0).forEach(p=>p.reject(new Error('workflow_storage_unavailable'))));
  child.on('exit',()=>pending.splice(0).forEach(p=>p.reject(new Error('workflow_storage_unavailable'))));
  child.stderr.resume();createInterface({input:child.stdout}).on('line',line=>{const next=pending.shift();if(!next)return;
    try{const value=JSON.parse(line);value.error?next.reject(new Error(value.error)):next.resolve(value.value);}catch{next.reject(new Error('workflow_storage_invalid'));}});
  return {async invoke(command,args){if(command!=='workflow_store')throw new Error('workflow_storage_invalid');
    if(closed)throw new Error('workflow_storage_unavailable');
    return new Promise((resolve,reject)=>{pending.push({resolve,reject});child.stdin.write(JSON.stringify({...args,...(now?{now:now()}:{})})+'\n');});},
    async close(){closed=true;child.stdin.end();if(!finished&&child.pid)await new Promise(r=>child.once('close',r));},kill(){closed=true;child.kill();},child};
}
