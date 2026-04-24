# TgBotWebClient

Fork of [Ajaxy/telegram-tt](https://github.com/Ajaxy/telegram-tt) adapted for Telegram bots.

It keeps the Telegram Web experience, but replaces QR / user-account login with server-side bot-token authorization.

---

## English

### Overview

`TgBotWebClient` is a Telegram bot web client based on [telegram-tt](https://github.com/Ajaxy/telegram-tt).

- UI base: `telegram-tt`
- Auth model: bot token on the server
- Login flow: panel password instead of Telegram QR login
- Storage: local SQLite database
- Multi-bot mode: up to 5 bots with fast switching in one panel

It is made for reading and replying to bot users from **Mac**, **iPhone**, and the web, since bot-focused Telegram clients are mostly available only on **Android**.

### Why it does not block your main bot

The panel connects through **MTProto**, while most production bots use the **Bot API** for business logic.

That means the panel can read incoming bot chats without taking over `getUpdates` or breaking the main bot server.

The MTProto client in this fork uses the public Telegram Desktop API keys from the open-source Telegram Desktop project.

### Security model

- `BOT_TOKEN` stays on the server
- The browser never receives the bot token
- Access to chats is protected by an `HttpOnly` session cookie and panel password

### Quick start

```bash
docker compose up -d --build
```

Open: [http://localhost:3000](http://localhost:3000)

Configuration lives in `backend/.env`.

### Multi-bot

- Configure `BOT_TOKEN_1` ... `BOT_TOKEN_5`
- Optional labels: `BOT_LABEL_1` ... `BOT_LABEL_5`
- All configured bots stay online in the background and keep writing messages to SQLite
- The active bot can be switched quickly from the left header in the web UI

---

## Русский

### Кратко

`TgBotWebClient` — это веб-клиент для Telegram-ботов на базе [telegram-tt](https://github.com/Ajaxy/telegram-tt).

- Основа интерфейса: `telegram-tt`
- Модель авторизации: токен бота на сервере
- Вход в панель: пароль вместо Telegram QR-логина
- Хранение данных: локальная SQLite-база
- Multi-bot режим: до 5 ботов с быстрым переключением в одной панели

Проект нужен, чтобы **читать** и **отвечать** пользователям бота с **Mac**, **iPhone** и из браузера, потому что отдельные клиенты для Telegram-ботов по сути существуют в основном только на **Android**.

### Почему это не блокирует основной сервер бота

Панель подключается через **MTProto**, а основной бот обычно работает через **Bot API**.

Из-за этого панель не перехватывает `getUpdates` и не мешает основной бизнес-логике бота.

MTProto-клиент в этом форке использует публичные ключи Telegram Desktop из открытого исходного кода Telegram Desktop.

### Модель безопасности

- `BOT_TOKEN` остаётся только на сервере
- В браузер токен бота не попадает
- Доступ к перепискам защищён паролем панели и `HttpOnly` cookie-сессией

### Быстрый запуск

```bash
docker compose up -d --build
```

Открыть: [http://localhost:3000](http://localhost:3000)

Настройки находятся в `backend/.env`.

### Multi-bot

- Укажите `BOT_TOKEN_1` ... `BOT_TOKEN_5`
- При желании задайте названия через `BOT_LABEL_1` ... `BOT_LABEL_5`
- Все подключённые боты остаются онлайн в фоне и продолжают писать сообщения в SQLite
- Активный бот быстро переключается из левого хедера в веб-интерфейсе

---

## 中文

### 简介

`TgBotWebClient` 是一个基于 [telegram-tt](https://github.com/Ajaxy/telegram-tt) 的 Telegram Bot Web 客户端。

- 界面基础：`telegram-tt`
- 授权方式：服务器端保存 bot token
- 登录方式：面板密码，而不是 Telegram 二维码登录
- 数据存储：本地 SQLite
- 多 Bot 模式：最多 5 个 Bot，可在一个面板里快速切换

这个项目的目标，是让你可以在 **Mac**、**iPhone** 和浏览器里直接**阅读**并**回复** Bot 用户消息，因为面向 Telegram Bot 的现成客户端基本主要只在 **Android** 上存在。

### 为什么不会阻塞主 Bot 服务

这个面板通过 **MTProto** 连接，而大多数正式环境中的机器人业务逻辑运行在 **Bot API** 上。

因此它不会抢占 `getUpdates`，也不会影响主 Bot 服务。

本分支中的 MTProto 客户端使用的是开源 Telegram Desktop 项目里的公开 API keys。

### 安全模型

- `BOT_TOKEN` 只保存在服务器上
- 浏览器永远拿不到 bot token
- 聊天记录访问由面板密码和 `HttpOnly` 会话 Cookie 保护

### 快速启动

```bash
docker compose up -d --build
```

打开: [http://localhost:3000](http://localhost:3000)

配置文件位于 `backend/.env`。

### Multi-bot

- 配置 `BOT_TOKEN_1` ... `BOT_TOKEN_5`
- 可选标签：`BOT_LABEL_1` ... `BOT_LABEL_5`
- 所有已配置 Bot 都会在后台持续在线并把消息写入 SQLite
- 前端左侧顶部可快速切换当前查看的 Bot
