# WireGuard

## Summary

WireGuard is a modern, fast, and secure VPN protocol. It creates lightweight encrypted tunnels between network endpoints using public-key cryptography. Tailscale is built on top of WireGuard (specifically the userspace Go implementation called wireguard-go).

## Key Points

- **Modern cryptography** — uses Curve25519 for key exchange, ChaCha20-Poly1305 for encryption, BLAKE2s for hashing
- **Fast** — simpler codebase (~4,000 lines) means better performance than OpenVPN or IPSec
- **Stateless** — no concept of "connections" that can time out; tunnels are always ready
- **Kernel vs userspace** — WireGuard traditionally runs in the Linux kernel; Tailscale uses the userspace version (wireguard-go) for cross-platform compatibility

### Tailscale's Use of WireGuard

Tailscale builds on WireGuard by adding:
- A **control plane** for key distribution and node discovery
- **NAT traversal** so nodes can find each other through firewalls
- **Identity layer** (SSO, ACLs) on top of WireGuard's public-key auth
- **DERP servers** for when direct peer-to-peer isn't possible

Without Tailscale, setting up WireGuard manually requires each node to know the public key, public IP, and port of every other node — impractical for dynamic networks.

## Related Concepts

- [[mesh-vpn]] — the topology WireGuard enables
- [[tailscale]] — builds on WireGuard
- [[nat-traversal]] — how nodes find each other
- [[tailscale-ssh]] — SSH built on Tailscale identity
