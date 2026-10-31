import method from './biology-authoring.json' with {type:'json'};

export const BIOLOGY_AUTHORING_VERSION=method.version;
export const biologyAuthoring=method;
export const authoringStages=['extract','cloze','exercise'] as const;
export function biologyAuthoringInstruction(stage:string,version:unknown):string{
 if(version!==BIOLOGY_AUTHORING_VERSION)return '';
 return method.stageInstructions[stage as keyof typeof method.stageInstructions]??'';
}
export function searchBiologyAuthoring(query:string){
 const text=query.normalize('NFKC').toLocaleLowerCase('en-US').trim();
 if(!text)return [];
 return method.principles.filter(p=>[p.title,...p.keywords].some(k=>text.includes(k.toLocaleLowerCase('en-US'))||k.toLocaleLowerCase('en-US').includes(text))).map(p=>structuredClone(p));
}
