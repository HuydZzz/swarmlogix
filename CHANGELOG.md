# CHANGELOG

All notable changes to SwarmLogix are documented here.

## [0.4.0] - 2026-04-20

### Added
- `vertex/examples/vertex_bridge.rs` — an observer Vertex node that hosts a WebSocket server on `ws://127.0.0.1:8787` and streams every consensus-ordered transaction (round, tx_hash, payload, latency) to connected browsers.
- Dashboard now auto-connects to the bridge on load. A header badge flips between `◯ SIMULATION` and `● LIVE VERTEX`, and a new **Consensus** tab shows the live transaction stream.
- `tokio-tungstenite` + `futures-util` dependencies to power the bridge.

### Changed
- `index.html` redesigned: Inter + JetBrains Mono typography, larger readable type, grid-based layout, consensus-round stat card, improved agent table with pills, protocol cards refreshed, better colour accessibility on dark background.
- `run_swarm.sh` now generates **4** keypairs and launches the bridge alongside the 3 delivery nodes so the dashboard goes live out of the box.

## [0.3.1] - 2026-04-20

### Fixed
- `vertex/Cargo.toml` now pulls `tashi-vertex` from the official git repo (`github.com/tashigit/tashi-vertex-rs`) instead of a non-existent `"0.12"` crate — `cargo build` now resolves.
- Corrected `engine.recv_message()` loop to handle `Result<Option<Message>>` (was `Result<Message>`), and matched `Message::SyncPoint(_)` as a payload-carrying variant. Affects `swarm_node.rs`, `vertex_monitor.rs`, and `src/main.rs`.
- `src/main.rs` no longer calls `.clone()` on `KeySecret` (which does not impl `Clone`) — the secret is now round-tripped via its base58 `Display` / `FromStr` encoding.

### Added
- `vertex/examples/handshake.rs` — the Warmup Track Stateful Handshake demo (greeting, 2s heartbeat, role change, 10s stale detection, auto-recovery).
- `anyhow` dependency for ergonomic errors in the new example.

## [0.3.0] - 2026-04-15

### Added
- Multi-zone routing optimization — agents now calculate optimal paths across London zones
- Weighted auction scoring v2 — added traffic density and delivery urgency as bid factors
- Agent reputation system — agents build trust scores based on delivery success rate
- Vertex consensus latency monitoring — real-time tracking of BFT finality times
- Fleet capacity dashboard widget — shows aggregate fleet utilization across vendors

### Improved
- Auction convergence speed reduced from ~50ms to ~12ms average
- Handoff success rate improved to 94.7% (was 88.2%)
- Safety mesh propagation now sub-50ms for 20-node swarms
- Battery drain model updated with realistic curves per agent type

### Fixed
- Edge case where simultaneous handoff requests could deadlock two agents
- Safety zone radius calculation now accounts for agent velocity vectors
- Memory leak in event log when running simulations beyond 10,000 ticks

## [0.2.0] - 2026-04-11

### Added
- Tashi Vertex consensus integration (Rust) — real P2P BFT coordination
- SwarmMessage protocol with 11 message types via Vertex transactions
- 3-node Vertex swarm demo with automatic keypair generation
- `run_swarm.sh` launcher for quick multi-node testing
- Vercel deployment with live dashboard at swarmlogix.vercel.app

### Improved
- Dashboard redesigned with Tashi brand identity (orange #FF6B00, Space Mono)
- README updated with Vertex SDK integration documentation

## [0.1.0] - 2026-04-01

### Added
- Initial SwarmLogix engine with 5 core P2P protocols
- Python simulation engine with 15+ multi-vendor agents
- Interactive React dashboard with real-time Canvas visualization
- Protocol validation test suite (34/34 tests passing)
- WebSocket API server for real-time state streaming
- Architecture documentation
- London metro zones: Camden, Canary Wharf, Greenwich, Shoreditch
