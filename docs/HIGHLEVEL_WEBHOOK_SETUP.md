# HighLevel webhook setup

The bot works in two modes:

1. **Webhook mode (recommended)** — near real-time and minimal API usage.
2. **Read-only polling fallback** — enabled by default so the bot can still detect inbound messages/calls before workflows are configured.

Both modes deduplicate by HighLevel message/transcript ID.

## 1. Customer Replied

In each sub-account (WallPanels and Verona Home):

1. Automation → Workflows → Create workflow.
2. Trigger: **Customer Replied**.
3. Add the standard **Webhook** action (POST).
4. URL:

```
https://YOUR_RAILWAY_DOMAIN/webhooks/highlevel/customer-replied?secret=YOUR_GHL_WEBHOOK_SHARED_SECRET&locationId={{location.id}}&contactId={{contact.id}}&eventId={{contact.id}}-{{right_now.year}}{{right_now.month}}{{right_now.day}}{{right_now.hour}}{{right_now.minute}}{{right_now.second}}
```

If HighLevel exposes conversation/message IDs as workflow custom values in that location, append them as query parameters too. They are optional because the bot can resolve the latest conversation from `contactId` using read-only API calls.

Do not use Custom Webhook unless you specifically need custom headers/body/auth; the standard Webhook action is enough for this bot.

## 2. Transcript Generated

Create another workflow:

1. Trigger: **Transcript Generated**.
2. Standard Webhook action (POST).
3. URL:

```
https://YOUR_RAILWAY_DOMAIN/webhooks/highlevel/transcript-generated?secret=YOUR_GHL_WEBHOOK_SHARED_SECRET&locationId={{location.id}}&contactId={{contact.id}}&eventId={{contact.id}}-{{right_now.year}}{{right_now.month}}{{right_now.day}}{{right_now.hour}}{{right_now.minute}}{{right_now.second}}
```

The backend resolves the newest Call message for the contact, then loads the full transcript through HighLevel's read-only transcription endpoint. Do not put the full transcript in the URL. If the standard Webhook action includes it in the POST body, the backend can use that payload as a fallback.

## 3. Task Reminder

Create a separate WallPanels workflow:

1. Trigger: **Task Reminder**.
2. Set the reminder timing required by the team.
3. Add the standard **Webhook** action (POST) with this URL:

```
https://YOUR_RAILWAY_DOMAIN/webhooks/highlevel/task-reminder?secret=YOUR_GHL_WEBHOOK_SHARED_SECRET&locationId={{location.id}}&contactId={{contact.id}}
```

The backend reloads the current task and CRM context through GET-only HighLevel APIs. A completed task is safely ignored and identical reminder deliveries are deduplicated.

## 4. Appointment preparation reminder

Create a separate WallPanels workflow:

1. Trigger: **Appointment Status**.
2. Filters: appointment status **New** or **Confirmed** and the relevant WallPanels calendar(s).
3. Add **Wait** → **An upcoming appointment or booking** → **Appointment / Calendar Event** → **Before** → **1 hour**. If the appointment time has already passed, select **Exit contact from this workflow**.
4. Add the standard **Webhook** action (POST) with this URL:

```
https://YOUR_RAILWAY_DOMAIN/webhooks/highlevel/appointment-reminder?secret=YOUR_GHL_WEBHOOK_SHARED_SECRET&locationId={{location.id}}&contactId={{contact.id}}
```

The standard Webhook action supplies the trigger's appointment/calendar object. The backend verifies its current status and reloads the appointment, calendar, contact, opportunity, messages, and relationship context with GET-only HighLevel APIs. HighLevel should continue sending any client-facing appointment SMS itself; this endpoint is for the internal sales briefing only.

## Safety

The supplied project contains **no HighLevel write method**. All HighLevel HTTP calls in `src/services/ghl.ts` are GET requests. The shared secret is accepted through `?secret=...` for the standard Webhook action, removed before persistence, timing-safely compared, and redacted from HTTP request logs. Requests are accepted only for the configured WallPanels and Verona location IDs.
