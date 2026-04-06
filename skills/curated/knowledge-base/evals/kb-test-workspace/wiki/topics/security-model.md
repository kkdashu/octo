# Security Model

## Summary

Tailscale's approach to securing your network through identity, encryption, and access control. Covers end-to-end encryption, ACLs, Tailscale SSH, Tailnet Lock, and PAM.

## Articles

- [[acl]] — Access Control Lists (JSON-based rules)
- [[tailscale-ssh]] — SSH with short-lived certificates
- [[auth-keys]] — Pre-authorized device connections
- [[tailnet-lock]] — Cryptographic device approval
- [[references/tailscale-features#aperture|Aperture]] — AI governance and data access control

## Key Principles

1. **Zero trust** — Every connection is authenticated, never assumed trusted
2. **End-to-end encryption** — Even Tailscale can't read your traffic
3. **Least privilege** — ACLs enforce minimum necessary access
4. ** Ephemeral credentials** — Short-lived certificates reduce key management risk

## Related Topics

- [[core-concepts]] — The foundations security is built on
- [[advanced-features]] — Advanced security features
