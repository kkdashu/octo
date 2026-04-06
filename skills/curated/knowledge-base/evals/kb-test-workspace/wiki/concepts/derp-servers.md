# DERP Servers

## Summary

DERP (Detour/Echo Relay Protocol) servers are Tailscale's relay infrastructure. They serve two purposes: helping nodes discover each other's public addresses, and relaying traffic when direct peer-to-peer connections aren't possible.

## Key Points

- **Not a proxy for all traffic** — only used as a fallback when NAT traversal fails
- **Two roles:** address discovery + traffic relay
- **Run by Tailscale** (with community-hosted options)
- **How NAT traversal works:**
  1. Node sends STUN request → learns its public IP:port
  2. Node registers with DERP → DERP learns both nodes' addresses
  3. DERP tells each node about the other
  4. Nodes attempt direct UDP connection (hole punching)
  5. If direct connection fails → fall back to DERP relay

### NAT Traversal Success Rates

| NAT Type | Direct Connection | Via DERP |
|----------|------------------|----------|
| Full cone | ✅ Always | ✅ |
| Restricted cone | ✅ Usually | ✅ |
| Symmetric NAT | ❌ Rarely | ✅ |

### DERP vs. Exit Node

- **DERP:** automatic, invisible fallback for peer traffic
- **Exit node:** explicit routing of all internet traffic through a specific node

## Related Concepts

- [[nat-traversal]] — the full NAT traversal process
- [[tailscale]] — runs the DERP network
- [[exit-nodes]] — deliberate traffic routing
- [[wireguard]] — the underlying tunnel protocol
