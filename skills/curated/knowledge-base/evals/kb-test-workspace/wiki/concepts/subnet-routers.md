# Subnet Routers

## Summary

A subnet router is a Tailscale device that advertises routes to non-Tailscale networks. Other Tailscale nodes can then reach devices on those networks as if they were directly connected to the tailnet.

## Key Points

### Example Use Case

Home network: 192.168.1.0/24
- No Tailscale installed on smart TV, printer, NAS
- But one Linux machine IS on Tailscale AND connected to the home router

That Linux machine can advertise the 192.168.1.0/24 route → all Tailscale devices can now reach any device at 192.168.1.x

### Setting Up

**On the router node:**
```bash
sudo tailscale up --advertise-routes=192.168.1.0/24
```

Multiple routes:
```bash
sudo tailscale up --advertise-routes=192.168.1.0/24,10.0.0.0/8
```

Approve in admin console.

**On client devices:**
```bash
tailscale up --accept-routes
```

Now `ping 192.168.1.50` from any client in the tailnet.

### Limitations

- Subnet router must be online for those routes to be reachable
- BOTH sides need `--accept-routes` (advertiser and requester)
- Only one-hop routes (can't chain subnet routers)

### vs. Exit Nodes

| | Subnet Router | Exit Node |
|--|---------------|-----------|
| Purpose | Reach specific networks | Route all internet traffic |
| Scope | Specific IP ranges | Everything |
| Traffic destination | Devices on advertised network | The internet |

## Related Concepts

- [[exit-nodes]] — routing all traffic
- [[tailscale]] — the feature that enables this
- [[mesh-vpn]] — how packets reach the subnet router
