//! SwarmLogix Delivery Agent Node — runs on Tashi Vertex P2P Consensus
//!
//! Each agent is a Vertex node. Orders, bids, handoffs, and safety alerts
//! are submitted as transactions. Vertex's BFT consensus ensures all agents
//! see the same ordered sequence — no central dispatcher needed.
//!
//! Usage (3-node swarm):
//!   # Terminal 1 - generate 3 keypairs
//!   cargo run --example key-generate   # save as KEY1_SECRET, KEY1_PUBLIC
//!   cargo run --example key-generate   # save as KEY2_SECRET, KEY2_PUBLIC
//!   cargo run --example key-generate   # save as KEY3_SECRET, KEY3_PUBLIC
//!
//!   # Terminal 1 - Agent 1 (Drone, RoyalFleet)
//!   cargo run --example swarm-node -- \
//!     -B 127.0.0.1:9001 -K <KEY1_SECRET> \
//!     -P <KEY2_PUBLIC>@127.0.0.1:9002 \
//!     -P <KEY3_PUBLIC>@127.0.0.1:9003 \
//!     --agent-type drone --vendor RoyalFleet --agent-id agent-001
//!
//!   # Terminal 2 - Agent 2 (Robot, SwiftBot)
//!   cargo run --example swarm-node -- \
//!     -B 127.0.0.1:9002 -K <KEY2_SECRET> \
//!     -P <KEY1_PUBLIC>@127.0.0.1:9001 \
//!     -P <KEY3_PUBLIC>@127.0.0.1:9003 \
//!     --agent-type robot --vendor SwiftBot --agent-id agent-002
//!
//!   # Terminal 3 - Agent 3 (E-Bike, AeroLink)
//!   cargo run --example swarm-node -- \
//!     -B 127.0.0.1:9003 -K <KEY3_SECRET> \
//!     -P <KEY1_PUBLIC>@127.0.0.1:9001 \
//!     -P <KEY2_PUBLIC>@127.0.0.1:9002 \
//!     --agent-type ebike --vendor AeroLink --agent-id agent-003

use clap::Parser;
use swarmlogix_vertex::{SwarmMessage, SwarmState};
use tashi_vertex::{Context, Engine, KeySecret, Message, Options, Peers, Socket, Transaction};

#[derive(Parser)]
#[command(name = "swarm-node")]
#[command(about = "SwarmLogix delivery agent running on Tashi Vertex consensus")]
struct Args {
    /// Local bind address (e.g., 127.0.0.1:9001)
    #[arg(short = 'B', long)]
    bind: String,

    /// This node's secret key (Base58)
    #[arg(short = 'K', long)]
    key: String,

    /// Peer addresses: PUBLIC_KEY@HOST:PORT (can specify multiple)
    #[arg(short = 'P', long, num_args = 1..)]
    peer: Vec<String>,

    /// Agent type: drone, robot, ebike
    #[arg(long, default_value = "drone")]
    agent_type: String,

    /// Vendor name
    #[arg(long, default_value = "RoyalFleet")]
    vendor: String,

    /// Agent ID
    #[arg(long, default_value = "agent-001")]
    agent_id: String,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();

    println!("╔══════════════════════════════════════════════════╗");
    println!("║  SWARMLOGIX · Vertex P2P Delivery Coordination  ║");
    println!("╚══════════════════════════════════════════════════╝");
    println!();
    println!("  Agent ID:   {}", args.agent_id);
    println!("  Type:       {}", args.agent_type);
    println!("  Vendor:     {}", args.vendor);
    println!("  Bind:       {}", args.bind);
    println!("  Peers:      {}", args.peer.len());
    println!();

    // Parse secret key
    let key: KeySecret = args.key.parse()
        .expect("Invalid secret key. Generate one with: cargo run --example key-generate");

    // Configure peers
    let mut peers = Peers::new()?;
    // Add self
    peers.insert(&args.bind, &key.public(), Default::default())?;
    // Add remote peers
    for peer_str in &args.peer {
        let parts: Vec<&str> = peer_str.split('@').collect();
        if parts.len() != 2 {
            eprintln!("Invalid peer format: {peer_str}. Use PUBLIC_KEY@HOST:PORT");
            continue;
        }
        let peer_key = parts[0].parse()
            .expect("Invalid peer public key");
        peers.insert(parts[1], &peer_key, Default::default())?;
    }

    // Initialize Vertex runtime
    let context = Context::new()?;
    let socket = Socket::bind(&context, &args.bind).await?;
    println!("  ✓ Vertex socket bound to {}", args.bind);

    // Start consensus engine
    let options = Options::default();
    let joining_running_session = false;
    let engine = Engine::start(
        &context, socket, options, &key, peers, joining_running_session
    )?;
    println!("  ✓ Vertex consensus engine started");
    println!("  ✓ Waiting for peer connections...");
    println!();

    // Create swarm state tracker
    let mut state = SwarmState::new();

    // Broadcast initial agent state as a Vertex transaction
    let init_msg = SwarmMessage::AgentState {
        agent_id: args.agent_id.clone(),
        agent_type: args.agent_type.clone(),
        vendor: args.vendor.clone(),
        x: rand_f64(40.0, 780.0),
        y: rand_f64(40.0, 460.0),
        battery: rand_f64(70.0, 100.0),
        capacity: match args.agent_type.as_str() {
            "drone" => 2.0,
            "robot" => 5.0,
            "ebike" => 8.0,
            _ => 5.0,
        },
        load: 0.0,
        status: "idle".into(),
    };

    send_message(&engine, &init_msg)?;
    println!("  → Broadcast initial state via Vertex");

    // Main loop: receive consensus-ordered messages
    println!();
    println!("  ═══ LISTENING FOR CONSENSUS EVENTS ═══");
    println!();

    while let Some(msg) = engine.recv_message().await? {
        match msg {
            Message::Event(event) => {
                // Process each transaction in the consensus-ordered event
                let tx_count = event.transaction_count();
                for i in 0..tx_count {
                    if let Some(tx_data) = event.transaction(i) {
                        if let Ok(msg) = SwarmMessage::from_bytes(tx_data) {
                            // Apply to local state — all nodes apply in same order
                            state.apply(&msg);
                            print_message(&msg, &state);
                        }
                    }
                }
            }
            Message::SyncPoint(_) => {
                println!("  ◈ SYNC POINT — all nodes aligned");
            }
        }
    }

    Ok(())
}

/// Send a SwarmMessage as a Vertex transaction
fn send_message(engine: &Engine, msg: &SwarmMessage) -> Result<(), Box<dyn std::error::Error>> {
    let data = msg.to_bytes();
    let mut tx = Transaction::allocate(data.len());
    tx.copy_from_slice(&data);
    engine.send_transaction(tx)?;
    Ok(())
}

/// Pretty-print a consensus-ordered message
fn print_message(msg: &SwarmMessage, state: &SwarmState) {
    match msg {
        SwarmMessage::AgentState { agent_id, agent_type, vendor, .. } => {
            println!("  [DISCOVERY] {} ({}/{}) joined the mesh | total: {} agents",
                agent_id, vendor, agent_type, state.agents.len());
        }
        SwarmMessage::OrderCreated { order_id, weight, .. } => {
            println!("  [ORDER]     New order {} — {:.1}kg | pending: {}",
                &order_id[..4.min(order_id.len())], weight, state.orders.len());
        }
        SwarmMessage::AuctionBid { order_id, agent_id, score, vendor } => {
            println!("  [BID]       {} bids on order {} — score {:.3} ({})",
                agent_id, &order_id[..4.min(order_id.len())], score, vendor);
        }
        SwarmMessage::AuctionWinner { order_id, winner_id } => {
            println!("  [AUCTION]   ✓ Order {} → {} wins | total auctions: {}",
                &order_id[..4.min(order_id.len())], winner_id, state.auction_count);
        }
        SwarmMessage::HandoffComplete { order_id, from_agent, to_agent } => {
            println!("  [HANDOFF]   ✓ {} → {} for order {} | total: {}",
                from_agent, to_agent, &order_id[..4.min(order_id.len())], state.handoff_count);
        }
        SwarmMessage::OrderDelivered { order_id, agent_id } => {
            println!("  [DELIVERED] ✓ Order {} by {} | total: {}",
                &order_id[..4.min(order_id.len())], agent_id, state.delivered_count);
        }
        SwarmMessage::AgentFailure { agent_id, reason } => {
            println!("  [FAULT]     ⚠ {} offline ({}) | self-heals: {}",
                agent_id, reason, state.heal_count);
        }
        SwarmMessage::AgentRecovery { agent_id, battery } => {
            println!("  [HEAL]      ✓ {} recovered ({:.0}%)", agent_id, battery);
        }
        SwarmMessage::SafetyAlert { alert_id, radius, .. } => {
            println!("  [SAFETY]    🛡 Alert {} — {:.0}m radius | total: {}",
                &alert_id[..4.min(alert_id.len())], radius, state.safety_count);
        }
        SwarmMessage::SafetyClear { alert_id } => {
            println!("  [SAFETY]    ✓ Alert {} cleared", &alert_id[..4.min(alert_id.len())]);
        }
        _ => {}
    }
}

fn rand_f64(lo: f64, hi: f64) -> f64 {
    use std::time::SystemTime;
    let seed = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .subsec_nanos() as f64
        / u32::MAX as f64;
    lo + seed * (hi - lo)
}
