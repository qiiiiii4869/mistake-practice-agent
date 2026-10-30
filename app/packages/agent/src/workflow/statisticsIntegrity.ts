// Permit only the small IEEE-754 representation drift seen in legacy Rust JSON
// round-trips of computed ratios. Counts, scores, IDs and structure stay exact.
const derivedFields=new Set(['correctRate','scoreRate','lossRate','meanScoreRate','meanScore','standardDeviation']);
export function sameStatistics(stored:unknown,computed:unknown,field=''):boolean{
 if(Object.is(stored,computed))return true;
 if(typeof stored==='number'&&typeof computed==='number')return derivedFields.has(field)
  &&Number.isFinite(stored)&&Number.isFinite(computed)&&!Number.isInteger(computed)
  &&Math.abs(stored-computed)<=2*Number.EPSILON*Math.abs(computed);
 if(Array.isArray(stored)||Array.isArray(computed))return Array.isArray(stored)&&Array.isArray(computed)&&stored.length===computed.length&&stored.every((v,i)=>sameStatistics(v,computed[i],field));
 if(stored&&computed&&typeof stored==='object'&&typeof computed==='object'){
  const left=stored as Record<string,unknown>,right=computed as Record<string,unknown>;
  const keys=Object.keys(right);return Object.keys(left).length===keys.length&&keys.every(k=>Object.hasOwn(left,k)&&sameStatistics(left[k],right[k],k));
 }return false;
}
