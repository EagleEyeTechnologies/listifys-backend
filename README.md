# Listifys API (v2) — Phase 1

New Express + TypeScript backend. Leaves `version-1/server` (legacy JS API) untouched.

## Stack

- Express 4 + TypeScript (strict)
- MongoDB / Mongoose — unified `listings` + `users`
- Redis (optional in dev) — OTP + refresh tokens
- BullMQ — email + listing side-effect queues
- Elasticsearch client stub
- S3 presign (mock when AWS env missing)

## Quick start

```bash
cd version-1/api
cp .env.example .env
# set MONGODB_URI + JWT secrets
npm install
npm run dev
```

API listens on **:5001** by default (legacy server uses :5000).

Optional worker (needs Redis):

```bash
npm run dev:worker
```

Seed sample listings:

```bash
npm run seed
```

## Migrate production → newlistifysdb

Converts legacy per-category collections into the unified `listings` schema, plus users / chat / notifications. **Source is read-only; target must not be `production`.** Default is dry-run.

```bash
# Set in shell or .env (do not commit secrets):
# SOURCE_MONGODB_URI=…/production?…
# TARGET_MONGODB_URI=…/newlistifysdb?…

npm run migrate:prod              # dry-run
npm run migrate:prod:write        # apply writes
npm run migrate:prod -- --write --limit=50
npm run migrate:prod -- --write --collections=users,listings
```

Reports land in `version-1/api/migration-reports/`. After a successful write, point `MONGODB_URI` at `newlistifysdb` and spot-check.

## Health

`GET /health` → `{ ok, mongo, redis, service, time }`

## Auth

| Method | Path                          | Notes                                              |
| ------ | ----------------------------- | -------------------------------------------------- |
| POST   | `/api/auth/otp/email/request` | `{ email }` — OTP logged in dev                    |
| POST   | `/api/auth/otp/email/verify`  | `{ email, code, name?, countryCode? }`             |
| POST   | `/api/auth/otp/phone/request` | `{ phone, phoneCode? }`                            |
| POST   | `/api/auth/otp/phone/verify`  | `{ phone, phoneCode?, code, name?, countryCode? }` |
| POST   | `/api/auth/refresh`           | `{ refreshToken }` or cookie                       |
| POST   | `/api/auth/logout`            |                                                    |
| POST   | `/api/auth/google`            | stub — requires `email` + `idToken`                |
| POST   | `/api/auth/apple`             | stub — requires `email` + `idToken`                |

Tokens returned in JSON; also set as httpOnly cookies.

| GET | `/api/users/me` | Current user (Bearer / cookie) |

## Listings

| Method | Path                | Auth                     |
| ------ | ------------------- | ------------------------ |
| GET    | `/api/listings`     | no                       |
| GET    | `/api/listings/:id` | no                       |
| POST   | `/api/listings`     | yes                      |
| PATCH  | `/api/listings/:id` | owner                    |
| DELETE | `/api/listings/:id` | owner (soft → `removed`) |

Query params: `category`, `intent`, `type` (`rentals`\|`wanted`\|`free`), `city`, `q`, `lat`, `lng`, `radiusMiles`, `sort`, `page`, `limit`, `sellerId`.

Market: `x-country-code` header or `?countryCode=` (US\|CA\|IN).

## Saved / wishlist

| Method | Path                | Auth | Body                               |
| ------ | ------------------- | ---- | ---------------------------------- |
| GET    | `/api/saved`        | yes  | → `{ ids, items }`                 |
| POST   | `/api/saved/toggle` | yes  | `{ listingId }` → `{ saved, ids }` |
| DELETE | `/api/saved`        | yes  | clear all                          |

## Compare

| Method | Path                  | Auth | Body                                    |
| ------ | --------------------- | ---- | --------------------------------------- |
| GET    | `/api/compare`        | yes  | → `{ ids, items, max }` (max 3)         |
| POST   | `/api/compare/toggle` | yes  | `{ listingId }` → `{ added, ids, max }` |
| DELETE | `/api/compare`        | yes  | clear tray                              |

## Chat

| Method | Path                                   | Auth                                             |
| ------ | -------------------------------------- | ------------------------------------------------ |
| GET    | `/api/chat/conversations`              | yes                                              |
| POST   | `/api/chat/conversations`              | yes — start `{ recipientId, listingId?, text? }` |
| GET    | `/api/chat/conversations/:id/messages` | yes                                              |
| POST   | `/api/chat/conversations/:id/messages` | yes — `{ text }`                                 |

Socket.IO (`CLIENT_URL` CORS): auth via `auth.token` access JWT.

- `chat:send` `{ conversationId, text }`
- `chat:message` `{ conversationId, message }`

## Notifications

| Method | Path                              | Auth                      |
| ------ | --------------------------------- | ------------------------- |
| GET    | `/api/notifications`              | yes → `{ items, unread }` |
| GET    | `/api/notifications/unread-count` | yes                       |
| POST   | `/api/notifications/:id/read`     | yes                       |
| POST   | `/api/notifications/read-all`     | yes                       |
| DELETE | `/api/notifications/:id`          | yes                       |

Message sends also create an in-app notification for recipients.

## Media

`POST /api/media/presign` (auth) → `{ uploadUrl, publicUrl, key, mock }`

## Premium

| Method | Path                           | Auth                 |
| ------ | ------------------------------ | -------------------- |
| GET    | `/api/premium/plan`            | no                   |
| GET    | `/api/premium/status`          | yes                  |
| POST   | `/api/premium/trial`           | yes — one free trial |
| POST   | `/api/premium/checkout`        | yes                  |
| POST   | `/api/premium/verify/razorpay` | yes                  |
| POST   | `/api/premium/verify/stripe`   | yes                  |

Webhooks activate boost, premium, and event tickets via payment `purpose`. Events stored in `webhookevents`.

## Event tickets

| Method | Path                                 | Auth                                                                  |
| ------ | ------------------------------------ | --------------------------------------------------------------------- |
| POST   | `/api/events/:listingId/checkout`    | yes — free confirms immediately; paid returns Razorpay/Stripe payload |
| POST   | `/api/events/:listingId/book`        | yes — free events only                                                |
| POST   | `/api/events/verify/razorpay`        | yes                                                                   |
| POST   | `/api/events/verify/stripe`          | yes                                                                   |
| GET    | `/api/events/my-bookings`            | yes                                                                   |
| GET    | `/api/events/my-bookings/:bookingId` | yes                                                                   |
| GET    | `/api/events/:listingId/bookings`    | yes — organizer                                                       |

## Seller reviews

| Method | Path                                  | Auth                                              |
| ------ | ------------------------------------- | ------------------------------------------------- |
| GET    | `/api/seller-reviews/:sellerId`       | no — list + stats                                 |
| GET    | `/api/seller-reviews/:sellerId/stats` | no                                                |
| POST   | `/api/seller-reviews`                 | yes — `{ sellerId, rating, comment, listingId? }` |

`GET /api/users/:id` includes `averageRating` and `totalReviews`.

Migrate legacy reviews (dry-run then write):

```bash
npm run migrate:prod -- --collections=sellerreviews
npm run migrate:prod:write -- --collections=sellerreviews
```

## Boost / payments

| Method | Path                         | Auth                                                              |
| ------ | ---------------------------- | ----------------------------------------------------------------- |
| GET    | `/api/boost/plans`           | no — market-aware plans                                           |
| GET    | `/api/boost/campaigns`       | yes — your boost history                                          |
| POST   | `/api/boost/checkout`        | yes — `{ planKey, listingId }` creates pending payment + campaign |
| POST   | `/api/boost/verify/razorpay` | yes — `{ orderId, paymentId, signature }`                         |
| POST   | `/api/boost/verify/stripe`   | yes — `{ paymentIntentId }`                                       |
| GET    | `/api/payments/config`       | no                                                                |
| POST   | `/api/webhooks/razorpay`     | provider HMAC                                                     |
| POST   | `/api/webhooks/stripe`       | Stripe signature                                                  |

On success: campaign → `active`, listing `featured: true` until `endAt`.

Set in `version-1/next-website/.env.local`:

```
NEXT_PUBLIC_API_URL=http://localhost:5001
```

When the API is healthy and the user is signed in, the website uses live:

- OTP auth + `/api/listings` (browse, publish)
- Saved / compare sync
- Chat (REST + Socket.IO) and “Message seller”
- Notifications (page + navbar badge)
- Media presign on post-add photos (demo images until S3 is configured)

If the API is down, it falls back to mock data.

Run both:

```bash
# terminal 1
cd version-1/api && npm run dev

# terminal 2
cd version-1/api && npm run seed   # once

# terminal 3
cd version-1/next-website && npm run dev
```
