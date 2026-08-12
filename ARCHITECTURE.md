# Anonka — целевая архитектура

> Статус: единая каноническая архитектурная спецификация проекта после полного аудита Teleton Agent 0.10.1 и повторной сверки с фактическим кодом `main`.  
> Репозиторий: `Frozertiru-gif/anonka`.  
> Этот файл — единственный источник архитектурных решений проекта. Отдельные addendum/старые Teleton-документы не должны переопределять его.

---

# 1. Что строим

`anonka` — Telegram-система для одного или нескольких `creator`-профилей.

`creator` — девушка/персона, а не LLM-модель.

Ключевая единица:

```text
Creator
├── свой Telegram user-account
├── своя persona / стиль общения
├── свой Media Vault
├── свои conversations
├── свой anon source/controller
├── свой runtime state
└── свой creator.db
```

Система:

1. работает через MTProto как реальные Telegram user-account;
2. работает с anonymous-chat bot и обычными DM;
3. сохраняет один логический `conversation` при anon → DM;
4. поддерживает `AI | HUMAN | HYBRID` на каждый conversation;
5. генерирует в runtime в основном текст;
6. фото/видео/video notes берет из заранее подготовленного Media Vault;
7. поддерживает `DIRECT_SALE` и `PATRON`;
8. Gifts подтверждает только code-side логикой по самому Telegram GiftEvent; Stars history остаётся audit/ledger infrastructure;
9. управляется через отдельного приватного Telegram Control Bot;
10. по умолчанию использует одну общую LLM-конфигурацию для всех creator runtime;
11. не содержит KYC, age verification, consent/approval workflow и аналогичной административной бюрократии;
12. не является general-purpose autonomous agent.

Teleton используется как инфраструктурный chassis, а не как готовый decision engine.

---

# 2. Главный архитектурный принцип

> **LLM отвечает за язык, persona, смысл и semantic intents. Код отвечает за состояние, Telegram actions, media, деньги и проверяемые факты.**

LLM может:

- написать reply;
- вернуть `no_reply`;
- выделить новые facts;
- сформировать `MediaIntent`;
- сформировать `OfferIntent`;
- предложить soft gift ask;
- предложить anon → DM handoff;
- рекомендовать human attention.

LLM не может:

- сама выполнять `search/next/stop/link`;
- считать Gift полученным;
- выбирать exact media asset id;
- помечать Offer paid;
- выполнять fulfillment;
- менять runtime config;
- читать arbitrary Telegram dialogs/contacts;
- выполнять generic Telegram tools;
- самостоятельно менять `AI/HUMAN/HYBRID`.

Production customer path:

```text
Telegram event
→ TransportRouter
→ durable Inbox
→ ConversationResolver
→ Debounce + ConversationQueue
→ ContextBuilder
→ AnonkaLLMService
→ ChatDecision
→ DecisionValidator
→ ResponseScheduler
→ ActionCoordinator
→ durable Outbox
→ Telegram / Media / Commerce
```

---

# 3. Что переиспользуем из Teleton

## 3.1. Telegram user-account infrastructure

Сохраняем и адаптируем:

```text
src/telegram/client.ts
src/telegram/bridges/user.ts
src/telegram/bridge-interface.ts
src/telegram/flood-retry.ts
src/telegram/offset-store.ts
src/telegram/debounce.ts
```

Из `src/telegram/handlers.ts` сохраняем инфраструктурные механизмы:

- per-chat/per-key serial queue;
- bounded global concurrency;
- dedupe;
- persistent transport offsets;
- typing primitives;
- incoming persistence before processing;
- graceful drain;
- retry/FloodWait behavior.

Не сохраняем текущий decision wiring `MessageHandler → AgentRuntime`.

## 3.2. Telegram Bot API infrastructure

Переиспользуем:

```text
src/telegram/bridges/bot.ts
src/bot/callback-router.ts
src/bot/callback-answer.ts
src/bot/rate-limiter.ts
```

На этой базе строится Control Bot.

Сохраняем идеи:

- Grammy bridge;
- inline keyboards;
- callback auth binding;
- single-use callback semantics;
- `answerCallbackOnce()`;
- command sync;
- typing/send/edit/delete primitives.

Но long-lived Control Bot callbacks переводим в durable storage, см. ниже.

## 3.3. LLM/provider layer

Переиспользуем:

```text
src/providers/
src/agent/client.ts
src/agent/model-request.ts
src/agent/provider-fallback.ts
```

Полезно уже реализовано:

- provider/model resolver;
- OpenAI-compatible endpoints;
- local model discovery;
- timeout;
- `AbortSignal`;
- temperature/max tokens;
- credential refresh для поддерживаемых providers;
- технический fallback;
- usage/cost plumbing;
- stripping `<think>...</think>` blocks.

Новый provider stack с нуля не пишем.

## 3.4. SQLite primitives

Сохраняем только foundation:

```text
better-sqlite3
WAL
foreign_keys
PRAGMA tuning
migration pattern
open/close lifecycle
file-permission hardening
FTS5 primitives
```

**Не используем старый `MemoryDatabase` как Anonka domain DB.**

Он связан с:

```text
sqlite-vec
knowledge tables
vector tables
embedding lifecycle
старым Teleton ensureSchema()/migrations
старой memory.db
```

Целевой слой:

```text
SQLite primitives
├── SupervisorDatabase → supervisor.db
└── CreatorDatabase    → creator.db
```

У обеих БД собственные чистые Anonka schemas/migrations.

## 3.5. Gifts / Stars primitives

Не выбрасываем код, работающий с:

```text
MessageActionStarGift
MessageActionStarGiftPurchaseOffer
MessageActionStarGiftPurchaseOfferDeclined
payments.GetStarsTransactions
```

Существующий parser/tool code превращаем из agent tools в обычные typed domain/infrastructure services. GiftEvent является source of truth для attribution/profit; Stars transaction ingestion сохраняется как audit/ledger primitive, а не обязательный matcher.

## 3.6. Telegram media helpers

Перед удалением tool layer сохранить/вынести полезный низкоуровневый код:

```text
downloadMedia
photo/video handling
voice/audio handling
videoNote detection
sticker/GIF handling
file/buffer metadata
entity resolving
audio transcription helper
Telegram error normalization
Stars/Gifts helpers
```

`vision-analyze` не является частью Media Vault tagging и после миграции не нужен для каталога.

## 3.7. Logger, permissions, lifecycle, CLI quality

Сохраняем:

- Pino structured logger;
- redaction API keys, api_hash, access tokens, passwords, secrets, bot tokens;
- `0600` для sensitive files;
- `0700` для sensitive directories;
- graceful SIGINT/SIGTERM handling;
- shutdown timeout safety net;
- идею `doctor` CLI;
- Docker non-root/multi-stage подход;
- сильные CI quality gates.

WebUI-specific logging stream, TON-specific doctor checks и старые paths позже удаляются.

---

# 4. Что переделываем в Teleton

## 4.1. MessageHandler

Было:

```text
Telegram message
→ AgentRuntime.processMessage()
→ tools
→ response
```

Станет:

```text
Telegram event
→ TransportRouter
→ Inbox
→ logical Conversation
→ LLM ChatDecision
→ code-side actions
```

`AgentRuntime` исчезает из customer production path.

## 4.2. Bot filter

Было:

```text
message.isBot → ignore
```

Станет:

```text
sender is bot?
├── configured anonymous bot → AnonAdapter
└── любой другой bot → ignore
```

## 4.3. Self outgoing

Было:

```text
sender == own account → ignore
```

Станет:

```text
outgoing event
├── matched to durable Outbox correlation → programmatic outgoing
└── not matched → creator_manual
```

Manual outgoing:

```text
persist source=creator_manual
→ resolve conversation
→ increment conversation_version
→ abort stale AI generation/send
→ apply AI/HUMAN/HYBRID policy
```

## 4.4. Rate limiting

Нельзя:

```text
rate limit reached
→ drop/skip message
```

Нужно:

```text
persist
→ queue
→ wait for transport/provider slot
→ process/send
```

Rate limit замедляет, но не теряет данные.

## 4.5. LLM failure

Нельзя отправлять customer внутреннее сообщение типа `AI provider unavailable`.

Нужно:

```text
LLM failure
→ bounded retry
→ technical fallback if configured
→ if still failed:
   keep/mark Inbox turn failed or retryable
   alert Control Bot
   do not expose internal error to customer
```

## 4.6. Sessions/transcripts

Критически:

```text
Teleton Session != Anonka Conversation
```

Teleton session привязан к `telegram:<chatId>`, имеет daily/idle reset и JSONL transcript. Это нельзя использовать как identity/history boundary Anonka.

После миграции убрать из canonical customer path:

- daily reset;
- idle reset как создание новой conversation;
- JSONL transcript как второй source of truth;
- global customer memory files.

Compaction/summarization algorithms можно переиспользовать после адаптации.

## 4.7. Embeddings/vector memory

Удалить:

```text
sqlite-vec
embedding_cache
message embeddings
knowledge vectors
vector RAG для обычной переписки
```

FTS5 можно оставить для обычного debug/text search.

## 4.8. ProviderRuntime

Оставить local OpenAI-compatible discovery и обычную provider initialization.

Удалить Gocoon-specific runtime.

---

# 5. Process topology

## 5.1. Один CreatorRuntime = отдельный process

Teleton singleton-oriented:

```text
1 process
1 TELETON_HOME
1 workspace
1 DB lifecycle
1 Telegram bridge/session
```

Поэтому не делаем несколько creator внутри одного большого `TeletonApp`.

Целевая схема:

```text
                         SUPERVISOR PROCESS
┌──────────────────────────────────────────────────────────┐
│ Telegram Control Bot                                     │
│ Creator Registry + supervisor.db                         │
│ Worker Manager                                           │
│ Alerts                                                   │
│ optional Global LLM Coordinator                          │
└──────────────────────────┬───────────────────────────────┘
                           │ typed IPC
             ┌─────────────┼─────────────┐
             ▼             ▼             ▼
      Creator Worker A  Worker B      Worker C
             │             │             │
      unique TELETON_HOME / creator.db / TG session
```

Пример runtime homes:

```text
/data/creators/alina
/data/creators/masha
/data/creators/vika
```

На MVP может работать один worker, но архитектура не должна мешать добавить второй.

## 5.2. CreatorProfile

```text
CreatorProfile
├── id
├── display_name
├── enabled
├── runtime_home
├── telegram_account/session reference
├── persona config
├── media_vault_chat_id
├── commercial_mode
├── default_offer_price_stars
└── anon source config
```

В коде:

```text
creator = девушка/персона
model   = LLM model
```

## 5.3. CreatorRuntime

Один worker обслуживает один Telegram user-account:

```text
CreatorRuntime
├── CreatorProfile
├── GramJS user bridge
├── Telegram session
├── TransportRouter
├── InboxProcessor
├── ConversationService
├── ConversationQueue/Debouncer
├── AnonController
├── MediaVaultIndexer
├── Gift/Offer services
├── OutboxWorker
├── creator persona
├── lifecycle/recovery
└── creator.db
```

## 5.4. CreatorSupervisor

Supervisor отвечает за:

```text
start creator worker
stop creator worker
restart creator worker
health/status
route admin commands
aggregate alerts/metrics
creator registry
optional shared LLM concurrency
crash backoff/crash-loop protection
```

Control Bot работает с Supervisor, а не напрямую с internal worker handlers.

Typed IPC минимум:

```text
START_CREATOR
STOP_CREATOR
RESTART_CREATOR
GET_STATUS
SET_CONTROL_MODE
ANON_START
ANON_STOP
ANON_NEXT
RELOAD_PROMPTS
MEDIA_REINDEX
PUSH_ALERT
AUTH_REQUIRED
```

### Crash-loop protection

```text
worker exits unexpectedly
→ record failure
→ bounded restart with backoff
→ repeated crashes inside configured window
→ mark creator ERROR/STOPPED
→ stop automatic restart loop
→ alert Control Bot
```

Не допускается бесконечный restart loop из-за битой session/config/DB migration/provider startup/persistent exception.

---

# 6. Database ownership и storage

## 6.1. `supervisor.db`

Supervisor владеет только global/control state:

```text
creators
admin_audit_events
admin_callbacks
runtime_status
runtime_config
```

## 6.2. `creator.db`

Каждый CreatorWorker владеет только своим доменным состоянием:

```text
anon_sources
conversations
conversation_messages
conversation_facts
conversation_summaries
handoffs
inbox
outbox
media_assets
media_series
media_series_items
media_deliveries
offers
gifts
domain_events
raw Telegram feed tables where useful
```

## 6.3. Ownership boundary

```text
Supervisor process → writes supervisor.db only
CreatorWorker A    → writes creator-A/creator.db only
CreatorWorker B    → writes creator-B/creator.db only
```

Supervisor не выполняет domain writes напрямую в creator DB. Управление — через typed IPC.

## 6.4. Raw feed vs canonical history

```text
conversation_messages = canonical customer history
raw Telegram feed       = transport/debug history
```

Raw feed можно pruning по retention policy только после появления canonical conversation history.

Facts, summaries, Offers, Gifts и media delivery history имеют собственный lifecycle и не зависят от raw feed retention.

---

# 7. Config и secrets

## 7.1. Сохраняем Teleton-подход

Переиспользуем идеи:

```text
YAML/env loading
Zod validation
path expansion
secret/env overrides
```

Но новая schema не содержит старые TON/MCP/WebUI/heartbeat/vector/agent-tool параметры.

## 7.2. Static/env config

Статические/секретные параметры:

```text
Telegram API ID/hash
Control Bot token
LLM provider/base URL/API key/model
root data paths
logging
process-level limits
```

API keys/secrets не хранятся в обычных mutable domain tables.

## 7.3. Mutable runtime state

В `supervisor.db` / `creator.db`:

```text
creator.enabled
commercial mode
price
media/offers toggles
AI|HUMAN|HYBRID
anon runtime state
mutable operational settings
```

Control Bot не должен переписывать YAML при каждом runtime изменении.

---

# 8. Creator Telegram auth

Первичная авторизация не должна происходить внутри обычного worker runtime через stdin.

Отдельный setup flow:

```text
anonka creator login <creator_id>
→ phone/code/2FA
→ save Telegram session with 0600 permissions
→ verify account identity
→ mark auth ready
```

Обычный CreatorWorker:

```text
valid session
→ start

missing/expired/revoked session
→ AUTH_REQUIRED
→ report Supervisor/Control Bot
→ do not wait on stdin
```

---

# 9. CreatorWorker lifecycle

При замене `TeletonApp` сохраняем правильную graceful семантику:

```text
stop accepting new ingress
→ flush debouncer
→ drain accepted conversation queues
→ abort/drain active LLM turns as policy requires
→ flush pending persistence
→ stop background resources
→ disconnect Telegram
→ close DB
```

Сохраняем:

- SIGINT/SIGTERM;
- shutdown timeout safety net;
- idempotent stop;
- controlled restart;
- recoverable restart state.

---

# 10. Общая LLM-конфигурация

По умолчанию одна конфигурация обслуживает всех creator:

```text
GlobalLLMConfig
├── provider
├── model
├── utility_model
├── api/base_url
├── temperature
├── max_tokens
└── technical fallbacks
```

Сейчас **не создаём**:

```text
ModelProfile table
creator-specific LLM profiles
conversation.model_profile_id
сложный ModelRouter
```

Creator-specific override можно добавить позже без изменения conversation core.

## 10.1. Global concurrency

Если несколько workers используют один локальный LLM server, per-worker semaphore недостаточен.

Опциональный supervisor-level coordinator:

```text
Creator workers
→ IPC / LLMCoordinator
→ global semaphore
→ existing Teleton provider layer
```

Для remote API на MVP допустима per-worker concurrency, если provider сам нормально ограничивает нагрузку.

---

# 11. TransportRouter

Жёсткий порядок маршрутизации:

```text
Telegram event
│
├── Media Vault chat
│      → MediaVaultIndexer
│
├── configured anonymous bot
│      → AnonAdapter
│
├── outgoing from own creator account
│      ├── matched Outbox correlation → programmatic ACK/update
│      └── no correlation             → ManualMessageService
│
├── normal private human DM
│      → ConversationService
│
└── group/channel/random bot
       → ignore
```

Это заменяет generic personal-agent policies Teleton.

---

# 12. Telegram primitives, которых не хватает

Для anon/media добавить/зафиксировать:

```text
onEditedMessage()
raw update access
extract reply/inline buttons
clickButton()
video_note media type
media_group_id / groupedId
sendVideo()
sendVideoNote()
copy/resend existing media without forward attribution
pre-send transport correlation where supported
```

AnonAdapter не должен зависеть только от урезанного DTO, если конкретный bot требует raw MTProto data.

---

# 13. AnonSource и AnonController

## 13.1. AnonSource

```text
AnonSource
├── id
├── creator_id
├── enabled
├── bot_peer_id / username
├── adapter_type
├── language
├── idle_timeout_seconds
└── search_watchdog_seconds
```

Это узкая transport-конфигурация, не центральная business entity.

## 13.2. AnonController state machine

```text
STOPPED
SEARCHING
ROOM_ACTIVE
HANDOFF_PENDING
SKIPPING
```

```text
STOPPED
  │ start
  ▼
SEARCHING
  │ room_ready / first_partner_message
  ▼
ROOM_ACTIVE
  ├── idle timeout ─────────► SKIPPING ─► SEARCHING
  ├── partner left ─────────► SEARCHING
  ├── admin next ───────────► SKIPPING ─► SEARCHING
  ├── handoff intent ───────► HANDOFF_PENDING
  │                            ├─ confirmed ─► SEARCHING
  │                            └─ timeout ───► SKIPPING ─► SEARCHING
  └── admin stop ───────────► STOPPED
```

## 13.3. AnonAdapter

```ts
interface AnonAdapter {
  search(): Promise<void>;
  next(): Promise<void>;
  stop(): Promise<void>;
  requestLink(): Promise<void>;
  reconcile(): Promise<ObservedAnonState>;
}
```

Нормализованные events:

```text
SEARCH_STARTED
ROOM_READY
PARTNER_MESSAGE
PARTNER_LEFT
PARTNER_SKIPPED
SEARCH_STOPPED
LINK_REQUEST_CONFIRMED
UNKNOWN_SERVICE_EVENT
```

Adapter может использовать:

- text commands;
- reply keyboard;
- inline buttons;
- edited messages;
- raw MTProto updates.

Перед реализацией конкретного anonymous bot обязателен protocol reconnaissance.

## 13.4. Stale generation protection

У controller монотонный `room_generation`.

Каждый LLM/send job хранит snapshot:

```text
creator_id
conversation_id
anon_source_id
room_generation
conversation_version
```

Перед side effect:

```text
if snapshot != current state:
    drop/cancel result
```

Generation инвалидируется до `next`, `stop`, confirmed handoff и manual creator intervention.

---

# 14. Conversation model

## 14.1. Conversation = один человек

Conversation не равен Telegram `chat_id`.

Особенно для anon bot:

```text
один physical chat with bot
→ partner A
→ partner B
→ partner C
```

Поэтому identity всегда domain-level `conversation_id`.

До handoff:

```text
conversation_id=184
creator_id=alina
current_transport=anon
anon_source_id=anon_main
telegram_peer_id=NULL
```

После handoff:

```text
conversation_id=184
creator_id=alina
current_transport=dm
telegram_peer_id=123456789
```

Прямой DM создаёт/находит active conversation внутри конкретного creator.

## 14.2. Conversation state

```text
creator_id
anon_source_id NULL
current_transport = anon|dm
state = active|handoff_pending|ended
control_mode = ai|human|hybrid
telegram_peer_id NULL
anon_generation NULL
version
commercial_mode
last_activity_at
```

Связанные данные:

```text
facts
rolling summary
recent messages
sent media
active Offer
```

## 14.3. Control modes

### AI

AI отвечает автоматически.

### HUMAN

Creator ведёт conversation вручную. AI не отправляет ответы.

### HYBRID

AI ведёт conversation, но creator может вмешиваться. Manual сообщения входят в ту же canonical history.

## 14.4. Handoff anon → DM

LLM может вернуть только semantic intent:

```json
{"handoff_intent":"offer"}
```

Код:

```text
AnonAdapter.requestLink()
→ HANDOFF_PENDING
→ handoff record
→ reliable correlation
```

Matching priority:

1. explicit token/prefilled marker;
2. другой уникальный protocol signal;
3. temporal correlation только если она однозначна.

После confirmed handoff сохраняется тот же `conversation_id`.

---

# 15. Durable Inbox

Одной записи raw `tg_messages` недостаточно для гарантированного recovery.

Schema concept:

```text
id
creator_id
conversation_id NULL until resolved
telegram_chat_id
telegram_message_id NULL
event_type
transport_event_key NULL
payload_json
status = received|processing|processed|failed
attempts
created_at
updated_at
```

Основной idempotency barrier:

```text
UNIQUE(creator_id, event_type, telegram_chat_id, telegram_message_id)
```

Для service/raw events без message id используется стабильный `transport_event_key`.

Правильный ingestion:

```text
Telegram event
→ INSERT/UPSERT durable Inbox
→ commit
→ update transport watermark/offset
→ later process Inbox
```

После crash `received` и stale `processing` возвращаются в очередь.

### Offset semantics

`telegram-offset.json`/offset-store — только transport watermark/optimization.

Он **не является source of truth** для «business event уже обработан».

---

# 16. Durable Outbox

Через Outbox идут все programmatic outgoing creator-account:

```text
AI text
photo
video
video_note
anon commands
handoff command
paid fulfillment
```

Schema concept:

```text
id
creator_id
conversation_id NULL
kind
payload_json
idempotency_key
transport_correlation_key
status = pending|sending|sent|failed
telegram_message_id NULL
attempts
created_at
sent_at NULL
```

## 16.1. Pre-send correlation

Недостаточно коррелировать только по Telegram message id, потому что он появляется после network send.

Порядок:

```text
create Outbox row
→ generate/persist client-side transport correlation
→ commit
→ network send
→ receive acknowledgement/outgoing update
→ persist telegram_message_id
→ mark sent
```

Для MTProto использовать `random_id` или другой стабильный client-generated primitive там, где он поддерживается.

Это необходимо для:

- manual-vs-programmatic outgoing detection;
- retry/idempotency;
- crash после Telegram acceptance до локального `sent`;
- paid fulfillment без дублей.

---

# 17. Debounce, queues, scheduler

## 17.1. Debounce = один logical batch

```text
«привет»
«слушай»
«ты тут?»

→ one batch
→ one ContextBuilder
→ one LLM call
```

Flow:

```text
incoming Inbox events
→ resolve conversation_id
→ debounce ~1.5–2.0s after last message
→ collect unprocessed messages
→ one logical batch
```

## 17.2. ConversationQueue

Идею Teleton `ChatQueue` переиспользуем, но domain lock key = `conversation_id`.

MUST:

```text
per-conversation serial execution
bounded concurrency
conversation_version guard
room_generation guard
AbortController
graceful drain
```

## 17.3. Human-like ResponseScheduler

После LLM generation ответ не отправляется мгновенно.

Пример:

```text
target_delay =
  base_delay
  + text_length / typing_speed
  + random_jitter

remaining_delay = max(0, target_delay - llm_elapsed)
```

Во время ожидания — typing action.

Если приходит новое customer message или manual creator outgoing:

```text
invalidate stale generation/scheduled send
→ rebuild context
```

Обычный AI ответ — новое Telegram message, а не автоматический reply на каждую входящую реплику.

---

# 18. AnonkaLLMService и ChatDecision

## 18.1. LLM service

```text
ContextBuilder
→ AnonkaLLMService
→ existing Teleton/pi-ai provider layer
→ ChatDecision
```

Fallback — только при технических сбоях.

Не использовать fallback для обхода refusal/safety behavior провайдера.

## 18.2. ChatDecision

```ts
type ChatDecision = {
  response_mode: "reply" | "no_reply";
  text?: string;
  learned_facts: FactUpdate[];
  media_intent?: MediaIntent;
  offer_intent?: OfferIntent;
  soft_gift_ask: boolean;
  handoff_intent: "none" | "offer";
  human_attention?: {
    recommended: boolean;
    reason?: string;
  };
};
```

## 18.3. Structured output MVP

Текущий Teleton provider wrapper не даёт гарантированный единый `response_format/json_schema` contract для всех providers.

Поэтому MVP:

```text
prompt explicitly requires JSON
→ parse JSON
→ Zod ChatDecision validation
→ one bounded repair call
→ if still invalid: safe text-only fallback
```

При safe fallback запрещены side effects:

```text
no media action
no offer action
no handoff action
no payment/system action
```

Native JSON Schema / JSON object mode можно включить позже как provider-specific optimization.

---

# 19. Persona и prompt

Для каждого creator:

```text
SOUL.md      → persona/style
STRATEGY.md  → behavior/commercial strategy
SECURITY.md  → runtime boundaries
```

Переиспользуем безопасное чтение/cache/sanitization Teleton, но **не используем текущий `buildSystemPrompt()` целиком**.

Из customer prompt исключаем:

```text
global MEMORY.md
USER.md
IDENTITY.md
heartbeat prompt
agent tools
owner-agent semantics
process-global frozen customer memory
```

Целевой `AnonkaPromptBuilder`:

```text
SYSTEM CORE
CREATOR PERSONA
CREATOR STRATEGY
FEW-SHOT EXAMPLES
RUNTIME CONTEXT
KNOWN FACTS
ROLLING SUMMARY
RECENT MESSAGES
CURRENT BATCH
```

---

# 20. Conversation memory

Canonical memory:

```text
structured facts
rolling summary
recent messages
canonical conversation_messages
```

Compaction Teleton можно переиспользовать как алгоритмическую основу, но prompts/inputs переписываются под обычный dialogue.

Не отправлять LLM всю историю с начала.

FTS5 — опционально для debug/search.

Vector embeddings не нужны.

---

# 21. Incoming customer media

## 21.1. Voice/audio

Если доступен существующий transcription helper:

```text
voice/audio
→ transcription
→ transcript into logical batch
```

Если нет:

```text
voice_untranscribed
```

Не выдумывать содержание.

## 21.2. Photo/video/video_note

MVP:

```text
persist metadata
record media event
no automatic visual interpretation
```

Vision можно добавить позже отдельно.

---

# 22. Media Vault

## 22.1. Один Vault на creator

```text
Creator A → private Media Vault A
Creator B → private Media Vault B
```

**Канонический индексатор Vault — CreatorWorker под user-account, а не Control Bot.**

```text
Private Media Vault
        │
        ▼
CreatorWorker / GramJS
        │
        ├── live updates
        ├── history scan/reindex
        ├── groupedId extraction
        ├── media metadata
        ├── caption/tag parsing
        └── creator.db catalog
                 │
                 ▼
          Supervisor / Control Bot
          cards + preview + commands
```

`/media_reindex` маршрутизируется worker-у.

Control Bot может быть добавлен в Vault для preview convenience, но это не обязательный механизм индексирования.

## 22.2. Media types

MVP:

```text
photo
video
video_note
```

Поддержать:

```text
groupedId/media_group_id
series_id
```

## 22.3. Resend без attribution

Нельзя использовать обычный forward, если он раскрывает Vault/source.

Нужно:

```text
refetch original media
→ resend/copy as new creator message
→ no forward attribution
```

## 22.4. Strict manual tags

Пример:

```text
#media
access=casual
content=face,full_body
view=front
outfit=shirt
scene=bedroom
series=home_04
```

Разметка только deterministic/manual.

Parser:

```text
known key
+
known controlled value
```

Unknown key/value → validation error.

LLM не размечает Media Vault.

## 22.5. Media approval

Technical catalog status:

```text
PENDING
APPROVED
REJECTED
```

Это контроль качества тегов/каталога, не юридическая бюрократия.

Flow:

```text
upload
→ parse tags
→ PENDING
→ optional Control Bot review
→ APPROVE / EDIT / REJECT
```

Для тестового режима:

```text
auto_approve_valid_media=true
```

может отключать ручной review при валидных tags.

## 22.6. Media schema

```text
id
creator_id
source_chat_id
source_message_id
media_group_id NULL
series_id NULL
media_type
access_class
content_tags
outfit_tags
scene_tags
view_tags
status
enabled
file/reference metadata
duration/width/height where available
created_at
```

## 22.7. MediaSelector

```text
MediaIntent
→ creator_id
→ APPROVED/enabled only
→ access/type/tags
→ exclude already sent
→ score
→ random top-N / deterministic tie-break
→ exact asset/series
```

Если ничего подходит → `MEDIA_NOT_AVAILABLE`.

## 22.8. MediaSeries

Offer/MediaIntent может ссылаться на:

```text
single asset
OR
series
```

Series хранит ordered assets:

```text
1 photo
2 photo
3 video
4 video_note
```

Каждый send фиксируется отдельно в `media_deliveries`.

---

# 23. Control Bot

Отдельный private Bot API bot в Supervisor process.

Auth:

```text
private chat
AND admin id in allowlist
```

Bot не участвует в customer conversations.

## 23.1. Команды

```text
/status

/creators
/creator <id>
/creator_start <id>
/creator_stop <id>
/creator_restart <id>

/anon_start <creator_id>
/anon_stop <creator_id>
/anon_next <creator_id>

/dialogs <creator_id>
/dialog <conversation_id>
/take <conversation_id>
/ai <conversation_id>
/hybrid <conversation_id>

/media_pending <creator_id>
/media_approve <asset_id>
/media_reject <asset_id>
/media_edit <asset_id>
/media_reindex <creator_id>

/mode <creator_id> direct|patron
/price <creator_id> <stars>
/offers <creator_id> on|off
/media <creator_id> on|off

/reload_prompts <creator_id>
/errors
/panic
```

Частые операции — inline buttons.

## 23.2. Durable callbacks

Существующий in-memory CallbackRouter недостаточен для карточек, которые должны переживать restart.

`supervisor.db`:

```text
admin_callbacks
├── token
├── admin_id
├── action
├── payload_json
├── status = active|consumed|expired
├── created_at
├── expires_at
└── consumed_at NULL
```

Требования:

```text
admin binding
private chat only
single-use
idempotent
explicit expiry
survive Supervisor restart
```

Из старого CallbackRouter сохраняем security semantics, не его in-memory lifecycle.

## 23.3. Human attention

LLM может только рекомендовать:

```text
human_attention.recommended=true
```

Control Bot показывает alert/Take over, но control mode меняет только code/admin action.

## 23.4. Panic

```text
disable new anon search
disable new AI replies
disable new offers/media intents
keep DB/recovery/control bot alive
never undo confirmed payment state
```

Выход только explicit admin action.

---

# 24. Commerce / Gifts

## 24.1. Commercial modes

```text
DIRECT_SALE
PATRON
```

Default у CreatorProfile; conversation может хранить snapshot/override.

### DIRECT_SALE

```text
OfferIntent
→ reserve compatible unsent asset OR series
→ snapshot price
→ WAITING
→ confirmed Gift attribution
→ PAID
→ FULFILLING
→ FULFILLED
```

### PATRON

Gift = support event. Не превращается автоматически в продажу конкретного asset без Offer.

## 24.2. Offer state machine

```text
WAITING
PAID
FULFILLING
FULFILLED
CANCELLED
EXPIRED
BLOCKED
```

Для одного conversation максимум один активный `WAITING DIRECT_SALE` Offer.

## 24.3. GiftEvent — source of truth

Канонический входящий Gift берётся из Telegram service event:

```text
GiftEvent
├── event_key
├── creator_id
├── chat_id / conversation context
├── sender_peer_id NULL when Telegram не дал sender
├── gift_ref/id
├── value_stars NULL when value cannot be trusted
├── received_at
└── raw/debug snapshot
```

Stars transaction history не требуется для обычного attribution и не используется как обязательное подтверждение подарка.

## 24.4. Attribution и expectation

Базовый flow:

```text
incoming GiftEvent
→ dedupe by event_key
→ sender/value validation
→ compare sender with current DM conversation user
   OR explicit pending gift expectation

match
→ CONFIRMED
→ credit profit exactly once
→ fulfill expectation if it existed

no sender / sender mismatch / no reliable value
→ MANUAL_REVIEW
→ Control Bot CONFIRM or REJECT
```

Правила:

- Gift от пользователя текущего DM → auto `CONFIRMED`;
- Gift от explicit expected sender → auto `CONFIRMED`, expectation закрывается;
- ожидали X, пришёл Y → `MANUAL_REVIEW` с expected/actual context;
- sender отсутствует → `MANUAL_REVIEW`;
- `nameHidden` сам по себе не делает sender неизвестным: это display/privacy flag;
- Gift без пригодной стоимости → `MANUAL_REVIEW`, стоимость не выдумывается;
- duplicate `event_key` не начисляет profit повторно;
- Gift service message не отправляется в LLM как обычная customer реплика.

## 24.5. Manual review через Control Bot

`MANUAL_REVIEW` должен содержать минимум:

```text
event_key
creator_id/chat/conversation context
actual sender, если известен
expected sender, если был
Gift id/title
value, если известна
reason
```

Действия владельца:

```text
CONFIRM
→ attribution accepted
→ credit known profit once
→ pending expectation для этого chat считается выполненной

REJECT
→ profit не начисляется
→ pending expectation остаётся активной
```

Если после ручного `CONFIRM` стоимость всё ещё неизвестна, система не должна выдумывать сумму; подтверждение attribution и денежное начисление должны оставаться различимыми состояниями в persistent Phase 5 implementation.

## 24.6. Stars history

`payments.GetStarsTransactions` и нормализованный Stars ledger сохраняются как infrastructure для:

- audit/debug;
- финансовой сверки;
- offline diagnostics;
- будущих задач, где ledger действительно нужен.

Они **не участвуют в обычном Gift sender attribution** и не образуют обязательный periodic reconciliation pipeline.

## 24.7. Offer payment binding

Для DIRECT_SALE Gift может оплатить Offer только после подтверждённого attribution:

```text
Offer.status == WAITING
AND creator/conversation context matches
AND confirmed Gift sender is the intended customer
AND confirmed Gift value reliably satisfies offer.required_stars
AND gift.event_key not consumed
→ PAID
```

Один Gift → максимум один Offer. При сомнении — `MANUAL_REVIEW`, а не автоматический `PAID`.

## 24.8. Fulfillment

```text
PAID
→ FULFILLING
→ load reserved asset/series
→ durable Outbox
→ record each media delivery
→ FULFILLED
```

Crash-safe и idempotent.

---

# 25. Observability

Domain events минимум:

```text
creator_runtime_started
creator_runtime_stopped
creator_runtime_auth_required
creator_runtime_error
conversation_created
anon_room_started
anon_room_ended
handoff_offered
handoff_confirmed
control_mode_changed
creator_manual_message
llm_call
llm_fallback
llm_failed
media_submitted
media_approved
media_rejected
media_sent
offer_created
gift_detected
gift_confirmed
gift_manual_review
gift_review_confirmed
gift_review_rejected
offer_paid
offer_fulfilled
admin_command
inbox_retry
outbox_retry
error
```

Metrics per creator:

```text
rooms started
messages received/sent
handoff rate
DM continuation rate
Gift count/value
Offer conversion
media sends
LLM latency/error/fallback
tokens/cost where available
conversation duration
AI/HUMAN/HYBRID distribution
inbox backlog
outbox backlog
worker health/restarts
```

---

# 26. Logger, permissions, Doctor

## 26.1. Logger

Сохраняем Pino и sensitive redaction.

WebUI SSE stream удаляем вместе с WebUI.

## 26.2. File permissions

Адаптируем hardening:

```text
0600 sensitive files
0700 sensitive directories
```

Минимум:

```text
Telegram sessions
creator DB files
supervisor.db
config/secrets
file-backed Control Bot credentials
```

## 26.3. Doctor CLI

Сохраняем идею `doctor`, переписываем checks:

```text
Node version
static config validity
Supervisor DB
Control Bot credentials/connectivity
LLM provider/model availability
creator registry
per-creator Telegram session status
creator DB migrations/readability
Vault binding
anon source config
filesystem permissions
```

TON/wallet/MCP/WebUI проверки удаляются.

---

# 27. Что полностью сносим после миграции

Только после переключения production path и прохождения test contracts:

```text
TON / wallet / DEX / NFT / DNS / DeFi
Gocoon
MCP runtime
AgentRuntime autonomous loop
Tool RAG
exec/general agent tools
plugin marketplace / plugin hot reload
WebUI
Management API, если не используется
heartbeat autonomous tasks
scheduled agent tasks
RVC docker layer
sqlite-vec / vector embeddings
old Teleton session/customer memory pipeline
```

### Перед удалением `src/agent/tools/telegram/*`

Сначала вынести:

```text
Stars transaction helpers
Gift helpers
media download/send/copy helpers
button/callback helpers
transcription helper
Telegram error helpers
videoNote/media metadata logic
```

И только затем удалить tool-executor wrappers.

---

# 28. Package cleanup

После cleanup обновить `package.json`.

Ожидаемое production ядро примерно:

```text
@earendil-works/pi-ai
better-sqlite3
grammy
telegram
yaml
zod
pino
```

плюс реально нужные build/dev зависимости.

Убираются зависимости TON/MCP/WebUI/SDK/vector/unused providers только после проверки usage.

---

# 29. Target module boundaries

Это границы ответственности, а не требование немедленно переместить каждый файл.

## Supervisor

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
├── llm-coordinator.ts      # optional
└── storage/
    └── supervisor-db.ts
```

## Creator runtime

```text
src/runtime/
├── creator-runtime.ts
├── lifecycle.ts
├── recovery.ts
└── auth-state.ts

src/telegram/
├── client.ts
├── bridge-interface.ts
├── bridges/user.ts
├── debounce.ts
├── flood-retry.ts
├── offset-store.ts
├── transport-router.ts
├── inbox-processor.ts
├── outbox-worker.ts
├── media-service.ts
└── anon/
    ├── adapter.ts
    └── controller.ts

src/storage/
├── sqlite-primitives.ts
└── creator-db.ts

src/llm/
├── client.ts
├── model-request.ts
├── provider-fallback.ts
├── service.ts
├── chat-decision.ts
└── decision-validator.ts

src/domain/
├── conversations/
├── handoff/
├── media/
└── commerce/

src/application/
├── context-builder.ts
├── response-scheduler.ts
├── action-coordinator.ts
└── analytics.ts

src/prompts/
├── system/
├── creators/
└── examples/
```

---

# 30. Migration plan

## Phase 0 — transport/reuse spike

До большого удаления подтвердить:

1. dedicated user-account стабильно получает/отправляет DM;
2. configured anonymous bot проходит allowlist exception;
3. доступны NewMessage, edited messages, buttons и нужные raw updates;
4. можно programmatically click нужную кнопку anon bot;
5. photo/video/video_note принимаются и отправляются;
6. Vault media можно resend/copy без forward attribution;
7. Vault history scan/reindex работает через CreatorWorker;
8. реальный Gift event даёт sender/value/event key и доходит до code-side GiftLedger;
9. `nameHidden` не ломает известный sender; неизвестный/сомнительный sender уходит в MANUAL_REVIEW;
10. Stars transaction ingestion/normalization/pagination работает как audit/ledger primitive, без обязательного Gift reconciliation;
11. manual outgoing можно надёжно отличать от programmatic outgoing;
12. найден pre-send correlation primitive для используемых MTProto send methods;
13. creator login/setup работает отдельно от normal worker runtime.

## Phase 1 — clean persistence + deterministic message path

- вынести чистые SQLite primitives;
- создать CreatorDatabase schema;
- добавить durable Inbox;
- зафиксировать Inbox UNIQUE/idempotency;
- offset обновлять только после durable Inbox commit;
- добавить logical `conversation_id`;
- добавить TransportRouter;
- перестроить debounce в logical batch;
- заменить AgentRuntime path на `AnonkaLLMService → ChatDecision`;
- Zod validation + one repair + text-only fallback;
- ResponseScheduler;
- ActionCoordinator;
- durable Outbox;
- pre-send correlation/idempotency;
- rate-limit waits, not drops;
- LLM failure не раскрывается customer;
- graceful worker lifecycle/drain.

## Phase 2 — Supervisor + CreatorWorker + Control Bot

- CreatorProfile;
- worker process isolation;
- SupervisorDatabase;
- CreatorSupervisor;
- typed IPC;
- separate Control Bot;
- start/stop/restart;
- crash backoff/crash-loop protection;
- non-interactive runtime auth + `AUTH_REQUIRED`;
- durable `admin_callbacks`;
- AI/HUMAN/HYBRID;
- admin audit;
- static config vs mutable DB state;
- optional GlobalLLMCoordinator.

## Phase 3 — conversations/memory/handoff

- canonical conversation tables;
- raw Telegram → logical conversation mapping;
- direct DM;
- anon→DM continuity;
- facts;
- rolling summary;
- recent messages;
- manual creator outgoing;
- stale guards;
- Teleton compaction adaptation;
- убрать dependency на daily/idle Teleton session identity;
- raw feed retention отделить от canonical history.

## Phase 4 — Media Vault

- MediaVaultIndexer inside CreatorWorker;
- live + history reindex;
- reuse existing media download/videoNote helpers;
- bridge primitives for video/video_note/groupedId;
- strict tags;
- optional approval/auto-approve;
- MediaSelector;
- MediaSeries;
- resend without forward attribution;
- delivery history;
- Control Bot = presentation/control, not history reader.

## Phase 5 — commerce

- persistent typed GiftEvent/GiftLedger state;
- GiftEvent-based sender/value attribution;
- pending gift expectation per conversation/chat where needed;
- MANUAL_REVIEW + durable Control Bot CONFIRM/REJECT;
- duplicate-Gift/profit idempotency;
- Stars ledger retained for audit/diagnostics, not mandatory attribution;
- Offer state machine;
- DIRECT_SALE;
- PATRON;
- asset/series fulfillment;
- paid Outbox idempotency.

## Phase 6 — cleanup

После доказанного нового runtime удалить unused Teleton bloat.

Затем обновить:

```text
package.json
package-lock.json
build scripts
Dockerfile
CI
README/docs
```

---

# 31. Обязательные test contracts

До массового удаления Teleton должны проходить как минимум:

```text
anon state machine
anon stale generation
anon edited-message/button protocol where used
DM concurrency
manual outgoing vs programmatic outgoing
AI/HUMAN/HYBRID
multi-message debounce → one LLM turn
new message cancels scheduled stale reply
rate-limit waits instead of dropping
LLM failure does not expose internal error to customer
Inbox duplicate event creates one logical turn
offset advances only after Inbox durable commit
crash after Inbox persistence
programmatic outgoing update before send() return is not classified as manual
crash after Telegram accepted send before local sent-state does not duplicate outgoing
crash during paid fulfillment does not duplicate paid media
Outbox idempotency
CreatorWorker missing/expired session → AUTH_REQUIRED without stdin blocking
graceful shutdown drains accepted work
Supervisor restart preserves pending admin callback
admin callback remains single-use after restart
Control Bot cannot execute callback for another admin
anon→DM keeps same conversation_id
creator workers do not share DB/session/persona
Vault reindex works through CreatorWorker without Bot API history access
strict media tag parser
MediaSelector avoids repeat when alternatives exist
series ordered fulfillment
invalid ChatDecision JSON → one repair → text-only fallback with no side effects
duplicate Gift credits profit once
Gift from current DM user auto-confirms
Gift from expected sender auto-confirms and fulfills expectation
sender mismatch / unknown sender → MANUAL_REVIEW
nameHidden with known sender does not become anonymous
manual CONFIRM/REJECT semantics are idempotent
one confirmed Gift pays at most one Offer
raw feed pruning does not remove canonical conversation history
repeated worker crashes trigger backoff then ERROR instead of infinite restart
Supervisor never writes creator.db directly
```

---

# 32. Docker и CI

## Docker

Сохраняем хорошие свойства Teleton:

```text
multi-stage build
production-only runtime dependencies
non-root runtime
persistent /data volume
native better-sqlite3 support
```

Целевая `/data`:

```text
/data/
├── supervisor.db
├── config/
└── creators/
    ├── alina/
    │   ├── creator.db
    │   ├── telegram_session.txt
    │   └── prompts/
    └── ...
```

WebUI/SDK build layers удаляются после их выхода из production path.

## CI

После cleanup сохранить quality gates:

```text
typecheck
lint
format check
dead-code check
circular dependency check
duplicate-code check
security audit
unit/integration tests
Docker build
```

Удалить только проверки уже несуществующих SDK/WebUI/TON subsystems.

---

# 33. Documentation migration

После stabilization переписать под Anonka:

```text
README.md
GETTING_STARTED.md
config.example.yaml
docs/configuration.md
docs/telegram-setup.md
docs/deployment.md
```

Удалить/архивировать Teleton-specific docs после удаления соответствующего runtime:

```text
TON/wallet docs
plugin docs
management API docs
TOOLS.md
docs-sdk/
```

`LICENSE` и необходимую attribution сохранить.

Старый Teleton `CHANGELOG.md` можно перенести в `docs/upstream/`, новый вести для Anonka.

---

# 34. Definition of Done

Архитектурный переход завершён, когда:

1. customer path не использует autonomous `AgentRuntime`;
2. Telegram transport сохраняет auth/session/reconnect/FloodWait преимущества Teleton;
3. configured anon bot проходит allowlist exception, остальные bots игнорируются;
4. edited-message/button/raw-update требования anon bot поддерживаются;
5. physical anon bot chat id не используется как conversation identity;
6. `Teleton Session != Anonka Conversation`;
7. old Teleton `MemoryDatabase` не является Anonka domain DB;
8. SupervisorDatabase и CreatorDatabase имеют независимые чистые schemas;
9. Supervisor не пишет напрямую creator DB;
10. durable Inbox — основной ingestion/idempotency source of truth;
11. offset — только transport watermark;
12. duplicate Telegram event не создаёт второй logical turn;
13. durable Outbox покрывает все programmatic creator sends;
14. Outbox имеет pre-send correlation/idempotency semantics;
15. crash после Telegram send не вызывает автоматический дубль paid fulfillment;
16. manual creator outgoing надёжно отличается от programmatic outgoing;
17. rate-limit не теряет сообщения;
18. LLM failure не раскрывает внутренний technical text customer;
19. debounce реально объединяет быстрые сообщения в один turn;
20. stale generation/scheduled send отменяется при новом context;
21. manual creator outgoing попадает в canonical history;
22. `AI | HUMAN | HYBRID` — явный state;
23. anon→DM сохраняет `conversation_id`;
24. CreatorWorker никогда не блокируется на interactive login;
25. missing/revoked session приводит к `AUTH_REQUIRED`;
26. worker crash loops ограничены и видны Control Bot;
27. существующий Teleton provider layer переиспользуется;
28. base ChatDecision path работает без обязательного provider-native JSON Schema;
29. invalid structured output не вызывает media/payment/system side effects;
30. глобальная LLM config обслуживает creators без обязательных per-creator ModelProfiles;
31. общий local LLM при необходимости ограничивается coordinator;
32. AnonkaPromptBuilder не грузит global Teleton customer memory;
33. canonical conversation history живёт в SQLite;
34. raw transport retention не удаляет canonical history;
35. Media Vault индексируется CreatorWorker;
36. `/media_reindex` не зависит от Bot API history access;
37. photo/video/video_note/series поддерживаются;
38. media resend не раскрывает Vault через forward attribution;
39. media tags deterministic/manual;
40. Control Bot long-lived callbacks переживают Supervisor restart;
41. admin callbacks привязаны к allowlisted admin и single-use;
42. Gifts идут через authoritative live GiftEvent, а не mandatory Stars reconciliation;
43. совпадение sender с current conversation/expectation auto-confirms Gift;
44. ambiguous/unknown/mismatched Gift идёт в MANUAL_REVIEW и не auto-pay Offer;
45. Gift attribution, manual review, profit credit и fulfillment идемпотентны;
46. Pino redaction и file-permission hardening сохранены;
47. graceful lifecycle Teleton сохранён в CreatorWorker;
48. Docker/CI quality gates сохранены после cleanup;
49. обязательные tests из раздела 31 проходят;
50. TON/general-agent/MCP/plugin/WebUI/vector bloat удалён из production path и, где возможно, физически из repo.

---

# 35. Итоговая схема

```text
                         SUPERVISOR PROCESS
┌──────────────────────────────────────────────────────────┐
│ Telegram Control Bot                                     │
│ Creator Registry + supervisor.db                         │
│ Durable admin callbacks                                  │
│ Worker Manager + crash protection                        │
│ Alerts                                                   │
│ optional Global LLM Coordinator                          │
└──────────────────────────┬───────────────────────────────┘
                           │ typed IPC
             ┌─────────────┼─────────────┐
             ▼             ▼             ▼
      Creator Worker A  Worker B      Worker C
             │             │             │
      unique runtime home / creator.db / TG session
             │
      Telegram user-account
             │
      TransportRouter
             │
        durable Inbox
             │
      ConversationResolver
             │
       Debounce + Queue
             │
       ContextBuilder
             │
      shared LLM config
             │
        ChatDecision
             │
      DecisionValidator
             │
      ResponseScheduler
             │
     ActionCoordinator
             │
       durable Outbox
       ┌─────┼──────────┐
       ▼     ▼          ▼
   Telegram Media     Commerce
            Vault     Gifts/Offers
```

## Ключевой принцип перехода

```text
сначала сохранить и вынести полезную инфраструктуру Teleton
→ заменить autonomous decision path
→ добавить чистые durable/domain слои Anonka
→ доказать работу тестами и fixtures
→ только потом удалить лишний Teleton bloat
```

Это единая каноническая архитектура Anonka.