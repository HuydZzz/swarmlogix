//! SwarmLogix Vertex Integration
//!
//! Uses Tashi Vertex BFT consensus to coordinate delivery agents P2P.
//! Each agent runs a Vertex node. All coordination messages (orders, bids,
//! handoffs, safety alerts) are submitted as transactions and ordered by
//! consensus — no central server needed.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Message types that flow through the Vertex consensus layer
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum SwarmMessage {
    /// Agent broadcasts its current state to the mesh
    AgentState {
        agent_id: String,
        agent_type: String,
        vendor: String,
        x: f64,
        y: f64,
        battery: f64,
        capacity: f64,
        load: f64,
        status: String,
    },

    /// New delivery order enters the system
    OrderCreated {
        order_id: String,
        pickup_x: f64,
        pickup_y: f64,
        deliver_x: f64,
        deliver_y: f64,
        weight: f64,
    },

    /// Agent submits a bid for an order (P2P auction)
    AuctionBid {
        order_id: String,
        agent_id: String,
        vendor: String,
        score: f64,
    },

    /// Auction winner is determined by consensus ordering
    AuctionWinner {
        order_id: String,
        winner_id: String,
    },

    /// Handoff request between two agents
    HandoffRequest {
        order_id: String,
        from_agent: String,
        to_agent: String,
        handoff_x: f64,
        handoff_y: f64,
    },

    /// Handoff completed confirmation
    HandoffComplete {
        order_id: String,
        from_agent: String,
        to_agent: String,
    },

    /// Order delivered confirmation
    OrderDelivered {
        order_id: String,
        agent_id: String,
    },

    /// Agent failure detected
    AgentFailure {
        agent_id: String,
        reason: String,
    },

    /// Agent recovery
    AgentRecovery {
        agent_id: String,
        battery: f64,
    },

    /// Safety alert propagated through mesh
    SafetyAlert {
        alert_id: String,
        x: f64,
        y: f64,
        radius: f64,
    },

    /// Safety alert cleared
    SafetyClear {
        alert_id: String,
    },
}

impl SwarmMessage {
    /// Serialize message to bytes for Vertex transaction
    pub fn to_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("Failed to serialize SwarmMessage")
    }

    /// Deserialize message from Vertex transaction bytes
    pub fn from_bytes(data: &[u8]) -> Result<Self, serde_json::Error> {
        serde_json::from_slice(data)
    }
}

/// Tracks consensus-ordered state for the swarm
#[derive(Debug, Default)]
pub struct SwarmState {
    pub agents: HashMap<String, AgentInfo>,
    pub orders: HashMap<String, OrderInfo>,
    pub pending_bids: HashMap<String, Vec<BidInfo>>,
    pub delivered_count: u64,
    pub auction_count: u64,
    pub handoff_count: u64,
    pub heal_count: u64,
    pub safety_count: u64,
}

#[derive(Debug, Clone)]
pub struct AgentInfo {
    pub agent_id: String,
    pub agent_type: String,
    pub vendor: String,
    pub x: f64,
    pub y: f64,
    pub battery: f64,
    pub capacity: f64,
    pub load: f64,
    pub status: String,
}

#[derive(Debug, Clone)]
pub struct OrderInfo {
    pub order_id: String,
    pub pickup_x: f64,
    pub pickup_y: f64,
    pub deliver_x: f64,
    pub deliver_y: f64,
    pub weight: f64,
    pub status: String,
    pub assigned_agent: Option<String>,
}

#[derive(Debug, Clone)]
pub struct BidInfo {
    pub agent_id: String,
    pub vendor: String,
    pub score: f64,
}

impl SwarmState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Apply a consensus-ordered message to update swarm state.
    /// Because Vertex guarantees total ordering, all nodes will
    /// apply messages in the same order and reach the same state.
    pub fn apply(&mut self, msg: &SwarmMessage) {
        match msg {
            SwarmMessage::AgentState {
                agent_id, agent_type, vendor, x, y, battery, capacity, load, status,
            } => {
                self.agents.insert(agent_id.clone(), AgentInfo {
                    agent_id: agent_id.clone(),
                    agent_type: agent_type.clone(),
                    vendor: vendor.clone(),
                    x: *x, y: *y, battery: *battery,
                    capacity: *capacity, load: *load,
                    status: status.clone(),
                });
            }

            SwarmMessage::OrderCreated {
                order_id, pickup_x, pickup_y, deliver_x, deliver_y, weight,
            } => {
                self.orders.insert(order_id.clone(), OrderInfo {
                    order_id: order_id.clone(),
                    pickup_x: *pickup_x, pickup_y: *pickup_y,
                    deliver_x: *deliver_x, deliver_y: *deliver_y,
                    weight: *weight, status: "pending".into(),
                    assigned_agent: None,
                });
                self.pending_bids.insert(order_id.clone(), Vec::new());
            }

            SwarmMessage::AuctionBid { order_id, agent_id, vendor, score } => {
                if let Some(bids) = self.pending_bids.get_mut(order_id) {
                    bids.push(BidInfo {
                        agent_id: agent_id.clone(),
                        vendor: vendor.clone(),
                        score: *score,
                    });
                }
            }

            SwarmMessage::AuctionWinner { order_id, winner_id } => {
                if let Some(order) = self.orders.get_mut(order_id) {
                    order.status = "assigned".into();
                    order.assigned_agent = Some(winner_id.clone());
                }
                self.pending_bids.remove(order_id);
                self.auction_count += 1;
            }

            SwarmMessage::HandoffComplete { order_id, to_agent, .. } => {
                if let Some(order) = self.orders.get_mut(order_id) {
                    order.assigned_agent = Some(to_agent.clone());
                }
                self.handoff_count += 1;
            }

            SwarmMessage::OrderDelivered { order_id, .. } => {
                if let Some(order) = self.orders.get_mut(order_id) {
                    order.status = "delivered".into();
                }
                self.delivered_count += 1;
            }

            SwarmMessage::AgentFailure { agent_id, .. } => {
                if let Some(agent) = self.agents.get_mut(agent_id) {
                    agent.status = "offline".into();
                }
                // Re-auction any order this agent was handling
                for order in self.orders.values_mut() {
                    if order.assigned_agent.as_deref() == Some(agent_id) {
                        order.status = "pending".into();
                        order.assigned_agent = None;
                        self.heal_count += 1;
                    }
                }
            }

            SwarmMessage::AgentRecovery { agent_id, battery } => {
                if let Some(agent) = self.agents.get_mut(agent_id) {
                    agent.status = "idle".into();
                    agent.battery = *battery;
                }
            }

            SwarmMessage::SafetyAlert { .. } => {
                self.safety_count += 1;
            }

            _ => {}
        }
    }
}
