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
    tauri_build::build()
}
