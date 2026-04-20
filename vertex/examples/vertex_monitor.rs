//! Vertex Consensus Latency Monitor
//!
//! Tracks BFT consensus finality times across the swarm.
//! Logs performance metrics for each consensus round.
//!
//! Usage:
//!   cargo run --example vertex-monitor -- \
//!     -B 127.0.0.1:9004 -K <SECRET> \
//!     -P <PEER1>@127.0.0.1:9001 \
//!     -P <PEER2>@127.0.0.1:9002 \
//!     -P <PEER3>@127.0.0.1:9003

use clap::Parser;
use swarmlogix_vertex::SwarmMessage;
use tashi_vertex::{Context, Engine, KeySecret, Message, Options, Peers, Socket};
use std::time::Instant;

#[derive(Parser)]
#[command(name = "vertex-monitor")]
struct Args {
    #[arg(short = 'B', long)]
    bind: String,
    #[arg(short = 'K', long)]
    key: String,
    #[arg(short = 'P', long, num_args = 1..)]
    peer: Vec<String>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();

    println!();
    println!("╔══════════════════════════════════════════════════╗");
    println!("║  SWARMLOGIX · Vertex Consensus Monitor          ║");
    println!("╚══════════════════════════════════════════════════╝");
    println!();

    let key: KeySecret = args.key.parse()?;
    let mut peers = Peers::new()?;
    peers.insert(&args.bind, &key.public(), Default::default())?;
    for p in &args.peer {
        let parts: Vec<&str> = p.split('@').collect();
        if parts.len() == 2 {
            peers.insert(parts[1], &parts[0].parse()?, Default::default())?;
        }
    }

    let context = Context::new()?;
    let socket = Socket::bind(&context, &args.bind).await?;
    let engine = Engine::start(&context, socket, Options::default(), &key, peers, false)?;

    println!("  ✓ Monitor node online at {}", args.bind);
    println!();
    println!("  {:>6}  {:>10}  {:>8}  {:>12}  {}", "EVENT", "LATENCY", "TX_COUNT", "TYPE", "DETAILS");
    println!("  {}", "─".repeat(60));

    let mut event_count: u64 = 0;
    let mut total_latency_us: u64 = 0;
    let start = Instant::now();

    while let Some(msg) = engine.recv_message().await? {
        let recv_time = Instant::now();
        match msg {
            Message::Event(event) => {
                event_count += 1;
                let latency = recv_time.elapsed();
                let latency_us = latency.as_micros() as u64;
                total_latency_us += latency_us;
                let avg = total_latency_us / event_count;

                let tx_count = event.transaction_count();
                let mut msg_type = "unknown".to_string();
                let mut details = String::new();

                for i in 0..tx_count {
                    if let Some(data) = event.transaction(i) {
                        if let Ok(msg) = SwarmMessage::from_bytes(data) {
                            match &msg {
                                SwarmMessage::AgentState { agent_id, vendor, .. } => {
                                    msg_type = "AGENT".into();
                                    details = format!("{} ({})", agent_id, vendor);
                                }
                                SwarmMessage::OrderCreated { order_id, weight, .. } => {
                                    msg_type = "ORDER".into();
                                    details = format!("{} — {:.1}kg", order_id, weight);
                                }
                                SwarmMessage::AuctionBid { agent_id, score, .. } => {
                                    msg_type = "BID".into();
                                    details = format!("{} score={:.3}", agent_id, score);
                                }
                                SwarmMessage::AuctionWinner { winner_id, .. } => {
                                    msg_type = "WINNER".into();
                                    details = format!("{}", winner_id);
                                }
                                SwarmMessage::SafetyAlert { radius, .. } => {
                                    msg_type = "SAFETY".into();
                                    details = format!("{:.0}m radius", radius);
                                }
                                SwarmMessage::AgentFailure { agent_id, reason } => {
                                    msg_type = "FAULT".into();
                                    details = format!("{} ({})", agent_id, reason);
                                }
                                _ => {
                                    msg_type = "OTHER".into();
                                }
                            }
                        }
                    }
                }

                println!("  {:>6}  {:>7}μs  {:>8}  {:>12}  {}",
                    event_count,
                    latency_us,
                    tx_count,
                    msg_type,
                    details,
                );

                // Print summary every 50 events
                if event_count % 50 == 0 {
                    let elapsed = start.elapsed().as_secs();
                    println!();
                    println!("  ── SUMMARY ──────────────────────────────────────");
                    println!("  Events: {}  |  Avg latency: {}μs  |  Uptime: {}s",
                        event_count, avg, elapsed);
                    println!("  ────────────────────────────────────────────────");
                    println!();
                }
            }
            Message::SyncPoint(_) => {
                println!("  {:>6}  {:>10}  {:>8}  {:>12}  {}", "·", "—", "—", "SYNC", "consensus aligned");
            }
        }
    }

    Ok(())
}
