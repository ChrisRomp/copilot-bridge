# Mattermost Infrastructure (Docker Compose)

This docker-compose setup provides the infrastructure that copilot-bridge connects to:

| Service | Purpose |
|---------|---------|
| **PostgreSQL 16** | Mattermost database |
| **Mattermost 11.4** | Team chat platform |
| **Cloudflare Tunnel** | (Optional) Public HTTPS access without port forwarding |

The bridge itself runs on the host — it connects to Mattermost via the configured URL.

## Quick Start

```bash
# 1. Configure
cp .env.example .env
# Edit .env — at minimum, set POSTGRES_PASSWORD

# 2. Start
docker compose up -d

# 3. Set up Mattermost
# Open http://localhost:${MATTERMOST_PORT:-8065}, create an admin account,
# then create a bot: System Console → Integrations → Bot Accounts

# 4. Configure copilot-bridge
copilot-bridge init
# Enter http://localhost:${MATTERMOST_PORT:-8065} as the Mattermost URL
```

## With Cloudflare Tunnel

If you want public HTTPS access (e.g., for mobile or remote use):

1. Create a tunnel at [Cloudflare Zero Trust](https://one.dash.cloudflare.com) → Networks → Tunnels
2. Configure the tunnel to route your domain to `http://mattermost:8065`
3. Add your tunnel token to `.env`
4. Set `MM_SITEURL` to your public domain (e.g., `https://chat.example.com`)
5. Start with the tunnel profile:

```bash
docker compose --profile tunnel up -d
```

## Data Persistence

All data is stored in Docker named volumes:

- `postgres-data` — database
- `mattermost-config` — server configuration
- `mattermost-data` — uploaded files
- `mattermost-logs` — server logs
- `mattermost-plugins` — installed plugins
- `mattermost-client-plugins` — client plugins

To back up, use `docker compose down` then back up the volumes. To reset everything: `docker compose down -v`.
