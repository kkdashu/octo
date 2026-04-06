# Tailscale Quickstart Guide

*Source: https://tailscale.com/docs/quickstart | Updated 2026*

## Prerequisites

- A Tailscale account (free at tailscale.com)
- A device to install Tailscale on

## Installation

### Linux

```bash
curl -fsSL https://tailscale.com/install.sh | sh
```

Or via package manager:
```bash
# Debian/Ubuntu
sudo apt-get install apt-transport-https
curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/jammy.noarmor.gpg | sudo tee /usr/share/keyrings/tailscale-archive-keyring.gpg >/dev/null
curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/jammy.tailscale-archive-keyring.list | sudo tee /etc/apt/sources.list.d/tailscale.list
sudo apt-get update
sudo apt-get install tailscale
```

### macOS

```bash
brew install tailscale
# Or download from https://tailscale.com/download
```

### Windows

Download from https://tailscale.com/download/windows or via winget:
```powershell
winget install tailscale
```

### iOS/Android

Download from App Store / Play Store.

## Authentication

### First-time setup

```bash
tailscale up
```

This opens a browser window for OAuth login (Google, GitHub, Microsoft SSO, etc.).

### Re-authenticate

```bash
tailscale up
```

### With pre-generated auth key (for servers/CI)

```bash
tailscale up --authkey=<key>
```

## Connect to Your Tailnet

After `tailscale up`, your device joins your tailnet and gets:
- A private IP in the 100.x.x.x range
- A MagicDNS name: `<hostname>.tail-scale.net`

Check status:
```bash
tailscale status
```

## Key First Steps

### 1. Access another device

```bash
tailscale ping hostname
tailscale ssh username@hostname
```

### 2. Set up exit node (route all traffic)

On the exit node:
```bash
sudo tailscale up --advertise-exit-node
```

In admin console, approve the exit node request.

On client:
```bash
tailscale up --exit-node=<exit-node-ip>
```

### 3. Set up subnet router

On the router node:
```bash
sudo tailscale up --advertise-routes=192.168.1.0/24
```

Approve in admin console. Now all tailnet devices can reach 192.168.1.x.

### 4. Enable Tailscale SSH

```bash
tailscale up --ssh
```

Requires Tailscale 1.34+.

## Troubleshooting

### Check connectivity

```bash
tailscale netcheck
```

### View logs

```bash
# Linux systemd
journalctl -u tailscaled

# macOS
tail -f /var/log/tailscaled.log
```

### Force reconnect

```bash
tailscale down && tailscale up
```

## Access the Admin Console

https://login.tailscale.com/admin/machines

Here you can:
- Approve/revoke devices
- Manage ACLs
- Set up SSO
- View device list
- Configure features
