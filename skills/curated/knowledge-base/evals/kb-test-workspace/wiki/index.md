# Tailscale Knowledge Base

A structured wiki about Tailscale — the mesh VPN built on WireGuard.

## What is Tailscale?

Tailscale is a zero-config VPN that creates a private mesh network between your devices. Built on WireGuard, it adds a control plane for key distribution, NAT traversal for firewall punching, and an identity layer (SSO, ACLs) for access control.

**Core proposition:** Connect any device to any other device, anywhere, without exposing either to the public internet.

## Navigating the Wiki

**Start here:**
- [[topics/getting-started]] — Install Tailscale in 5 minutes
- [[topics/core-concepts]] — Understand mesh VPN, WireGuard, DERP, NAT traversal
- [[topics/security-model]] — Master ACLs, Tailscale SSH, and access control
- [[topics/advanced-features]] — Exit nodes, subnet routers, Serve, Funnel

**Quick reference:**
- [[topics/_index|Topics]] — Browse by topic
- [[concepts/_index|Concepts]] — Browse by concept
- [[references/_index|References]] — Source documents and guides

## Key Themes

### Mesh over Hub-and-Spoke
Traditional VPN routes all traffic through a central concentrator. Tailscale routes traffic directly between devices — optimal latency, no single point of failure.

### End-to-End Encrypted
All peer-to-peer traffic is encrypted using WireGuard. Tailscale's coordination servers only manage keys and policy — they never see your data.

### Identity-Based Access
ACLs let you define access by user, group, or device tag — not by IP address. Add a new engineer → they automatically get access to appropriate resources.

### Zero Config
Install Tailscale, run `tailscale up`, authenticate via SSO. Within minutes you're connected to your entire private network with stable DNS names for every device.

## Core Workflows

| What you want | How |
|---|---|
| SSH to a server | `tailscale ssh user@hostname` |
| Reach home network devices | Set up a [[subnet-routers]] |
| Browse from a specific IP | Use an [[exit-nodes]] |
| Expose a local web service publicly | Use [[tailscale-serve]] + Funnel |
| No SSH keys, just identity | Use [[tailscale-ssh]] |
| Control access between devices | Write [[acl]] in the admin console |

## Further Questions

- How does Tailscale compare to WireGuard directly?
- How does DERP relay traffic without decrypting it?
- What's the difference between subnet router and exit node?
- How do I set up Tailscale SSH with just-in-time approval?
