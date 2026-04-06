# Tailscale SSH

## Summary

Tailscale SSH replaces traditional SSH key management with Tailscale's identity layer. Connect to any device in your tailnet with zero SSH keys — certificates and authentication are handled entirely by Tailscale.

## Key Points

### How It Works

1. You authenticate to Tailscale (SSO/OIDC)
2. Tailscale issues a short-lived SSH certificate valid for that session
3. No need to copy your public key to the target server
4. Certificate auto-expires — no need to revoke keys when someone leaves

### Enabling Tailscale SSH

On the target node:
```bash
tailscale up --ssh
```

Or in admin console: enable SSH on the device.

### Using Tailscale SSH

```bash
tailscale ssh user@hostname
# or
tailscale ssh user@hostname.tail-scale.net
```

Works from any device in the tailnet — no public IP needed on target.

### Access Requests (Just-in-Time)

For sensitive servers, enable **access requests**:
1. User requests access to a server
2. Designated approver receives notification
3. Approver grants temporary access (e.g., 1 hour)
4. After the window, access auto-expires

### Session Recording

Enterprise plan feature: records SSH sessions to an audit log. Useful for:
- Security auditing
- Compliance requirements
- Incident investigation

### Requirements

- Tailscale 1.34+ (uses built-in `tssh`)
- `tssh` binary (bundled with Tailscale)
- Tailscale SSH enabled on both source and target

## Related Concepts

- [[acl]] — SSH port access is controlled by ACLs
- [[tailnet]] — the network SSH operates within
- [[auth-keys]] — automated auth for servers/CI
- [[pam]] — Privileged Access Management (broader than SSH)
