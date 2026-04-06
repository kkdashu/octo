# Why Not ZeroTier? — Tailscale's Perspective

*Source: https://tailscale.com/blog/why-not-zerotier | Tailscale Team*

## Comparison Overview

Both Tailscale and ZeroTier are mesh VPNs built on WireGuard-like principles. Key differences:

### Control Plane

**ZeroTier:** Fully decentralized. You can run your own controller (ZeroTier Central is optional, or use self-hosted Central). The network definition is stored on each node.

**Tailscale:** Centralized coordination server (managed by Tailscale). Simpler to use but not self-hostable.

### Network Addressing

**ZeroTier:** Uses its own address space (16-bit ZeroTier addresses) independent of any network. You choose any IP range you want.

**Tailscale:** Uses CGNAT address space (100.64.0.0/10) by default. MagicDNS integrates with this. More opinionated but less flexible.

### NAT Traversal

**ZeroTier:** Uses UPnP and NAT-PMP for port forwarding. Can fail on symmetric NATs without manual configuration.

**Tailscale:** Uses STUN + ICE + DERP fallback. More robust NAT traversal out of the box.

### Managed vs. Self-Hosted

ZeroTier wins for: teams that want to fully self-host everything.
Tailscale wins for: teams that want zero infrastructure management.

### Speed and Performance

Both use WireGuard at the core. Performance is comparable for similar workloads.

## When to Choose ZeroTier

1. You need full self-hosting control
2. You want a specific IP range not in 100.x.x.x
3. You're building a product that includes VPN functionality
4. You need to support very exotic network configurations

## When to Choose Tailscale

1. You want the simplest possible setup
2. You need SSO/OIDC integration
3. You want just-in-time access and audit logging
4. You need SSH certificate-based auth
5. You want to avoid managing any infrastructure

## The Bottom Line

ZeroTier is more technically flexible. Tailscale is more operationally simple. The choice depends on whether you want to manage your own control plane or have Tailscale manage it for you.
