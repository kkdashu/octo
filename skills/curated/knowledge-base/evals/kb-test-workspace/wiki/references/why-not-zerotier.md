# Why Not ZeroTier

**Source:** https://tailscale.com/blog/why-not-zerotier
**Author:** Tailscale Team

## Summary

Tailscale's comparison between itself and ZeroTier, focusing on control plane architecture (centralized vs. decentralized), NAT traversal approaches, network addressing, and when to choose each solution.

## Key Points

- ZeroTier: fully decentralized, optional self-hosted controller
- Tailscale: centralized coordination server, simpler operations
- ZeroTier: uses 16-bit ZeroTier address space, more flexible IP ranges
- Tailscale: uses 100.x.x.x CGNAT range with MagicDNS integration
- NAT traversal: ZeroTier uses UPnP/NAT-PMP, Tailscale uses STUN+ICE+DERP
- Choose ZeroTier for full self-hosting; choose Tailscale for operational simplicity

## Related Concepts

- [[mesh-vpn]] — shared foundation
- [[nat-traversal]] — key difference in NAT handling
- [[tailnet]] — Tailscale's network model
