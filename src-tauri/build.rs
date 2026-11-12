fn main() {
    // Declaring the app's own commands makes them subject to capabilities/default.json.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "studio_connection",
            "studio_open_files",
            "studio_save_file",
            "studio_reveal_file",
        ]),
    ))
    .expect("tauri build");
}
