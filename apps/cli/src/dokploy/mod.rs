//! Direct Dokploy operation, ported from dokploy-agent: redacted reads,
//! typed plans that a person approves, and an audit log.

pub mod approval;
pub mod audit;
pub mod client;
pub mod commands;
pub mod config;
pub mod envfile;
pub mod extra;
pub mod inventory;
pub mod logs;
pub mod net;
pub mod paths;
pub mod plan;
pub mod redact;

use anyhow::Result;
use serde::Serialize;

pub fn print_json<T: Serialize>(value: &T) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}
