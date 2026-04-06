# MagicDNS

## Summary

MagicDNS is Tailscale's built-in private DNS service. Every device on your tailnet gets a stable, memorable DNS name that resolves only within your private network. No need to remember IP addresses.

## Key Points

### How It Works

Each Tailscale device gets:
- **IP address:** assigned from the tailnet's CGNAT range (100.64.0.0/10)
- **DNS name:** `<hostname>.tail-scale.net` (note: beta used to be `.betahelp.net`)

Example: A laptop named `laptop-amy` gets `laptop-amy.tail-scale.net`.

### DNS Resolution

- MagicDNS names only resolve **within the tailnet**
- You can reach devices by name instead of IP: `ping laptop-amy`
- Works on all Tailscale-supported platforms
- Resolvers are automatically configured when you connect

### Custom DNS (Advanced)

You can configure custom DNS servers for your tailnet:
- Override MagicDNS with your own internal DNS
- Split-horizon DNS: internal domains resolve internally, everything else goes to public DNS
- Useful when integrating with existing internal DNS infrastructure

### HTTPS Certificates

With HTTPS enabled (Tailscale 1.46+), you get free TLS certificates for your MagicDNS names:
- `https://database-server.tail-scale.net` — valid HTTPS without manual cert setup
- Issued via Let's Encrypt through Tailscale's infrastructure

## Related Concepts

- [[tailnet]] — the network MagicDNS operates within
- [[tailscale-serve]] — serving HTTPS locally
- [[tailscale-funnel]] — exposing services publicly
