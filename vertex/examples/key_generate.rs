//! Generate a keypair for a SwarmLogix Vertex node.
//!
//! Usage:
//!   cargo run --example key-generate
//!
//! Run this once per agent to get a secret/public key pair.

use tashi_vertex::KeySecret;

fn main() {
    let secret = KeySecret::generate();
    let public = secret.public();
    println!("Secret: {secret}");
    println!("Public: {public}");
}
