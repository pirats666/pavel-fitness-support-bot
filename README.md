# Pavel Fitness Support Bot

Internal trainer-only Telegram bot for @pavel_fitness_support_bot.

## Architecture

- Telegram bot only — no client interface.
- Access is restricted by `ADMIN_TELEGRAM_ID`.
- PostgreSQL is the only persistent storage.
- Render runs the Node.js service.
- Long polling is used; no Telegram webhook is required.
- `/health` is provided for Render health checks.

## Questionnaire

1. Goal
2. Training experience
3. Training location
4. Workouts per week
5. Workout duration
6. Limitations / special considerations

The completed profile is upserted into `trainer_profiles`.

## Environment

Provide:

- `BOT_TOKEN`
- `ADMIN_TELEGRAM_ID`
- `DATABASE_URL`
- `PORT` (Render provides this automatically; local default is 10000)

Never commit real tokens or database credentials.

## Database

Run `schema.sql` once against the PostgreSQL database.

## Local development

```bash
npm ci
npm run build
npm start
```

## Production

Render uses `render.yaml`:

- build: `npm ci && npm run build`
- start: `npm start`
- health check: `/health`

## Commands

- `/start` — main menu
- `/profile` — show saved profile
- `/reset` — restart questionnaire
- `/help` — command list

## Separation rule

This repository is independent from `pavel-fit-official-bot` and the legacy `fitlife` archive. Do not share tokens, environment files, database credentials, webhook settings, or production code between the two bots.
