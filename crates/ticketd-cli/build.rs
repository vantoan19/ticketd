fn main() {
    // Clap's full command tree exceeds the Windows default stack in debug builds.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        println!("cargo:rustc-link-arg-bin=ticketd=/STACK:8388608");
    }
}
