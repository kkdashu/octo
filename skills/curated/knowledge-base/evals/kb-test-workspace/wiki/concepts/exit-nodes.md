# Exit Nodes

## Summary

An exit node is a Tailscale device that routes all your internet traffic through itself — like a traditional VPN gateway. When you use an exit node, your traffic appears to originate from the exit node's public IP address.

## Key Points

### Use Cases

1. **Privacy on untrusted networks** — route all traffic through your home/exit node
2. **Access geographically-restricted content** — exit node in a specific country
3. **Ad-blocking** — exit node running Pi-hole
4. **Corporate compliance** — route traffic through company-monitored exit

### Setting Up an Exit Node

**On the exit node device:**
```bash
sudo tailscale up --advertise-exit-node
```

Then approve in admin console: login.tailscale.com/admin/machines → find the node → approve exit node.

**On the client:**
```bash
tailscale up --exit-node=<exit-node-ip>
```

Example:
```bash
tailscale up --exit-node=100.105.67.189
```

### Checking Exit Node Status

```bash
tailscale status --json | jq '.Peer[] | select(.exitNode == true)'
```

### Disabling Exit Node

```bash
tailscale up --exit-node=
```

### Exit Node vs. DERP

| | Exit Node | DERP Server |
|--|-----------|-------------|
| Purpose | Route all internet traffic | Relay peer-to-peer traffic |
| Explicit? | Yes — user chooses | No — automatic fallback |
| Traffic goes through | Exit node's public IP | Tailscale's DERP servers |
| Can be self-hosted? | Yes (any Tailscale device) | Partially (Tailscale DERP, or headscale) |

## Related Concepts

- [[derp-servers]] — automatic traffic relay
- [[tailscale]] — exit node is a Tailscale feature
- [[acl]] — ACLs control who can advertise/use exit nodes
