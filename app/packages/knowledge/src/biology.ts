import library from './biology-library.json' with {type:'json'};
import {BIOLOGY_AUTHORING_VERSION} from './biologyAuthoring.ts';

export const BIOLOGY_LIBRARY_VERSION=library.version;
export const biologyLibrary=library;
export type BiologyCard=typeof library.cards[number];
export const isBiology=(subject:string)=>/生物|biology/i.test(subject);
export const knowledgeVersion=(revision:string|number,subject:string)=>isBiology(subject)?`${revision}:${BIOLOGY_LIBRARY_VERSION}:${BIOLOGY_AUTHORING_VERSION}`:String(revision);
const normalize=(text:string)=>text.normalize('NFKC').replace(/\s+/g,'').toLocaleLowerCase('en-US');

// Local lexical retrieval; an overlap proposes a topic, never proves that a
// particular option, experimental result or diagram is correct.
export function searchBiology(query:string,limit=6):BiologyCard[]{
 if(!Number.isSafeInteger(limit)||limit<1||limit>20)throw new Error('knowledge_invalid_query');
 const text=normalize(query);if(!text||text.length>50000)return [];
 return library.cards.map((card,index)=>{
  const terms=[...new Set([card.title,...card.keywords].map(normalize))].filter(t=>t.length>=2);
  const matched=terms.filter(t=>text.includes(t));
  const score=matched.reduce((n,t)=>n+Math.min(t.length,12)**1.3+(text===t?10:0),0)+(text.includes(normalize(card.title))?20:0);
  return {card,index,score};
 }).filter(r=>r.score>=4).sort((a,b)=>b.score-a.score||a.index-b.index).slice(0,limit).map(r=>structuredClone(r.card));
}
export function biologyEvidence(query:string,limit=6):{documentId:string;page:number;text:string}[]{
 return searchBiology(query,limit).map(card=>{
  const ref=card.sources[0],source=library.sources.find(s=>s.id===ref.sourceId)!;
  return {documentId:source.sha256,page:ref.page,text:formatBiologyCard(card)};
 });
}
export function formatBiologyCard(card:BiologyCard):string{
 const module=library.modules.find(m=>m.id===card.moduleId)!;
 const locations=card.sources.map(ref=>`${library.sources.find(s=>s.id===ref.sourceId)!.name}，PDF物理第${ref.page}页，规范第${ref.question}题`).join('；');
 return `【内置知识卡 ${card.id}｜${module.name}｜${card.title}】\n性质：${card.scope}，由用户资料整理，非教材原文或原题逐字摘录。\n${card.facts.map(f=>f.statement).join('\n')}\n辨析：${card.misconception}\n学习任务：对照本题实际问法选择相关命题，明确条件后再使用，不代表本题选项和图示结果已正确。\n来源定位：${locations}`;
}
export const biologySourceNames=Object.fromEntries(library.sources.map(s=>[s.sha256,`${s.name}（内置整理卡）`]));
