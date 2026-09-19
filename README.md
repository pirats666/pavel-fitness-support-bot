# Pavel Fitness Support Bot — Stage 1

Internal trainer-only Telegram bot for @pavel_fitness_support_bot.

Stage 1 includes only:
- trainer-only access;
- /start and main menu;
- Clients;
- real PostgreSQL persistence;
- client creation, confirmation, editing, deletion;
- client list and client card;
- Notes placeholder.

Environment:
- BOT_TOKEN
- ADMIN_TELEGRAM_ID
- DATABASE_URL
- PORT (Render default: 10000)

Run:
```bash
npm ci
npm run build
npm start
```

The bot uses the existing Supabase PostgreSQL database. No mock client data is created.
