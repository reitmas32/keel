/// The command futures are large, and Windows gives the main thread only 1 MiB of
/// stack, so the CLI runs on a thread (and runtime workers) with room to spare.
const STACK_SIZE: usize = 16 * 1024 * 1024;

fn main() {
    let thread = std::thread::Builder::new()
        .name("keel".into())
        .stack_size(STACK_SIZE)
        .spawn(|| {
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .thread_stack_size(STACK_SIZE)
                .build()
                .expect("no se pudo iniciar el runtime de tokio")
                .block_on(keel::cli::main());
        })
        .expect("no se pudo crear el hilo principal de keel");
    if thread.join().is_err() {
        std::process::exit(101);
    }
}
