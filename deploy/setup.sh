#!/usr/bin/env bash
# One-time setup script for a fresh Ubuntu 24.04 Hetzner VPS.
# Run as root: bash deploy/setup.sh
set -euo pipefail

REPO_URL="https://github.com/YOUR_ORG/djtoolkit.git"
APP_DIR="/opt/djtoolkit"
DOMAIN="YOUR_DOMAIN"          # e.g. api.djtoolkit.com
EMAIL="YOUR_EMAIL"            # for Let's Encrypt notifications

# ── 1. Docker ──────────────────────────────────────────────────────────────
echo "==> Installing Docker..."
apt-get update
apt-get install -y ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | tee /etc/apt/sources.list.d/docker.list > /dev/null
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# ── 2. Nginx + Certbot ─────────────────────────────────────────────────────
echo "==> Installing Nginx and Certbot..."
apt-get install -y nginx certbot python3-certbot-nginx

# ── 3. Clone repo ──────────────────────────────────────────────────────────
echo "==> Cloning repository to $APP_DIR..."
git clone "$REPO_URL" "$APP_DIR"
cd "$APP_DIR"

# ── 4. Populate .env ───────────────────────────────────────────────────────
echo "==> Creating .env from example..."
cp .env.example .env
echo ""
echo "IMPORTANT: Edit $APP_DIR/.env and fill in all secret values:"
echo "  SUPABASE_DATABASE_URL, SUPABASE_JWT_SECRET, SUPABASE_SERVICE_ROLE_KEY"
echo "  SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_TOKEN_ENCRYPTION_KEY"
echo ""
read -rp "Press Enter once .env is populated..."

# ── 5. Directories ─────────────────────────────────────────────────────────
mkdir -p "$APP_DIR/logs"

# ── 6. Nginx config ────────────────────────────────────────────────────────
echo "==> Configuring Nginx..."
sed "s/YOUR_DOMAIN/$DOMAIN/g" nginx/djtoolkit.conf \
    > /etc/nginx/sites-available/djtoolkit
ln -sf /etc/nginx/sites-available/djtoolkit /etc/nginx/sites-enabled/djtoolkit
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

# ── 7. SSL certificate ─────────────────────────────────────────────────────
echo "==> Obtaining SSL certificate via Certbot..."
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL"

# ── 8. Start app ───────────────────────────────────────────────────────────
echo "==> Building and starting Docker Compose..."
docker compose build
docker compose up -d

echo ""
echo "==> Setup complete. App running at https://$DOMAIN"
echo "    Check logs: docker compose logs -f"
