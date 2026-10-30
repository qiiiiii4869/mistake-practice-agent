// Explicit, bounded terminology aliases. This is not model-driven semantic
// similarity: stages I and II, and prophase/metaphase/etc. remain distinct.
export function acceptedTermAliases(answer:string):string[]{
  const cleaned=answer.normalize('NFKC').replace(/\s/g,'');
  const directions=[['下降','降低','减少','减小','变小'],['上升','升高','增加','增多','增大','变大'],['不变','保持不变','无变化']];
  const direction=directions.find(group=>group.includes(cleaned));
  if(direction)return [...new Set([answer,...direction])];
  const match=cleaned.match(/^减数(?:分裂(I|II)|第(一|二)次分裂)(前|中|后|末)期$/);
  if(!match)return [answer];
  const roman=match[1]??(match[2]==='一'?'I':'II'),chinese=roman==='I'?'一':'二',phase=match[3];
  return [...new Set([answer,`减数分裂${roman}${phase}期`,`减数第${chinese}次分裂${phase}期`,`减数第${chinese}次分裂的${phase}期`])];
}
export function answerFormat(answer:string):'change_direction'|'term'{
  return ['下降','降低','减少','减小','变小','上升','升高','增加','增多','增大','变大','不变','保持不变','无变化'].includes(answer.normalize('NFKC').replace(/\s/g,''))?'change_direction':'term';
}
