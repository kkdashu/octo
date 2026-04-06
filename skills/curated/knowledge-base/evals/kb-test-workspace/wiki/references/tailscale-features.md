# Tailscale Features Reference

**Source:** https://tailscale.com/docs
**Updated:** 2026

## Summary

A comprehensive overview of Tailscale's product lineup, covering VPN, PAM, CI/CD connectivity, AI security (Aperture), and core features like MagicDNS, ACLs, Tailscale SSH, Tailscale Serve, and Tailscale Funnel.

## Key Points

- Core offering: mesh VPN built on WireGuard
- SSH replacement: Tailscale SSH with short-lived certificates
- DNS: MagicDNS gives every device a stable private name
- Access control: JSON-based ACLs with users, groups, and tags
- Exit nodes: route all internet traffic through a Tailscale node
- Subnet routers: expose non-Tailscale networks to the tailnet
- Funnel: expose local web services to the public internet
- Aperture: AI governance and data access control for AI agents
- Platform support: Linux, macOS, Windows, iOS, Android, NAS, routers, Kubernetes

## Related Concepts

- [[tailscale-ssh]] — SSH replacement
- [[magicdns]] — private DNS
- [[acl]] — access control lists
- [[exit-nodes]] — internet routing
- [[subnet-routers]] — network advertising
- [[tailscale-serve]] — local HTTPS proxy
- [[tailscale-funnel]] — public web exposure
- [[aperture]] — AI security
- [[tailnet]] — the private network concept
