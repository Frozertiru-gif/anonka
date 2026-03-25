# anonka

Телеграм-бот, который читает сообщения выбранного пользователя и генерирует ответ через xAI (Grok).

## Быстрый запуск

1. Перейдите в директорию проекта:
   ```bash
   cd ai_chat_experiment
   ```
2. Создайте виртуальное окружение и активируйте его:
   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   ```
3. Установите зависимости:
   ```bash
   pip install -r requirements.txt
   ```
4. Создайте `.env` из примера:
   ```bash
   cp .env.example .env
   ```
5. Заполните обязательные поля в `.env` (список ниже).
6. Запустите приложение:
   ```bash
   python run.py
   ```

---

## Какие поля нужно заполнить в `.env`

### Обязательные

- `TG_API_ID` — числовой API ID приложения Telegram (с my.telegram.org).
- `TG_API_HASH` — API HASH приложения Telegram.
- `TG_SESSION_NAME` — имя файла сессии Telethon (например, `anonka_session`).
- `TG_TARGET_USERNAME` — username пользователя Telegram, за которым бот будет следить (без `@`, например `example_user`).
- `XAI_API_KEY` — API-ключ xAI.

Если хотя бы одно обязательное поле пустое, приложение завершится с ошибкой конфигурации.

### Необязательные (есть значения по умолчанию)

- `XAI_BASE_URL` — базовый URL API xAI. По умолчанию: `https://api.x.ai/v1`.
- `XAI_MODEL` — модель xAI. По умолчанию: `grok-3-mini`.
- `XAI_TIMEOUT_SECONDS` — таймаут запроса к xAI в секундах. По умолчанию: `45`.
- `REPLY_DELAY_MIN` — минимальная задержка перед ответом в секундах. По умолчанию: `3`.
- `REPLY_DELAY_MAX` — максимальная задержка перед ответом в секундах. По умолчанию: `10`.
- `MAX_CONTEXT_MESSAGES` — размер контекстного окна (количество сообщений). По умолчанию: `12`.
- `DRY_RUN` — режим без отправки сообщений в Telegram (`true/false`). По умолчанию: `false`.

---

## Пример `.env`

```dotenv
TG_API_ID=123456
TG_API_HASH=your_telegram_api_hash
TG_SESSION_NAME=anonka_session
TG_TARGET_USERNAME=example_user

XAI_API_KEY=your_xai_api_key
XAI_BASE_URL=https://api.x.ai/v1
XAI_MODEL=grok-3-mini
XAI_TIMEOUT_SECONDS=45

REPLY_DELAY_MIN=3
REPLY_DELAY_MAX=10
MAX_CONTEXT_MESSAGES=12
DRY_RUN=false
```

## Полезно знать

- `TG_API_ID` должен быть целым числом.
- `REPLY_DELAY_MIN` не может быть больше `REPLY_DELAY_MAX`.
- `MAX_CONTEXT_MESSAGES` и `XAI_TIMEOUT_SECONDS` должны быть больше 0.
