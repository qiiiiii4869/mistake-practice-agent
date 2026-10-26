#[path="../../../../app/apps/desktop/src-tauri/src/storage.rs"]mod storage;
#[path="../../../../app/apps/desktop/src-tauri/src/practice.rs"]mod practice;
#[path="../../../../app/apps/desktop/src-tauri/src/pdf_export.rs"]mod pdf_export;
fn main(){
    let compiler=std::env::args().nth(1).expect("pass an absolute Typst compiler path");
    let root=std::path::Path::new("tmp/native-pdf-export-check");std::fs::create_dir_all(root).unwrap();
    let mut value:serde_json::Value=serde_json::from_str(&std::fs::read_to_string("tests/fixtures/practice-workspace-synthetic.json").unwrap()).unwrap();
    value["practice"]["mode"]="real".into();
    value["practice"]["variants"][0]["stem"]="【合成排版检查】计算 $E=\\frac{1}{2}mv^{2}$，特殊字符 #read(\"secret\") 仅按文字显示。".into();
    value["practice"]["variants"][0]["answer"]="A，$x=\\sqrt{4}$".into();
    value["practice"]["variants"][0]["check"]["answer"]=value["practice"]["variants"][0]["answer"].clone();
    let mut docs=pdf_export::plan(value.clone(),"class",true).unwrap();docs.extend(pdf_export::plan(value,"individual",true).unwrap());
    for doc in &mut docs{doc.source=format!("#set page(header: align(center, text(fill: red)[合成排版测试 / 不可分发]))\n{}",doc.source);}
    let outputs=pdf_export::compile(std::path::Path::new(&compiler),&root.canonicalize().unwrap(),&docs).unwrap();
    println!("PASS: {} synthetic native-rendered PDFs compiled with mandatory test watermark.",outputs.len());
}
