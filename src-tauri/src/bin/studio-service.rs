use byoridb_studio::service::StudioService;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter("byoridb_studio=info")
        .init();
    match StudioService::start(None).await {
        Ok(service) => {
            println!("Studio service listening on {}", service.connection.url);
            let _ = tokio::signal::ctrl_c().await;
            drop(service);
        }
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
