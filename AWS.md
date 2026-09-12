# Deploy listifys-api on AWS (EC2)

Recommended layout for Listifys:

| Layer | Where |
|--------|--------|
| Website (Next.js) | **Amplify** — e.g. `https://next.listifys.com` |
| API + Socket.IO | **EC2** behind Nginx — e.g. `https://api.listifys.com` |
| Mongo / Redis / S3 / OpenSearch | Existing managed services (already in `.env.production`) |

Render is optional; this path is the production default.

---

## 1. EC2 instance

- AMI: **Amazon Linux 2023** or Ubuntu 22.04
- Size: **t3.small** (or larger if chat + search are heavy)
- Region: same as users / S3 when possible
- Security group inbound:
  - **22** (SSH) — your IP only
  - **80 / 443** — public (Nginx)
  - Do **not** open `5001` publicly

Elastic IP → point DNS `api.listifys.com` (A record) at it.

---

## 2. Server bootstrap (Amazon Linux 2023)

```bash
sudo dnf update -y
sudo dnf install -y git nginx
# Node 22 via NodeSource or nvm
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
sudo dnf install -y nodejs
sudo npm i -g pm2

# Optional TLS helper
sudo dnf install -y certbot python3-certbot-nginx
```

Ubuntu equivalent: `apt` + NodeSource `setup_22.x`.

---

## 3. App deploy

```bash
sudo mkdir -p /var/www/listifys-api
sudo chown -R $USER:$USER /var/www/listifys-api
cd /var/www/listifys-api

git clone <YOUR_REPO_URL> .
# OR clone monorepo and cd version-1/new-server

cd version-1/new-server   # if monorepo
npm ci
npm run build

# Create production env on the box (never commit secrets)
nano .env.production
# paste values from your local .env.production
# CLIENT_URL=https://next.listifys.com
# CORS_ORIGINS=https://www.listifys.com,https://next.listifys.com,...
# GOOGLE_CALLBACK_URL=https://api.listifys.com/api/auth/google/callback

NODE_ENV=production pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # follow the printed systemd command
```

Health check:

```bash
curl -s http://127.0.0.1:5001/health/live
```

---

## 4. Nginx + HTTPS

Copy `deploy/nginx-api.listifys.com.conf` to `/etc/nginx/conf.d/api.listifys.com.conf` (or sites-available), then:

```bash
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d api.listifys.com
```

Nginx must proxy **HTTP and WebSocket** (Socket.IO). The sample config does both.

---

## 5. Wire Amplify ↔ API

On Amplify (website) environment:

```text
NEXT_PUBLIC_API_URL=https://api.listifys.com
NEXT_PUBLIC_SITE_URL=https://next.listifys.com
NEXT_PUBLIC_ALLOW_MOCKS=false
NEXT_PUBLIC_S3_BUCKET_URL=https://listys.s3.eu-north-1.amazonaws.com
```

On EC2 `.env.production`:

```text
CLIENT_URL=https://next.listifys.com
CORS_ORIGINS=https://www.listifys.com,https://next.listifys.com,https://listifys.com
GOOGLE_CALLBACK_URL=https://api.listifys.com/api/auth/google/callback
```

Redeploy Amplify after changing `NEXT_PUBLIC_*`.

---

## 6. Redeploy updates

```bash
cd /var/www/listifys-api/version-1/new-server
git pull
npm ci
npm run build
pm2 reload listifys-api
```

---

## 7. Checklist

- [ ] `https://api.listifys.com/health` returns OK (Mongo + S3 in prod)
- [ ] Browser console: API calls go to `api.listifys.com` (no localhost)
- [ ] Chat Socket.IO connects (no CORS / WS errors)
- [ ] Google OAuth callback URL includes production API host
- [ ] Security group does not expose Node port publicly
