---
name: backend-express-typescript-ecommerce
description: "Build and maintain the Express + TypeScript backend for this eCommerce platform, including API endpoints, MySQL schema updates, email/SMTP behavior, shipping and payment integrations, deployment configuration, and environment setup."
argument-hint: "Describe the backend task, affected API/domain (auth/orders/payments/email/shipment/settings), and whether deployment or env updates are needed."
user-invocable: true
---

# Backend Skill (Express + TypeScript + MySQL)

## Purpose
Use this skill for backend work in this repository:
- API implementation and refactors in `server.ts`
- Database schema and migration-safe changes (`schema.sql`, `scripts/apply-schema.ts`)
- Runtime settings and app settings behavior (`app_settings`)
- Email/SMTP integration and troubleshooting
- Stripe/Swish/PostNord integration changes
- Deployment and environment configuration for Docker/Dokploy

## Stack and Runtime
- Node.js: `>=18`
- Framework: Express `5.x`
- Language: TypeScript (`tsc` outputs to `dist/`)
- Database: MySQL (`mysql2`)
- Real-time: Socket.io
- Main runtime entry: `server.js` (loads `dist/server.js`)

## Key Files
- Server routes and core logic: `server.ts`
- Runtime config parsing: `config.ts`
- DB pool/types: `db.ts`, `db.d.ts`
- Schema source of truth: `schema.sql`
- Schema apply script: `scripts/apply-schema.ts`
- Email delivery and templates: `email/email.ts`, `email/*.hbs`
- Shipment integration: `shipment/shipment.ts`
- Swish integration: `swish/SwishApi.ts`
- Container build/runtime: `Dockerfile`

## Local Development
1. Install deps:
```bash
npm install
```
2. Configure env:
- Copy `.env.example` to `.env`
- Set required values (especially `DATABASE_URL`, `JWT_SECRET`, `CLIENT_URL`)
3. Apply schema:
```bash
npm run db:init
```
4. Start dev server:
```bash
npm run dev
```
5. Build for production check:
```bash
npm run build
```

## Build and Startup Commands
- Dev: `npm run dev`
- Build: `npm run build`
- Run compiled app: `npm start`
- Init schema manually: `npm run db:init`
- Production helper: `npm run start:prod`

## Environment Configuration
Use `.env.example` as baseline.

Required in production:
- `NODE_ENV=production`
- `PORT` (internal app port, default `3000`)
- `DATABASE_URL`
- `JWT_SECRET`
- `CLIENT_URL`
- `BACKEND_PUBLIC_BASE_URL`
- `CORS_ORIGINS` (explicit allowlist)
- `GOOGLE_CLIENT_ID` (if Google auth enabled)
- `STRIPE_SECRET_KEY` (if Stripe enabled)

Common optional/runtime env:
- Rate limits: `SIGNIN_MAX_ATTEMPTS`, `SIGNIN_RATE_LIMIT_WINDOW_MINUTES`, `SIGNUP_MAX_ATTEMPTS`, `SIGNUP_RATE_LIMIT_WINDOW_MINUTES`
- PostNord: `POSTNORD_*`, `POSTNORD_TRACKING_BASE_URL`
- Swish: `SWISH_*`
- Platform defaults: `DEFAULT_PLATFORM_COMMISSION_PERCENT`, `DEFAULT_PLATFORM_COMMISSION_FIXED`, `PROMOTION_COMMISSION_PERCENT`, `VAT_SHIPPING_RATE`

Important behavior:
- SMTP sender credentials are DB-driven (app settings + email accounts), not primarily static env.
- `CORS_ORIGINS` is strict in production; missing values can block all origins.

## Deployment (Docker / Dokploy)
This project includes a multi-stage `Dockerfile`.

Container flow:
1. Build stage: install dependencies and run `npm run build`
2. Runtime stage: install prod deps, copy `dist/`, `server.js`, `email/`, `swish/`, `schema.sql`
3. Startup command runs schema reconcile then starts server:
```sh
node dist/scripts/apply-schema.js && exec node server.js
```

Dokploy guidance:
- Deploy backend as an app/service container using this `Dockerfile`
- Set all production env vars in Dokploy service env UI
- Keep backend listening on internal `PORT` (do not bind app directly to 80/443)
- Route external traffic through Dokploy reverse proxy
- Ensure DB service is reachable from backend container by `DATABASE_URL`

## Database and Migration Rules
- Always update `schema.sql` for schema changes
- Keep changes re-runnable and backward-safe when possible
- Validate with:
```bash
npm run db:init
npm run build
```
- If adding new columns, align DB typings (`db.d.ts`) and query logic

## Email and App Settings Rules
- Runtime email behavior is influenced by DB settings (`app_settings`, `email_accounts`)
- When adding footer/company/platform settings, update:
  - settings read/write endpoints in `server.ts`
  - fallback logic for backward compatibility
  - email footer context mapping in `email/email.ts` and templates

## Security and Operations Notes
- Never commit real secrets in `.env` or source code
- Keep `JWT_SECRET` long/random (32+ chars)
- Avoid disabling CORS/auth checks in production
- Validate destructive admin operations carefully (e.g., DB reset behavior)

## Definition of Done
A backend task is complete when:
1. Code compiles (`npm run build`)
2. Schema/runtime changes are applied safely
3. Required env vars are documented/updated
4. Deployment impact is clear (Docker/Dokploy)
5. Any changed API behavior is reflected in frontend expectations
