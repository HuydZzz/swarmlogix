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

- **Rust 1.75+** — `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- **CMake ≥ 4.0** — required by the `tashi-vertex` build script
- **git** — `tashi-vertex` is fetched directly from [tashigit/tashi-vertex-rs](https://github.com/tashigit/tashi-vertex-rs) (see `vertex/Cargo.toml`)

Build everything once:

```bash
cd vertex && cargo build --release --examples
```

### Warm Up · Stateful Handshake (Track 0)

Two-node P2P handshake on Vertex — proves peer discovery, heartbeat, role propagation <1s, stale detection after 10s, and auto-recovery. Matches the requirements from [tashigit/warmup-vertex-rust](https://github.com/tashigit/warmup-vertex-rust).

```bash
cd vertex

# 1. Generate two keypairs (run twice, keep the outputs)
cargo run --release --example handshake -- gen-key
cargo run --release --example handshake -- gen-key

# 2. Terminal A — node "alpha" as coordinator
cargo run --release --example handshake -- run \
    --bind 127.0.0.1:9100 \
    --secret <SECRET_A> \
    --peer-addr 127.0.0.1:9101 \
    --peer-pubkey <PUBKEY_B> \
    --node-id alpha --role coordinator

# 3. Terminal B — node "beta" as worker
cargo run --release --example handshake -- run \
    --bind 127.0.0.1:9101 \
    --secret <SECRET_B> \
    --peer-addr 127.0.0.1:9100 \
    --peer-pubkey <PUBKEY_A> \
    --node-id beta --role worker
```

Expected output (truncated):

```
  ✓ Vertex engine online
  → GREETING sent as Vertex tx
  [GREETING]  alpha (self) role=coordinator latency=1ms
  [GREETING]  beta (peer) role=worker latency=3ms
  ◈ SYNC POINT — 2 peer(s) in replicated state
  [HEARTBEAT] beta seq=1 latency=4ms
  [HEARTBEAT] beta seq=2 latency=3ms
  [ROLE]      beta → coordinator (propagated in 6ms)   # after pressing `p` in beta
  [STALE]     beta no heartbeat for 10.4s              # after killing beta
  [RECOVER]   beta reconnected — state resynced        # after restarting beta
```

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

### Run the Live Dashboard (connected to real Vertex)

The dashboard auto-detects the Vertex WebSocket bridge. Start the swarm and open the page — the header badge flips from `◯ SIMULATION` to `● LIVE VERTEX` as soon as the bridge is reachable.

```bash
# Terminal 1 — start 3 delivery nodes + bridge (auto-generates 4 keypairs)
cd vertex && ./run_swarm.sh

# Terminal 2 — open the dashboard
open ../index.html
```

Under the hood:

- `vertex/examples/vertex_bridge.rs` joins the mesh as a 4th Vertex peer (read-only observer) and runs a WebSocket server on `ws://127.0.0.1:8787`.
- Every consensus-ordered transaction is broadcast as JSON `{ round, tx_hash, payload, latency_us }`.
- The dashboard's **Consensus** tab renders the live tx stream; the **Mesh Event Log** interleaves simulation events with real `[VERTEX]` events prefixed with their round number.

If you just want to explore the UI without running Rust, open `index.html` directly — the built-in simulation engine keeps rendering with the badge showing `SIMULATION`.

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
│   │   ├── handshake.rs         # Warmup Track — 2-node stateful handshake
│   │   ├── swarm_node.rs        # Single agent Vertex node
│   │   └── vertex_monitor.rs    # Consensus latency observer
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

- **Coordination**: Tashi Vertex (Rust, BFT consensus) — pulled from `github.com/tashigit/tashi-vertex-rs`
- **Simulation**: Python 3.11+ (protocol validation)
- **Dashboard**: React + Canvas API (real-time visualization)
- **API**: WebSocket (state streaming)

## Tracks Covered

| Track | Status | Artifact |
| --- | --- | --- |
| Warm Up · Stateful Handshake | ✅ | `vertex/examples/handshake.rs` |
| Track 3 · Agent Economy | ✅ | `vertex/examples/swarm_node.rs` + `vertex/src/main.rs` |

---

*The future of autonomy is peer-to-peer. Built on Tashi Vertex.* ◈
