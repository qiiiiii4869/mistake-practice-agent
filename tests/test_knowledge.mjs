import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePage, validateDocument } from '../app/packages/knowledge/src/index.ts';

const fixture = () => ({id:'a'.repeat(64),name:'模拟课本.pdf',pages:[{number:1,text:'光合作用\r\n与  细胞呼吸'},{number:2,text:''}]});
test('normalizes whitespace without joining lines or changing source pages', () => {
  assert.equal(normalizePage('  DNA\t replication\r\n\r\n\r\n中文\u0000 '),'DNA replication\n\n中文');
  const doc = validateDocument(fixture());
  assert.equal(doc.pages[0].text,'光合作用\n与 细胞呼吸');
  assert.equal(doc.pages[1].number,2); assert.equal(doc.pages[1].text,'');
});
for (const [name,mutate] of [
  ['invalid fingerprint', d=> d.id='unknown'],
  ['missing pages', d=> d.pages=[]],
  ['nonconsecutive page number', d=> d.pages[1].number=3],
  ['duplicate page', d=> d.pages.push({...d.pages[0]})],
  ['oversized page', d=> d.pages[0].text='中'.repeat(100001)],
  ['oversized file text', d=> d.pages=Array.from({length:100},(_,i)=>({number:i+1,text:'中'.repeat(100000)}))],
  ['empty name', d=> d.name='  '],
  ['all pages empty', d=> d.pages.forEach(p=>p.text=' ')],
]) test(`knowledge rejects ${name}`,()=>{const doc=fixture();mutate(doc);assert.throws(()=>validateDocument(doc));});
