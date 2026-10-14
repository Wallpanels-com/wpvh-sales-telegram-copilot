# Deployment checklist

1. Create corporate GitHub repository `wpvh-sales-telegram-copilot`.
2. Create Neon project and copy its `DATABASE_URL`.
3. Create Telegram bot in BotFather.
4. Fill Railway environment variables from `.env.example` using the local private Word access document. Never commit the document.
5. Connect Railway service to the GitHub repository.
6. Deploy. Railway runs `npm run migrate` before starting the service.
7. Set `PUBLIC_BASE_URL` to the generated Railway HTTPS domain.
8. Run `npm run seed:sales` once with production env to upsert Sales mappings.
9. Run `npm run telegram:set-webhook` once with production env.
10. Keep `TELEGRAM_DELIVERY_MODE=disabled` until the user explicitly approves a Dmitry-only test. Then use `allowlist` with only Dmitry's Telegram ID.
11. Configure HighLevel Customer Replied + Transcript Generated webhooks from `docs/HIGHLEVEL_WEBHOOK_SETUP.md`.
12. Keep `AUTOMATION_ENABLED=false` until AI validation and the Dmitry-only test are complete. After approval, enable automation while Telegram remains allowlisted.
13. Keep `POLLING_ENABLED=true` initially. After webhook delivery is proven reliable, polling can remain as recovery fallback or be disabled.

Do not send test customer messages or modify HighLevel data. Validate with read-only data and Dmitry's Telegram account first.
