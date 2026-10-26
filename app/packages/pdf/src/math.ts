// A deliberately limited LaTeX subset. Unknown commands fail rather than being
// evaluated or silently printed as a different formula.
export function latexToTypst(source: string): string {
  if (!source.trim() || source.length > 2000) throw new Error('unsupported_formula');
  let i=0;
  const symbols:Record<string,string>={times:'times',cdot:'dot',div:'div',le:'<=',leq:'<=',ge:'>=',geq:'>=',neq:'!=',ne:'!=',approx:'approx',infty:'infinity',pi:'pi',alpha:'alpha',beta:'beta',gamma:'gamma',delta:'delta',Delta:'Delta',theta:'theta',lambda:'lambda',mu:'mu',sigma:'sigma',omega:'omega',Omega:'Omega',rightarrow:'arrow.r',to:'arrow.r',leftrightarrow:'arrow.l.r',in:'in',notin:'in.not',pm:'plus.minus',sin:'sin',cos:'cos',tan:'tan',log:'log',ln:'ln'};
  const bad=():never=>{throw new Error('unsupported_formula');};
  const space=()=>{while(/\s/.test(source[i]??'')&&i<source.length)i++;};
  const group=(depth:number):string=>{
    space();if(source[i]!=='{')return bad();i++;const value=parse('}',depth+1);if(!value.trim())return bad();return value;
  };
  const atom=(depth:number):string=>{
    space();const c=source[i];if(!c)return bad();
    if(c==='{')return `(${group(depth)})`;
    if(c==='\\'){
      i++;const match=source.slice(i).match(/^[a-zA-Z]+/);if(!match)return bad();const name=match[0];i+=name.length;
      if(name==='frac')return `frac(${group(depth)}, ${group(depth)})`;
      if(name==='sqrt')return `sqrt(${group(depth)})`;
      if(name==='mathrm')return `upright(${group(depth)})`;
      if(name==='left'||name==='right')return atom(depth);
      return symbols[name]??bad();
    }
    if(/[0-9]/.test(c)) {const n=source.slice(i).match(/^\d+(?:\.\d+)?/)![0];i+=n.length;return n;}
    if(/[a-zA-Z]/.test(c)){i++;return c;}
    if('+-=<>(),[]|/'.includes(c)){i++;return c;}
    return bad();
  };
  const parse=(end:string|null,depth:number):string=>{
    if(depth>32)return bad();const parts:string[]=[];
    while(i<source.length){
      space();if(i>=source.length)break;
      if(end&&source[i]===end){i++;return parts.join(' ');}
      if(source[i]==='}'||source[i]==='$')return bad();
      let value=atom(depth);
      while(true){space();const op=source[i];if(op!=='^'&&op!=='_')break;i++;space();const script=source[i]==='{'?group(depth):atom(depth);value+=`${op}(${script})`;}
      parts.push(value);
    }
    if(end)return bad();return parts.join(' ');
  };
  return parse(null,0);
}

export function typstContent(value: string): string {
  // JSON strings are data inside #text; never eval model/teacher input as Typst.
  const parts:string[]=[];let cursor=0;
  const expression=/\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$|\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]/g;
  for(const match of value.matchAll(expression)){
    parts.push(`#text(${JSON.stringify(value.slice(cursor,match.index))})`);
    const formula=latexToTypst(match[1]??match[2]??match[3]??match[4]);
    parts.push(match[1]||match[4]?`$ ${formula} $`:`$${formula}$`);cursor=match.index+match[0].length;
  }
  parts.push(`#text(${JSON.stringify(value.slice(cursor))})`);
  return parts.join('');
}
