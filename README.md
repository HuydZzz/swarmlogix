# ◈ SwarmLogix

### P2P Last-Mile Delivery Coordination — Built on Tashi Vertex Consensus

> **Vertex Swarm Challenge 2026 · Track 3: The Agent Economy**

---

## Architecture

SwarmLogix runs each delivery agent as a **Tashi Vertex consensus node**. All coordination — orders, auctions, handoffs, safety alerts — flows as Vertex transactions with BFT consensus ordering. No central server, no cloud, no single point of failure.

```
┌──────────────────────────────────────────────────────┐
│                 SwarmLogix Network                    │
│                                                      │
│   Agent 1 (Vertex Node)  ←──P2P──→  Agent 2 (Vertex)│
│        ↕                                  ↕          │
│   Agent 3 (Vertex Node)  ←──P2P──→  Agent N (Vertex)│
│                                                      │
│   Every agent = Vertex node                          │
│   Every coordination message = Vertex transaction    │
│   Consensus ordering = all agents see same state     │
└──────────────────────────────────────────────────────┘
```

## Vertex Integration

### How Vertex is Used

| SwarmLogix Feature | Vertex Component |
|-------------------|-----------------|
| Agent discovery | `Engine::start()` — nodes join P2P mesh |
| State broadcast | `engine.send_transaction()` — AgentState messages |
| Auction bids | `engine.send_transaction()` — AuctionBid messages |
| Order assignment | Consensus-ordered — first valid bid wins |
| Handoff negotiation | `engine.send_transaction()` — HandoffRequest/Complete |
| Safety alerts | `engine.send_transaction()` — SafetyAlert propagation |
| Self-healing | `engine.recv_message()` — detect AgentFailure, re-auction |
| Consensus ordering | Vertex BFT ensures all nodes apply messages in same order |

### Message Types via Vertex Transactions

```rust
enum SwarmMessage {
    AgentState { agent_id, type, vendor, x, y, battery, capacity, status }
    OrderCreated { order_id, pickup, delivery, weight }
    AuctionBid { order_id, agent_id, score }
    AuctionWinner { order_id, winner_id }
    HandoffRequest { order_id, from_agent, to_agent, point }
    HandoffComplete { order_id, from_agent, to_agent }
    OrderDelivered { order_id, agent_id }
    AgentFailure { agent_id, reason }
    AgentRecovery { agent_id, battery }
    SafetyAlert { alert_id, x, y, radius }
    SafetyClear { alert_id }
}
```

## Quick Start

### Prerequisites

- Rust 1.75+ (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`)
- Tashi Vertex library (auto-fetched by cargo build)

### Run the 3-Node Swarm Demo

```bash
cd vertex
chmod +x run_swarm.sh
./run_swarm.sh
```

This generates 3 keypairs, launches 3 Vertex nodes (drone, robot, e-bike from different vendors), and shows consensus-ordered coordination events in real-time.

### Run Nodes Manually (separate terminals)

```bash
# Generate 3 keypairs
cd vertex
cargo run --example key-generate  # → KEY1_SECRET, KEY1_PUBLIC
cargo run --example key-generate  # → KEY2_SECRET, KEY2_PUBLIC
cargo run --example key-generate  # → KEY3_SECRET, KEY3_PUBLIC

# Terminal 1 — Drone (RoyalFleet)
cargo run --example swarm-node -- \
  -B 127.0.0.1:9001 -K <KEY1_SECRET> \
  -P <KEY2_PUBLIC>@127.0.0.1:9002 \
  -P <KEY3_PUBLIC>@127.0.0.1:9003 \
  --agent-type drone --vendor RoyalFleet --agent-id drone-001

# Terminal 2 — Robot (SwiftBot)
cargo run --example swarm-node -- \
  -B 127.0.0.1:9002 -K <KEY2_SECRET> \
  -P <KEY1_PUBLIC>@127.0.0.1:9001 \
  -P <KEY3_PUBLIC>@127.0.0.1:9003 \
  --agent-type robot --vendor SwiftBot --agent-id robot-002

# Terminal 3 — E-Bike (AeroLink)
cargo run --example swarm-node -- \
  -B 127.0.0.1:9003 -K <KEY3_SECRET> \
  -P <KEY1_PUBLIC>@127.0.0.1:9001 \
  -P <KEY2_PUBLIC>@127.0.0.1:9002 \
  --agent-type ebike --vendor AeroLink --agent-id ebike-003
```

### Run the Dashboard

```bash
# Open index.html in browser for real-time visualization
open index.html
```

### Run Protocol Tests (Python simulation)

```bash
cd src
python3 test_protocols.py
```

## Project Structure

```
swarmlogix/
├── vertex/                      # ← VERTEX INTEGRATION (Rust)
│   ├── Cargo.toml               # tashi-vertex dependency
│   ├── src/
│   │   ├── lib.rs               # SwarmMessage types + SwarmState
│   │   └── main.rs              # Multi-node demo
│   ├── examples/
│   │   ├── key_generate.rs      # Generate Vertex keypairs
│   │   └── swarm_node.rs        # Single agent Vertex node
│   └── run_swarm.sh             # Launch 3-node swarm
├── src/
│   ├── swarmlogix_engine.py     # Python simulation engine
│   ├── test_protocols.py        # Protocol validation (34 tests)
│   └── api_server.py            # WebSocket API
├── dashboard.jsx                # React dashboard
├── index.html                   # Standalone HTML dashboard
├── docs/
│   └── architecture.md          # Detailed architecture
└── README.md
```

## 5 Core Protocols (via Vertex)

| # | Protocol | Vertex Usage |
|---|----------|-------------|
| 01 | **P2P Discovery** | Each agent = Vertex node. `Engine::start()` forms P2P mesh. AgentState broadcast via transactions. |
| 02 | **Auction Protocol** | Orders + bids submitted as Vertex transactions. BFT consensus determines ordering → first highest bid wins. |
| 03 | **Multi-Hop Handoff** | HandoffRequest/Complete transactions. Consensus ensures both agents agree on the handoff. |
| 04 | **Self-Healing** | AgentFailure transaction triggers re-auction. All nodes see failure in same order → consistent recovery. |
| 05 | **Safety Mesh** | SafetyAlert transaction propagates via Vertex. Sub-100ms consensus finality → instant fleet freeze. |

## Why Vertex

- **Sub-100ms BFT consensus** — auctions resolve faster than cloud round-trips
- **No central server** — every agent is a peer, tolerates up to ⌊(n-1)/3⌋ Byzantine failures
- **Total ordering** — all agents apply messages in the same sequence, guaranteeing consistent state
- **Vendor-neutral** — agents from different companies join the same Vertex mesh

## Tech Stack

- **Coordination**: Tashi Vertex 0.12 (Rust, BFT consensus)
- **Simulation**: Python 3.11+ (protocol validation)
- **Dashboard**: React + Canvas API (real-time visualization)
- **API**: WebSocket (state streaming)

---

*The future of autonomy is peer-to-peer. Built on Tashi Vertex.* ◈
