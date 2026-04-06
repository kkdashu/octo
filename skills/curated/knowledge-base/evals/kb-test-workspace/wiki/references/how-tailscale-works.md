# How Tailscale Works (Blog Post)

**Source:** https://tailscale.com/blog/how-tailscale-works
**Author:** Avery Pennarun (Tailscale Co-founder)
**Published:** March 2020

## Summary

A comprehensive technical deep-dive into Tailscale's architecture, covering WireGuard, DERP servers, NAT traversal, and the mesh networking model that makes Tailscale fundamentally different from traditional hub-and-spoke VPNs.

## Key Points

- Tailscale is built on WireGuard's userspace Go implementation (wireguard-go)
- Mesh topology enables direct peer-to-peer connections without a central hub
- DERP servers handle NAT traversal and serve as fallback relays
- The control plane only distributes keys and enforces ACLs — it never sees data traffic
- End-to-end encryption means even Tailscale's servers can't read your traffic

## Related Concepts

- [[wireguard]] — the underlying VPN protocol
- [[derp-servers]] — Tailscale's relay infrastructure
- [[mesh-vpn]] — mesh vs. hub-and-spoke networking
- [[acl]] — access control in Tailscale
- [[nat-traversal]] — how Tailscale punches through NATs
