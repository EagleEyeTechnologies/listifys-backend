# Render (optional)

This API is intended for **AWS EC2** in production. See **[AWS.md](./AWS.md)**.

Render can still work for experiments; if you use it, set:

- Root Directory: `version-1/new-server`
- Build: `npm install && npm run build`
- Start: `npm start`
- Node 20 or 22 (`NODE_VERSION=22`)
