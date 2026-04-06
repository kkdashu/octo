# Tailscale Quickstart Guide

**Source:** https://tailscale.com/docs/quickstart
**Updated:** 2026

## Summary

Step-by-step guide for installing and configuring Tailscale on Linux, macOS, Windows, and mobile. Covers authentication, first commands, exit nodes, subnet routers, and troubleshooting.

## Key Points

- Install via `curl | sh` on Linux, Homebrew on macOS, or download on Windows
- Authenticate via OAuth browser login
- Use `--authkey` for server/CI automated setup
- Exit nodes advertise as internet gateways; subnet routers advertise as network gateways
- All approval of advertised routes happens in admin console (login.tailscale.com)

## Related Concepts

- [[tailscale-cli]] — CLI reference
- [[exit-nodes]] — routing all traffic
- [[subnet-routers]] — network advertising
- [[tailnet]] — joining the network
