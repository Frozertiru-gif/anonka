# Anonka — конкретный план миграции и реализации

> Статус: рабочий implementation plan.  
> Этот файл отвечает на вопрос **что именно оставляем, что меняем, что переписываем с нуля и что удаляем**.  
> Product behavior определяется [`PRODUCT_REQUIREMENTS.md`](https://github.com/Frozertiru-gif/anonka/blob/main/PRODUCT_REQUIREMENTS.md).  
> Техническая архитектура определяется [`ARCHITECTURE.md`](https://github.com/Frozertiru-gif/anonka/blob/main/ARCHITECTURE.md).  
> Правила для coding agents находятся в [`AGENTS.md`](https://github.com/Frozertiru-gif/anonka/blob/main/AGENTS.md).

## Ссылки

- Проект: https://github.com/Frozertiru-gif/anonka
- Product requirements: https://github.com/Frozertiru-gif/anonka/blob/main/PRODUCT_REQUIREMENTS.md
- Архитектура: https://github.com/Frozertiru-gif/anonka/blob/main/ARCHITECTURE.md
- Правила для агентов: https://github.com/Frozertiru-gif/anonka/blob/main/AGENTS.md
- Текущий README: https://github.com/Frozertiru-gif/anonka/blob/main/README.md
- CI: https://github.com/Frozertiru-gif/anonka/blob/main/.github/workflows/ci.yml
- Package manifest: https://github.com/Frozertiru-gif/anonka/blob/main/package.json

---

# 1. Краткая карта решений

## ОСТАВЛЯЕМ как техническую основу

Сохраняем и адаптируем, а не переписываем с нуля:

- GramJS Telegram user-account transport;
- Telegram user bridge;
- Telegram Bot API bridge для Control Bot;
- FloodWait/retry;
- debounce/queue mechanics;
- transport offsets как watermark;
- low-level media download/send primitives;
- low-level Gifts parsing + Stars ledger/ingestion primitives;
- LLM provider/model infrastructure;
- `better-sqlite3`, WAL, PRAGMA, migrations pattern;
- Pino logger и redaction;
- graceful shutdown/lifecycle идеи;
- file-permission hardening;
- Docker multi-stage/non-root подход;
- CI quality gates;
- при наличии пригодных primitives — только низкоуровневые TON/wallet возможности, которые реально помогают принимать/проверять TON/USDT платежи.

## МЕНЯЕМ / ВЫНОСИМ ПОЛЕЗНОЕ

Старые Teleton-модули, из которых полезна только часть:

- `src/telegram/handlers.ts`;
- `src/memory/*`;
- `src/soul/*`;
- `src/agent/tools/telegram/*`;
- TON/wallet код — только как потенциальный донор receive/verification primitives, не trading/business logic;
- `src/sdk/telegram-utils.ts` и близкие transport helpers;
- `src/app/provider-runtime.ts`;
- старый CLI/doctor;
- текущий config loader/schema;
- текущий Dockerfile/CI/package scripts.

Из них сначала выносим нужные primitives, после чего старые оболочки удаляем.

## ПЕРЕПИСЫВАЕМ ЦЕЛИКОМ на Anonka domain

- bootstrap приложения;
- `TeletonApp` / current `src/index.ts`;
- customer message pipeline;
- domain databases;
- durable Inbox;
- durable Outbox;
- logical conversations;
- conversation lifecycle `ACTIVE | INACTIVE | ARCHIVED`;
- proactive follow-up scheduler;
- relationship-manager AI contour;
- Supervisor + CreatorWorker topology;
- typed IPC;
- AnonAdapter/AnonController;
- anon search policy + active-capacity gating;
- Control Bot application layer;
- dialogue `AnonkaLLMService`;
- `ChatDecision` validation;
- `AnonkaPromptBuilder`;
- Media Vault index/catalog/selection;
- Offer/Gift domain state machines;
- crypto `PaymentExpectation` + incoming payment watcher/matching;
- AI/HUMAN/HYBRID control;
- recovery/idempotency layer;
- Anonka-specific config schema;
- doctor checks под Anonka.

## УДАЛЯЕМ после отвязки runtime

- старый general-purpose TON/wallet agent stack, кроме извлечённых payment receive/verification primitives;
- DEX/STON.fi/DeDust trading;
- NFT/DNS/DeFi;
- ненужный `src/ton-proxy/*` после extraction;
- Gocoon;
- MCP runtime;
- general AgentRuntime autonomous loop;
- generic tool RAG;
- exec/general-agent tools;
- plugin marketplace/hot reload;
- backend WebUI;
- Management API, если к моменту миграции не используется;
- **старый generic Teleton heartbeat/scheduled-agent runtime**;
- vector embeddings/sqlite-vec;
- old Teleton session/customer-memory pipeline;
- SDK package и SDK-specific CI после извлечения действительно нужных transport helpers.

Важно: удаление old heartbeat **не означает отказ от proactive messaging**. Для Anonka пишется отдельный event-driven follow-up scheduler. Аналогично удаление old wallet agent не означает отказ от узкого TON/USDT payment layer.

---

# 2. Что ОСТАВЛЯЕМ

## 2.1. Telegram user transport

Текущие файлы:

- [`src/telegram/client.ts`](https://github.com/Frozertiru-gif/anonka/blob/main/src/telegram/client.ts)
- [`src/telegram/bridges/user.ts`](https://github.com/Frozertiru-gif/anonka/blob/main/src/telegram/bridges/user.ts)
- [`src/telegram/bridge-interface.ts`](https://github.com/Frozertiru-gif/anonka/blob/main/src/telegram/bridge-interface.ts)
- [`src/telegram/flood-retry.ts`](https://github.com/Frozertiru-gif/anonka/blob/main/src/telegram/flood-retry.ts)
- [`src/telegram/offset-store.ts`](https://github.com/Frozertiru-gif/anonka/blob/main/src/telegram/offset-store.ts)
- [`src/telegram/debounce.ts`](https://github.com/Frozertiru-gif/anonka/blob/main/src/telegram/debounce.ts)

### Решение

**ОСТАВИТЬ И АДАПТИРОВАТЬ.**

### Что сохранить

- GramJS connection/session;
- `NewMessage` и raw/service updates;
- send/get message primitives;
- typing;
- FloodWait handling;
- reconnect;
- transport offset persistence;
- debounce mechanics;
- graceful connect/disconnect.

### Что добавить

- edited message support;
- raw update access, если текущего API недостаточно;
- button/reply-markup extraction;
- button click;
- `video_note` в transport types;
- `sendVideo`;
- `sendVideoNote`;
- `groupedId/media_group_id`;
- media resend/copy without forward attribution;
- non-interactive auth state reporting.

### Что НЕ делать

Не переписывать GramJS transport с нуля.

---

# 3. Что МЕНЯЕМ

## 3.1. `src/telegram/handlers.ts`

Текущий файл:

- [`src/telegram/handlers.ts`](https://github.com/Frozertiru-gif/anonka/blob/main/src/telegram/handlers.ts)

### Решение

**НЕ сохранять как customer decision engine. Использовать как донор infrastructure-кода.**

### Забрать из него

- serial queue;
- bounded global concurrency;
- dedupe ideas;
- typing;
- incoming persistence ordering;
- retry/drain mechanics;
- transport offset integration.

### Убрать

```text
MessageHandler
→ AgentRuntime.processMessage()
→ tools
→ response
```

### Целевая схема

```text
Telegram event
→ TransportRouter
→ durable Inbox
→ ConversationResolver
→ Debounce / ConversationQueue
→ ContextBuilder
→ Dialogue LLM contour
→ ChatDecision
→ DecisionValidator
→ ResponseScheduler / proactive follow-up entry
→ ActionCoordinator
→ durable Outbox
→ Telegram
```

Relationship-manager contour работает рядом с conversation domain и scheduler, но **не пишет customer-facing текст**.

### Новые файлы

- `src/telegram/transport-router.ts`
- `src/telegram/inbox-processor.ts`
- `src/telegram/outbox-worker.ts`
- `src/application/context-builder.ts`
- `src/application/response-scheduler.ts`
- `src/application/action-coordinator.ts`
- `src/application/followup-scheduler.ts`
- `src/llm/relationship-manager.ts`

### Фактическое состояние и безопасное переключение

Текущий `MessageHandler` остаётся рабочим **legacy path** только до переключения:

```text
Telegram event
→ legacy raw feed
→ MessageHandler
→ AgentRuntime.processMessage()
→ generic tools / response
```

Его RAM-dedupe по `chatId:messageId`, файловый offset и rate limiter, который пропускает сообщения при лимите, не являются частью нового core. В частности, edited update с тем же `chatId:messageId` нельзя считать duplicate нового Inbox.

Phase 1 добавляет отдельный single-creator customer entrypoint рядом с legacy runtime. Новый ingress получает нормализованные bridge events, классифицирует их через `TransportRouter`, сначала фиксирует Inbox и только затем обновляет transport offset. Старый путь не удаляется и не переписывается «на месте» до прохождения Phase-1 test gates.

---

## 3.2. SQLite / old memory layer

Текущая зона:

- [`src/memory/`](https://github.com/Frozertiru-gif/anonka/tree/main/src/memory)

### Решение

**FOUNDATION оставить, domain layer переписать полностью.**

### Оставить

- `better-sqlite3`;
- WAL;
- `foreign_keys`;
- PRAGMA tuning;
- migration mechanics;
- safe open/close;
- file permissions;
- FTS5 primitives при необходимости.

### Не переносить в новый domain DB

- `MemoryDatabase` как application DB;
- sqlite-vec;
- knowledge/vector schema;
- embeddings lifecycle;
- старые Teleton tasks/tools/audit tables;
- старый global `memory.db` как customer source of truth.

### Написать заново

- `src/storage/sqlite-primitives.ts`
- `src/storage/creator-db.ts`

- `src/supervisor/storage/supervisor-db.ts` относится к Phase 2 и не входит в первый deterministic core.

`sqlite-primitives.ts` — небольшой foundation, а не второй ORM: открыть creator-scoped путь, создать директорию, применить безопасные права, WAL/`foreign_keys`/нужные PRAGMA и транзакционные migrations. `CreatorDatabase` получает собственную schema version и никогда не открывает старый global `memory.db` как source of truth.

### Целевые DB

```text
supervisor.db
creator-A/creator.db
creator-B/creator.db
...
```

---

## 3.3. LLM/provider infrastructure

Текущие зоны:

- [`src/providers/`](https://github.com/Frozertiru-gif/anonka/tree/main/src/providers)
- [`src/agent/client.ts`](https://github.com/Frozertiru-gif/anonka/blob/main/src/agent/client.ts)
- [`src/agent/model-request.ts`](https://github.com/Frozertiru-gif/anonka/blob/main/src/agent/model-request.ts)
- [`src/agent/provider-fallback.ts`](https://github.com/Frozertiru-gif/anonka/blob/main/src/agent/provider-fallback.ts)

### Решение

**ОСТАВИТЬ provider stack. НЕ писать свой HTTP/LLM client с нуля.**

Поверх одной provider/model инфраструктуры работают две логические роли:

1. dialogue contour — формирует весь customer-facing текст и semantic intents;
2. relationship-manager contour — lifecycle/next-action/follow-up decisions, без customer-facing wording.

Это не требует двух разных физических моделей. По умолчанию обе роли могут использовать одну global LLM config с разными prompt/contracts.

### Поверх provider stack написать

- `src/llm/service.ts` — dialogue contour;
- `src/llm/chat-decision.ts`;
- `src/llm/decision-validator.ts`;
- `src/llm/relationship-manager.ts`;
- отдельный typed manager decision contract/validator.

### Structured output MVP

```text
prompt требует JSON
→ parse JSON
→ Zod validation
→ один repair call
→ если снова invalid: safe fallback
```

Dialogue text-only fallback не имеет права запускать media/offer/handoff/payment side effects.

Manager invalid output не имеет права автоматически менять payment truth, архивировать критический paid flow либо создавать произвольные side effects; безопасный fallback — сохранить текущий lifecycle/не выполнять новое действие.

Dialogue LLM вызывает provider stack без `AgentRuntime`, generic tools, plugin/MCP/trading context и legacy transcript persistence. Из `src/soul/loader.ts` можно извлечь только безопасное чтение creator-файлов, cache и sanitization; старый Teleton system prompt и global MEMORY/USER/IDENTITY в customer path не входят.

---

## 3.4. ProviderRuntime

Текущий файл:

- [`src/app/provider-runtime.ts`](https://github.com/Frozertiru-gif/anonka/blob/main/src/app/provider-runtime.ts)

### Решение

**АДАПТИРОВАТЬ.**

### Оставить

- provider initialization;
- OpenAI-compatible provider/local model discovery;
- обычный provider lifecycle.

### Удалить

- Gocoon-specific runtime;
- Gocoon runner/proxy wiring.

---

## 3.5. Persona / prompts

Текущая зона:

- [`src/soul/`](https://github.com/Frozertiru-gif/anonka/tree/main/src/soul)

### Решение

**ОСТАВИТЬ загрузку/cache/sanitization, prompt assembly переписать.**

### Оставить идеи

- `SOUL.md`;
- `STRATEGY.md`;
- `SECURITY.md`;
- safe file loading;
- cache;
- sanitization.

### Не использовать старый system prompt целиком

Убрать из customer path:

- global MEMORY;
- USER/IDENTITY;
- old generic heartbeat;
- tool instructions;
- owner-agent semantics;
- frozen process-global customer memory.

### Написать

- `AnonkaPromptBuilder` для dialogue contour;
- manager prompt/contract отдельно;
- creator-specific prompt loading;
- runtime context/facts/summary/recent-message assembly;
- follow-up context: why due, what changed since scheduling, known timing/schedule facts.

---

## 3.6. Telegram media / Gifts agent tools

Текущая зона:

- [`src/agent/tools/telegram/`](https://github.com/Frozertiru-gif/anonka/tree/main/src/agent/tools/telegram)

### Решение

**НЕ удалять всё сразу. Сначала извлечь low-level primitives. Затем удалить tool wrappers.**

### Извлечь

- media download;
- photo/video/video_note detection;
- audio/voice helpers;
- file metadata;
- transcription helper;
- Telegram error normalization;
- `payments.GetStarsTransactions` helper;
- Gift/service-message parsing;
- useful button/media helpers.

### Новое место

Например:

- `src/telegram/media-service.ts`;
- `src/telegram/media-download.ts`;
- `src/telegram/stars.ts`;
- `src/domain/commerce/gift-event.ts`.

После переноса удалить agent-tool wrappers и generic tool registration для них.

---

## 3.7. Bot API / Control Bot primitives

Текущие файлы:

- [`src/telegram/bridges/bot.ts`](https://github.com/Frozertiru-gif/anonka/blob/main/src/telegram/bridges/bot.ts)
- [`src/bot/callback-router.ts`](https://github.com/Frozertiru-gif/anonka/blob/main/src/bot/callback-router.ts)
- [`src/bot/callback-answer.ts`](https://github.com/Frozertiru-gif/anonka/blob/main/src/bot/callback-answer.ts)
- [`src/bot/rate-limiter.ts`](https://github.com/Frozertiru-gif/anonka/blob/main/src/bot/rate-limiter.ts)

### Решение

**ОСТАВИТЬ transport/security primitives, application layer написать заново.**

### Оставить

- grammY bridge;
- callback binding/security ideas;
- inline keyboards;
- answer-once semantics;
- send/edit/delete primitives.

### Переписать

- command set;
- creator status UI;
- anon search enabled/stop controls;
- `max_active_conversations` setting;
- search state `SEARCHING | PAUSED_CAPACITY | STOPPED_BY_ADMIN`;
- lists/counts for `ACTIVE | INACTIVE | ARCHIVED`;
- conversation takeover/control-mode actions;
- media moderation UI;
- runtime controls;
- payment/review cards;
- alerts;
- callback storage.

### Product boundary

Control Bot — **не зеркало переписок**.

Он показывает conversation metadata: peer/identity, lifecycle status, last activity, control mode, next follow-up, pending payment/review/error и т.п.

Не делать обычный `/dialog <id>` интерфейсом чтения полного message body. Полную переписку владелец читает и пишет через Telegram user-account creator.

Long-lived callbacks должны храниться в `supervisor.db`, а не только RAM.

---

## 3.8. Контракт Outbox transport boundary

Concrete `GramJSUserBridge` уже умеет отправку с сохранённым MTProto `random_id`, но этот параметр должен быть доступен и через typed application-facing bridge contract. Перед Outbox нужно добавить явный outbox-send API либо расширить `ITelegramBridge` для text/photo/video/video_note/copy.

Нельзя обходить это приведением типа к concrete `GramJSUserBridge`: durable Outbox обязан передавать свой сохранённый correlation key через интерфейс и повторно использовать его после restart.

---

# 4. Что ПЕРЕПИСЫВАЕМ ЦЕЛИКОМ

## 4.1. Bootstrap / `TeletonApp`

Текущий файл:

- [`src/index.ts`](https://github.com/Frozertiru-gif/anonka/blob/main/src/index.ts)

### Решение

**ПЕРЕПИСАТЬ ЦЕЛИКОМ.**

Текущий `TeletonApp` связывает general AgentRuntime, tools, old TON stack, MCP, plugins, WebUI/API, heartbeat, scheduled tasks и old memory lifecycle.

Целевой bootstrap:

```text
main
→ load static config
→ open supervisor.db
→ start Control Bot
→ start CreatorSupervisor
→ validate creator registry
→ spawn enabled CreatorWorkers
→ lifecycle/signals
```

Новый customer path не должен зависеть от `TeletonApp`.

---

## 4.2. Creator process topology

Создать:

```text
src/supervisor/
├── supervisor.ts
├── worker-manager.ts
├── creator-registry.ts
├── ipc.ts
├── control-bot/
│   ├── commands.ts
│   ├── callbacks.ts
│   └── alerts.ts
└── storage/
    └── supervisor-db.ts

src/runtime/
├── creator-runtime.ts
├── lifecycle.ts
├── recovery.ts
└── auth-state.ts
```

### Требования

- один creator = один OS process;
- одна Telegram user session на worker;
- отдельный `creator.db`;
- отдельный runtime home;
- Supervisor пишет только `supervisor.db`;
- worker пишет только свой `creator.db`;
- typed IPC;
- bounded restart backoff;
- crash-loop protection;
- `AUTH_REQUIRED`, а не stdin prompt в production worker.

---

## 4.3. Durable Inbox

Написать новый Anonka Inbox.

### Минимальный ключ дедупликации

```text
creator_id + event_type + telegram_chat_id + telegram_message_id
```

### Правило

```text
Telegram event
→ durable Inbox commit
→ только потом transport offset advancement
```

Offset store — watermark/optimization, не источник истины о domain processing.

---

## 4.4. Durable Outbox

Написать новый Outbox.

### Нужно хранить

```text
id
creator_id
conversation_id
kind
payload_json
idempotency_key
transport_random_id/correlation_id
status
telegram_message_id
attempts
created_at
sent_at
```

### Критическое требование

Pre-send transport correlation сохраняется **до network send**, где MTProto это позволяет.

Crash после принятия Telegram send, но до локального `sent` acknowledgement, не должен приводить к повторной отправке платного media.

---

## 4.5. Conversations

Написать новый domain layer:

```text
src/domain/conversations/
```

### Обязательно

- logical `conversation_id`;
- direct DM mapping;
- anonymous room mapping;
- anon → DM continuity;
- `conversation_version`;
- source `customer | creator_manual | programmatic`;
- AI/HUMAN/HYBRID;
- product lifecycle `ACTIVE | INACTIVE | ARCHIVED`;
- `next_followup_at` / `followup_reason` / `waiting_for`;
- facts;
- rolling summary;
- recent messages;
- canonical `conversation_messages`.

Telegram physical `chatId` не является conversation identity.

`24h` inactivity может быть configurable fallback, но не единственным lifecycle rule. Quick completed sale может освободить active slot сразу; meaningful long-term contact может оставаться active дольше при явном контексте/следующем follow-up.

Если известный человек из INACTIVE/ARCHIVED снова пишет, восстановить тот же conversation context/history, а не начинать знакомство с нуля.

---

## 4.6. Anonymous chat domain

Создать:

```text
src/telegram/anon/adapter.ts
src/telegram/anon/controller.ts
```

### State machine

```text
STOPPED
SEARCHING
ROOM_ACTIVE
HANDOFF_PENDING
SKIPPING
```

### Отдельная search policy

У creator хранить/получать:

```text
anon_search_enabled
max_active_conversations
```

Поверх low-level controller:

```text
search enabled + active_count < max
→ разрешить/продолжить поиск

active_count >= max
→ PAUSED_CAPACITY

capacity freed + search enabled
→ resume

admin stop
→ STOPPED_BY_ADMIN и никакого auto-resume
```

Остановка поиска не завершает существующие conversations.

### Code-side only

LLM не нажимает `next/search/stop/link` напрямую.

### Stale guard

```text
creator_id
conversation_id
anon_source_id
room_generation
conversation_version
```

---

## 4.7. Dialogue `AnonkaLLMService`

Создать:

```text
src/llm/service.ts
src/llm/chat-decision.ts
src/llm/decision-validator.ts
```

Dialogue contour отвечает за весь customer-facing communication:

- reply/no_reply;
- exact customer-facing text;
- tone/persona;
- один или несколько natural messages;
- semantic facts;
- media intent;
- offer intent;
- soft gift ask;
- handoff intent;
- human-attention recommendation;
- semantic signals для управляющего слоя: обещание написать позже, payment intent, known schedule/event, естественное завершение разговора и т.п.

Dialogue LLM не подтверждает деньги и не выбирает exact paid asset.

---

## 4.8. Relationship-manager contour + proactive scheduler

Создать отдельный typed manager layer, например:

```text
src/llm/relationship-manager.ts
src/domain/conversations/relationship-manager.ts
src/application/followup-scheduler.ts
```

Manager **не пишет customer-facing текст**.

Он решает:

- ACTIVE/INACTIVE/ARCHIVED transitions/recommendations;
- ждём ли customer response;
- нужен ли future proactive contact;
- когда `next_followup_at`;
- reason/priority;
- стоит ли вообще инициировать контакт при наступлении срока;
- human-attention recommendation;
- создать/обновить semantic payment expectation, если это явно следует из разговора.

### Не делать global LLM polling

Manager вызывается по событиям и due tasks:

```text
meaningful conversation change
sale completion
payment promise
confirmed payment
manual creator intervention
next_followup_at due
meaningful wait/deadline expired
```

При наступлении follow-up:

```text
cheap deterministic validity check
→ stale/new-message/manual-intervention guard
→ manager re-evaluation if needed
→ dialogue contour composes actual text
→ scheduler/Outbox sends
```

Incoming/manual messages должны отменять или пересчитывать stale follow-up.

---

## 4.9. Media Vault

Создать новый domain/application слой:

```text
src/domain/media/
src/telegram/media-service.ts
```

### Индексатор

Canonical Vault reader = **CreatorWorker / Telegram user account**.

Control Bot не является source of truth для history indexing.

### Реализовать

- live indexing;
- history scan/reindex;
- manual strict tags;
- deterministic parser;
- PENDING/APPROVED/REJECTED;
- `media_group_id`;
- MediaSeries;
- MediaSelector;
- no-repeat selection;
- resend without forward attribution;
- `media_deliveries`.

Vision/LLM auto-tagging не делать.

---

## 4.10. Commerce / Gifts / Crypto

Создать/довести:

```text
src/domain/commerce/
src/payments/
```

### Gift attribution

Канонический source of truth — входящий Telegram `GiftEvent`.

```text
GiftEvent
→ dedupe
→ sender/value validation
→ current conversation sender OR pending expectation
   ├── match → CONFIRMED + profit once
   └── no/ambiguous/mismatch → MANUAL_REVIEW
```

`nameHidden` не означает anonymous sender. Если Telegram sender известен, он остаётся usable.

Stars transaction history не используется как обязательный Gift matcher. Она остаётся audit/ledger infrastructure.

### Crypto PaymentExpectation

Разговорный контур может извлечь semantic intent:

```text
asset = TON|USDT
amount/range
when
purpose = patron|offer|unknown
```

Application/manager layer создаёт durable expectation. LLM не подтверждает receipt.

Минимально:

```text
creator_id
conversation_id
payment_method
asset
expected_amount / expected_range
purpose
expected_sender/wallet if known
related_offer_id NULL
created_at
expires_at
status
```

### Crypto watcher

Не использовать LLM polling кошелька.

Обычный adapter/watcher получает incoming wallet/blockchain/payment events через выбранный Wallet/TON API, webhook либо lightweight indexer polling.

```text
incoming crypto event
→ normalize
→ dedupe
→ deterministic match pending expectations
→ CONFIRMED | MANUAL_REVIEW
```

### Approximate amount

Для PATRON/support допустим configurable tolerance, default candidate например `±5 USD equivalent`, если разговор действительно описывает приблизительную сумму.

Пример: «около 25 USDT» → expectation может быть `20–30 USD equivalent`.

Это только matching range. При нескольких подходящих candidates attribution не угадывать.

### DIRECT_SALE

Patron tolerance не является автоматической скидкой.

Offer должен быть оплачен по negotiated/snapshotted price, кроме отдельного малого technical rounding tolerance. Если в разговоре реально согласовали новую цену, сначала обновляется price snapshot, потом новая сумма считается достаточной.

### Manual review

Control Bot должен уметь показывать pending Gift/crypto reviews и выполнять idempotent CONFIRM/REJECT там, где manual review разрешён domain contract.

### Offer states

```text
WAITING
PAID
FULFILLING
FULFILLED
CANCELLED
EXPIRED
BLOCKED
```

DIRECT_SALE Offer переходит в `PAID` только после confirmed payment attribution + reliable value/context. При сомнении — manual review.

Один Gift/crypto payment event может оплатить максимум один Offer и не начисляет profit дважды.

### Paid fulfillment

Только через durable Outbox + idempotency.

---

## 4.11. Config

Текущие файлы/доки:

- [`config.example.yaml`](https://github.com/Frozertiru-gif/anonka/blob/main/config.example.yaml)
- [`docs/configuration.md`](https://github.com/Frozertiru-gif/anonka/blob/main/docs/configuration.md)

### Решение

**Loader/Zod ideas оставить, schema переписать под Anonka.**

### Static YAML/env

- Telegram API ID/hash;
- Control Bot token/admin allowlist;
- global LLM provider/model/base URL/key;
- filesystem paths;
- logging;
- operational limits;
- crypto payment provider/wallet/indexer secrets/config where applicable.

### Mutable DB state

- creator enabled;
- AI/HUMAN/HYBRID;
- commercial mode;
- price;
- offers/media toggles;
- `anon_search_enabled`;
- `max_active_conversations`;
- anon runtime/search state;
- fallback inactivity threshold;
- payment feature toggles where needed.

Control Bot не должен постоянно переписывать YAML.

---

# 5. Что УДАЛЯЕМ ЦЕЛИКОМ

Удалять только после отвязки от нового bootstrap и после извлечения полезных primitives.

## 5.1. Старый TON / wallet ecosystem

Удалить после extraction:

- DEX/STON.fi/DeDust trading logic;
- NFT/DNS/DeFi tooling;
- autonomous TON wallet agent/tools;
- irrelevant TON business logic/config/tests/docs;
- ненужные части `src/ton/` и `src/ton-proxy/`.

### Перед удалением проверить и при необходимости извлечь

- wallet/address primitives;
- TON/USDT transfer normalization;
- balance/transaction reading primitives;
- безопасные helpers, которые реально уменьшают работу для receive/verification payment adapter.

Не сохранять старый TON subsystem целиком только ради платежей. Целевая функция — узкий payment receive/verification layer.

## 5.2. General autonomous agent platform

После замены customer path удалить:

- old `AgentRuntime` autonomous execution path;
- generic tool registry/runtime;
- tool search/RAG;
- exec/general-purpose agent tools;
- tool permission machinery, если больше нигде не нужна;
- agent turn/tool trace tables.

## 5.3. MCP

Удалить:

- MCP loader/runtime;
- MCP config;
- MCP tests/dependencies.

## 5.4. Plugins

Удалить:

- plugin marketplace/module loader;
- plugin watcher/hot reload;
- plugin lifecycle/events/hooks;
- plugin-specific config/storage.

## 5.5. WebUI/API

Frontend `web/` уже удалён.

После нового bootstrap удалить оставшийся backend:

- [`src/webui/`](https://github.com/Frozertiru-gif/anonka/tree/main/src/webui)
- [`src/api/`](https://github.com/Frozertiru-gif/anonka/tree/main/src/api), если не нужен отдельный API;
- server-deps wiring;
- WebUI logging stream;
- WebUI/API dependencies/tests/config.

## 5.6. Old heartbeat / scheduled autonomous work

Удалить:

- старый generic Teleton `heartbeat` general-agent behavior;
- старые scheduled agent tasks;
- соответствующие generic config/schema/tests.

Но **не удалять product requirement на инициативное общение**. Вместо старого heartbeat реализовать отдельный Anonka event-driven `followup-scheduler`, который хранит конкретные due tasks и не сканирует все conversations через LLM.

## 5.7. Vector/RAG memory

Удалить:

- `sqlite-vec`;
- embeddings;
- vector knowledge;
- embedding cache;
- vector RAG.

FTS5 допускается оставить отдельно.

## 5.8. Old Session/transcript customer identity

Удалить из canonical path:

- `telegram:<chatId>` session identity;
- daily reset как conversation boundary;
- idle reset как conversation boundary;
- JSONL transcript как второй source of truth;
- global MEMORY-based customer identity.

## 5.9. SDK package

Текущая зона:

- [`packages/sdk/`](https://github.com/Frozertiru-gif/anonka/tree/main/packages/sdk)

### Решение

SDK как публичный Teleton product Anonka не нужен.

Но **до удаления** проверить и вынести low-level Telegram helpers, на которые ещё ссылается runtime.

После этого удалить:

- `packages/sdk/`;
- SDK build scripts;
- SDK CI coverage/contracts;
- SDK docs/dependencies.

---

# 6. Порядок работы

## Phase 0 — Transport spike и фиксация primitives

Цель: доказать Telegram-specific вещи до большого рефакторинга.

Сделать:

1. DM receive/send через dedicated user account.
2. Anonymous bot allowlist exception.
3. Raw updates + edited messages.
4. Extract reply markup/buttons и programmatic click.
5. Photo/video/video_note send/receive.
6. Vault history scan.
7. Vault media resend без forward attribution.
8. Реальный Gift event/fixture: sender/value/event key доходят до GiftLedger.
9. `nameHidden` edge case: известный sender не теряется; unknown/mismatch уходит в MANUAL_REVIEW.
10. Stars transaction ingestion/normalization/pagination spike как audit/ledger primitive, без mandatory Gift reconciliation.
11. Manual vs programmatic outgoing correlation spike.
12. Pre-send MTProto correlation/idempotency spike.
13. Отдельный `creator login`/setup flow; worker без session возвращает `AUTH_REQUIRED`.

### Готово, когда

Есть executable tests/fixtures для рискованных Telegram предположений.

---

## Phase 1 — новый deterministic core

Порядок:

Это **implementation order**, а не порядок обработки одного Telegram update. Runtime порядок остаётся: `normalized event → TransportRouter → durable Inbox commit → transport offset → Inbox processing`.

До начала обработки Inbox router обязан различать как минимум `message_created`, `message_edited`, service/raw event и outgoing event. Поэтому edit с тем же Telegram message id не конфликтует с исходным сообщением: `event_type` входит в idempotency key.

1. `sqlite-primitives.ts`.
2. `CreatorDatabase` + migrations.
3. durable Inbox.
4. authoritative event dedupe.
5. TransportRouter.
6. logical Conversation resolver.
7. logical debounce/queue.
8. dialogue `AnonkaLLMService`.
9. `ChatDecision` + Zod validation/repair.
10. ResponseScheduler.
11. ActionCoordinator.
12. durable Outbox.
13. pre-send correlation.
14. graceful worker lifecycle.

### После этого

Customer message больше не должен идти через старый `AgentRuntime`.

### Чёткие границы Phase 1

В Phase 1 нужен минимальный logical `conversation_id`, creator-scoped mapping и version для queue/stale guards. Полные canonical `conversation_messages`, facts, summaries, creator manual history, proactive relationship management и anon → DM continuity остаются Phase 3.

Не включать сюда `SupervisorDatabase`, registry, OS-process isolation, IPC, Control Bot и crash-loop management: это Phase 2. Media Vault не переносится из transport spike в domain catalog до Phase 4; durable Gifts/Offers/crypto payments — до Phase 5.

### Phase-1 test gates

До переключения customer path должны быть доказаны отдельными тестами:

```text
Inbox duplicate → one durable record / one logical turn
Inbox commit succeeds before offset advances
stale processing recovers after crash
edited event and original message are distinct event types
multi-message logical batch → one LLM turn
same conversation serial / different conversations bounded-concurrent
invalid ChatDecision → one repair → text-only fallback with no side effects
technical LLM failure does not expose internals to customer
Outbox row + correlation commit before bridge send
accepted-send/crash restart reuses the same random_id
FloodWait waits or retries; customer event is never dropped
graceful drain finishes accepted Inbox/Outbox work
```

---

## Phase 2 — Supervisor / multi-creator / Control Bot

1. `SupervisorDatabase`.
2. Creator registry.
3. `CreatorWorker` process entrypoint.
4. Worker Manager.
5. typed IPC.
6. Control Bot.
7. durable admin callbacks.
8. AI/HUMAN/HYBRID controls.
9. non-interactive auth state.
10. restart backoff/crash-loop protection.
11. admin audit/alerts.
12. owner `anon_search_enabled` toggle.
13. `max_active_conversations` per creator.
14. automatic `PAUSED_CAPACITY` / resume policy.
15. Control Bot counts/lists `ACTIVE | INACTIVE | ARCHIVED` with metadata only, no full message-body viewer.

---

## Phase 3 — conversation memory, relationship management и handoff

1. canonical `conversation_messages`.
2. facts.
3. rolling summary.
4. recent history window.
5. manual outgoing integration.
6. stale response cancellation.
7. anonymous room identity.
8. anon → DM same `conversation_id`.
9. raw feed retention independent from canonical history.
10. lifecycle `ACTIVE | INACTIVE | ARCHIVED`.
11. reactivation of known inactive/archived person with preserved context.
12. configurable inactivity fallback (например 24h), но не как единственный lifecycle rule.
13. relationship-manager AI contour with typed decision/validation.
14. `next_followup_at` / reason / waiting state.
15. durable event-driven follow-up scheduler.
16. due follow-up validity/stale checks.
17. manager decides whether/when to initiate; dialogue contour always writes customer-facing text.
18. cancel/recompute proactive follow-up after incoming customer/manual creator intervention.
19. manager invocation only on meaningful events/due tasks, no periodic LLM scan of every conversation.

---

## Phase 4 — Media Vault

1. Extract low-level media helpers.
2. MediaVaultIndexer inside CreatorWorker.
3. strict tag parser.
4. approval state.
5. `media_group_id`.
6. MediaSeries.
7. MediaSelector.
8. no-repeat logic.
9. copy/resend without attribution.
10. delivery history.
11. Control Bot media cards/actions.

---

## Phase 5 — Commerce: Gifts + crypto

1. Persist normalized GiftEvent/GiftLedger state.
2. GiftEvent-based sender/value attribution.
3. Pending gift expectation per conversation/chat where needed.
4. MANUAL_REVIEW + durable Control Bot CONFIRM/REJECT.
5. Duplicate-Gift/profit idempotency.
6. Keep Stars ledger for audit/diagnostics only; no mandatory reconciliation matcher.
7. Offer state machine.
8. DIRECT_SALE.
9. PATRON.
10. asset/series reservation.
11. crash-safe paid fulfillment.
12. durable generic `PaymentExpectation` abstraction for crypto promises from conversation context.
13. TON/USDT incoming payment adapter/watcher.
14. crypto transaction normalization/dedupe.
15. deterministic matching using asset, amount/range, time, sender wallet/reference and related Offer where available.
16. configurable approximate PATRON tolerance, default candidate ±5 USD-equivalent.
17. DIRECT_SALE price rule separate from patron tolerance; underpayment does not auto-pay.
18. ambiguous crypto match → MANUAL_REVIEW.
19. one Gift/crypto payment event → at most one profit credit / one Offer consumption.
20. confirmed crypto fact returned into conversation context for natural dialogue reaction.

---

## Phase 6 — mass cleanup

Только когда новый path покрыт test contracts:

1. удалить old AgentRuntime customer path;
2. удалить old TON trading/DEX/NFT/DNS/DeFi/wallet-agent stack **после extraction нужных payment receive primitives**;
3. удалить Gocoon;
4. удалить MCP;
5. удалить plugins;
6. удалить backend WebUI/API;
7. удалить old generic heartbeat/scheduled agent tasks, сохранив новый Anonka follow-up scheduler;
8. удалить vector/RAG memory;
9. удалить old sessions/transcripts;
10. удалить SDK package после extraction;
11. удалить unused dependencies;
12. пересобрать `package-lock.json`;
13. упростить Dockerfile;
14. очистить CI от legacy jobs;
15. переписать operational docs.

---

# 7. Документация, которую переписываем в конце

Текущие файлы:

- [`README.md`](https://github.com/Frozertiru-gif/anonka/blob/main/README.md)
- [`config.example.yaml`](https://github.com/Frozertiru-gif/anonka/blob/main/config.example.yaml)
- [`docs/configuration.md`](https://github.com/Frozertiru-gif/anonka/blob/main/docs/configuration.md)
- [`docs/telegram-setup.md`](https://github.com/Frozertiru-gif/anonka/blob/main/docs/telegram-setup.md)
- [`docs/deployment.md`](https://github.com/Frozertiru-gif/anonka/blob/main/docs/deployment.md)

Переписать под фактический Anonka runtime только после стабилизации интерфейсов/config.

`PRODUCT_REQUIREMENTS.md` остаётся source of truth для product behavior, `ARCHITECTURE.md` — для technical architecture, а этот файл — порядком реализации.

---

# 8. Test gates перед удалением legacy

Минимально должны быть доказаны:

```text
duplicate Telegram event -> one Inbox record / one logical turn
offset advances only after durable Inbox write
rate limit waits instead of dropping
multi-message debounce -> one LLM call
manual outgoing != programmatic outgoing
outgoing update race before send() return handled correctly
crash after Telegram accepted send does not duplicate outgoing
paid fulfillment crash does not duplicate paid media
invalid ChatDecision cannot trigger side effects
worker without session -> AUTH_REQUIRED, no stdin wait
repeated worker crashes -> ERROR/STOPPED, no infinite restart
Supervisor restart does not invalidate active durable admin callback
Vault reindex works through user-account worker
media resend has no forward attribution
duplicate Gift credits profit once
Gift from current DM user auto-confirms
Gift from expected sender auto-confirms and fulfills expectation
sender mismatch / unknown sender -> MANUAL_REVIEW
nameHidden with known sender remains attributable
manual CONFIRM credits known profit once and clears expectation
manual REJECT credits nothing and keeps expectation
one confirmed Gift pays at most one Offer
anon -> DM preserves conversation_id
raw feed pruning cannot delete canonical history
Supervisor does not write creator.db
workers do not share DB/session/persona
search enabled + free capacity -> anon search proceeds
active capacity reached -> search pauses without disabling owner toggle
capacity freed + owner toggle enabled -> search resumes
admin stop -> search does not auto-resume
quick completed sale can become INACTIVE immediately
meaningful long-term contact can remain ACTIVE beyond fallback timeout
inactive/archive customer returns -> existing context is restored
Control Bot lists metadata without full customer message bodies
manager schedules a single future follow-up without polling every conversation
incoming/manual message invalidates stale follow-up
follow-up due -> dialogue contour writes the actual customer text
manager contour never writes customer-facing content
crypto promise -> durable PaymentExpectation
PATRON approximate crypto expectation can use configured ±5 USD-equivalent range
DIRECT_SALE underpayment is not accepted by patron tolerance
unambiguous crypto event -> one confirmed attribution
ambiguous crypto event -> MANUAL_REVIEW
one crypto payment cannot credit twice or pay two Offers
```

До прохождения соответствующего gate нельзя удалять код, который остаётся единственным рабочим implementation нужной функции.

---

# 9. Правило для DeepSeek / OpenCode

Перед любой задачей DeepSeek должен прочитать:

1. [`AGENTS.md`](https://github.com/Frozertiru-gif/anonka/blob/main/AGENTS.md)
2. [`PRODUCT_REQUIREMENTS.md`](https://github.com/Frozertiru-gif/anonka/blob/main/PRODUCT_REQUIREMENTS.md)
3. [`ARCHITECTURE.md`](https://github.com/Frozertiru-gif/anonka/blob/main/ARCHITECTURE.md)
4. этот `IMPLEMENTATION_PLAN.md`.

Этот plan **не отменяет protected scope из `AGENTS.md`**.

Если шаг плана требует изменения области, которую `AGENTS.md` запрещает DeepSeek трогать без отдельного разрешения:

```text
DeepSeek читает protected code для контекста
→ не меняет его
→ выполняет безопасную часть задачи
→ сообщает, какой конкретно protected change остаётся
```

Не разрешается обходить protected scope переносом/удалением файла, массовым codemod, dependency cleanup или косвенным изменением generated/config artifacts.

---

# 10. Definition of Done миграции

Миграция Teleton → Anonka считается законченной, когда:

- customer path не зависит от `AgentRuntime`;
- один creator изолирован в одном worker process;
- Supervisor/worker DB ownership соблюдается;
- Inbox является authoritative ingestion/dedupe boundary;
- Outbox обеспечивает crash-safe idempotent sends;
- anonymous physical chat отделён от logical conversation;
- anon → DM сохраняет conversation identity;
- AI/HUMAN/HYBRID работает со stale cancellation;
- dialogue contour является единственным генератором customer-facing AI text;
- relationship-manager contour event-driven управляет lifecycle/next follow-up и не пишет customer text;
- proactive follow-up переживает restart и не требует LLM polling всех conversations;
- ACTIVE/INACTIVE/ARCHIVED и creator active-capacity работают по `PRODUCT_REQUIREMENTS.md`;
- anon search owner toggle, capacity pause и auto-resume работают независимо и предсказуемо;
- Control Bot показывает operational metadata, но не дублирует полные customer messages;
- Media Vault индексируется user-account worker-ом;
- media tags deterministic/manual;
- Gifts подтверждаются code-side по authoritative live GiftEvent;
- sender match с current conversation/expectation auto-confirms Gift;
- unknown/mismatched/ambiguous Gift идёт в MANUAL_REVIEW и не оплачивает Offer автоматически;
- Stars history остаётся audit/ledger infrastructure, а не mandatory Gift reconciliation;
- crypto PaymentExpectation создаётся из conversation intent, но receipt подтверждается только real payment event;
- TON/USDT payment matching deterministic; ambiguity идёт в MANUAL_REVIEW;
- approximate patron tolerance не превращается в скидку DIRECT_SALE;
- paid fulfillment crash-safe;
- Control Bot callbacks durable;
- runtime auth не блокируется на stdin;
- graceful shutdown drains accepted work;
- old trading/DeFi/NFT/general wallet-agent stack удалён, узкий payment layer сохранён/реализован;
- old generic heartbeat удалён, Anonka-specific proactive scheduler сохранён;
- old MCP/plugins/WebUI/vector/SDK bloat удалён;
- package dependencies очищены;
- Docker/CI сохраняют security/quality свойства;
- README/config/deployment docs соответствуют фактическому runtime;
- обязательные test contracts проходят.
