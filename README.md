# Backend API

Node.js + Express + PostgreSQL + Prisma.

Three identity types:

| Identity   | Client       | Login method       |
| ---------- | ------------ | ------------------ |
| `CUSTOMER` | Customer app | Phone + OTP        |
| `PARTNER`  | Partner app  | Phone + OTP        |
| `ADMIN`    | Admin panel  | Email + password   |

## Structure

```
backend/
├── prisma/
│   ├── schema.prisma       # Customer, Partner, Admin, Otp
│   └── seed.js             # Seeds a default admin
├── src/
│   ├── config/             # env, logger, prisma client
│   ├── middlewares/        # authenticate, requireType, validate, errorHandler, notFound
│   ├── modules/
│   │   └── auth/
│   │       ├── auth.routes.js
│   │       ├── auth.controller.js
│   │       ├── auth.service.js
│   │       ├── auth.validator.js
│   │       └── otp.service.js
│   ├── routes/             # API route aggregator
│   ├── utils/              # ApiError, asyncHandler, jwt, password, apiResponse
│   ├── app.js
│   └── server.js
├── .env.example
├── .gitignore
├── .nvmrc
└── package.json
```

## Setup

```bash
cd backend
cp .env.example .env         # edit DATABASE_URL and JWT_SECRET
npm install
npm run prisma:migrate -- --name init
npm run prisma:seed          # creates admin@example.com / Admin@123
npm run dev
```

Server listens on `http://localhost:PORT` (default `5000`). API base: `/api/v1`.

## Auth endpoints

### Customer app (OTP)
- `POST /api/v1/auth/customer/send-otp` — `{ phone }`
- `POST /api/v1/auth/customer/verify-otp` — `{ phone, code, name? }`

### Partner app (OTP)
- `POST /api/v1/auth/partner/send-otp` — `{ phone }`
- `POST /api/v1/auth/partner/verify-otp` — `{ phone, code, name? }`

### Admin panel (password)
- `POST /api/v1/auth/admin/login` — `{ email, password }`

### Common
- `GET /api/v1/auth/me` *(Bearer token)* — returns `{ type, user }`

## JWT payload

```json
{ "sub": "<user-id>", "type": "CUSTOMER | PARTNER | ADMIN" }
```

Protect routes with the middlewares:

```js
const { authenticate, requireType } = require('./middlewares/auth');

router.use(authenticate);                       // any logged-in user
router.get('/admin-only', requireType('ADMIN'), handler);
router.get('/partner-only', requireType('PARTNER'), handler);
```

## OTP behavior

- 6-digit numeric code, bcrypt-hashed in DB.
- `OTP_EXPIRY_MINUTES` (default 5) — validity window.
- `OTP_RESEND_SECONDS` (default 60) — resend cooldown per phone.
- Max 5 wrong attempts per OTP before it is invalidated.
- In non-production, the OTP is logged to the console (swap the SMS stub in [src/modules/auth/otp.service.js](src/modules/auth/otp.service.js) with your provider, e.g. Twilio / MSG91).

## Response shape

```json
{ "success": true, "message": "OK", "data": { }, "meta": { } }
```

Errors:

```json
{ "success": false, "message": "...", "details": { } }
```

## Scripts

| Script                    | Purpose                        |
| ------------------------- | ------------------------------ |
| `npm run dev`             | Start with nodemon             |
| `npm start`               | Production start               |
| `npm run prisma:migrate`  | Create and apply a migration   |
| `npm run prisma:deploy`   | Apply migrations in production |
| `npm run prisma:studio`   | Open Prisma Studio             |
| `npm run prisma:seed`     | Seed the database              |
