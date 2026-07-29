# GBrain deployment assets

These are the checked-in, non-secret assets for the current cloud deployment shape:

- `systemd/gbrain-serve-http.service.example` runs the HTTP MCP and admin review service.
- `env/gbrain-serve.env.example` documents Basic Auth, admin origin, bind, and the anonymous MCP switch.
- `scripts/bootstrap-server.sh` installs templates, dry-run by default.
- `scripts/verify-server.sh` performs read-only health/readiness checks.
- `scripts/install-client-assets.sh` installs rules and skills only; it never handles credentials.

The service listener must stay behind the cloud firewall allowlist and a TLS
termination layer. Anonymous MCP access is intentionally limited to `read` and
`write`; admin operations remain protected by the admin authentication layer.
