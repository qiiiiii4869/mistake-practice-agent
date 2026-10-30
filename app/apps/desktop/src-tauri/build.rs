fn main() {
    let source = std::path::Path::new("../../../../browser-probe/probe.mjs");
    println!("cargo:rerun-if-changed={}", source.display());
    let probe = std::fs::read_to_string(source).expect("existing browser probe must be present");
    assert_eq!(
        probe.matches("export async function zhixueProbe").count(),
        1
    );
    let reusable = probe.replacen(
        "export async function zhixueProbe",
        "async function zhixueProbe",
        1,
    );
    let output = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("probe.js");
    std::fs::write(output, reusable).expect("write reusable probe");
    let resources=std::path::Path::new("resources/typst");
    println!("cargo:rerun-if-changed={}",resources.display());
    if resources.is_dir(){
        let out=std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
        let destination=out.ancestors().nth(3).unwrap().join("resources/typst");
        std::fs::create_dir_all(&destination).expect("create runtime resource directory");
        for entry in std::fs::read_dir(resources).expect("runtime resources"){
            let entry=entry.expect("resource entry");if entry.path().is_file(){std::fs::copy(entry.path(),destination.join(entry.file_name())).expect("copy runtime resource");}
        }
    }else{println!("cargo:warning=PDF compiler resource absent; run prepare-runtime.ps1 before distribution");}
    fn copy_tree(source:&std::path::Path,destination:&std::path::Path){
        std::fs::create_dir_all(destination).expect("create PDF runtime directory");
        for entry in std::fs::read_dir(source).expect("PDF runtime resources"){
            let entry=entry.expect("runtime entry");let target=destination.join(entry.file_name());
            if entry.path().is_dir(){copy_tree(&entry.path(),&target)}else{std::fs::copy(entry.path(),target).expect("copy PDF runtime resource");}
        }
    }
    let runtime=std::path::Path::new("resources/workflow-runtime");
    println!("cargo:rerun-if-changed={}",runtime.display());
    if runtime.is_dir(){let out=std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap());copy_tree(runtime,&out.ancestors().nth(3).unwrap().join("resources/workflow-runtime"));}
    tauri_build::build()
}
