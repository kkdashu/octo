# Access Control Lists (ACLs)

## Summary

Tailscale ACLs are JSON-based rules that define which users, groups, and devices can connect to which other devices and ports. They are the primary mechanism for securing a Tailscale network beyond just "who's logged in."

## Key Points

### ACL Format

```json
{
  "acls": [
    {
      "action": "accept",
      "src": ["alice@example.com"],
      "dst": ["tag:server:22"]
    },
    {
      "action": "accept",
      "src": ["group:engineering"],
      "dst": ["tag:database:5432"]
    }
  ]
}
```

### Subjects (src/dst)

- **Users:** `alice@example.com`
- **Groups:** `group:engineering`
- **Tags:** `tag:server`
- **Tailscale IPs:** `100.x.x.x`
- **Wildcards:** `*` (all users/nodes)
- **Autogroups:** `autogroup:members` (all users in tailnet)

### Capabilities (dst port)

- `22` — SSH
- `3389` — RDP
- `*:80,*:443` — HTTP/HTTPS
- `*` — all ports

### Built-in Autogroups

- `autogroup:members` — all users in the tailnet
- `autogroup:admin` — tailnet admins
- `autogroup:poster` — users who can publish to the tailnet

### Tag Best Practices

Use tags (not user emails) for server ACLs:
```json
{"action": "accept", "src": ["group:engineering"], "dst": ["tag:database:5432"]}
```

This way, adding a new engineer automatically grants access — no ACL changes needed.

### Testing ACLs

Use the Tailscale admin console (login.tailscale.com/acl) — it has a live ACL editor with a simulator showing which connections are allowed.

## Related Concepts

- [[tailnet]] — the network ACLs apply to
- [[tailscale-ssh]] — SSH permissions via ACLs
- [[tailnet-lock]] — defense in depth beyond ACLs
