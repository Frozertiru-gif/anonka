# Anonka — implementation checklist

Каноническая архитектура: `docs/ARCHITECTURE.md`.

Правило работы: реализовывать небольшими законченными этапами; после каждого этапа обновлять этот файл и фиксировать commit SHA.

Обозначения: `[x]` готово, `[~]` в работе, `[ ]` не начато.

## 0. Подготовка

- [x] Архитектура зафиксирована в `docs/ARCHITECTURE.md`.
- [x] Создан этот чек-лист.
- [x] Добавлен `.gitignore` для `.env`, Telethon session и runtime SQLite-файлов.

## 1. Persistence foundation

- [x] Добавить typed domain enums/models для conversation/message.
- [x] Добавить SQLite async connection manager.
- [x] Добавить versioned migrations.
- [x] Создать core tables: `conversations`, `messages`, `conversation_facts`, `conversation_summaries`, `events`, `runtime_config`, `app_state`.
- [x] Включить `WAL`, `foreign_keys`, `busy_timeout`.
- [x] Добавить `DATABASE_PATH` в config/.env.example.
- [x] Подключить инициализацию БД при старте приложения и корректное закрытие при shutdown.
- [x] Добавить `aiosqlite` dependency.

## 2. Provider-agnostic LLM

- [ ] `XAI_*` -> `LLM_*` без привязки бизнес-логики к провайдеру.
- [ ] Async OpenAI-compatible provider.
- [ ] DeepSeek V4 Flash default.
- [ ] Локальный OpenAI-compatible endpoint через config.
- [ ] Pydantic `ChatDecision`, `MediaIntent`, `FactUpdate`.
- [ ] Убрать `action=end`.
- [ ] Добавить `no_reply`.
- [ ] Structured-output validation/repair fallback.

## 3. Conversation engine

- [ ] SQLite как source of truth вместо RAM-only sessions.
- [ ] Независимая conversation на каждого DM peer.
- [ ] Per-conversation lock.
- [ ] Debounce пачек сообщений.
- [ ] Facts extraction в основном LLM call.
- [ ] Recent context + rolling summary policy.
- [ ] Manual outgoing ingestion.
- [ ] `MANUAL_OVERRIDE`.
- [ ] Crash recovery необработанных incoming сообщений.

## 4. Anonymous chat adapter/controller

- [ ] Protocol reconnaissance конкретного anonymous bot.
- [ ] Нормализованные events.
- [ ] `STOPPED/SEARCHING/ROOM_ACTIVE/HANDOFF_PENDING/SKIPPING`.
- [ ] Search/next/stop/link code-side.
- [ ] 10-minute idle timeout.
- [ ] SEARCHING watchdog.
- [ ] Observed-state reconciliation.
- [ ] `room_generation` stale-response guard.
- [ ] MessageEdited/raw update handling при необходимости.

## 5. DM + handoff

- [ ] Обычный новый DM создает отдельную conversation.
- [ ] anon -> DM сохраняет тот же logical conversation.
- [ ] Handoff correlation/token/temporal fallback.
- [ ] Ambiguous handoff не угадывается.
- [ ] После confirmed handoff anon сразу ищет следующего.
- [ ] Параллельная работа нескольких DM + одного anon flow.

## 6. Persona/context behavior

- [ ] Одна фиксированная девушка; без persona framework.
- [ ] Stable system/persona prompt.
- [ ] Few-shot examples.
- [ ] В anon нет жестко зафиксированного раннего AI disclosure.
- [ ] Раскрытие AI-природы управляется prompt/experiment policy, в основном уже в DM.
- [ ] Два commerce behavior modes: `DIRECT_SALE` и `PATRON`.
- [ ] Commerce mode snapshot на conversation/experiment arm.

## 7. Media Vault

- [ ] Private Telegram Vault.
- [ ] Caption/tag parser.
- [ ] Auto index on Vault NewMessage/MessageEdited.
- [ ] Manual `.media reindex`.
- [ ] `photo/video/video_note` support.
- [ ] Кружки доступны и через anon transport, если конкретный anonymous bot это поддерживает.
- [ ] Semantic `MediaIntent`; LLM не видит message_id/catalog.
- [ ] Exact/weighted selector + explicit fallback rules.
- [ ] No-repeat per conversation.
- [ ] Series continuity optional.
- [ ] Actual sent metadata возвращается в следующий LLM context.
- [ ] Missing/deleted reserved asset -> blocked/equivalent fallback policy.

## 8. Incoming non-text media

- [ ] Voice message fallback без STT: коротко сообщить, что голосовые не слушаются.
- [ ] Unsupported media не ломает pipeline.
- [ ] Позже при необходимости STT/vision отдельным этапом.

## 9. DIRECT_SALE commerce mode

- [ ] Runtime price.
- [ ] Offer + price snapshot + reserved asset.
- [ ] GiftDetector по реальному Telegram fixture.
- [ ] Strict peer/dedupe matching.
- [ ] insufficient/unmatched/wrong-peer/duplicate handling.
- [ ] Gift -> PAID -> code-side fulfillment без LLM.
- [ ] Paid-unfulfilled restart recovery.

## 10. PATRON commerce mode

- [ ] Soft gift-request behavior policy.
- [ ] Gift считается поддержкой, а не автоматически покупкой конкретного файла.
- [ ] Отдельные analytics events/metrics.
- [ ] Не смешивать fulfillment semantics с `DIRECT_SALE`.

## 11. Runtime/admin

- [ ] Saved Messages admin commands.
- [ ] `.anon start/stop/next/status`.
- [ ] `.price N`.
- [ ] `.offers on/off`.
- [ ] `.media on/off/reindex`.
- [ ] `.mode direct_sale|patron`.
- [ ] Per-DM pause/resume.

## 12. Reliability

- [ ] Outbox.
- [ ] Incoming dedupe.
- [ ] Programmatic outgoing vs manual outgoing correlation.
- [ ] FloodWait/retry/backoff.
- [ ] Uncertain-delivery reconciliation.
- [ ] Expired Telegram media reference refresh.
- [ ] Process/instance lock.
- [ ] SQLite backup procedure.

## 13. Analytics

- [ ] Event table wired to runtime flows.
- [ ] anon -> handoff -> DM funnel.
- [ ] price conversion.
- [ ] `DIRECT_SALE` vs `PATRON` comparison.
- [ ] media request/availability/fallback metrics.
- [ ] LLM usage/latency/cost logs.

## 14. Tests

- [ ] Unit tests state machines/repositories/selectors/commerce.
- [ ] Fake OpenAI-compatible server.
- [ ] Telegram fixtures.
- [ ] Gift fixture.
- [ ] Restart/recovery tests.
- [ ] FloodWait/file-reference tests.

## История этапов

| Этап | Статус | Commit | Что сделано |
|---|---|---|---|
| 1. Persistence foundation | готово | `a75189188f4f1e686d52c69a92f0fe6fb401ff44` | Domain enums/models, async SQLite, migration v1, core tables/indexes, WAL/FK/busy timeout, `DATABASE_PATH`, startup/shutdown wiring, `aiosqlite`, runtime secrets/data в `.gitignore` |
