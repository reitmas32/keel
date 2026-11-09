//! keel: one binary to create versions and deploy them through the keel
//! server (which waits for CI), and to operate Dokploy directly with reviewed,
//! expiring plans.

pub mod cli;
pub mod dokploy;
pub mod failure;
pub mod keel;
pub mod ui;

/// The version this binary reports, set by the release workflow from the tag.
pub const VERSION: &str = match option_env!("KEEL_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};
