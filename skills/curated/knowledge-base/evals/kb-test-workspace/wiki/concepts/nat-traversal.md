# NAT Traversal

## Summary

NAT (Network Address Translation) traversal is the technique of establishing direct peer-to-peer connections between devices that are behind firewalls or NATs. Tailscale uses STUN, ICE, and DERP servers to achieve this, falling back to relays when direct connection isn't possible.

## Key Points

### NAT Types and Challenges

Most home and office devices are behind NAT:
- **Full cone NAT:** any external host can send to the internal host (easiest)
- **Restricted cone NAT:** only hosts you've contacted can send back
- **Symmetric NAT:** different external port for each destination (hardest)

### Tailscale's Traversal Stack

1. **STUN** — Node sends request to STUN server, learns its public IP:port mapping
2. **Registration** — Node registers with DERP server, which learns both nodes' addresses
3. **ICE candidate gathering** — Collect all possible ways to reach each node (local IP, public STUN IP, DERP relay)
4. **Connection attempts** — Try in order of preference: direct UDP → UDP hole punching → TCP → DERP relay
5. **DERP relay** — Last resort; Tailscale's DERP servers relay encrypted traffic

### Why Direct Connection Matters

- **Lower latency** — traffic takes the shortest path
- **Better bandwidth** — no relay bottleneck
- **Reduced costs** — Tailscale's DERP bandwidth is expensive

## Related Concepts

- [[derp-servers]] — the fallback infrastructure
- [[wireguard]] — the tunnel being established
- [[mesh-vpn]] — where NAT traversal enables mesh connectivity
