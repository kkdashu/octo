# How Tailscale Works

*Source: https://tailscale.com/blog/how-tailscale-works | Author: Avery Pennarun | March 2020*

## Overview

Tailscale is a VPN (Virtual Private Network) built on top of WireGuard. It creates a mesh network where every device can talk directly to every other device, regardless of network location or firewall.

## Data Plane: WireGuard

The base layer is WireGuard (userspace Go variant: wireguard-go). WireGuard creates encrypted tunnels between nodes.

**Key difference from traditional VPN:**
- Traditional VPN uses hub-and-spoke: all traffic routes through a central concentrator
- WireGuard/Tailscale creates a mesh: devices talk directly to each other

### Hub-and-Spoke Problems

Traditional VPN:
1. Remote users connect to VPN concentrator (often far from their location)
2. Traffic then forwarded to destination (often far from concentrator)
3. Double latency penalty
4. Single point of failure
5. Hard to scale

Example: Worker in New York trying to reach server in New York, routed through company VPN in San Francisco.

### WireGuard Mesh Advantages

1. Devices talk directly — optimal routing
2. Multi-hub setup without much trouble
3. Lightweight tunnels scale well
4. No single point of failure

**The catch:** Each node needs to know public key, public IP, and port of every other node. Tailscale solves this with DERP servers and NAT traversal.

## Control Plane

Tailscale's control plane solves the key problem: how do new devices discover each other and get the right encryption keys?

### DERP Servers (Detour Routing Protocol)

DERP servers are relay servers that:
1. Help nodes discover each other's public IP and port
2. Relay traffic when direct peer-to-peer connection isn't possible (both nodes behind symmetric NAT)
3. Act as a "phone book" for the network

**Not used for all traffic** — only for initial connection setup and NAT traversal. Once peers connect directly, traffic bypasses DERP.

### STUN and NAT Traversal

Tailscale uses STUN to discover a node's public IP and port mapping. Then tries:
1. Direct UDP connection
2. UDP hole punching (both nodes send packets simultaneously)
3. TCP hole punching
4. DERP relay (last resort)

## Tailscale Network Structure

### Tailnet

A "tailnet" is your private Tailscale network. Each tailnet has:
- A private network range (e.g., 100.x.x.x by default)
- A magic DNS suffix (.betahelp.net, deprecated) — now uses `<node>.tail-scale.net`
- All connected devices get IPs from this range

### Nodes

Any device running the Tailscale client (Linux, macOS, Windows, iOS, Android, etc.) is a "node."

### Relay Nodes vs. Exit Nodes

- **Relay nodes:** Regular devices on the network
- **Exit nodes:** Nodes that route all traffic to the internet (like a traditional VPN gateway)
- **Subnet routers:** Nodes that advertise routes to non-Tailscale networks

## Security Model

### End-to-End Encryption

All traffic between nodes is end-to-end encrypted using WireGuard's encryption. Tailscale's control plane cannot read your traffic — only the nodes themselves have the decryption keys.

### Access Control Lists (ACLs)

ACLs define which nodes can talk to which other nodes. Example:
```json
{
  "acls": [
    {"action": "accept", "src": ["group:engineering"], "dst": ["tag:server:22"]}
  ]
}
```

### Users and Groups

Tailscale supports:
- Individual user accounts (Google, GitHub, Microsoft SSO, Okta, etc.)
- Groups (e.g., `group:engineering`)
- Tags (for devices, e.g., `tag:server`, `tag:workstation`)
- Public devices (without auth)

## Key Features

### 1. Tailscale SSH

SSH with Tailscale's identity layer — no SSH keys needed. Benefits:
- Short-lived certificates instead of long-lived keys
- Works from any Tailscale node
- Access requests and approval workflows
- Session recording (with Tailscale SOCKS5 proxy)

### 2. HTTPS Certificates (MagicDNS + acme.sh)

Tailscale provides free HTTPS certificates for nodes using MagicDNS. Requires Tailscale 1.46+.

### 3. Tailscale Funnel

Expose a local web server to the public internet over Tailscale. Combines Tailscale Serve with Cloudflare or Tailscale's own certificates.

### 4. Tailscale Serve

Local HTTPS proxy that makes local services available over your tailnet. Supports:
- Serving files from disk
- Proxying to local services
- Path-based routing

### 5. Tailscale SOCKS5

Built-in SOCKS5 proxy to route traffic from apps that don't support Tailscale directly.

## Comparison with Alternatives

### vs. Traditional VPN (OpenVPN, IPSec)

- Tailscale: mesh, identity-based, easy setup
- Traditional: hub-and-spoke, certificate-based, complex

### vs. ZeroTier

Both are mesh VPNs. Differences:
- ZeroTier: more decentralized, self-hosted control plane option
- Tailscale: simpler UX, WireGuard-based, better NAT traversal

### vs. WireGuard

- WireGuard: the protocol that Tailscale uses under the hood
- Tailscale: adds control plane, identity, ACLs, NAT traversal, easy onboarding

### vs. headscale

headscale is an open-source control server for WireGuard, similar to Tailscale's coordination server but self-hosted.

## Architecture Summary

```
User Device (Tailscale client)
        ↓ WireGuard tunnel
  Tailscale Coordination Server (control plane)
        ↓ key exchange, ACLs, node discovery
  DERP Relay Servers (fallback traffic relay)
        ↓ NAT traversal
  Other User Devices
```

All peer-to-peer traffic is end-to-end encrypted. The coordination server only handles key distribution and policy enforcement, never sees your data.
