# Backend AI Agent Instructions

## Project Overview
Express.js + TypeScript backend for an eCommerce platform. Monolithic server (~9700 lines in `server.ts`) with MySQL database, WebSocket support, and integrations for payments (Stripe/Swish), email (Nodemailer), and shipping (PostNord).

**Key Stack**: Express 5.2.1, MySQL2, TypeScript 6.0.3, Socket.io 4.8.3, Node ≥18

## Getting Started
```bash
npm install                    # Install dependencies
npm run dev                    # Start dev server with nodemon (hot reload)
npm run build                  # Compile TypeScript to dist/
npm start                      # Run compiled server
npm run db:init                # Initialize database schema
```

**Dev Environment**: TS-Node + Nodemon on port 0.0.0.0 (dynamic port fallback)

## Architecture

### Route Handlers
- All routes are **inline in server.ts** (no separate route files)
- Pattern: `app.post('/api/resource', middleware, handler)`
- Authentication: JWT (HS256) + Google OAuth2 + TOTP 2FA
- Use `req.user` (set by auth middleware) to access authenticated user

### Key Modules
| Module | Purpose |
|--------|---------|
| `db.ts` | MySQL2 connection pool (limit: 10) with type definitions in `db.d.ts` |
| `websocket.ts` | Socket.io events for orders, payments, products, notifications (JWT auth) |
| `email/` | Nodemailer + Handlebars templates (DigitalProduct, InvoiceCustomer, SellerPayoutReceipt, Shipment) |
| `shipment/` | PostNord integration for shipping labels and tracking |
| `swish/` | Swedish payment API (test mode available) |

### Middleware Stack
1. CORS (dynamic origin from env)
2. JSON parser (limit: 50mb)
3. Static files from `uploads/`
4. Custom auth middleware (JWT + optional 2FA verification)
5. WebSocket

### Database
- **MySQL2** with connection pooling
- Schema: `bootstrap.sql` (initial schema), `schema.sql` (current state)
- Key tables: users, profiles, bank_accounts, products, orders, transactions, shipments, notifications
- Features: 2FA tokens, email verification, password reset (1-hour TTL), role-based access

## Critical Environment Variables
| Variable | Purpose | Required |
|----------|---------|----------|
| `DATABASE_URL` | MySQL connection string | ✓ |
| `JWT_SECRET` | Signing key (min 32 chars) | ✓ |
| `STRIPE_SECRET_KEY` | Stripe API key | ✓ |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth2 | ✓ |
| `CLIENT_URL` | Frontend origin for CORS/redirects | ✓ |
| `BACKEND_PUBLIC_BASE_URL` | For email links | ✓ |
| `SMTP_*` | Email config (can use TEST_MODE=true) | ✓ |
| `CORS_ORIGINS` | Comma-separated allowed origins | ✓ |
| `POSTNORD_*` | Shipping credentials | Optional |

## Common Tasks

### Adding a New Route
1. Find similar endpoint in `server.ts` 
2. Add handler with auth middleware if needed
3. Test via `apitest.rest` REST client
4. Update database schema if needed (run `npm run db:init`)

### Database Modifications
- Schema changes: Edit `schema.sql`, run `npm run db:init`
- Migrations: Add `.ts` files in `scripts/` (see `apply-schema.ts` pattern)
- Type safety: Update `db.d.ts` after schema changes

### Email Templates
- Handlebars templates in `email/` folder (.hbs files)
- Use `email.ts` to send emails with template context
- Test mode: Set `SMTP_TEST_MODE=true` to skip actual sending

### WebSocket Events
- Defined in `websocket.ts`
- Rooms: `order:${orderId}`, `product:${productId}`, `user:${userId}`, `notifications:${userId}`
- Events: `order-updated`, `payment-completed`, `product-changed`, `notification`

### Payment Integration
- **Stripe**: Full integration for card payments
- **Swish** (Sweden): Optional test mode (check `swish/SwishApi.ts`)
- Transaction logging in database

## File Conventions
- Route handlers: Keep in `server.ts`, group by feature
- New modules: Create in root if general-use, in feature folder if specific
- Migrations: Add to `scripts/` as `.ts` files
- Database schemas: `bootstrap.sql` (initial), `schema.sql` (current)

## Common Gotchas
- **JWT_SECRET**: Must be 32+ characters; weak secrets will fail
- **CORS_ORIGINS**: Must include frontend URL in production
- **Database pool**: Limited to 10 connections; watch for connection leaks
- **Email**: Test mode doesn't actually send; check logs instead
- **Multer limit**: 5MB max file size for uploads
- **Password reset**: Tokens are 1-hour TTL only

## Testing
- Manual REST testing: Use `apitest.rest` file with REST Client extension
- No automated test framework configured
- Test payments via Stripe/Swish test modes

## Debugging
- Server logs: Check terminal output (nodemon auto-restarts on file changes)
- Database: Connect directly to MySQL for schema inspection
- WebSocket: Enable Socket.io debug with `DEBUG=*`
- Check `trash/` folder for deprecated code/migrations
