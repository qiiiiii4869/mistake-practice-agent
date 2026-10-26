use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use unicode_normalization::UnicodeNormalization;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct Batch {
    schema_version:u32, mode:String, input_key:String, subject:Subject,
    annotations:Vec<Annotated>, variants:Vec<Variant>, skipped:Vec<Skipped>, calls:Calls,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Subject { id:String,subject:String,formula:String,common_diagrams:bool,common_materials:bool,unsupported:Vec<String>,diagram:String,shared_material:String }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Annotation { knowledge_points:Vec<String>,keywords:Vec<String>,kind:String,material_group:Option<String> }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Annotated { number:String,annotation:Annotation }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Variant { id:String,stem:String,options:Vec<String>,answer:String,explanation:String,knowledge_points:Vec<String>,source_indexes:Vec<usize>,source_numbers:Vec<String>,evidence:Vec<Evidence>,check:Check,passed:bool,attempts:u32,review:String }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Evidence { document_id:String,name:String,page:u32,ordinal:u32,text:String }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Check { answer:String,complete:bool,in_scope:bool,too_similar:bool,explanation:String }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Skipped { numbers:Vec<String>,reason:String }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Calls { annotate:u32,generate:u32,solve:u32 }

fn text(s:&str,max:usize)->bool { !s.trim().is_empty() && s.chars().count()<=max }
fn strings(values:&[String],max:usize)->bool { !values.is_empty()&&values.len()<=max&&values.iter().all(|v|text(v,300)) }
fn equivalent(a:&str,b:&str)->bool {
    let normalize=|s:&str|s.nfkc().filter(|c|!c.is_whitespace()).flat_map(char::to_uppercase).collect::<String>();
    normalize(a)==normalize(b)
}
impl Batch {
    pub(crate) fn validate(&self,subject_name:&str,input_key:&str,numbers:&HashSet<&str>,confirmed:&HashMap<&str,&str>)->Result<(),String> {
        let bad=||"invalid_practice".to_string();
        if self.schema_version!=1||!["mock","real"].contains(&self.mode.as_str())||self.input_key!=input_key||!text(&self.input_key,2*1024*1024)
            || self.annotations.len()>1000||self.variants.len()>10000||self.skipped.len()>1000
            || serde_json::to_vec(self).map_err(|_|bad())?.len()>6*1024*1024 {return Err(bad());}
        let s=&self.subject;
        let expected_subject=if subject_name.trim().is_empty(){"通用学科"}else{subject_name.trim()};
        if s.subject!=expected_subject||!["math","physics","chemistry","biology","geography","chinese","english","history","politics","general"].contains(&s.id.as_str())
            ||s.formula!="latex"||s.diagram!="text_only"||s.shared_material!="whole_group"||s.unsupported!=["listening","writing","practical"] {return Err(bad());}
        let valid_numbers=|values:&[String]|!values.is_empty()&&values.len()<=1000&&values.iter().all(|n|numbers.contains(n.as_str()))&&values.iter().collect::<HashSet<_>>().len()==values.len();
        let mut annotated=HashSet::new();
        for item in &self.annotations {
            let a=&item.annotation;
            if !numbers.contains(item.number.as_str())||!annotated.insert(&item.number)||!strings(&a.knowledge_points,10)||!strings(&a.keywords,5)
                ||!["choice","text","diagram","shared_material","listening","writing","practical"].contains(&a.kind.as_str())
                ||a.material_group.as_ref().is_some_and(|s|!text(s,100))||(a.kind=="shared_material"&&a.material_group.is_none()) {return Err(bad());}
        }
        let mut ids=HashSet::new();
        for v in &self.variants {
            if !text(&v.id,200)||!ids.insert(&v.id)||!text(&v.stem,20000)||!text(&v.answer,10000)||!text(&v.explanation,20000)
                ||v.options.len()>10||v.options.iter().any(|s|!text(s,3000))||!strings(&v.knowledge_points,10)||!valid_numbers(&v.source_numbers)
                ||v.source_numbers.iter().any(|n|!confirmed.contains_key(n.as_str()))||v.evidence.is_empty()||v.evidence.len()>6
                ||v.source_indexes.is_empty()||v.source_indexes.len()>6||v.source_indexes.iter().any(|i|*i>=v.evidence.len())
                ||v.source_indexes.iter().collect::<HashSet<_>>().len()!=v.source_indexes.len()||!(1..=2).contains(&v.attempts)
                ||!["pending","approved","rejected"].contains(&v.review.as_str())||(v.review=="approved"&&!v.passed)
                ||!text(&v.check.answer,10000)||!text(&v.check.explanation,20000) {return Err(bad());}
            for e in &v.evidence {
                if e.document_id.len()!=64||!e.document_id.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b))
                    ||!text(&e.name,300)||!(1..=1000).contains(&e.page)||!(1..=100000).contains(&e.ordinal)||!text(&e.text,2000) {return Err(bad());}
            }
            if v.passed&&(!equivalent(&v.answer,&v.check.answer)||!v.check.complete||!v.check.in_scope||v.check.too_similar
                ||v.source_numbers.iter().any(|n|equivalent(confirmed[n.as_str()],&v.stem))) {return Err(bad());}
        }
        if self.skipped.iter().any(|s|!valid_numbers(&s.numbers)||!text(&s.reason,300))||self.calls.annotate>50000||self.calls.generate>50000||self.calls.solve>50000 {return Err(bad());}
        Ok(())
    }
}
