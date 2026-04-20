//! SwarmLogix · Vertex → WebSocket Bridge
//!
//! Joins the Vertex mesh as a read-only observer peer and re-broadcasts every
//! consensus-ordered transaction to any browser connected over WebSocket.
//! The dashboard (index.html) connects to this bridge on ws://127.0.0.1:8787
//! and flips from SIMULATION mode to LIVE VERTEX mode.
//!
//! Usage:
//!   cargo run --release --example vertex-bridge -- \
//!       -B 127.0.0.1:9004 -K <OBSERVER_SECRET> \
//!       -P <KEY1_PUBLIC>@127.0.0.1:9001 \
//!       -P <KEY2_PUBLIC>@127.0.0.1:9002 \
//!       -P <KEY3_PUBLIC>@127.0.0.1:9003 \
//!       --ws-addr 127.0.0.1:8787
//!
//! (run_swarm.sh launches this automatically alongside the 3 delivery nodes)

use clap::Parser;
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::Arc;
use std::time::Instant;
use swarmlogix_vertex::SwarmMessage;
use tashi_vertex::{Context, Engine, KeySecret, Message, Options, Peers, Socket};
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use tokio_tungstenite::tungstenite;

#[derive(Parser)]
#[command(name = "vertex-bridge")]
#[command(about = "Relays Vertex consensus events to browsers via WebSocket")]
struct Args {
    #[arg(short = 'B', long)]
    bind: String,
    #[arg(short = 'K', long)]
    key: String,
    #[arg(short = 'P', long, num_args = 1..)]
    peer: Vec<String>,
    #[arg(long, default_value = "127.0.0.1:8787")]
    ws_addr: String,
}

/// Every frame pushed to the dashboard. Serialised as a single JSON object.
#[derive(Serialize)]
#[serde(tag = "type")]
enum Frame {
    /// Sent once on connection so the UI can paint the initial badge.
    Hello {
        bridge_bind: String,
        vertex_peers: usize,
    },
    /// One consensus-ordered event, possibly carrying many transactions.
    Consensus {
        round: u64,
        tx_count: usize,
        latency_us: u64,
        transactions: Vec<TxFrame>,
    },
    /// Emitted when Vertex reports a sync point — every node is aligned.
    SyncPoint { round: u64 },
}

#[derive(Serialize)]
struct TxFrame {
    /// 16-hex-char digest of the transaction bytes — stable across nodes.
    tx_hash: String,
    /// Parsed SwarmMessage, or raw base64 if it wasn't a SwarmLogix tx.
    payload: serde_json::Value,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();

    println!("╔══════════════════════════════════════════════════╗");
    println!("║  SWARMLOGIX · Vertex → WebSocket Bridge          ║");
    println!("╚══════════════════════════════════════════════════╝");
    println!();
    println!("  Vertex bind:   {}", args.bind);
    println!("  Upstream peers: {}", args.peer.len());
    println!("  WebSocket:      ws://{}", args.ws_addr);
    println!();

    // ── Vertex ───────────────────────────────────────────────────────────
    let key: KeySecret = args.key.parse()
        .map_err(|_| anyhow::anyhow!("invalid --key (need a base58 secret)"))?;
    let mut peers = Peers::new()?;
    peers.insert(&args.bind, &key.public(), Default::default())?;
    let peer_count = args.peer.len();
    for p in &args.peer {
        let parts: Vec<&str> = p.split('@').collect();
        if parts.len() != 2 { continue }
        let pk = parts[0].parse()
            .map_err(|_| anyhow::anyhow!("invalid peer public key: {}", parts[0]))?;
        peers.insert(parts[1], &pk, Default::default())?;
    }
    let context = Context::new()?;
    let socket = Socket::bind(&context, &args.bind).await?;
    let engine = Engine::start(&context, socket, Options::default(), &key, peers, false)?;
    println!("  ✓ Vertex observer online");

    // ── WebSocket server ─────────────────────────────────────────────────
    let (tx, _) = broadcast::channel::<String>(256);
    let ws_listener = TcpListener::bind(&args.ws_addr).await?;
    println!("  ✓ WebSocket listening on ws://{}\n", args.ws_addr);

    let ws_tx = tx.clone();
    let ws_bind = args.bind.clone();
    tokio::spawn(async move {
        while let Ok((stream, addr)) = ws_listener.accept().await {
            let ws_tx = ws_tx.clone();
            let ws_bind = ws_bind.clone();
            tokio::spawn(async move {
                let ws = match tokio_tungstenite::accept_async(stream).await {
                    Ok(ws) => ws,
                    Err(e) => { eprintln!("  ✗ ws handshake from {addr}: {e}"); return; }
                };
                println!("  → dashboard connected: {addr}");
                let (mut sink, mut source) = ws.split();
                // Greet the new client.
                let hello = serde_json::to_string(&Frame::Hello {
                    bridge_bind: ws_bind,
                    vertex_peers: peer_count,
                }).unwrap();
                let _ = sink.send(tungstenite::Message::Text(hello)).await;

                let mut rx = ws_tx.subscribe();
                loop {
                    tokio::select! {
                        incoming = source.next() => {
                            match incoming {
                                Some(Ok(tungstenite::Message::Close(_))) | None => break,
                                Some(Err(_)) => break,
                                _ => {}
                            }
                        }
                        frame = rx.recv() => {
                            let Ok(frame) = frame else { break };
                            if sink.send(tungstenite::Message::Text(frame)).await.is_err() {
                                break;
                            }
                        }
                    }
                }
                println!("  ← dashboard disconnected: {addr}");
            });
        }
    });

    // ── Main consensus loop ──────────────────────────────────────────────
    let engine = Arc::new(engine);
    let mut round: u64 = 0;
    while let Some(msg) = engine.recv_message().await? {
        let arrived = Instant::now();
        match msg {
            Message::Event(event) => {
                round += 1;
                let n = event.transaction_count();
                let mut txs = Vec::with_capacity(n);
                for i in 0..n {
                    let Some(bytes) = event.transaction(i) else { continue };
                    let tx_hash = short_hash(bytes);
                    let payload = match SwarmMessage::from_bytes(bytes) {
                        Ok(msg) => serde_json::to_value(&msg)
                            .unwrap_or(serde_json::Value::Null),
                        Err(_) => serde_json::json!({
                            "type": "Unknown",
                            "size": bytes.len(),
                        }),
                    };
                    txs.push(TxFrame { tx_hash, payload });
                }
                let latency_us = arrived.elapsed().as_micros() as u64;
                let frame = Frame::Consensus {
                    round,
                    tx_count: n,
                    latency_us,
                    transactions: txs,
                };
                if let Ok(s) = serde_json::to_string(&frame) {
                    let _ = tx.send(s);
                }
                println!("  [ROUND {round}] {n} tx · {latency_us}μs");
            }
            Message::SyncPoint(_) => {
                let frame = Frame::SyncPoint { round };
                if let Ok(s) = serde_json::to_string(&frame) {
                    let _ = tx.send(s);
                }
                println!("  ◈ sync @ round {round}");
            }
        }
    }
    Ok(())
}

fn short_hash(bytes: &[u8]) -> String {
    let mut h = DefaultHasher::new();
    bytes.hash(&mut h);
    format!("{:016x}", h.finish())
}
