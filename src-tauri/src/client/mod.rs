//! ByoriDB client for communicating with the graph database server.
//!
//! # Module layout
//!
//! | Module | Contents |
//! |--------|----------|
//! | `error` | `ClientError` — shared across transports |
//! | `types` | `ConnectionConfig`, `QueryResult`, `SpaceInfo`, `SchemaInfo` |
//! | `http`  | HTTP REST transport + JSON parsers (`ByoriDBClient`, `test_connection`) |
//!
//! When gRPC support is added, introduce a sibling `grpc` module that reuses
//! `error` and `types` without touching `http`.

mod error;
mod http;
mod types;

pub use error::ClientError;
pub use http::{test_connection, ByoriDBClient};
pub use types::{ConnectionConfig, QueryResult, SchemaInfo, SpaceInfo};
