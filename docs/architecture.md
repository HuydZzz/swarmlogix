# SwarmLogix — Architecture Document

## Overview

SwarmLogix implements a **fully decentralized** coordination layer for heterogeneous delivery fleets. The system eliminates central dispatchers by enabling agents to self-organize through 5 layered protocols running over the Vertex P2P mesh.

---

## Design Principles

1. **No Single Point of Failure** — Every agent is autonomous. No master node, no central server.
2. **Vendor-Neutral** — Agents from different companies (RoyalFleet, SwiftBot, AeroLink...) cooperate as one swarm.
3. **Local-First** — All coordination happens via local P2P communication. Cloud is optional, not required.
4. **Graceful Degradation** — When agents fail or networks degrade, the swarm adapts automatically.
5. **Safety-First** — Hazard alerts propagate instantly and override all other operations.

---

## Protocol Stack

```
┌─────────────────────────────────────────┐
│       APPLICATION LAYER                 │
│  Order Management, Fleet Dashboard      │
├─────────────────────────────────────────┤
│       COORDINATION LAYER                │
│  Auction Protocol  │  Handoff Protocol  │
│  Self-Healing      │  Safety Mesh       │
├─────────────────────────────────────────┤
│       DISCOVERY LAYER                   │
│  P2P Peer Discovery via Vertex          │
│  State Broadcasting & Sync             │
├─────────────────────────────────────────┤
│       TRANSPORT LAYER                   │
│  Vertex 2.0 P2P Mesh Network           │
│  Local-first, edge-native              │
└─────────────────────────────────────────┘
```

---

## Protocol 1: P2P Discovery

**Purpose**: Allow agents to find nearby peers and share state without a central registry.

**Mechanism**:
- Each agent broadcasts a state packet every tick:
  ```json
  {
    "agent_id": "a3f2c1",
    "type": "drone",
    "vendor": "RoyalFleet",
    "position": {"x": 234.5, "y": 167.2},
    "battery": 78.3,
    "capacity": 2.0,
    "load": 0.0,
    "status": "idle"
  }
  ```
- Agents within `comm_range` receive the broadcast and register the peer.
- Connection strength = `1 - (distance / comm_range)` — used for prioritization.

**Vertex Integration**:
- Uses `VertexNode.broadcast()` for state announcements
- Uses `VertexNode.on_peer_discovered()` for peer registration
- Runs on local network — no cloud round-trip

---

## Protocol 2: Auction-Based Task Assignment

**Purpose**: Assign delivery orders to the best available agent through decentralized bidding.

**Flow**:
1. New order enters the system (from API, sensor, or user request)
2. Order is broadcast to all agents within 1.5× communication range of pickup point
3. Eligible agents calculate a bid score:
   ```
   score = (proximity × 0.4) + (battery_level × 0.3) + (available_capacity × 0.3)
   ```
4. Bids are collected locally — no central auctioneer
5. Highest-scoring agent wins and is assigned the order
6. Total auction time: < 10ms (local P2P, no cloud)

**Eligibility Criteria**:
- Status = idle
- Not in safety mode
- Capacity ≥ order weight
- Battery > 20%
- Distance to pickup < 1.5 × communication range

**Why Auction vs. Central Assignment**:
- No single point of failure
- Naturally load-balances across vendors
- Scales horizontally — more agents = more bidders
- Works in disconnected/degraded networks

---

## Protocol 3: Multi-Hop Handoff

**Purpose**: Enable relay delivery for long distances or cross-environment handoffs (air → ground).

**Trigger Conditions**:
- Total delivery distance > 80% of agent's range
- Drone delivering to indoor location (needs ground robot)
- Agent battery insufficient for full trip

**Flow**:
1. Delivering agent detects handoff need
2. Calculates midpoint between current position and delivery
3. Searches for idle relay agents near midpoint
4. Selects relay with shortest distance to final delivery
5. Both agents navigate to handoff point
6. Order transfers: original agent releases, relay picks up
7. Relay completes the delivery

**Vertex Integration**:
- Handoff negotiation via `VertexNode.send_direct()` — P2P message between two agents
- State transfer via `VertexNode.sync_state()` — ensures order data moves with the package

---

## Protocol 4: Self-Healing Recovery

**Purpose**: Automatically recover from agent failures with zero downtime.

**Failure Types Handled**:
- Network loss (agent can't communicate)
- Hardware fault (motor, sensor failure)
- Battery death (0% charge)
- Software crash

**Recovery Flow**:
1. Agent status changes to `OFFLINE`
2. If agent had an active order:
   - Order status reverts to `PENDING`
   - Order re-enters the auction queue
   - Nearby agents bid and take over
3. Failed agent recovers after repair interval (3-6 seconds in simulation)
4. On recovery: agent rejoins mesh with refreshed battery, resumes idle state

**Key Metrics**:
- Recovery time: < 500ms for order reassignment
- Zero manual intervention required
- System maintains delivery throughput even with 20% agent failure rate

---

## Protocol 5: Safety Mesh

**Purpose**: Instant fleet-wide safety response when any agent detects a hazard.

**Hazard Types**:
- Weather event (storm, high wind for drones)
- Physical obstacle (road block, construction)
- System-wide alert (recall, emergency)

**Propagation**:
1. One agent detects hazard at position (x, y)
2. Broadcasts safety alert with radius via `VertexNode.broadcast_urgent()`
3. All agents within radius immediately:
   - Set `safety_mode = true`
   - Stop all movement
   - Cancel current navigation target
4. Alert persists for configured duration (4 seconds in simulation)
5. On clear: all agents resume normal operation

**Design Choices**:
- Safety alerts use `broadcast_urgent()` — highest priority in Vertex mesh
- Propagation is O(1) — direct broadcast, not hop-by-hop
- Safety mode overrides all other protocols (auction, delivery, handoff)
- No agent can opt out of safety freeze

---

## Agent Types

| Type | Speed | Capacity | Range | Best For |
|------|-------|----------|-------|----------|
| Drone ◈ | 3.5 | 2kg | 180m | Fast, short-distance, open-air |
| Robot ◉ | 1.2 | 5kg | 90m | Indoor, last-50-meter delivery |
| E-Bike ◆ | 2.5 | 8kg | 250m | Heavy loads, medium distance |

---

## State Machine: Agent Lifecycle

```
         ┌──────────────────┐
         │                  │
         ▼                  │
    ┌─────────┐        ┌────┴────┐
    │  IDLE   │───────▶│DELIVERING│
    └────┬────┘ auction └────┬────┘
         │    wins           │
         │                   │ arrives
    ┌────┴────┐        ┌────▼────┐
    │ FROZEN  │        │DELIVERED│
    │(safety) │        │ → IDLE  │
    └────┬────┘        └─────────┘
         │
         │ alert clears
         ▼
    ┌─────────┐        ┌─────────┐
    │  IDLE   │        │ OFFLINE │
    └─────────┘        │(failure)│
                       └────┬────┘
                            │ recovers
                            ▼
                       ┌─────────┐
                       │  IDLE   │
                       └─────────┘
```

---

## State Machine: Order Lifecycle

```
  PENDING → AUCTIONING → ASSIGNED → IN_TRANSIT → DELIVERED
                                  ↘
                              HANDOFF → IN_TRANSIT → DELIVERED
       ↑                          
       └── (agent fails: re-auction) ──┘
```

---

## Scalability Considerations

- **Agent count**: Tested with 5-50 agents. Discovery is O(n²) but bounded by comm_range (only local peers).
- **Order throughput**: ~15-25 deliveries per 500 ticks with 20 agents.
- **Network partitions**: Agents in disconnected clusters still coordinate locally.
- **Hot-join**: New agents can join the mesh at any time — no restart needed.

---

## Vertex SDK Mapping

| SwarmLogix Feature | Vertex SDK Component |
|-------------------|---------------------|
| State broadcast | `VertexNode.broadcast(state)` |
| Peer discovery | `VertexNode.on_peer_discovered(callback)` |
| Auction bids | `VertexNode.send_direct(peer_id, bid)` |
| Handoff negotiation | `VertexNode.send_direct(relay_id, handoff_plan)` |
| Safety alerts | `VertexNode.broadcast_urgent(alert)` |
| State sync | `VertexNode.sync_state(peer_id, state)` |

---

## Future Extensions

1. **Reputation system** — Agents build trust scores based on delivery success rate
2. **Dynamic pricing** — Auction bids include cost negotiation
3. **Route optimization** — Swarm-level path planning using shared traffic data
4. **Cross-zone federation** — Multiple SwarmLogix networks bridged at city scale
5. **Physical integration** — ROS2 bridge for real robots, MAVLink for real drones
