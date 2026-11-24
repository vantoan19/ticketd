use std::{
    io::{self, IsTerminal, Write},
    thread,
};

use ticketd_core::source::RefreshControl;
use tokio::{runtime::Builder, sync::oneshot};

/// Runs one foreground refresh. Terminal progress goes to stderr, leaving
/// stdout available for the final machine-readable report.
pub fn controlled<T>(connection: &str, work: impl FnOnce(RefreshControl) -> T) -> io::Result<T> {
    let runtime = Builder::new_current_thread().enable_io().build()?;
    let control = RefreshControl::default();
    let interrupt = control.clone();
    let mut progress = control.progress();
    let (stop, mut finished) = oneshot::channel();
    let connection = connection.to_owned();
    let terminal_progress = io::stderr().is_terminal();
    let observer = thread::Builder::new()
        .name("source-refresh-terminal".into())
        .spawn(move || {
            runtime.block_on(async {
                let signal = tokio::signal::ctrl_c();
                tokio::pin!(signal);
                let mut listening = true;
                loop {
                    tokio::select! {
                        biased;
                        result = &mut signal, if listening => {
                            if result.is_ok() {
                                interrupt.cancel();
                            }
                            listening = false;
                        }
                        Ok(()) = progress.changed(), if terminal_progress => {
                            let update = *progress.borrow_and_update();
                            if let Some(progress) = update {
                                let mut terminal = io::stderr().lock();
                                let _ = match progress.total {
                                    Some(total) => writeln!(terminal, "Syncing {connection}: {} of {total}", progress.completed),
                                    None => writeln!(terminal, "Syncing {connection}: {}", progress.completed),
                                };
                            }
                        }
                        _ = &mut finished => return,
                    }
                }
            });
        })?;
    let result = work(control);
    let _ = stop.send(());
    let _ = observer.join();
    Ok(result)
}
