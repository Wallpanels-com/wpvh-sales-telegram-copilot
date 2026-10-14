# Security model

- HighLevel tokens are intended to be read-only Private Integration Tokens.
- The codebase implements HighLevel GET calls only; there is no client-message send endpoint and no CRM mutation endpoint.
- Telegram webhook uses Telegram's webhook secret token header.
- Workflow webhooks use a strong shared secret in query/header because standard Workflow Webhook actions are not assumed to provide Marketplace webhook signatures.
- Admins receive all routed events. Sales receive only events whose assigned GHL user ID maps to that Sales user for the specific location.
- Unknown/unassigned clients go to admins only.
- Secrets belong in Railway environment variables, never Git.
- Raw API tokens are never logged.
- Webhook events are deduplicated in Neon.
- Heavy processing occurs after durable event enqueueing.
- Off-hours notifications are deferred until the next configured work start.
