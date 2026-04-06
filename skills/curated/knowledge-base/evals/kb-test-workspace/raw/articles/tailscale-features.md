# Tailscale Key Features Overview

*Source: https://tailscale.com/docs | Updated: 2026*

## Products

### 1. Business VPN
Tailscale as a traditional VPN replacement. Connect work devices securely without exposing them to the public internet.

### 2. PAM (Privileged Access Management)
Just-in-time access to resources. Request access to a server, get temporary permission, auto-expires.

### 3. CI/CD Connectivity
Connect GitHub Actions, GitLab runners, and other CI/CD systems to private resources without exposing them publicly.

### 4. Secure Access to AI
Control which AI tools and agents can access which data sources. Includes **Aperture** — Tailscale's AI governance product.

### 5. Cloud Connectivity
Connect instances across AWS, GCP, Azure without VPN gateways or complex networking.

### 6. Workload Connectivity
Connect containers and microservices in the same tailnet.

### 7. Edge & IoT
Connect Raspberry Pi, servers, IoT devices behind NAT without port forwarding.

### 8. Homelab
Run a personal VPN for home lab enthusiasts. Free tier is generous for homelab use.

## Core Concepts

### Tailnet

A tailnet is your private Tailscale network. One organization = one tailnet. Default DNS suffix: `<node-name>.tail-scale.net`

### MagicDNS

MagicDNS gives every Tailscale device a stable, private DNS name. No need to remember IP addresses. Names resolve only within your tailnet.

### ACLs (Access Control Lists)

JSON-based rules that define which users/groups/tags can access which resources.

Example:
```json
{
  "acls": [
    {"action": "accept", "src": ["alice@example.com"], "dst": ["tag:server:22"]},
    {"action": "accept", "src": ["group:engineering"], "dst": ["group:production:3000"]}
  ]
}
```

### Tags

Tags are labels for devices (not users). Useful for applying ACLs to groups of machines (e.g., `tag:database`, `tag:webserver`).

### Tailnet Lock

Tailnet Lock is a feature where all nodes in your network must be approved by existing members. Prevents unauthorized nodes from joining even if they have valid credentials. Uses Tailscale's coordination server signatures.

### Ephemeral Nodes

Ephemeral nodes automatically go offline when they disconnect. No persistent presence. Useful for BYOD or contractor devices.

### Auth Keys

Auth keys allow pre-authorized device connections without user interaction. Useful for CI/CD and automated server setup.

## Network Setup

### Subnet Router

A Tailscale node that advertises routes to non-Tailscale networks (e.g., your home network 192.168.1.0/24). Other Tailscale nodes can then reach devices on that network.

### Exit Node

An exit node routes ALL your internet traffic through it — like a traditional VPN. When you use an exit node, your traffic appears to come from the exit node's IP.

### App Connector

App Connector is a DNS-based approach to exposing web apps. Instead of routing at the network layer, you configure domain names, and App Connector handles routing.

### High Availability

Tailscale supports HA setups with:
- Multiple subnet routers
- Redundant exit nodes
- OIDC provider failover

## Use Cases

1. **SSH from anywhere** — Tailscale SSH with no SSH keys
2. **Access home lab remotely** — Subnet router on home network
3. **Private GitHub Actions runners** — Connect runners to internal services
4. **Ad-blocking VPN** — Exit node with Pi-hole
5. **Remote desktop** — Windows RDP through Tailscale
6. **Database access** — Connect to MongoDB Atlas, PostgreSQL privately
7. **Code from iPad** — SSH/VSCodium Remote SSH via Tailscale
8. **Access PiKVM** — Remote IP-KVM management
9. **Protect production databases** — ACLs only allow specific tags/devices

## Pricing

- **Free:** Unlimited devices for personal use, 1 user, basic features
- **Starter:** $25/user/month — SSO, more features
- **Premium:** Custom pricing — more users, advanced features
- **Enterprise:** Custom — full admin controls, compliance

## Platform Support

- Linux (CLI, systemd)
- macOS (CLI, app)
- Windows (CLI, app)
- iOS
- Android
- Synology NAS
- QNAP NAS
- pfSense
- OpenWrt
- Kubernetes (via operator)
- Docker
- NixOS

## Tailscale SSH Details

Tailscale SSH replaces traditional SSH key management:

- **No SSH keys needed** — Tailscale identity is enough
- **Short-lived certificates** — automatic expiry
- **Access requests** — request temporary access, approver reviews
- **Session recording** — optional audit log
- **Works through Tailscale** — no public IPs needed

Requires `tssh` (built into Tailscale CLI 1.34+).

## Tailscale Serve

Local HTTPS proxy built into Tailscale CLI. Features:
- Serve static files: `tailscale serve --bg /tmp/files/`
- Proxy to local service: `tailscale serve --proxy-to :3000`
- Path-based routing
- Authentication via Tailscale identity

## Tailscale Funnel

Exposes local web services to the public internet via Tailscale Serve + Cloudflare or built-in TLS. Useful for:
- Quick demos without cloud hosting
- Temporary public URLs
- Testing webhooks

## Aperture (AI Security)

Aperture is Tailscale's AI governance product:
- Control which AI agents can access which data
- Audit AI data access
- Policy enforcement for AI tool usage
- No waitlist (as of 2026)

## Tailscale vs Alternatives

| Feature | Tailscale | WireGuard | OpenVPN | ZeroTier |
|---------|-----------|-----------|---------|----------|
| Setup complexity | Low | Medium | High | Low |
| NAT traversal | Built-in | Manual | Manual | Built-in |
| ACLs | JSON | None | Config | Network |
| Identity | SSO/OIDC | None | Certificates | Network |
| Self-hosted control | No | N/A | Yes | Yes |
| Mesh topology | Yes | Partial | No | Yes |
| Open source | Partial | Yes | Yes | Yes |

## Installation

```bash
# Linux
curl -fsSL https://tailscale.com/install.sh | sh

# macOS (Homebrew)
brew install tailscale

# Authenticate
tailscale up

# Connect to tailnet
tailscale up --accept-routes
```

## CLI Reference

```bash
tailscale up          # Start and authenticate
tailscale down        # Disconnect
tailscale status      # Show connected nodes
tailscale logout      # Log out
tailscale ping        # Ping another node
tailscale ssh         # SSH via Tailscale
tailscale serve       # Start local HTTPS proxy
tailscale funnel      # Expose to public internet
tailscale status --json | jq '.Peer[]'  # List peers
tailscale netcheck    # Check NAT type and connectivity
```
