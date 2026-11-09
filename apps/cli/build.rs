fn main() {
    // The release workflow sets KEEL_VERSION to the tag; rebuild when it changes.
    println!("cargo:rerun-if-env-changed=KEEL_VERSION");
}
