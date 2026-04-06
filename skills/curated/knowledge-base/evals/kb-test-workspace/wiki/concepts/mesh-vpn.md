# Mesh VPN

## Summary

A mesh VPN (Virtual Private Network) creates direct encrypted tunnels between all connected devices, enabling optimal routing without a central hub. Each device can connect to every other device directly, and traffic takes the shortest path.

## Key Points

- **Mesh topology** — every node connects to every other node (logically); no central gateway
- **Optimal routing** — traffic goes directly from source to destination, minimizing latency
- **No single point of failure** — losing one node doesn't break the network
- **vs. Hub-and-spoke** — traditional VPN forces all traffic through a central concentrator

### Hub-and-Spoke Problem

In traditional VPN:
1. User in New York → VPN concentrator in San Francisco
2. VPN concentrator → Server in New York
3. Result: unnecessary round-trip adding ~60-100ms latency

In mesh VPN:
1. User in New York → Server in New York
2. Direct connection, minimal latency

### When Mesh Works Best

- Devices are distributed across multiple geographic locations
- You need low latency between all endpoints
- You have multiple cloud VPCs or office networks
- You want to avoid a single point of failure

## Related Concepts

- [[wireguard]] — the underlying protocol
- [[tailscale]] — a commercial mesh VPN built on WireGuard
- [[zerotier]] — another mesh VPN option
- [[exit-nodes]] — where mesh nodes can route internet traffic
- [[subnet-routers]] — extending mesh to non-mesh networks
