fn main() {
    // Embed the target triple so daemon.rs can construct the correct sidecar filename.
    println!(
        "cargo:rustc-env=TARGET_TRIPLE={}",
        std::env::var("TARGET").unwrap()
    );
    tauri_build::build()
}
