use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionConfig {
    pub host: String,
    pub port: u32,
    pub username: String,
    pub password: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<HashMap<String, serde_json::Value>>,
    #[serde(rename = "executionTime")]
    pub execution_time: f64,
    /// Server-reported row count (see byoridb `QueryResponse.row_count`).
    /// `None` when the response didn't include it; frontends should fall
    /// back to `rows.len()` in that case.
    #[serde(rename = "rowCount", skip_serializing_if = "Option::is_none")]
    pub row_count: Option<usize>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SpaceInfo {
    pub name: String,
    #[serde(rename = "partitionNum")]
    pub partition_num: u32,
    #[serde(rename = "replicaFactor")]
    pub replica_factor: u32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SchemaInfo {
    pub tags: Vec<String>,
    pub edges: Vec<String>,
}
