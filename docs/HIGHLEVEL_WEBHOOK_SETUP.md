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

## 3. Optional Task Reminder

For a HighLevel Task Reminder workflow, POST to:

```
https://YOUR_RAILWAY_DOMAIN/webhooks/highlevel/task-reminder?secret=YOUR_GHL_WEBHOOK_SHARED_SECRET&locationId={{location.id}}&contactId={{contact.id}}
```

The bot also builds a daily task briefing from read-only Opportunity data, so this webhook is optional.

## 4. Optional appointment preparation reminder

Create a workflow that runs before the appointment (for example 1 hour before) and POST to:

```
https://YOUR_RAILWAY_DOMAIN/webhooks/highlevel/appointment-reminder?secret=YOUR_GHL_WEBHOOK_SHARED_SECRET&locationId={{location.id}}&contactId={{contact.id}}
```

HighLevel should continue sending any client-facing appointment SMS itself. This endpoint is for the internal Sales briefing only.

## Safety

The supplied project contains **no HighLevel write method**. All HighLevel HTTP calls in `src/services/ghl.ts` are GET requests. The shared secret is accepted through `?secret=...` for the standard Webhook action, removed before persistence, timing-safely compared, and redacted from HTTP request logs. Requests are accepted only for the configured WallPanels and Verona location IDs.
