Backend environment variables
===========================

This project uses environment variables for runtime configuration.

Quick start:

1. Copy `backend/.env.example` to `backend/.env`
2. Fill secrets and production URLs
3. Run `npm run build` then `npm start`

Deployment:

- Backend startup file for Node hosting: `server.js`
- Docker image file: `backend/Dockerfile`
- Full Dokploy env reference: `../DOKPLOY_ENV.md`
- Ubuntu + Dokploy: add the variables from `backend/.env.example` into the Dokploy service environment tab
- Set `NODE_ENV=production`, `PORT=3000`, `CLIENT_URL`, `BACKEND_PUBLIC_BASE_URL`, and `DATABASE_URL` before first boot
- Dokploy should proxy public traffic to the app's internal `PORT`; do not bind the app directly to 80/443

Important production variables:

- `CLIENT_URL`
- `BACKEND_PUBLIC_BASE_URL`
- `CORS_ORIGINS`
- `JWT_SECRET`
- `DATABASE_URL`
- `SMTP_*`
- `STRIPE_SECRET_KEY`
- `POSTNORD_*`
- `SWISH_*`
