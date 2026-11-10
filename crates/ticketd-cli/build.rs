fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        // Clap's generated command builders exceed MSVC's default 1 MiB stack
        // in debug builds, even for --version. Reserve more address space for
        // this executable's main thread; keep the default commit size.
        // https://learn.microsoft.com/cpp/build/reference/stack-stack-allocations
        println!("cargo:rustc-link-arg-bin=ticketd=/STACK:8388608");
    }
}
