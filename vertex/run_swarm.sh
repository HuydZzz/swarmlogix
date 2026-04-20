#!/bin/bash
# SwarmLogix — Launch 4-node Vertex P2P Swarm + Dashboard Bridge
# Run from the vertex/ directory: ./run_swarm.sh
#
# Starts three delivery agents (drone / robot / e-bike) plus a bridge
# node that observes consensus and streams it to the browser dashboard
# on ws://127.0.0.1:8787. Open ../index.html in a browser to go LIVE.

set -e

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║  SWARMLOGIX · 4-Node Vertex Swarm + Bridge       ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# Build first
echo "  Building SwarmLogix..."
cargo build --release --examples 2>&1 | tail -1
echo ""

# Generate 4 keypairs (3 delivery agents + 1 observer bridge)
echo "  Generating Vertex keypairs..."
gen() { cargo run --release --example key-generate 2>/dev/null; }
parse_secret() { echo "$1" | grep "Secret:" | awk '{print $2}'; }
parse_public() { echo "$1" | grep "Public:" | awk '{print $2}'; }

K1=$(gen); K1S=$(parse_secret "$K1"); K1P=$(parse_public "$K1")
K2=$(gen); K2S=$(parse_secret "$K2"); K2P=$(parse_public "$K2")
K3=$(gen); K3S=$(parse_secret "$K3"); K3P=$(parse_public "$K3")
K4=$(gen); K4S=$(parse_secret "$K4"); K4P=$(parse_public "$K4")

echo "  ✓ 4 keypairs generated"
echo ""
echo "  Launching swarm nodes..."
echo "  ─────────────────────────────────────"

# Every node knows about all 4 peers.
cargo run --release --example swarm-node -- \
  -B 127.0.0.1:9001 -K "$K1S" \
  -P "$K2P@127.0.0.1:9002" \
  -P "$K3P@127.0.0.1:9003" \
  -P "$K4P@127.0.0.1:9004" \
  --agent-type drone --vendor RoyalFleet --agent-id drone-001 &
PID1=$!

cargo run --release --example swarm-node -- \
  -B 127.0.0.1:9002 -K "$K2S" \
  -P "$K1P@127.0.0.1:9001" \
  -P "$K3P@127.0.0.1:9003" \
  -P "$K4P@127.0.0.1:9004" \
  --agent-type robot --vendor SwiftBot --agent-id robot-002 &
PID2=$!

cargo run --release --example swarm-node -- \
  -B 127.0.0.1:9003 -K "$K3S" \
  -P "$K1P@127.0.0.1:9001" \
  -P "$K2P@127.0.0.1:9002" \
  -P "$K4P@127.0.0.1:9004" \
  --agent-type ebike --vendor AeroLink --agent-id ebike-003 &
PID3=$!

# Bridge node — observer + WebSocket server for the dashboard.
cargo run --release --example vertex-bridge -- \
  -B 127.0.0.1:9004 -K "$K4S" \
  -P "$K1P@127.0.0.1:9001" \
  -P "$K2P@127.0.0.1:9002" \
  -P "$K3P@127.0.0.1:9003" \
  --ws-addr 127.0.0.1:8787 &
PID4=$!

echo "  ✓ 4 nodes launched (PIDs: $PID1 $PID2 $PID3 $PID4)"
echo ""
echo "  Dashboard: open ../index.html in a browser."
echo "  The badge will flip to ● LIVE VERTEX once it connects to ws://127.0.0.1:8787."
echo ""
echo "  Press Ctrl+C to stop all nodes"

# Cleanup on exit
trap "kill $PID1 $PID2 $PID3 $PID4 2>/dev/null; echo '  Swarm stopped.'" EXIT

# Wait for all
wait
