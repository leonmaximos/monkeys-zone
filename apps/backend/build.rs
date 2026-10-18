fn main() {
    // Recompile o migrator embutido quando uma migration for adicionada.
    println!("cargo:rerun-if-changed=migrations");
}
