use byori_studio::service::{Host, StudioService};

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "byori_studio=info".into()),
        )
        .init();
    byori_studio::runtime::extend_process_path();
    let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
    runtime.block_on(async {
        match StudioService::start(None, Host::Service).await {
            Ok(service) => {
                println!("Studio service listening on {}", service.connection.url);
                // npm run studio stops this process with SIGTERM.
                #[cfg(unix)]
                {
                    use tokio::signal::unix::{signal, SignalKind};
                    let mut terminate = signal(SignalKind::terminate()).expect("signal handler");
                    tokio::select! {
                        _ = tokio::signal::ctrl_c() => {}
                        _ = terminate.recv() => {}
                    }
                }
                #[cfg(not(unix))]
                let _ = tokio::signal::ctrl_c().await;
                service.shutdown();
                byori_studio::runtime::kill_children_of(std::process::id());
                byori_studio::render::remove_partial_outputs();
            }
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
    });
}
