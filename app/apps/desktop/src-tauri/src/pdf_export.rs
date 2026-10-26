use serde_json::Value;
use std::{collections::HashSet,path::{Path,PathBuf},process::{Command,Stdio},time::{Duration,Instant}};
use unicode_normalization::UnicodeNormalization;

pub(crate) struct Document {pub filename:String,pub source:String}
fn bad()->String{"pdf_invalid_data".into()}
fn text<'a>(v:&'a Value,key:&str)->Result<&'a str,String>{v.get(key).and_then(Value::as_str).ok_or_else(bad)}
fn array<'a>(v:&'a Value,key:&str)->Result<&'a Vec<Value>,String>{v.get(key).and_then(Value::as_array).ok_or_else(bad)}
fn literal(s:&str)->String{format!("#text({})",serde_json::to_string(s).unwrap())}
fn heading(s:&str,level:u8)->String{format!("#heading(level: {level}, [{}])\n",literal(s))}

// No eval, imports, paths or arbitrary Typst code can be produced by this parser.
fn math(source:&str)->Result<String,String>{
    struct Parser{chars:Vec<char>,i:usize}
    impl Parser{
        fn err<T>(&self)->Result<T,String>{Err("pdf_unsupported_formula".into())}
        fn spaces(&mut self){while self.i<self.chars.len()&&self.chars[self.i].is_whitespace(){self.i+=1;}}
        fn group(&mut self,depth:usize)->Result<String,String>{self.spaces();if self.chars.get(self.i)!=Some(&'{'){return self.err();}self.i+=1;let v=self.parse(true,depth+1)?;if v.is_empty(){return self.err();}Ok(v)}
        fn atom(&mut self,depth:usize)->Result<String,String>{
            self.spaces();let c=*self.chars.get(self.i).ok_or("pdf_unsupported_formula")?;
            if c=='{'{return Ok(format!("({})",self.group(depth)?));}
            if c=='\\'{self.i+=1;let start=self.i;while self.chars.get(self.i).is_some_and(|c|c.is_ascii_alphabetic()){self.i+=1;}let name:String=self.chars[start..self.i].iter().collect();
                return Ok(match name.as_str(){
                    "frac"=>format!("frac({}, {})",self.group(depth)?,self.group(depth)?),"sqrt"=>format!("sqrt({})",self.group(depth)?),"mathrm"=>format!("upright({})",self.group(depth)?),"left"|"right"=>self.atom(depth)?,
                    "times"=>"times".into(),"cdot"=>"dot".into(),"div"=>"div".into(),"le"|"leq"=>"<=".into(),"ge"|"geq"=>">=".into(),"neq"|"ne"=>"!=".into(),"approx"=>"approx".into(),"infty"=>"infinity".into(),"rightarrow"|"to"=>"arrow.r".into(),"leftrightarrow"=>"arrow.l.r".into(),"notin"=>"in.not".into(),"pm"=>"plus.minus".into(),
                    "pi"|"alpha"|"beta"|"gamma"|"delta"|"Delta"|"theta"|"lambda"|"mu"|"sigma"|"omega"|"Omega"|"in"|"sin"|"cos"|"tan"|"log"|"ln"=>name,_=>return self.err(),
                });
            }
            if c.is_ascii_digit(){let start=self.i;while self.chars.get(self.i).is_some_and(|c|c.is_ascii_digit()){self.i+=1;}if self.chars.get(self.i)==Some(&'.')&&self.chars.get(self.i+1).is_some_and(|c|c.is_ascii_digit()){self.i+=1;while self.chars.get(self.i).is_some_and(|c|c.is_ascii_digit()){self.i+=1;}}return Ok(self.chars[start..self.i].iter().collect());}
            if c.is_ascii_alphabetic()||"+-=<>(),[]|/".contains(c){self.i+=1;return Ok(c.to_string());}self.err()
        }
        fn parse(&mut self,group:bool,depth:usize)->Result<String,String>{
            if depth>32{return self.err();}let mut out=Vec::new();
            while self.i<self.chars.len(){self.spaces();if self.i>=self.chars.len(){break;}if self.chars[self.i]=='}'{if !group{return self.err();}self.i+=1;return Ok(out.join(" "));}
                let mut atom=self.atom(depth)?;loop{self.spaces();let op=self.chars.get(self.i).copied();if op!=Some('^')&&op!=Some('_'){break;}self.i+=1;self.spaces();let script=if self.chars.get(self.i)==Some(&'{'){self.group(depth)?}else{self.atom(depth)?};atom.push_str(&format!("{}({script})",op.unwrap()));}out.push(atom);
            }if group{return self.err();}Ok(out.join(" "))
        }
    }
    if source.trim().is_empty()||source.len()>8000{return Err("pdf_unsupported_formula".into());}Parser{chars:source.chars().collect(),i:0}.parse(false,0)
}
fn content(s:&str)->Result<String,String>{
    let pattern=regex::Regex::new(r"\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$|\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]").map_err(|_|bad())?;
    let mut out=String::new();let mut cursor=0;
    for c in pattern.captures_iter(s){let matched=c.get(0).unwrap();out.push_str(&literal(&s[cursor..matched.start()]));let formula=(1..=4).find_map(|i|c.get(i)).unwrap();let converted=math(formula.as_str())?;if c.get(1).is_some()||c.get(4).is_some(){out.push_str(&format!("$ {converted} $"));}else{out.push_str(&format!("${converted}$"));}cursor=matched.end();}
    out.push_str(&literal(&s[cursor..]));Ok(out)
}
fn pages(w:&Value,s:&Value,selected:&[&Value],uncovered:&[String],answers:bool)->Result<String,String>{
    let name=text(s,"name")?;let mut out=heading(&format!("{} · {}",if name.is_empty(){"未命名学生"}else{name},if answers{"参考答案与解析"}else{"个人补练"}),1);
    let e=&w["exam"];out.push_str(&format!("{}\n#v(3mm)\n",literal(&format!("{} / {} / {}",text(e,"name")?,text(e,"className")?,text(e,"subjectName")?))));
    if text(s,"availability")?!="scored"{out.push_str(&literal("本场没扫或无原卷，没有逐题判断，不安排自动补练。"));return Ok(out);}
    if selected.is_empty(){out.push_str(&literal(if uncovered.is_empty(){"本场暂无纳入补练的薄弱题。"}else{"本场尚无可用的已审核补练题，请教师补充。"}));out.push('\n');}
    if !uncovered.is_empty(){out.push_str(&format!("#block(fill: rgb(\"fff5e8\"), inset: 8pt, width: 100%)[{}]\n",literal(&format!("待教师补充：原第 {} 题尚未覆盖。",uncovered.join("、")))));}
    for (i,v) in selected.iter().enumerate(){let numbers:Vec<_>=array(v,"sourceNumbers")?.iter().map(|n|n.as_str().ok_or_else(bad)).collect::<Result<_,_>>()?;out.push_str(&heading(&format!("{}. 原第 {} 题的补练",i+1,numbers.join("、")),2));
        if answers{out.push_str(&format!("#strong[答案] {}\n\n#strong[解析] {}\n\n",content(text(v,"answer")?)?,content(text(v,"explanation")?)?));}
        else{out.push_str(&format!("{}\n\n",content(text(v,"stem")?)?));for(j,option)in array(v,"options")?.iter().enumerate(){out.push_str(&format!("{}{}\n\n",literal(&format!("{}. ",(b'A'+j as u8)as char)),content(option.as_str().ok_or_else(bad)?)?));}}
        let evidence=array(v,"evidence")?;let mut citations=Vec::new();for index in array(v,"sourceIndexes")?{let e=&evidence[index.as_u64().ok_or_else(bad)?as usize];let citation=format!("{} 第 {} 页",text(e,"name")?,e["page"].as_u64().ok_or_else(bad)?);if !citations.contains(&citation){citations.push(citation);}}
        out.push_str(&format!("#text(size: 8pt, fill: rgb(\"64736c\"))[{}]\n",literal(&format!("依据：{}",citations.join("；")))));if !answers{out.push_str("#v(18mm)\n");}
    }Ok(out)
}
const HEADER:&str="#set page(paper: \"a4\", margin: (x: 19mm, y: 18mm), footer: context align(center, text(size: 8pt, [错题补练 · #counter(page).display(\"1\")])))\n#set text(font: (\"Noto Sans SC\", \"Microsoft YaHei\", \"SimSun\", \"PingFang SC\"), size: 10.5pt, lang: \"zh\")\n#set par(leading: 0.65em, justify: true)\n#set heading(numbering: none)\n";
pub(crate) fn plan(value:Value,layout:&str,answers:bool)->Result<Vec<Document>,String>{
    let snapshot:crate::storage::Snapshot=serde_json::from_value(value.clone()).map_err(|_|bad())?;snapshot.validate()?;
    let batch=value.get("practice").filter(|v|v.is_object()).ok_or("pdf_no_batch")?;
    if text(batch,"mode")?!="real"{return Err("mock_not_exportable".into());}
    let variants=array(batch,"variants")?;if variants.iter().any(|v|v["review"]=="pending"){return Err("pdf_unreviewed".into());}
    let approved:Vec<_>=variants.iter().filter(|v|v["review"]=="approved"&&v["passed"]==true).collect();if approved.is_empty(){return Err("pdf_no_approved_exercises".into());}
    if !["class","individual"].contains(&layout){return Err(bad());}
    let settings=&value["settings"];let max=settings["maxQuestionsPerStudent"].as_u64().ok_or_else(bad)?as usize;let mut documents=Vec::new();let mut combined=Vec::new();let mut size=0usize;
    for(i,student)in array(&value,"students")?.iter().enumerate(){
        let weak:Vec<String>=array(student,"questions")?.iter().filter(|q|q["result"]=="incorrect"||(q["result"]=="partial_credit"&&settings["includePartialCredit"]==true&&q["score"].as_f64().unwrap()/q["fullScore"].as_f64().unwrap()*100.0<settings["partialCreditThreshold"].as_f64().unwrap())).map(|q|text(q,"number").map(String::from)).collect::<Result<_,_>>()?;
        let mut selected=Vec::new();let mut concepts=HashSet::new();
        for v in &approved{if selected.len()>=max{break;}if !array(v,"sourceNumbers")?.iter().any(|n|n.as_str().is_some_and(|n|weak.iter().any(|w|w==n))){continue;}let keys:Vec<String>=array(v,"knowledgePoints")?.iter().map(|k|k.as_str().unwrap().nfkc().collect::<String>().trim().to_lowercase()).collect();if keys.iter().any(|k|concepts.contains(k)){continue;}selected.push(*v);concepts.extend(keys);}
        let uncovered:Vec<_>=weak.into_iter().filter(|n|!selected.iter().any(|v|v["sourceNumbers"].as_array().unwrap().iter().any(|q|q.as_str()==Some(n)))).collect();
        let mut student_pages=vec![pages(&value,student,&selected,&uncovered,false)?];if answers&&!selected.is_empty(){student_pages.push(pages(&value,student,&selected,&uncovered,true)?);}
        let body=student_pages.join("\n#pagebreak()\n");size+=body.len();if size>50*1024*1024{return Err("pdf_export_too_large".into());}
        if layout=="class"{combined.push(body);}else{documents.push(Document{filename:format!("student-{:03}.pdf",i+1),source:format!("{HEADER}{body}")});}
    }
    if layout=="class"{documents.push(Document{filename:"class-practice.pdf".into(),source:format!("{HEADER}{}",combined.join("\n#pagebreak()\n"))});}Ok(documents)
}
pub(crate) fn compile(compiler:&Path,work:&Path,documents:&[Document])->Result<Vec<PathBuf>,String>{
    if !compiler.is_file(){return Err("pdf_compiler_missing".into());}let start=Instant::now();let mut output=Vec::new();
    for(i,doc)in documents.iter().enumerate(){let source=work.join(format!("source-{i}.typ"));let pdf=work.join(&doc.filename);std::fs::write(&source,&doc.source).map_err(|_|"pdf_write_failed")?;
        let mut command=Command::new(compiler);command.args(["compile","--root"]).arg(work).arg(&source).arg(&pdf).stdout(Stdio::null()).stderr(Stdio::null());
        #[cfg(windows)]{use std::os::windows::process::CommandExt;command.creation_flags(0x08000000);}
        let mut child=command.spawn().map_err(|_|"pdf_compile_failed")?;let file_start=Instant::now();
        loop{match child.try_wait().map_err(|_|"pdf_compile_failed")?{Some(s)=>{if !s.success(){return Err("pdf_compile_failed".into());}break;},None=>{if file_start.elapsed()>Duration::from_secs(60)||start.elapsed()>Duration::from_secs(300){let _=child.kill();let _=child.wait();return Err("pdf_export_timeout".into());}std::thread::sleep(Duration::from_millis(100));}}}
        let bytes=std::fs::read(&pdf).map_err(|_|"pdf_compile_failed")?;if !bytes.starts_with(b"%PDF-"){return Err("pdf_compile_failed".into());}output.push(pdf);
    }Ok(output)
}
#[cfg(test)]mod tests{
 use super::*;
 fn fixture()->Value{let mut v:Value=serde_json::from_str(include_str!("../../../../../tests/fixtures/practice-workspace-synthetic.json")).unwrap();v["practice"]["mode"]=Value::String("real".into());v}
 #[test]fn rejects_demo_unreviewed_and_stale(){let mut v=fixture();v["practice"]["mode"]="mock".into();assert!(plan(v,"class",true).is_err());let mut v=fixture();v["practice"]["variants"][0]["review"]="pending".into();assert!(plan(v,"class",true).is_err());let mut v=fixture();v["settings"]["variantsPerQuestion"]=3.into();assert!(plan(v,"class",true).is_err());}
 #[test]fn real_reviewed_export_has_separate_answers_sources_and_safe_names(){let docs=plan(fixture(),"individual",true).unwrap();assert_eq!(docs.len(),3);assert_eq!(docs[0].filename,"student-001.pdf");assert!(docs[0].source.contains("参考答案与解析"));assert!(docs[0].source.contains("第 12 页"));assert!(docs[2].source.contains("没有逐题判断"));}
 #[test]fn safe_formulas_and_literal_source(){assert_eq!(math(r"E=\frac{1}{2}mv^{2}").unwrap(),"E = frac(1, 2) m v^(2)");assert!(math(r"\input{secret}").is_err());assert!(content("#read(\"secret\")").unwrap().starts_with("#text(\"#read"));}
}
