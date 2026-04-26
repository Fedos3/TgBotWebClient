# TgBotWebClient

Fork of [Ajaxy/telegram-tt](https://github.com/Ajaxy/telegram-tt) adapted for Telegram bots.

It keeps the Telegram Web experience, but replaces QR and user-account login with server-side bot-token authorization.

Russian version: [README.ru.md](README.ru.md)

## Overview

`TgBotWebClient` is a Telegram bot web client based on `telegram-tt`.

- UI base: `telegram-tt`
- Auth model: bot token stored on the server
- Login flow: panel password instead of Telegram QR login
- Storage: local SQLite database
- Multi-bot mode: up to 5 bots with fast switching and bot connection from the UI

It is built for reading and replying to bot users from Mac, iPhone, and the web, since bot-oriented Telegram clients are mostly available only on Android.

## Why it does not block your main bot

The panel connects through MTProto, while most production bots use the Bot API for business logic.

That means the panel can read incoming bot chats without taking over `getUpdates` or breaking the main bot server.

The MTProto client in this fork uses the public Telegram Desktop API keys from the open-source Telegram Desktop project.

## Quick start

```bash
docker compose up -d --build
```

Open: [http://localhost:3000](http://localhost:3000)

Configuration lives in `backend/.env`.

## Multi-bot

- Configure `BOT_TOKEN_1` ... `BOT_TOKEN_5`
- Optional labels: `BOT_LABEL_1` ... `BOT_LABEL_5`
- You can also connect the first bot or additional bots directly from the web UI
- All configured bots stay online in the background and keep writing messages to SQLite
- The active bot can be switched quickly from the left header in the web UI

## License

This project is distributed under `GNU GPL v3`; see [LICENSE](/C:/Users/Fedos/Documents/GitHub/TgBotWebClient/LICENSE).

If you distribute this fork, keep the original copyright and license notices and make the derivative work available under GPL-compatible terms.
