---
name: frontend-typescript-role-routing
description: "Generate and refactor frontend TypeScript code with reusable components, role-based route metadata, strict role view folders (AdminPages/SellerPages/CustomerPages), auth guards for admin/seller, and webhook-first real-time updates. Use for Vue + TypeScript feature work, route design, component architecture, and implementation reviews."
argument-hint: "Describe the feature, target role (admin/seller/buyer), route path, and whether this is a new route, component, or refactor."
user-invocable: true
---

# Frontend Development Guidelines (TypeScript + Role-Based Structure)

## Enviroment
- Expressjs and typescriprt
- Deployment in Dokploy 
- Deployment of database in dokploy and run the schema during deployment and build process.
- use Dockerfile and .env for environment configuration and deployment settings.
- Setup in Dokploy Backend = service application, Frontend = service application, Database = database service with schema applied during deployment.


## Outcome
Produce frontend code that is:
- Type-safe and maintainable
- Built from reusable components and shared logic
- Organized around strict role-based routes
- Auth-safe for protected areas
- Webhook-first for real-time and event-driven updates

## When To Use
Use this skill when implementing or modifying:
- Vue + TypeScript components, views, composables, and routes
- Admin, seller, or buyer route flows
- Real-time update behavior (events, status updates, notifications)
- Refactors where duplicate UI/logic should be consolidated

## Project Rules
1. Use TypeScript for all new frontend code.
2. Prefer explicit types and interfaces; avoid `any` unless there is no practical typed alternative.
3. Keep business logic outside presentational components when possible.
4. Reuse existing components and composables before creating new ones.

## Repository Layout

- Backend
	- Location: `./`
	- Server entry: `/server.ts`
	- Database schema / migrations: `/database.sql`
	- Email logic: `/email/email.ts`
	- Shipment logic: `/shipment/shipment.ts`
	- Notes:
		- When database parameters or schema change, update `/schema.sql` and run the project's migration scripts or SQL commands to apply changes.
		- Document the exact migration commands in the PR and ensure CI/staging runs migrations before deployment.


## Database Parameter Changes

- Policy: Whenever database parameters change (columns, types, constraints, config values):
	1. Update `/schema.sql` (or add an appropriate migration script in `/`).
	2. Run the project's migration/apply scripts or execute the SQL commands against the development database to apply the change.
	3. Include the commands used and reasoning in the PR description; add rollback notes where applicable.
	4. Notify backend maintainers and ensure staging/production environments receive the migration as part of deployment.

## Role and Structure Mapping
1. Admin:
- View files must be under `Frontend/src/views/AdminPages`.
- Route metadata should include admin role access.
- Route requires authentication.

2. Seller:
- View files must be under `Frontend/src/views/SellerPages`.
- Route metadata should include seller role access.
- Route requires authentication.

3. Buyer (Customer):
- View files must be under `Frontend/src/views/CustomerPages`.
- Route is public by default unless feature sensitivity requires authentication.
- Route metadata should explicitly mark public routes.
- UX should prioritize customer-facing clarity.

## Authentication Requirements
1. Every admin route must enforce login.
2. Every seller route must enforce login.
3. Unauthorized users must be redirected to login before route entry.
4. Buyer routes default to public; require authentication for sensitive actions or data.

## Webhook-First Strategy
1. Prefer webhooks over polling for server-driven updates.
2. Use webhook/event-driven updates for:
- Real-time UI state changes
- Backend completion events
- Async process status propagation
3. Use polling only when webhook/event integration is unavailable, and document why.

## Workflow
1. Identify feature scope.
- Confirm role target: admin, seller, or buyer.
- Confirm whether this is a new route, component, or logic refactor.

2. Check for reusable building blocks first.
- Search existing components, composables, and shared utilities.
- If suitable pieces exist, compose from them instead of duplicating.

3. Decide routing and auth.
- Map views to `AdminPages`, `SellerPages`, or `CustomerPages` based on role.
- Apply route metadata (`roles`, `public`) consistent with existing router patterns.
- Add or verify auth guards for admin and seller routes.

4. Implement with strong typing.
- Define interfaces/types for props, payloads, API responses, and state.
- Keep UI and domain logic separated (component vs composable/service).

5. Choose real-time mechanism.
- Prefer webhook/event-driven flow.
- If using fallback polling, capture the reason in code and PR notes.

6. Validate quality gates.
- No avoidable `any` usage.
- No duplicated UI blocks that could be shared.
- Role mapping, route metadata, and auth behavior are correct.
- New code follows existing folder conventions.

## Decision Points
1. Reuse vs create:
- If existing component/composable satisfies >=80% of need, reuse and extend carefully.
- Otherwise create a new generic reusable unit in shared/component-appropriate structure.

2. Webhook vs polling:
- If backend supports event delivery, use webhook/event-driven updates.
- If not, use minimal polling with clear exit/cleanup behavior and a documented justification.

3. Protected vs public buyer pages:
- If sensitive customer data/actions are present, require authentication.
- Otherwise allow public access with optional progressive auth prompts.

## Completion Checklist
- View path is in the correct role folder (`AdminPages`, `SellerPages`, `CustomerPages`).
- Route metadata correctly represents role/public behavior.
- Admin and seller routes enforce login and redirect unauthorized users.
- Existing reusable components/composables were evaluated before adding new ones.
- Any new component/composable is generic and reusable.
- TypeScript types are explicit and maintainable.
- Webhook/event-driven updates were used when feasible.
- Business logic remains separated from display concerns.
- Folder and naming conventions match the existing project style.

