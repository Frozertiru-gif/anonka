# Anonka — целевая архитектура

> Статус: каноническая архитектурная спецификация проекта после аудита фактической кодовой базы Teleton Agent.  
> Репозиторий: `Frozertiru-gif/anonka`.  
> Цель документа: зафиксировать, что мы реально переиспользуем из Teleton, что меняем, что удаляем и какую доменную архитектуру строим поверх готовой инфраструктуры.

---

## 1. Что строим

`anonka` — Telegram-платформа для одного или нескольких реальных creator-аккаунтов, где AI может вести переписки от имени конкретного creator, а сам creator в любой момент может вмешаться вручную.

Ключевая модель системы:

```text
Creator
├── свой Telegram user-account
├── своя persona / стиль общения
├── свой Media Vault
├── свои conversation
├── свой anon source/controller
└── свой runtime state
```

Система:

1. работает через MTProto как реальные Telegram user-account;
2. умеет работать с anonymous-chat bot и обычными DM;
3. сохраняет один логический `conversation` при переходе anon → DM;
4. поддерживает режимы `AI | HUMAN | HYBRID` на каждый conversation;
5. генерирует в runtime в основном текст;
6. берет фото/видео/video notes из заранее подготовленного и промодерированного Media Vault;
7. поддерживает `DIRECT_SALE` и `PATRON`;
8. подтверждает Gifts/Stars только кодом;
9. управляется через отдельного приватного Telegram control-bot;
10. использует общую LLM-конфигурацию для всех CreatorRuntime, если явно не появится необходимость в override позже.

Система **не является general-purpose autonomous agent**. Teleton используется как инфраструктурный chassis, а не как готовый decision engine.

---

# ЧАСТЬ A — ЧТО БЕРЕМ ИЗ TELETON

## 2. База проекта: Teleton Agent

Импортированный baseline уже содержит значительную часть нужной инфраструктуры. Ее не нужно переписывать с нуля.

### 2.1. Сохраняем практически как есть

#### Telegram user-account infrastructure

Сохраняем и переиспользуем:

```text
src/telegram/client.ts
src/telegram/bridges/user.ts
src/telegram/bridge-interface.ts
src/telegram/flood-retry.ts
src/telegram/offset-store.ts
src/telegram/debounce.ts
```

Из `src/telegram/handlers.ts` сохраняем инфраструктурную часть:

- `ChatQueue`;
- per-chat serial processing;
- global concurrency limit;
- dedupe;
- persistent offset;
- rate limit;
- typing simulation primitives;
- сохранение incoming до обработки;
- graceful drain/recovery behavior.

#### SQLite foundation

Сохраняем:

- `better-sqlite3`;
- WAL;
- foreign keys;
- migrations;
- текущий database lifecycle;
- существующие полезные stores там, где они не конфликтуют с новой доменной моделью.

Новый отдельный `DatabaseService` не нужен.

#### LLM provider layer

Сохраняем существующий provider/model layer Teleton:

```text
src/providers/
src/agent/client.ts
src/agent/model-request.ts
src/agent/provider-fallback.ts
```

Он уже решает:

- выбор provider/model;
- OpenAI-compatible endpoints;
- local model servers;
- timeout;
- AbortSignal;
- temperature/max tokens;
- provider fallback на технических ошибках;
- stripping reasoning blocks там, где это требуется;
- usage/provider plumbing.

Мы не пишем новый универсальный `LLMProvider` с нуля.

#### Telegram Bot API infrastructure

Сохраняем существующий bot-layer:

```text
src/telegram/bridges/bot.ts
src/bot/callback-router.ts
src/bot/callback-answer.ts
src/bot/rate-limiter.ts
```

Control Bot строится **на этой инфраструктуре**, а не отдельной новой библиотекой.

#### Gifts / service messages

Teleton уже разбирает MTProto service events:

```text
MessageActionStarGift
MessageActionStarGiftPurchaseOffer
MessageActionStarGiftPurchaseOfferDeclined
```

Этот low-level parsing сохраняем и превращаем в typed domain events.

---

## 3. Что из Teleton переделываем

### 3.1. `MessageHandler`

Не удаляем целиком.

Было:

```text
Telegram message
→ AgentRuntime.processMessage()
→ LLM tools
→ response
```

Станет:

```text
Telegram message
→ TransportRouter
→ ConversationService
→ ContextBuilder
→ AnonkaLLMService
→ ChatDecision
→ DecisionValidator
→ ActionCoordinator
```

Инфраструктурная очередь и persistence остаются, decision engine заменяется.

### 3.2. Bot filter

Исходный Teleton игнорирует `message.isBot`.

Для Anonka:

```text
sender is bot?
├── exact configured anonymous bot → AnonAdapter
└── любой другой bot → ignore
```

Нельзя включать общий режим «принимать всех ботов».

### 3.3. Outgoing from self

Исходный Teleton игнорирует сообщения от собственного user-account.

В Anonka manual outgoing от creator является важным событием:

```text
manual outgoing
→ persist source=creator_manual
→ invalidate stale AI job
→ применить AI/HUMAN/HYBRID policy
```

Программные outgoing должны коррелироваться с outbox/message id и не считаться ручным вмешательством.

### 3.4. Gifts

Сейчас Teleton может представлять Gift event как текст для AgentRuntime.

В Anonka:

```text
MTProto service event
→ GiftEventParser
→ typed GiftEvent
→ GiftService
→ OfferMatcher
```

Gift не отправляется LLM как инструкция и LLM не подтверждает оплату.

### 3.5. Persona/Soul

Сохраняем концепцию стабильных prompt blocks и файлов вроде `SOUL.md`, но полностью меняем содержимое.

Для каждого CreatorRuntime:

```text
SOUL.md      → persona и стиль creator
STRATEGY.md  → стратегия общения/коммерческая политика
SECURITY.md  → системные ограничения runtime
```

Глобальные `MEMORY.md`, `USER.md`, daily memory Teleton нельзя использовать как память разных клиентов.

### 3.6. Memory compaction

Алгоритмическую основу compaction/summarization можно переиспользовать.

Переписываем summary prompt под conversation:

```text
Facts about person
Relationship/context summary
Important previous events
Open conversation threads
Recent messages
```

Не сохраняем TON/tool-agent semantics.

---

## 4. Что удаляем после переключения production path

Удаление выполняется **после** того, как новый runtime покрыт тестами/spike.

### Полностью удалить

```text
TON / wallet / DEX / NFT / DNS / DeFi
Gocoon
MCP runtime
Agent tool registry
Agent autonomous loop
Tool RAG
general-purpose Telegram tools exposed to LLM
coding/general-agent capabilities
plugin marketplace / plugin hot reload
WebUI
Management API, пока он не нужен продукту
heartbeat autonomous tasks
scheduled autonomous agent tasks
RVC docker layer
vector embeddings / sqlite-vec для обычной переписки
```

### Из `src/agent/` сначала вынести полезное

Перед удалением generic agent layer сохранить/переместить в нейтральный `src/llm/`:

```text
client.ts
model-request.ts
provider-fallback.ts
нужные token usage helpers
provider/schema compatibility helpers
```

После этого удаляется `AgentRuntime`, tool loop и связанная general-agent инфраструктура.

---

# ЧАСТЬ B — RUNTIME TOPOLOGY

## 5. Главная архитектурная единица — Creator

Вместо прежнего центрального `Channel` вводится `CreatorProfile`.

```text
CreatorProfile
├── id
├── display_name
├── enabled
├── telegram account/session config
├── persona config
├── media_vault_chat_id
├── commercial_policy
├── default_offer_price_stars
└── anon source config
```

Слово `model` в доменной архитектуре не используется для обозначения creator-девушки, чтобы не путать ее с LLM model.

В коде используем термин `creator`.

---

## 6. CreatorRuntime

Один `CreatorRuntime` обслуживает **один Telegram user-account**.

```text
CreatorRuntime
├── CreatorProfile
├── GramJS user bridge
├── Telegram session
├── ConversationService
├── AnonController
├── Media Vault binding
├── Gift event pipeline
├── creator-specific persona
└── runtime state
```

### Почему не один огромный multi-account `TeletonApp`

Текущий Teleton сильно singleton-oriented:

```text
1 TeletonApp
1 bridge
1 TELETON_HOME
1 memory.db
1 session/workspace
```

Ломать это ради нескольких user-account невыгодно.

Поэтому масштабирование строится через изолированные runtime:

```text
/data/creators/alina
/data/creators/masha
/data/creators/vika
```

или эквивалентные отдельные `TELETON_HOME`/runtime directories.

Каждый runtime имеет собственные:

- Telegram session;
- SQLite data/runtime state;
- persona files;
- media binding;
- conversations;
- anon state.

---

## 7. CreatorSupervisor

Над CreatorRuntime находится общий supervisor:

```text
CreatorSupervisor
├── start creator runtime
├── stop creator runtime
├── restart creator runtime
├── health/status
├── route admin commands
└── aggregate alerts/metrics
```

Control Bot общается с Supervisor, а не напрямую с внутренним Telegram handler конкретного creator.

### MVP

На первом этапе допускается один creator runtime.

Архитектура при этом сразу должна позволять:

```text
Creator #1 runtime
Creator #2 runtime
Creator #3 runtime
```

без смешивания sessions/conversations/media.

---

## 8. Общая LLM-конфигурация

По умолчанию все CreatorRuntime используют одну общую LLM-конфигурацию.

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

Creator-specific LLM override **не нужен для MVP**.

Если позже появится реальная причина использовать разную LLM для разных creator, добавляется optional override без изменения conversation core.

Не создавать сейчас:

```text
Channel.model_profile_id
conversation.model_profile_id
ModelProfile table
ModelRouter per channel
```

---

## 9. Control Bot работает параллельно user runtimes

У Teleton основной bridge сейчас выбирается как `user OR bot`.

Anonka требует:

```text
CreatorRuntime(s) → user-account bridge(s)
Control Plane     → отдельный bot bridge
```

Поэтому bot runtime wiring отделяется от creator user bridge.

Существующий `GrammyBotBridge` переиспользуется как база Control Bot.

---

# ЧАСТЬ C — ANON SOURCE

## 10. AnonSource вместо Channel

Если creator работает через anonymous-chat bot, у него есть `AnonSource`.

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

`AnonSource` — узкая transport-конфигурация, а не центральная бизнес-сущность.

Если позже одному creator понадобится несколько anonymous bots, `AnonSource` становится массивом/отдельной таблицей без изменения остальных доменов.

---

## 11. AnonController

На каждый активный AnonSource:

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
  │
  ├── idle timeout ───────────► SKIPPING ─► SEARCHING
  ├── partner left/skipped ───► SEARCHING
  ├── admin next ─────────────► SKIPPING ─► SEARCHING
  ├── handoff intent ─────────► HANDOFF_PENDING
  │                               ├─ dm_confirmed ─► SEARCHING
  │                               ├─ partner_left ─► SEARCHING
  │                               └─ timeout ───────► SKIPPING ─► SEARCHING
  └── admin stop ─────────────► STOPPED
```

---

## 12. AnonAdapter

```ts
interface AnonAdapter {
  search(): Promise<void>;
  next(): Promise<void>;
  stop(): Promise<void>;
  requestLink(): Promise<void>;
  reconcile(): Promise<ObservedAnonState>;
}
```

Нормализованные события:

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

Adapter может работать через:

- text commands;
- reply keyboard;
- inline buttons;
- edited messages;
- raw MTProto updates.

Перед production нужен reconnaissance конкретного anonymous bot.

---

## 13. Stale generation protection

У AnonController есть монотонный `room_generation`.

Каждый LLM job хранит snapshot:

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

Generation инвалидируется **до** `next`, `stop` и confirmed handoff.

---

# ЧАСТЬ D — CONVERSATIONS

## 14. Conversation = один человек

Conversation не равен Telegram chat id.

Это критично для anonymous chat: физический Telegram chat с anonymous bot один и тот же, а люди в комнатах разные.

Нужен собственный `conversation_id`.

До handoff:

```text
conversation_id=184
creator_id=alina
current_transport=anon
anon_source_id=anon_ru
telegram_peer_id=NULL
```

После handoff:

```text
conversation_id=184
creator_id=alina
current_transport=dm
telegram_peer_id=123456789
```

Прямой DM создает новый conversation для конкретного creator.

---

## 15. Conversation data

Conversation хранит:

```text
creator_id
current_transport
telegram_peer_id
anon_source_id
state
control_mode
version
facts
rolling summary
recent messages
sent media
active Offer
commercial mode
last activity
```

Контексты разных людей и разных creator никогда не смешиваются.

---

## 16. Control mode

На каждый conversation:

```text
AI
HUMAN
HYBRID
```

### AI

AI отвечает автоматически.

### HUMAN

Creator ведет conversation вручную. AI не отправляет сообщения.

### HYBRID

AI продолжает вести conversation, но creator может вручную вмешиваться. Ручные сообщения сохраняются в общей истории и учитываются AI дальше.

---

## 17. Manual creator outgoing

При ручном сообщении creator:

```text
persist source=creator_manual
→ increment conversation_version
→ cancel/invalidate pending AI generation
→ apply control-mode policy
```

Не использовать фиксированный `MANUAL_OVERRIDE=60s` как основную модель управления.

Явный `control_mode` является source of truth.

---

## 18. Handoff anon → DM

LLM может вернуть только semantic intent:

```json
{"handoff_intent":"offer"}
```

Код выполняет:

```text
AnonAdapter.requestLink()
→ HANDOFF_PENDING
→ create handoff record
→ wait for reliable DM correlation
```

Порядок matching:

1. token/prefilled marker, если protocol позволяет;
2. другой уникальный технический признак;
3. temporal correlation только если она однозначна.

Нельзя считать любой новый DM во время pending handoff тем же человеком.

После confirmed handoff:

```text
bind telegram_peer_id
switch transport → dm
keep same conversation_id
invalidate anon generation
release anon room
start next search
DM continues independently
```

---

# ЧАСТЬ E — LLM И DECISION ENGINE

## 19. Главный принцип

> **LLM отвечает за язык, смысл, persona и семантические намерения. Код отвечает за состояние, Telegram actions, media, деньги и проверяемые факты.**

### LLM может

- написать ответ;
- вернуть `no_reply`;
- выделить новые facts о собеседнике;
- сформировать `MediaIntent`;
- сформировать `OfferIntent`;
- предложить мягкий gift ask в `PATRON`;
- предложить handoff anon → DM;
- рекомендовать human attention;
- учитывать подтвержденные кодом события.

### LLM не может

- сама отправлять `next/search/stop/link`;
- считать Gift полученным;
- выбирать конкретный `media_asset_id`;
- помечать Offer как paid;
- выполнять fulfillment;
- менять runtime config;
- читать произвольные Telegram dialogs/contacts;
- выполнять arbitrary Telegram tools.

---

## 20. AnonkaLLMService

Не создаем новый provider stack.

```text
ContextBuilder
→ AnonkaLLMService
→ existing Teleton/pi-ai provider layer
→ normalized ChatDecision
```

Используем существующие provider/model resolver, timeout, fallback и request plumbing.

Fallback разрешен только для технических ошибок:

- timeout;
- transient 5xx;
- connection error;
- rate limit;
- local endpoint unavailable.

---

## 21. ChatDecision

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

Fact extraction по возможности выполняется в основном chat call, а не отдельным LLM request на каждое сообщение.

---

## 22. Structured output strategy

```text
native JSON/schema support if provider supports it
→ JSON object mode
→ plain JSON + validation
→ one repair attempt
→ safe text-only fallback
```

При невалидном structured output:

- текст можно отправить только через безопасный fallback;
- media/offer/handoff/system actions не выполняются.

---

## 23. Prompt assembly

Порядок:

```text
1. SYSTEM CORE
2. CREATOR PERSONA / SOUL
3. CREATOR BEHAVIOR / STRATEGY
4. FEW-SHOT STYLE EXAMPLES
5. RUNTIME CONTEXT
6. KNOWN FACTS ABOUT CUSTOMER
7. ROLLING SUMMARY
8. RECENT MESSAGES
9. CURRENT BATCH
```

Стабильные блоки идут первыми для prefix caching.

---

## 24. Generation defaults

Для обычного Telegram dialogue baseline:

```text
temperature ≈ 0.8–1.0
reasoning/thinking = off
короткий output
```

Точные значения задаются global LLM config.

Логировать:

```text
creator_id
conversation_id
provider
model
task
prompt_version
persona_version
temperature
latency_ms
input_tokens
output_tokens
cached_tokens if available
fallback_used
```

---

# ЧАСТЬ F — MEMORY И CONCURRENCY

## 25. Память

Для каждого conversation:

### Structured facts

Например:

```text
name
city
work
interests
preferences
important events
```

### Rolling summary

Компактное состояние старой части разговора.

### Recent messages

Последняя часть диалога без summarization.

Не отправлять всю историю с начала.

Не использовать global Teleton user memory для клиентов.

---

## 26. Raw Telegram journal и domain conversation

Существующий `tg_messages` можно сохранить как raw Telegram journal.

Поверх него вводятся domain entities:

```text
conversations
conversation_messages
conversation_facts
conversation_summaries
```

Это особенно важно для anonymous bot, где один Telegram `chat_id` содержит последовательность разных реальных собеседников.

---

## 27. Debounce

Существующий `MessageDebouncer` переиспользуется, но wiring меняется.

```text
incoming
→ persist raw event
→ resolve conversation_id
→ per-conversation debounce
→ build one logical batch
→ one chat call
```

Для DM debounce тоже должен работать, а не только для групп.

---

## 28. Concurrency

Сохраняем идею существующего `ChatQueue`, но domain lock key должен быть `conversation_id`, а не только физический Telegram chat.

MUST:

```text
per-conversation serial execution
bounded global LLM concurrency
conversation_version guard
room_generation guard for anon
AbortController for stale generation
bounded retries
graceful drain
```

---

# ЧАСТЬ G — MEDIA VAULT

## 29. Один Media Vault на creator

У каждого creator свой private Telegram channel/chat.

```text
Creator A → Media Vault A
Creator B → Media Vault B
Creator C → Media Vault C
```

Creator может самостоятельно загружать туда контент через обычный Telegram.

AI-инструменты для разметки creator не нужны.

---

## 30. Поддерживаемые media

MVP:

```text
photo
video
video_note
```

Для наборов фото/видео используем Telegram `media_group_id` и собственный `series_id`.

Текущий Teleton media interface нужно расширить:

```text
video_note media type
media_group_id
sendVideo()
sendVideoNote()
```

или единым domain-facing `sendMedia(asset)`.

---

## 31. Strict manual tags

Caption содержит фиксированные tags из заранее известной схемы.

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

Parser:

```text
known key
+
known enum/value
```

Неизвестный key/value → validation error.

Creator не работает с prompt/context/temperature и не взаимодействует с LLM для разметки.

---

## 32. Media moderation

Новый asset не становится доступным AI сразу.

```text
Creator upload
→ PENDING
→ strict tag validation
→ Control Bot moderation card
├── APPROVE
├── EDIT TAGS
└── REJECT
```

Только `APPROVED` media входит в каталог, доступный `MediaSelector`.

---

## 33. Media schema

Минимально:

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
description NULL
moderation_status
submitted_by
approved_by NULL
approved_at NULL
enabled
created_at
```

Дополнительно полезно:

```text
file_unique_id / reusable Telegram reference
content hash
duration
width
height
moderation_note
```

---

## 34. MediaSelector

LLM возвращает только semantic `MediaIntent`.

Пример:

```text
media_type = video_note
scene = home
outfit = shirt
```

Код:

```text
MediaIntent
→ creator_id
→ APPROVED only
→ filter access class
→ filter type/tags
→ exclude already sent to this conversation
→ score
→ random top-N / deterministic tie-break
→ exact asset
```

Если подходящего asset нет:

```text
MEDIA_NOT_AVAILABLE
```

Нельзя отправлять нерелевантный asset просто потому, что он есть.

---

## 35. Media memory

LLM не получает весь каталог.

После отправки в conversation context добавляется semantic event, например:

```text
Sent media: series=home_04, type=video_note, scene=bedroom, view=front
```

Source of truth остается SQLite/MediaCatalog.

---

# ЧАСТЬ H — CONTROL BOT

## 36. Control Bot

Control Bot — отдельный private Bot API bot и главный admin UI.

Он строится на существующем `GrammyBotBridge`/callback infrastructure Teleton.

Принимать команды только от разрешенных admin Telegram IDs и только в приватном admin context.

Control Bot не участвует в customer conversations.

---

## 37. Что переиспользуем из текущего AdminHandler

Сохраняем концепции:

- admin ID auth;
- command parser;
- status;
- pause/resume primitives;
- config mutation helpers там, где они подходят.

Удаляем команды/логику, связанные с:

```text
wallet
TON
RAG
modules
plugins
agent loop iteration count
```

---

## 38. Основные команды

Целевой набор:

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

/mode <creator_id> direct|patron
/price <creator_id> <stars>
/offers <creator_id> on|off
/media <creator_id> on|off

/reload_prompts <creator_id>
/errors
/panic
```

Частые действия должны иметь inline buttons.

---

## 39. Human attention

LLM может вернуть рекомендацию:

```text
human_attention.recommended = true
```

Это только signal.

Код/Control Bot решает:

- показать creator/admin alert;
- предложить `Take over`;
- ничего не менять автоматически.

LLM не переключает conversation в HUMAN самостоятельно.

---

## 40. Panic

```text
disable new anon search
disable new AI replies
disable new offers/media intents
keep persistence/recovery/control bot alive
never undo confirmed payment state
```

Выход — только explicit admin action.

---

# ЧАСТЬ I — COMMERCE И GIFTS

## 41. Commercial mode

Default принадлежит CreatorProfile, conversation хранит snapshot/override при необходимости.

```text
DIRECT_SALE
PATRON
```

### DIRECT_SALE

```text
OfferIntent
→ reserve compatible APPROVED unsent media
→ snapshot current creator price
→ Offer WAITING
→ verified Gift from bound DM peer
→ PAID
→ code-side fulfillment
```

### PATRON

Gift является support event. Он не превращается автоматически в покупку конкретного asset без отдельного Offer.

---

## 42. Typed GiftEvent

Low-level MTProto parsing Teleton переиспользуем, но результат должен быть domain event:

```text
GiftEvent
├── event_key
├── creator_id
├── sender_peer_id
├── gift_ref/id
├── value_stars
├── received_at
└── raw_event_snapshot/debug ref
```

Если sender/value не определены надежно, автоматическая оплата не подтверждается.

До production обязательно проверить реальным Gift fixture, какие поля Telegram дает стабильно.

---

## 43. Gift matching

```text
Offer.status == WAITING
AND offer.creator_id == GiftEvent.creator_id
AND conversation.telegram_peer_id == GiftEvent.sender_peer_id
AND GiftEvent.value_stars >= offer.required_stars
AND GiftEvent.event_key not consumed
→ PAID
```

Один Gift не оплачивает два Offer.

Duplicate event не выполняет fulfillment повторно.

---

## 44. Fulfillment

Fulfillment выполняет код:

```text
PAID Offer
→ fetch reserved media asset
→ verify asset still APPROVED/available
→ Telegram send
→ persist delivery
→ FULFILLED
```

LLM не участвует в подтверждении оплаты и exact-media fulfillment.

---

# ЧАСТЬ J — PERSISTENCE

## 45. SQLite source of truth

Используем существующий SQLite/WAL foundation Teleton.

Основные domain tables:

```text
creators
anon_sources
conversations
conversation_messages
conversation_facts
conversation_summaries
handoffs
media_assets
media_series
media_deliveries
media_moderation_events
offers
gifts
admin_audit_events
domain_events
outbox
```

Существующие `tg_messages/tg_chats/tg_users` можно оставить как raw Telegram feed, пока они полезны для транспорта/debug.

---

## 46. `creators`

```text
id TEXT PK
display_name TEXT
enabled BOOL
runtime_home TEXT
media_vault_chat_id TEXT
commercial_mode TEXT
default_offer_price_stars INTEGER
created_at
updated_at
```

Telegram session secrets и API credentials не должны храниться как открытый текст в domain rows.

---

## 47. `anon_sources`

```text
id TEXT PK
creator_id TEXT FK
enabled BOOL
bot_peer_id TEXT
bot_username TEXT NULL
adapter_type TEXT
language TEXT
idle_timeout_seconds INTEGER
search_watchdog_seconds INTEGER
created_at
updated_at
```

---

## 48. `conversations`

```text
id INTEGER PK
creator_id TEXT FK
anon_source_id TEXT NULL
current_transport anon|dm
state active|handoff_pending|ended
control_mode ai|human|hybrid
telegram_peer_id INTEGER NULL
anon_generation INTEGER NULL
version INTEGER
commercial_mode direct|patron
last_activity_at
created_at
updated_at
ended_at NULL
end_reason NULL
```

Не более одной active DM conversation на Telegram peer **внутри одного creator**.

---

## 49. Outbox и recovery

Важные side effects идут через durable outbox:

```text
DB transaction
→ state change + outbox action
→ worker executes Telegram side effect
→ mark delivered
```

Особенно:

```text
paid media fulfillment
handoff command
critical control-bot notification
```

После crash runtime восстанавливает:

```text
pending outbox
PAID but not FULFILLED offers
anon state needing reconcile
unfinished moderation/admin actions where applicable
```

---

# ЧАСТЬ K — OBSERVABILITY

## 50. Domain events

Минимум:

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
media_submitted
media_approved
media_rejected
media_sent
offer_created
gift_received
offer_paid
offer_fulfilled
admin_command
error
```

Каждый event включает `creator_id` и `conversation_id`, где применимо.

---

## 51. Метрики

Считать по creator:

```text
anon rooms started
messages received/sent
handoff rate
DM continuation rate
Gift count/value
Offer conversion
media sends
LLM latency/error rate
fallback rate
tokens/cost where available
conversation duration
AI/HUMAN/HYBRID distribution
```

---

# ЧАСТЬ L — ЧТО НЕ СТРОИМ СЕЙЧАС

## 52. Не нужно для MVP

```text
microservices
Postgres
Redis
Kubernetes
vector DB
runtime image/video generation
creator-specific LLM routing
ModelProfile table
Channel abstraction as core domain
WebUI as primary admin
MCP
autonomous agent tool loop
plugin marketplace
complex relationship simulator
automatic vision tagging of Media Vault
```

Базовый target:

```text
CreatorSupervisor
+ 1..N isolated CreatorRuntime
+ GramJS user sessions
+ separate Telegram Control Bot
+ SQLite/WAL per runtime/domain
+ shared LLM provider configuration
+ ConversationService
+ AnonAdapter/AnonController
+ Media Vault + moderation
+ Gifts/Offers
```

---

# ЧАСТЬ M — TARGET MODULE BOUNDARIES

## 53. Целевая схема

Физически переносить весь существующий Teleton в новые папки одним коммитом не нужно.

Границы ответственности:

```text
src/
├── runtime/
│   ├── creator-runtime.ts
│   ├── creator-supervisor.ts
│   └── recovery.ts
│
├── telegram/
│   ├── client.ts                  # reuse Teleton
│   ├── bridge-interface.ts        # reuse/extend
│   ├── bridges/
│   │   ├── user.ts                # reuse/modify
│   │   └── bot.ts                 # Control Bot base
│   ├── handlers.ts                # reuse infra, replace decision path
│   ├── debounce.ts                # reuse
│   ├── flood-retry.ts             # reuse
│   ├── offset-store.ts            # reuse
│   └── anon/
│       ├── adapter.ts
│       └── controller.ts
│
├── control-bot/
│   ├── commands.ts
│   ├── callbacks.ts
│   ├── moderation.ts
│   └── alerts.ts
│
├── llm/
│   ├── client.ts                  # extracted Teleton provider client
│   ├── model-request.ts
│   ├── provider-fallback.ts
│   ├── service.ts
│   ├── chat-decision.ts
│   └── decision-validator.ts
│
├── domain/
│   ├── creators/
│   ├── conversations/
│   ├── handoff/
│   ├── media/
│   └── commerce/
│
├── application/
│   ├── transport-router.ts
│   ├── context-builder.ts
│   ├── action-coordinator.ts
│   └── analytics.ts
│
└── prompts/
    ├── system/
    ├── creators/
    └── examples/
```

Это target boundaries, а не требование немедленно переименовать все существующие файлы.

---

# ЧАСТЬ N — MIGRATION FROM TELETON

## 54. Phase 0 — transport spike

До большого удаления подтвердить:

1. dedicated user-account стабильно получает и отправляет DM;
2. configured anonymous bot проходит patched bot filter;
3. видны нужные NewMessage/MessageEdited/buttons/raw events;
4. photo/video/video_note реально принимаются и отправляются;
5. Media Vault channel updates читаются;
6. реальный Gift дает sender/value/stable event key, достаточные для matching;
7. manual outgoing creator можно надежно отличить от programmatic outgoing.

---

## 55. Phase 1 — deterministic message path

- сохранить Telegram infra `client/bridge/queue/debounce/dedup/flood retry`;
- отключить `AgentRuntime.processMessage()` из customer production path;
- отключить LLM-accessible Telegram tools;
- добавить `TransportRouter`;
- добавить `ConversationService`;
- добавить `AnonkaLLMService → ChatDecision`;
- добавить `ActionCoordinator`.

---

## 56. Phase 2 — creator runtime + control bot

- `CreatorProfile`;
- `CreatorRuntime`;
- `CreatorSupervisor`;
- разнести user runtime и bot control plane;
- перепрофилировать существующий Admin/Bot layer;
- `/status`, creator start/stop/restart;
- AI/HUMAN/HYBRID commands;
- admin audit.

На первом этапе достаточно одного creator runtime, но без hardcode singleton business logic.

---

## 57. Phase 3 — conversation memory + handoff

- domain `conversation_id`;
- raw Telegram chat → logical conversation mapping;
- facts;
- rolling summary;
- recent messages;
- anon→DM continuity;
- direct DM;
- manual creator outgoing;
- stale guards;
- reuse/rewrite Teleton compaction where appropriate.

---

## 58. Phase 4 — Media Vault

- extend media types with `video_note` and `media_group_id`;
- Media Vault ingestion per creator;
- strict manual tags;
- PENDING moderation;
- Control Bot moderation cards;
- `APPROVED` catalog;
- MediaSelector;
- per-conversation delivery history.

---

## 59. Phase 5 — commerce

- typed GiftEvent from existing MTProto service parsing;
- Gift fixture verification;
- OfferService;
- GiftMatcher;
- DIRECT_SALE;
- PATRON;
- durable/idempotent fulfillment.

---

## 60. Phase 6 — cleanup

После доказанного нового production path удалить:

```text
TON/DEX/DNS/wallet
Gocoon
AgentRuntime/tool loop
generic agent tools
Tool RAG
MCP
plugin system/SDK marketplace
WebUI
Management API if still unused
heartbeat/scheduled agent tasks
vector embeddings/sqlite-vec
RVC
Teleton-specific docs/code paths that no longer используются
```

После удаления обновить `package.json`, build scripts и CI под реально оставшиеся зависимости.

---

# ЧАСТЬ O — DOCUMENTATION MIGRATION

## 61. Документация, которую нужно переписать

После стабилизации новой архитектуры обновить:

```text
README.md
GETTING_STARTED.md
config.example.yaml
docs/configuration.md
docs/telegram-setup.md
docs/deployment.md
```

Удалить/архивировать Teleton-specific документы, если их соответствующий runtime удален:

```text
TON/wallet docs
plugin docs
management API docs
TOOLS.md
docs-sdk/
```

`LICENSE` и необходимые attribution сохраняются.

Старый Teleton `CHANGELOG.md` можно перенести в `docs/upstream/`, а новый `CHANGELOG.md` вести уже для Anonka.

---

# ЧАСТЬ P — DEFINITION OF DONE

## 62. Архитектурный переход завершен, когда

1. customer production path не использует autonomous `AgentRuntime`;
2. Telegram user-account transport сохраняет dedupe/queue/retry/persistence преимущества Teleton;
3. configured anonymous bot проходит allowlist exception, остальные bots игнорируются;
4. физический Telegram chat anonymous bot не используется как conversation identity;
5. каждый conversation изолирован;
6. manual creator outgoing попадает в ту же историю и инвалидирует stale AI response;
7. `AI | HUMAN | HYBRID` работает как явное состояние;
8. anon→DM сохраняет тот же `conversation_id`;
9. LLM возвращает только `ChatDecision`;
10. Telegram/media/payment side effects выполняются code-side;
11. общий Teleton provider layer используется вместо нового provider stack;
12. Control Bot работает параллельно user runtime и переиспользует существующий bot layer;
13. у каждого creator отдельный Media Vault;
14. media проходит PENDING → APPROVED/REJECTED moderation;
15. LLM не выбирает exact media asset;
16. Gifts поступают в typed code-side pipeline;
17. Gift matching и fulfillment идемпотентны;
18. SQLite остается source of truth;
19. несколько creator можно запустить как изолированные runtime без смешивания sessions/data/persona;
20. TON/general-agent/MCP/tool-loop код больше не входит в production path и после migration удален.

---

## 63. Короткая итоговая схема

```text
                        TELEGRAM CONTROL BOT
                                │
                         CreatorSupervisor
                                │
              ┌─────────────────┼─────────────────┐
              ▼                 ▼                 ▼
       CreatorRuntime A  CreatorRuntime B  CreatorRuntime C
              │                 │                 │
       TG user account A TG user account B TG user account C
              │                 │                 │
       Conversations A   Conversations B   Conversations C
       AnonSource A       AnonSource B       AnonSource C
       Media Vault A      Media Vault B      Media Vault C
              │                 │                 │
              └─────────────────┼─────────────────┘
                                ▼
                         Shared LLM config
                                │
                         existing pi-ai /
                         provider layer
                                │
                                ▼
                           ChatDecision
                                │
                       DecisionValidator
                                │
                       ActionCoordinator
                     ┌──────────┼──────────┐
                     ▼          ▼          ▼
                  Telegram     Media     Commerce
                               Vault      Gifts
```

### Ключевой принцип перехода

Не переписывать то, что Teleton уже делает хорошо.

Сначала:

```text
reuse transport/provider/SQLite/bot infrastructure
```

затем:

```text
replace autonomous agent decision layer
```

и только после переключения production path:

```text
remove unused Teleton general-agent/TON/MCP/WebUI bloat
```

Это и есть целевая архитектура Anonka. Все последующие изменения кода и документации должны проверяться против нее.
