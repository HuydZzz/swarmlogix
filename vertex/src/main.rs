//! SwarmLogix Multi-Node Demo
//!
//! Runs 3 Vertex consensus nodes in a single process to demonstrate
//! P2P delivery coordination without any central server.
//!
//! Usage:
//!   cargo run

use swarmlogix_vertex::{SwarmMessage, SwarmState};
use tashi_vertex::{Context, Engine, KeySecret, Message, Options, Peers, Socket, Transaction};
use std::sync::Arc;
use tokio::sync::Mutex;

const NUM_AGENTS: usize = 3;
const BASE_PORT: u16 = 9001;

struct AgentConfig {
    id: String,
    agent_type: String,
    vendor: String,
    port: u16,
    secret: KeySecret,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!();
    println!("╔══════════════════════════════════════════════════════╗");
    println!("║  SWARMLOGIX · Multi-Node Vertex Consensus Demo      ║");
    println!("║  P2P Last-Mile Delivery Coordination                ║");
    println!("║  Built on Tashi Vertex · No Central Server          ║");
    println!("╚══════════════════════════════════════════════════════╝");
    println!();

    // Generate keypairs for each agent
    let agents: Vec<AgentConfig> = vec![
        AgentConfig {
            id: "drone-001".into(),
            agent_type: "drone".into(),
            vendor: "RoyalFleet".into(),
            port: BASE_PORT,
            secret: KeySecret::generate(),
        },
        AgentConfig {
            id: "robot-002".into(),
            agent_type: "robot".into(),
            vendor: "SwiftBot".into(),
            port: BASE_PORT + 1,
            secret: KeySecret::generate(),
        },
        AgentConfig {
            id: "ebike-003".into(),
            agent_type: "ebike".into(),
            vendor: "AeroLink".into(),
            port: BASE_PORT + 2,
            secret: KeySecret::generate(),
        },
    ];

    println!("  Initializing {} Vertex nodes...", agents.len());
    for a in &agents {
        println!("    ◈ {} ({}/{}) on 127.0.0.1:{}", a.id, a.vendor, a.agent_type, a.port);
    }
    println!();

    // Collect all public keys for peer setup
    let pub_keys: Vec<_> = agents.iter()
        .map(|a| (format!("127.0.0.1:{}", a.port), a.secret.public()))
        .collect();

    // Shared state (all nodes converge to same state via consensus)
    let state = Arc::new(Mutex::new(SwarmState::new()));

    // Start each agent as a Vertex node
    let mut handles = Vec::new();

    for agent in &agents {
        let bind_addr = format!("127.0.0.1:{}", agent.port);
        let agent_id = agent.id.clone();
        let agent_type = agent.agent_type.clone();
        let vendor = agent.vendor.clone();
        let secret = agent.secret.clone();
        let pub_keys = pub_keys.clone();
        let state = Arc::clone(&state);

        let handle = tokio::spawn(async move {
            // Setup peers
            let context = Context::new().unwrap();
            let mut peers = Peers::new().unwrap();

            for (addr, pk) in &pub_keys {
                peers.insert(addr, pk, Default::default()).unwrap();
            }

            // Bind socket and start engine
            let socket = Socket::bind(&context, &bind_addr).await.unwrap();
            let options = Options::default();
            let engine = Engine::start(
                &context, socket, options, &secret, peers, false
            ).unwrap();

            println!("  ✓ {} started on {}", agent_id, bind_addr);

            // Broadcast initial agent state
            let init_msg = SwarmMessage::AgentState {
                agent_id: agent_id.clone(),
                agent_type: agent_type.clone(),
                vendor: vendor.clone(),
                x: 100.0 + (agent.port as f64 - BASE_PORT as f64) * 200.0,
                y: 200.0,
                battery: 90.0,
                capacity: match agent_type.as_str() {
                    "drone" => 2.0, "robot" => 5.0, "ebike" => 8.0, _ => 5.0,
                },
                load: 0.0,
                status: "idle".into(),
            };

            let data = init_msg.to_bytes();
            let mut tx = Transaction::allocate(data.len());
            tx.copy_from_slice(&data);
            engine.send_transaction(tx).unwrap();

            // Send a test order from the first node
            if agent.port == BASE_PORT {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;

                let order_msg = SwarmMessage::OrderCreated {
                    order_id: "ord-0001".into(),
                    pickup_x: 150.0,
                    pickup_y: 200.0,
                    deliver_x: 600.0,
                    deliver_y: 350.0,
                    weight: 1.5,
                };
                let data = order_msg.to_bytes();
                let mut tx = Transaction::allocate(data.len());
                tx.copy_from_slice(&data);
                engine.send_transaction(tx).unwrap();

                // Submit a bid
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                let bid_msg = SwarmMessage::AuctionBid {
                    order_id: "ord-0001".into(),
                    agent_id: agent_id.clone(),
                    vendor: vendor.clone(),
                    score: 0.85,
                };
                let data = bid_msg.to_bytes();
                let mut tx = Transaction::allocate(data.len());
                tx.copy_from_slice(&data);
                engine.send_transaction(tx).unwrap();
            }

            // Submit bids from other nodes
            if agent.port == BASE_PORT + 1 {
                tokio::time::sleep(std::time::Duration::from_millis(800)).await;
                let bid_msg = SwarmMessage::AuctionBid {
                    order_id: "ord-0001".into(),
                    agent_id: agent_id.clone(),
                    vendor: vendor.clone(),
                    score: 0.72,
                };
                let data = bid_msg.to_bytes();
                let mut tx = Transaction::allocate(data.len());
                tx.copy_from_slice(&data);
                engine.send_transaction(tx).unwrap();
            }

            // Receive consensus-ordered messages
            loop {
                match engine.recv_message().await {
                    Ok(Message::Event(event)) => {
                        let tx_count = event.transaction_count();
                        for i in 0..tx_count {
                            if let Some(tx_data) = event.transaction(i) {
                                if let Ok(msg) = SwarmMessage::from_bytes(tx_data) {
                                    let mut s = state.lock().await;
                                    s.apply(&msg);
                                    // Only first node prints to avoid duplicates
                                    if agent.port == BASE_PORT {
                                        print_consensus_event(&msg, &s);
                                    }
                                }
                            }
                        }
                    }
                    Ok(Message::SyncPoint) => {
                        if agent.port == BASE_PORT {
                            println!("  ◈ SYNC POINT — consensus reached");
                        }
                    }
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
        });
        handles.push(handle);
    }

    // Wait for all nodes
    for h in handles {
        h.await?;
    }

    Ok(())
}

fn print_consensus_event(msg: &SwarmMessage, state: &SwarmState) {
    match msg {
        SwarmMessage::AgentState { agent_id, vendor, agent_type, .. } => {
            println!("  [CONSENSUS] Agent {} ({}/{}) discovered | mesh: {} nodes",
                agent_id, vendor, agent_type, state.agents.len());
        }
        SwarmMessage::OrderCreated { order_id, weight, .. } => {
            println!("  [CONSENSUS] Order {} created — {:.1}kg", order_id, weight);
        }
        SwarmMessage::AuctionBid { order_id, agent_id, score, .. } => {
            println!("  [CONSENSUS] Bid: {} → order {} (score {:.3})", agent_id, order_id, score);
        }
        SwarmMessage::AuctionWinner { order_id, winner_id } => {
            println!("  [CONSENSUS] ✓ Winner: {} for order {}", winner_id, order_id);
        }
        SwarmMessage::OrderDelivered { order_id, .. } => {
            println!("  [CONSENSUS] ✓ Order {} delivered | total: {}", order_id, state.delivered_count);
        }
        SwarmMessage::SafetyAlert { alert_id, .. } => {
            println!("  [CONSENSUS] 🛡 Safety alert {}", alert_id);
        }
        _ => {}
    }
}
