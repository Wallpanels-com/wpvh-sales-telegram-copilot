# WP/VH AI Sales Telegram Copilot

Production-oriented TypeScript backend for a Telegram Sales Copilot on top of GoHighLevel for WallPanels and Verona Home.

## What it does

- Detects new inbound client messages from HighLevel via webhook and/or read-only polling fallback.
- Routes every event to Dmitry/Kate admins and only to the Sales user assigned in HighLevel.
- Builds CRM context from Contact, Opportunity, Stage, recent messages, Tasks and stored call memory.
- Uses OpenAI to create a short suggested reply; it **never sends the reply to the client**.
- Telegram buttons: Copy reply, Shorter, Friendlier, Rewrite, Open in HighLevel.
- Analyzes HighLevel call transcripts and stores relationship memory in Neon.
- `/today` shows due/overdue tasks and today's calendar events from assigned open Opportunities.
- Daily briefing at configured work start.
- Off-hours client notifications are deferred to the next work start.
- Optional HighLevel Task Reminder and appointment-prep webhook endpoints.
- Durable webhook queue + retries + deduplication in Neon.

## Architecture

```text
HighLevel Customer Reply / Call Transcript
              ↓ webhook (preferred)
        Railway / Fastify
              ↓
       Durable Neon queue
              ↓
       HighLevel GET context
              ↓
            OpenAI
              ↓
      Telegram assigned Sales
       + Dmitry + Kate admins
```

Read-only polling is a fallback:

```text
HighLevel GET message export every ~60s
       ↓ dedupe in Neon
same processing pipeline
```

## HighLevel safety

The supplied HighLevel client performs GET requests only. There is no implementation for:

- sending SMS/email/WhatsApp,
- creating/updating Tasks,
- changing Opportunities/Stages,
- creating Notes,
- changing Contacts/Tags/Custom Fields.

Use read-only Private Integration Tokens for both locations.

## Quick start

```bash
cp .env.example .env
npm install
npm run migrate
npm run seed:sales
npm run dev
```

After Railway deployment:

```bash
npm run telegram:set-webhook
```

Then configure HighLevel workflow webhooks using `docs/HIGHLEVEL_WEBHOOK_SETUP.md`.

## Neon

Neon is PostgreSQL. This project needs one primary secret:

`DATABASE_URL`

Use the pooled connection string from Neon for the Railway runtime. There is no Supabase-style public/anon key requirement for this backend.

## Sales mapping

Example env value:

```json
[
  {
    "name": "Mary Razumna",
    "telegramUserId": "123456789",
    "wpGhlUserId": "WP_USER_ID",
    "vhGhlUserId": "VH_USER_ID"
  }
]
```

Set it as a one-line `SALES_MAPPINGS_JSON`, then run `npm run seed:sales`.

Admins are configured with:

`ADMIN_TELEGRAM_USER_IDS=DMITRY_ID,KATE_ID`

Admins receive all routed events; Sales only receive events assigned to their mapped GHL user ID.

## Telegram commands

- `/today` — tasks/calls/meetings due today
- `/status` — bot status
- `/help` — usage

## Work hours

Defaults:

```text
TIMEZONE=America/New_York
WORK_START=08:45
WORK_END=20:00
WORK_DAYS=1,2,3,4,5,6
```

Inbound events may still be received and stored outside the work window, but Telegram delivery is deferred until the next work start.

## Deployment

See:

- `docs/DEPLOY.md`
- `docs/HIGHLEVEL_WEBHOOK_SETUP.md`
- `docs/SECURITY.md`
- `docs/ACCESS_DOCUMENT_FORMAT.md`
