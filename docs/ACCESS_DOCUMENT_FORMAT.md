# Local access document expected by Codex

Keep this Word file LOCAL ONLY. Do not commit it.
Recommended filename: `WPVH_SALES_COPILOT_ACCESS.docx`.

Required values:

- GitHub corporate repo HTTPS + SSH URLs
- Neon `DATABASE_URL` (pooled connection string preferred for Railway runtime)
- Telegram bot token, username, Dmitry/Kate numeric user IDs, every sales numeric user ID
- OpenAI API key + model name to use
- WallPanels Location ID + read-only Private Integration Token
- Verona Home Location ID + read-only Private Integration Token
- Each sales: WallPanels GHL User ID, Verona GHL User ID, Telegram numeric user ID
- Work timezone, work days, work start/end

Generated secrets (Codex may generate strong random values locally):
- `TELEGRAM_WEBHOOK_SECRET`
- `GHL_WEBHOOK_SHARED_SECRET`

Do not store API keys in Git, source code, README, SQL migrations, or logs.
