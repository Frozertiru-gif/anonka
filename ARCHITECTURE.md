# Anonka — целевая архитектура

> Статус: каноническая архитектурная спецификация после полного аудита Teleton Agent 0.10.1.  
> Репозиторий: `Frozertiru-gif/anonka`.  
> Цель документа: зафиксировать, что переиспользуем из Teleton, что переделываем, что удаляем, и какую доменную архитектуру строим поверх уже готовой Telegram/SQLite/LLM инфраструктуры.

---

## 1. Что строим

`anonka` — Telegram-система для одного или нескольких `creator`-профилей. В тестовом режиме creator может быть полностью вымышленной/AI-сгенерированной персоной. Позже тот же runtime может обслуживать реальные creator-аккаунты без изменения ядра.

Ключевая единица:

```text
Creator
├── свой Telegram user-account
├── своя persona / стиль общения
├── свой Media Vault
├── свои conversations
├── свой anon source/controller
└── свой runtime state
```

Система:

1. работает через MTProto как реальные Telegram user-account;
2. работает с anonymous-chat bot и обычными DM;
3. сохраняет один логический `conversation` при anon → DM;
4. поддерживает `AI | HUMAN | HYBRID` на каждый conversation;
5. генерирует в runtime в основном текст;
6. фото/видео/video notes берет из заранее подготовленного Media Vault;
7. поддерживает `DIRECT_SALE` и `PATRON`;
8. Gifts/Stars подтверждает только кодом;
9. управляется через отдельного приватного Telegram Control Bot;
10. по умолчанию использует одну общую LLM-конфигурацию для всех creator runtime;
11. не содержит KYC, age-verification, consent/approval workflow и аналогичной административной бюрократии.

Система **не является general-purpose autonomous agent**. Teleton используется как инфраструктурный chassis.

---

# ЧАСТЬ A — ЧТО БЕРЕМ ИЗ TELETON

## 2. Сохраняем практически как есть

### Telegram user-account infrastructure

Сохраняем:

```text
src/telegram/client.ts
src/telegram/bridges/user.ts
src/telegram/bridge-interface.ts
src/telegram/flood-retry.ts
src/telegram/offset-store.ts
src/telegram/debounce.ts
```

Из `src/telegram/handlers.ts` сохраняем инфраструктурные идеи:

- `ChatQueue`;
- serial processing;
- bounded global concurrency;
- dedupe;
- persistent offsets;
- typing primitives;
- incoming persistence до обработки;
- graceful drain.

При этом часть wiring/поведения handler будет заменена, см. ниже.

### SQLite foundation

Сохраняем:

- `better-sqlite3`;
- WAL;
- foreign keys;
- migrations;
- database lifecycle;
- FTS5 по Telegram messages;
- полезные raw feed stores.

Новый универсальный `DatabaseService` не нужен.

### LLM provider layer

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
- AbortSignal;
- temperature/max tokens;
- технический fallback;
- usage/cost plumbing;
- stripping reasoning blocks, где требуется.

Новый provider stack с нуля не пишем.

### Telegram Bot API infrastructure

Переиспользуем:

```text
src/telegram/bridges/bot.ts
src/bot/callback-router.ts
src/bot/callback-answer.ts
src/bot/rate-limiter.ts
```

На этой базе строится Control Bot.

### Gifts / Stars primitives

Teleton уже умеет низкоуровнево работать с:

```text
MessageActionStarGift
MessageActionStarGiftPurchaseOffer
MessageActionStarGiftPurchaseOfferDeclined
payments.GetStarsTransactions
```

Этот код не выбрасываем. Из agent/tool оболочек выносим обычные domain services.

### Telegram utility code

Перед удалением SDK/tools отдельно сохранить полезные GramJS helpers, включая:

- audio transcription;
- entity resolving;
- Stars/Gifts primitives;
- нужные media send/download implementations;
- Telegram error normalization.

---

## 3. Что из Teleton переделываем

### MessageHandler

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
→ durable Inbox
→ ConversationResolver
→ Debounce/ConversationQueue
→ ContextBuilder
→ AnonkaLLMService
→ ChatDecision
→ DecisionValidator
→ ResponseScheduler
→ ActionCoordinator
→ durable Outbox
→ Telegram
```

`AgentRuntime` исчезает из customer production path.

### Bot filter

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

### Self outgoing

Было:

```text
sender == own account → ignore
```

Станет:

```text
manual outgoing from creator
→ persist source=creator_manual
→ resolve conversation
→ increment conversation_version
→ cancel stale AI job
→ apply AI/HUMAN/HYBRID policy
```

Программные outgoing коррелируются через Outbox и exact Telegram message id, поэтому не считаются ручными.

### Rate limiter

Текущее поведение «лимит достигнут → skip message» недопустимо.

Нужно:

```text
persist incoming
→ queue
→ wait for send/provider slot
→ process/send
```

Rate limit **замедляет**, а не выбрасывает сообщение.

### LLM failure

Нельзя отправлять customer техническое сообщение вроде `AI provider unavailable` и считать turn завершенным.

Нужно:

```text
LLM failure
→ bounded retry
→ configured technical fallback
→ if still failed:
   mark turn failed/pending retry
   alert Control Bot
   do not send internal technical error to customer
```

### Sessions / transcripts

Критически:

```text
Teleton Session != Anonka Conversation
```

Старый Teleton session привязан к `telegram:<chatId>`, имеет daily/idle reset и отдельный JSONL transcript.

Для Anonka это не подходит, особенно при anon → DM.

Используем из старой системы только полезные алгоритмы compaction/summary. Каноническая history живет в SQLite domain tables.

После миграции убрать:

- daily reset как способ начать новый customer conversation;
- idle reset как identity boundary;
- JSONL transcript как второй source of truth.

### Embeddings / vector memory

Удалить:

```text
sqlite-vec
embedding_cache
message embeddings
knowledge vectors
vector RAG для обычной переписки
```

Оставить обычный FTS5 по тексту сообщений.

### ProviderRuntime

Оставить local model discovery и обычную provider initialization.

Удалить Gocoon-specific части.

---

# ЧАСТЬ B — PROCESS TOPOLOGY

## 4. Один CreatorRuntime = отдельный process

Текущий Teleton singleton-oriented:

```text
1 process
1 TELETON_HOME
1 workspace
1 DB lifecycle
1 Telegram bridge/session
```

Поэтому несколько creator не надо пихать в один огромный `TeletonApp`.

Правильная схема:

```text
                    SUPERVISOR PROCESS
┌────────────────────────────────────────────────┐
│ Telegram Control Bot                           │
│ Creator Registry / supervisor.db               │
│ Worker Manager                                 │
│ Alerts                                         │
│ optional Global LLM Coordinator                │
└───────────────────┬────────────────────────────┘
                    │ typed IPC
          ┌─────────┼─────────┐
          ▼         ▼         ▼
      WORKER A   WORKER B   WORKER C
      creator A  creator B  creator C
          │         │         │
      unique TELETON_HOME per worker
```

Например:

```text
/data/creators/alina
/data/creators/masha
/data/creators/vika
```

На первом этапе может работать только один worker.

---

## 5. CreatorProfile

```text
CreatorProfile
├── id
├── display_name
├── enabled
├── runtime_home
├── Telegram session/account config reference
├── persona config
├── media_vault_chat_id
├── commercial_mode
├── default_offer_price_stars
└── anon source config
```

В коде слово `creator` используется для девушки/персоны. `model` означает только LLM model.

---

## 6. CreatorRuntime

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
├── Media Vault binding
├── Gift/Offer services
├── Outbox worker
├── creator persona
└── creator.db
```

---

## 7. CreatorSupervisor

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
```

Control Bot работает с Supervisor, а не напрямую с внутренними handlers creator worker.

IPC должен быть typed и минимальным, например:

```text
START_CREATOR
STOP_CREATOR
GET_STATUS
SET_CONTROL_MODE
ANON_START
ANON_STOP
ANON_NEXT
RELOAD_PROMPTS
PUSH_ALERT
```

---

## 8. Supervisor DB и Creator DB

Не смешивать global и per-creator state.

### `supervisor.db`

```text
creators
admin_audit_events
runtime_status/runtime_config
```

### `creator.db`

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
media_deliveries
offers
gifts
domain_events
raw Telegram feed tables where useful
```

---

## 9. Общая LLM-конфигурация

По умолчанию:

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

Не создавать сейчас:

```text
ModelProfile table
Channel.model_profile_id
conversation.model_profile_id
сложный ModelRouter
```

Creator-specific override можно добавить позже.

### Global concurrency

Если creator workers используют один локальный LLM server, per-worker semaphore недостаточен.

Нужен опциональный supervisor-level `LLMCoordinator`:

```text
Creator workers
→ IPC / coordinator request
→ global semaphore
→ existing Teleton provider layer
```

Для remote API на MVP допустим per-worker provider control, если общий лимит не нужен.

---

# ЧАСТЬ C — TRANSPORT ROUTER

## 10. Жесткий порядок маршрутизации

```text
Telegram event
│
├── Media Vault chat
│      → MediaIngestor
│
├── configured anonymous bot
│      → AnonAdapter
│
├── manual outgoing from creator
│      → ManualMessageService
│
├── normal private human DM
│      → ConversationService
│
└── group/channel/random bot
       → ignore
```

Это заменяет generic personal-agent policies Teleton.

---

## 11. Telegram primitives, которых не хватает

Для anon и Media Vault добавить/зафиксировать:

```text
onEditedMessage()
raw update access
extract reply/inline buttons
clickButton()
video_note media type
media_group_id / groupedId
sendVideo()
sendVideoNote()
resend/copy existing media without forward attribution
```

AnonAdapter не должен зависеть только от урезанного `TelegramMessage`, если конкретный bot требует raw MTProto data.

---

# ЧАСТЬ D — ANON SOURCE

## 12. AnonSource

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

---

## 13. AnonController

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

---

## 14. AnonAdapter

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

Перед implementation конкретного bot нужен protocol reconnaissance.

---

## 15. Stale generation protection

У AnonController монотонный `room_generation`.

Каждый LLM job хранит:

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
    drop result
```

Generation инвалидируется до `next`, `stop`, confirmed handoff и manual creator intervention.

---

# ЧАСТЬ E — CONVERSATIONS

## 16. Conversation = один человек

Conversation не равен Telegram `chat_id`.

Для anonymous bot это критично: один physical Telegram chat последовательно содержит разных людей.

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

Прямой DM создает/находит active conversation внутри конкретного creator.

---

## 17. Conversation state

```text
creator_id
anon_source_id NULL
current_transport anon|dm
state active|handoff_pending|ended
control_mode ai|human|hybrid
telegram_peer_id NULL
anon_generation NULL
version
commercial_mode
last_activity_at
```

Дополнительно связаны:

```text
facts
rolling summary
recent messages
sent media
active Offer
```

---

## 18. Control mode

### AI

AI отвечает автоматически.

### HUMAN

Creator ведет conversation вручную. AI не отправляет ответы.

### HYBRID

AI ведет conversation, но creator может вмешиваться вручную. Ручные сообщения входят в общую историю.

Manual outgoing:

```text
persist source=creator_manual
→ increment version
→ abort stale generation
→ apply control_mode
```

---

## 19. Handoff anon → DM

LLM может вернуть только intent:

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

# ЧАСТЬ F — DURABLE INBOX / OUTBOX

## 20. Durable Inbox

Одной записи raw `tg_messages` недостаточно для гарантированного turn recovery.

Нужна `inbox`:

```text
id
creator_id
conversation_id NULL until resolved
telegram_chat_id
telegram_message_id
event_type
payload_json
status = received|processing|processed|failed
attempts
created_at
updated_at
```

Flow:

```text
Telegram event
→ persist raw event + inbox row
→ ACK local ingestion
→ processor claims inbox row
→ resolve/process
→ processed
```

После crash `received` и зависшие `processing` возвращаются в очередь.

---

## 21. Durable Outbox

Через Outbox идут **все programmatic outgoing creator-account**, а не только платежи:

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
status = pending|sending|sent|failed
telegram_message_id NULL
attempts
created_at
sent_at NULL
```

Преимущества:

- retry;
- idempotency;
- crash recovery;
- exact sent message id;
- надежное отличие AI outgoing от creator manual outgoing.

---

# ЧАСТЬ G — DEBOUNCE, QUEUES, RESPONSE SCHEDULER

## 22. Debounce = один logical batch

Несколько быстрых сообщений должны давать один LLM turn:

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
incoming
→ durable inbox
→ resolve conversation_id
→ debounce ~1.5–2.0s after last message
→ collect unprocessed messages
→ one logical batch
```

---

## 23. ConversationQueue

Идею `ChatQueue` сохраняем, но lock key в domain path = `conversation_id`, а не physical Telegram chat id.

MUST:

```text
per-conversation serial execution
bounded global concurrency
conversation_version guard
room_generation guard
AbortController
graceful drain
```

---

## 24. Human-like ResponseScheduler

После LLM generation ответ не отправляется мгновенно.

Пример:

```text
target_delay =
  base_delay
  + text_length / typing_speed
  + random_jitter

remaining_delay = max(0, target_delay - llm_elapsed)
```

Пока ожидаем — typing action.

Если приходит новое customer сообщение или manual creator outgoing:

```text
invalidate old generation/send
→ rebuild context
```

По умолчанию обычный AI ответ отправляется как новое Telegram message, **не reply на каждую входящую реплику**. `replyToId` используется только когда смысловой reply действительно нужен.

---

# ЧАСТЬ H — LLM / DECISION ENGINE

## 25. Главный принцип

> **LLM отвечает за язык, persona, смысл и semantic intents. Код отвечает за состояние, Telegram actions, media, деньги и проверяемые факты.**

LLM может:

- написать reply;
- `no_reply`;
- выделить facts;
- вернуть `MediaIntent`;
- вернуть `OfferIntent`;
- предложить soft gift ask;
- предложить anon → DM handoff;
- рекомендовать human attention.

LLM не может:

- выполнять `next/search/stop/link`;
- считать Gift полученным;
- выбирать exact media asset id;
- помечать Offer paid;
- выполнять fulfillment;
- менять runtime config;
- читать arbitrary Telegram dialogs/contacts;
- вызывать generic Telegram tools.

---

## 26. AnonkaLLMService

```text
ContextBuilder
→ AnonkaLLMService
→ existing Teleton/pi-ai provider layer
→ ChatDecision
```

Новый provider stack не создаем.

Fallback только для технических ошибок.

---

## 27. ChatDecision

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

---

## 28. Structured output

```text
native JSON/schema
→ JSON object mode
→ plain JSON + validation
→ one repair
→ text-only safe fallback
```

Если structured output невалиден:

- можно отправить безопасный text fallback;
- нельзя выполнять media/offer/handoff/system actions.

---

## 29. Prompt / persona

Для каждого creator:

```text
SOUL.md      → persona/style
STRATEGY.md  → behavior/commercial strategy
SECURITY.md  → runtime boundaries
```

Prompt order:

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

Не использовать глобальные `MEMORY.md`/`USER.md` Teleton как память customers.

---

## 30. Conversation memory

Canonical memory:

```text
structured facts
rolling summary
recent messages
```

Compaction algorithm Teleton можно переиспользовать, но prompt переписать под обычный диалог.

FTS5 можно оставить для debug/search. Vector embeddings не нужны.

---

# ЧАСТЬ I — INCOMING CUSTOMER MEDIA

## 31. Voice

Если доступна Telegram transcription:

```text
voice/audio
→ existing transcription helper
→ transcript added to batch
```

Если transcription недоступна:

```text
voice_untranscribed event
```

Не выдумывать содержание.

### Photo/video/video_note от customer

На MVP:

```text
persist metadata
record media event
no automatic visual interpretation
```

Vision можно добавить отдельно позже.

---

# ЧАСТЬ J — MEDIA VAULT

## 32. Один Vault на creator

```text
Creator A → private Media Vault A
Creator B → private Media Vault B
```

Control Bot должен иметь доступ к Vault для preview/admin UI. Самый простой MVP-вариант: добавить Control Bot в каждый private Vault как участника/админа с минимально необходимыми правами.

Альтернатива позже: worker отправляет preview metadata/file в Control Bot через Supervisor.

---

## 33. Media types

MVP:

```text
photo
video
video_note
```

Нужно поддержать:

```text
Telegram groupedId/media_group_id
series_id
```

### Важно

Нельзя отправлять vault content обычным forward, если это раскрывает источник.

Нужно:

```text
refetch source media
→ resend/copy as new message
→ no forward attribution
```

---

## 34. Strict manual tags

Пример caption:

```text
#media
access=casual
content=face,full_body
view=front
outfit=shirt
scene=bedroom
series=home_04
```

Теги проверяются deterministic parser:

```text
known key
+
known controlled value
```

Неизвестное значение → validation error. LLM не размечает media.

---

## 35. Media approval/status

Media catalog хранит технический статус пригодности к использованию:

```text
PENDING
APPROVED
REJECTED
```

Это не юридическая/возрастная бюрократия, а обычный контроль качества каталога и тегов.

Flow:

```text
upload
→ parse/validate tags
→ PENDING
→ Control Bot card
→ APPROVE / EDIT TAGS / REJECT
```

Если для тестового режима ручная модерация не нужна, Supervisor может иметь настройку `auto_approve_valid_media=true`.

---

## 36. Media schema

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

---

## 37. MediaSelector

LLM возвращает semantic `MediaIntent`.

Код:

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

Если ничего подходящего нет → `MEDIA_NOT_AVAILABLE`.

---

## 38. MediaSeries

Offer и обычный media intent могут ссылаться на:

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

Каждый фактический send фиксируется отдельно в `media_deliveries`.

---

# ЧАСТЬ K — CONTROL BOT

## 39. Control Bot

Отдельный private Bot API bot, построенный на существующем Grammy bridge.

Принимать команды только:

```text
private chat
AND admin id in allowlist
```

Не участвует в customer conversations.

---

## 40. Команды

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

---

## 41. Human attention

LLM может только рекомендовать внимание.

```text
human_attention.recommended=true
```

Control Bot показывает уведомление/`Take over`, но сам LLM не меняет `control_mode`.

---

## 42. Panic

```text
disable new anon search
disable new AI replies
disable new offers/media intents
keep DB/recovery/control bot alive
never undo confirmed payment state
```

Выход только explicit admin action.

---

# ЧАСТЬ L — COMMERCE / GIFTS

## 43. Commercial mode

```text
DIRECT_SALE
PATRON
```

Default у CreatorProfile, conversation может хранить snapshot/override.

### DIRECT_SALE

```text
OfferIntent
→ reserve compatible unsent asset OR series
→ snapshot price
→ WAITING
→ verified Gift
→ PAID
→ FULFILLING
→ FULFILLED
```

### PATRON

Gift = support event. Не превращается автоматически в продажу конкретного asset без Offer.

---

## 44. Offer state machine

```text
WAITING
PAID
FULFILLING
FULFILLED
CANCELLED
EXPIRED
BLOCKED
```

Для одного conversation допускается максимум **один активный `WAITING` DIRECT_SALE Offer**. Это устраняет неоднозначный Gift matching.

---

## 45. Typed GiftEvent

```text
GiftEvent
├── event_key
├── creator_id
├── sender_peer_id
├── gift_ref/id
├── value_stars
├── received_at
└── raw/debug snapshot
```

Если sender/value нельзя определить надежно — автоматическая оплата не подтверждается.

---

## 46. Live event + reconciliation

Gift detection состоит из двух путей:

```text
live MTProto Gift/service event
        +
startup/periodic Stars transaction reconciliation
        ↓
GiftService
```

Reconciliation нужен на случай, если worker был offline во время Gift.

Периодический polling должен быть умеренным и идемпотентным.

---

## 47. Gift matching

```text
Offer.status == WAITING
AND creator matches
AND conversation.telegram_peer_id == gift.sender_peer_id
AND gift.value_stars >= offer.required_stars
AND gift.event_key not consumed
→ PAID
```

Один Gift не оплачивает два Offer.

---

## 48. Fulfillment

```text
PAID
→ FULFILLING
→ load reserved asset/series
→ send through durable Outbox
→ record every delivery
→ FULFILLED
```

Crash-safe и идемпотентно.

---

# ЧАСТЬ M — OBSERVABILITY

## 49. Domain events

```text
creator_runtime_started
creator_runtime_stopped
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
gift_received
offer_paid
offer_fulfilled
admin_command
inbox_retry
outbox_retry
error
```

---

## 50. Metrics

По creator:

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
worker health
```

---

# ЧАСТЬ N — ЧТО СНОСИМ ПОСЛЕ МИГРАЦИИ

## 51. Полностью удалить

После того как новый production path покрыт тестами:

```text
TON / wallet / DEX / NFT / DNS / DeFi
Gocoon
MCP runtime
AgentRuntime autonomous loop
Tool RAG
exec/general agent tools
plugin marketplace / plugin hot reload
WebUI
Management API, если не нужен
heartbeat autonomous tasks
scheduled agent tasks
RVC docker layer
sqlite-vec / vector embeddings
```

### Важно перед удалением `src/agent/tools/telegram/*`

Сначала вынести полезный low-level код:

```text
Stars transaction helpers
Gift helpers
media send/download/copy helpers
button/callback helpers
transcription helper
Telegram error helpers
```

Только потом удалить tool-executor оболочки.

---

## 52. Package cleanup

После удаления обновить `package.json` и CI.

Ожидаемо останется ядро уровня:

```text
@earendil-works/pi-ai
better-sqlite3
grammy
telegram
yaml
zod
pino
```

плюс реально используемые dev/build dependencies.

---

# ЧАСТЬ O — TARGET MODULE BOUNDARIES

## 53. Supervisor side

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
├── llm-coordinator.ts      # optional/shared local model concurrency
└── storage/
    └── supervisor-db.ts
```

## 54. Creator worker side

```text
src/runtime/
├── creator-runtime.ts
├── recovery.ts
└── shutdown.ts

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
└── anon/
    ├── adapter.ts
    └── controller.ts

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

Это границы ответственности, а не требование немедленно физически перестроить весь repo.

---

# ЧАСТЬ P — MIGRATION PLAN

## 55. Phase 0 — transport spike

До большого удаления подтвердить:

1. dedicated user-account стабильно получает/отправляет DM;
2. configured anonymous bot проходит allowlist exception;
3. доступны NewMessage, edited messages, reply/inline buttons и нужные raw updates;
4. можно programmatically click нужную кнопку anon bot;
5. photo/video/video_note принимаются и отправляются;
6. Vault media можно resend/copy без forward attribution;
7. Vault updates читаются;
8. реальный Gift дает sender/value/stable key;
9. Stars transaction history достаточна для reconciliation;
10. manual outgoing creator надежно отличается от programmatic outgoing.

---

## 56. Phase 1 — deterministic message path

- сохранить Telegram infra;
- добавить TransportRouter;
- добавить durable Inbox;
- добавить logical `conversation_id`;
- перестроить debounce в batch;
- заменить `AgentRuntime.processMessage()` на `AnonkaLLMService → ChatDecision`;
- добавить DecisionValidator;
- добавить ResponseScheduler;
- добавить ActionCoordinator;
- все sends перевести на durable Outbox;
- исправить rate-limit и LLM-failure semantics.

---

## 57. Phase 2 — creator worker + supervisor/control bot

- CreatorProfile;
- CreatorRuntime worker process;
- CreatorSupervisor;
- `supervisor.db`;
- typed IPC;
- separate Bot control plane;
- creator start/stop/restart;
- AI/HUMAN/HYBRID;
- admin audit;
- optional global LLMCoordinator.

---

## 58. Phase 3 — conversation memory + handoff

- conversation tables;
- raw Telegram → logical conversation mapping;
- facts;
- rolling summary;
- recent messages;
- anon→DM continuity;
- direct DM;
- manual creator outgoing;
- stale guards;
- Teleton compaction adaptation;
- убрать dependency на daily/idle Teleton session identity.

---

## 59. Phase 4 — Media Vault

- video_note/groupedId primitives;
- Vault ingestion;
- strict tags;
- optional PENDING approval flow / auto-approve config;
- MediaSelector;
- MediaSeries;
- resend without forward attribution;
- delivery history.

---

## 60. Phase 5 — commerce

- typed GiftEvent;
- real Gift fixture;
- Stars reconciliation;
- Offer state machine;
- GiftMatcher;
- DIRECT_SALE;
- PATRON;
- asset/series fulfillment;
- durable/idempotent delivery.

---

## 61. Phase 6 — cleanup

После доказанного нового runtime удалить весь unused general-agent/TON/MCP/WebUI/plugin/vector bloat.

Затем обновить:

```text
package.json
build scripts
CI
README/docs
```

---

# ЧАСТЬ Q — ОБЯЗАТЕЛЬНЫЕ TEST CONTRACTS

## 62. До массового удаления Teleton должны быть тесты

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
crash after inbox persistence
crash during normal outgoing send
crash during paid fulfillment
outbox idempotency
duplicate Gift
Gift recovery/reconciliation after restart
one WAITING direct-sale Offer per conversation
MediaSelector does not repeat already sent media when alternatives exist
strict media tag parser
series ordered fulfillment
Control Bot unauthorized access
anon→DM keeps same conversation_id
creator workers do not share DB/session/persona
```

---

# ЧАСТЬ R — DOCUMENTATION MIGRATION

## 63. Переписать после stabilization

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

`LICENSE` и необходимые attribution сохранить.

Старый Teleton `CHANGELOG.md` можно перенести в `docs/upstream/`, новый вести для Anonka.

---

# ЧАСТЬ S — DEFINITION OF DONE

## 64. Архитектурный переход завершен, когда

1. customer path не использует autonomous `AgentRuntime`;
2. Telegram transport сохраняет session/reconnect/dedup/FloodWait преимущества Teleton;
3. configured anon bot проходит allowlist exception, остальные bots игнорируются;
4. edited-message/button/raw-update requirements anon bot поддерживаются;
5. physical anon bot chat id не используется как conversation identity;
6. durable Inbox восстанавливает незавершенные incoming turns;
7. все programmatic creator outgoing идут через durable Outbox;
8. rate-limit не теряет сообщения;
9. LLM provider failure не раскрывает customer внутреннюю техническую ошибку;
10. debounce реально объединяет серию сообщений в один LLM turn;
11. stale generation/scheduled response отменяется при новом контексте;
12. manual creator outgoing попадает в ту же history;
13. `AI | HUMAN | HYBRID` является явным state;
14. anon→DM сохраняет `conversation_id`;
15. `Teleton Session != Anonka Conversation` и daily reset не ломает history;
16. LLM возвращает только `ChatDecision`;
17. Telegram/media/payment actions выполняются code-side;
18. существующий Teleton provider layer переиспользуется;
19. Supervisor и creator workers разделены process isolation;
20. у каждого creator отдельный runtime home/DB/session/persona/Vault;
21. общий local LLM можно ограничивать global coordinator;
22. Media Vault поддерживает photo/video/video_note/series;
23. media resend не раскрывает Vault через forward attribution;
24. Gifts идут через live event + reconciliation;
25. Gift matching/Offer fulfillment идемпотентны;
26. crash recovery не теряет paid fulfillment;
27. SQLite является source of truth;
28. FTS5 может остаться, vector embeddings удалены;
29. test contract из раздела 62 проходит;
30. TON/general-agent/MCP/plugin/WebUI bloat больше не входит в production path и удален.

---

## 65. Итоговая схема

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
             │
      Telegram event
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

### Ключевой принцип перехода

```text
сначала переиспользовать хорошую инфраструктуру Teleton
→ затем заменить autonomous decision path
→ затем добавить durable/domain слои Anonka
→ только потом удалить лишний Teleton bloat
```

Это каноническая целевая архитектура Anonka.