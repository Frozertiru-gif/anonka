# Anonka — целевая архитектура

> Статус: каноническая архитектурная спецификация проекта после перехода на Teleton Agent как инфраструктурную базу.  
> Репозиторий: `Frozertiru-gif/anonka`.  
> Цель документа: зафиксировать границы системы и согласованные решения так, чтобы Codex реализовывал их поэтапно, не придумывая архитектуру заново.

---

## 1. Что строим

`anonka` — постоянно работающая Telegram-система под отдельным пользовательским аккаунтом, которая:

1. работает через MTProto как реальный Telegram user-account;
2. ведет разговоры через один или несколько настраиваемых анонимных chat-каналов;
3. параллельно ведет обычные DM;
4. сохраняет один логический conversation при переходе anon → DM;
5. использует одну фиксированную девушку/персону, но допускает разные behavioral/model profiles для разных каналов;
6. генерирует в runtime в основном текст, а фото/видео/video notes берет из заранее подготовленного Media Vault;
7. поддерживает `DIRECT_SALE` и `PATRON`;
8. проверяет Gifts/Stars только кодом;
9. управляется через отдельного приватного Telegram control-bot;
10. позволяет назначать разные LLM-модели на разные каналы и задачи без изменения Telegram/DB/media-логики.

Система не должна быть general-purpose autonomous agent. Teleton используется как инфраструктурный chassis, а не как готовый decision engine.

---

## 2. База проекта: Teleton Agent

Текущий импортированный baseline: Teleton Agent 0.10.1, TypeScript/Node.js, GramJS/MTProto.

### Из Teleton сохраняем

- MTProto user-account session/auth;
- Telegram bridge;
- получение и отправку DM;
- message queue;
- dedupe;
- typing primitives;
- rate-limit/FloodWait/retry primitives;
- SQLite/WAL foundation;
- media send/download primitives;
- LLM provider adapters/OpenAI-compatible infrastructure;
- usage/latency instrumentation, где оно уже есть;
- low-level Stars/Gifts helpers после проверки реальным Gift fixture.

### Не используем как ядро Anonka

- автономный `AgentRuntime` с циклом `LLM → tool → LLM → tool`;
- универсальный tool registry как способ управлять Telegram;
- произвольные LLM-accessible Telegram tools;
- TON/DEX/DNS/NFT/DeFi/wallet функциональность;
- MCP как обязательную часть runtime;
- coding/general assistant функции;
- глобальную память Teleton для персональных фактов о разных собеседниках;
- WebUI как основной control plane.

### Главная замена

Вместо agent loop:

```text
Telegram Event
→ EventRouter
→ ConversationService
→ ContextBuilder
→ ModelRouter / LLMService
→ ChatDecision
→ DecisionValidator
→ ActionCoordinator
→ Telegram / Media / Offer / Handoff actions
```

LLM принимает смысловые решения. Код выполняет реальные действия.

---

## 3. Главный архитектурный принцип

> **LLM отвечает за язык, смысл, характер и семантические намерения. Код отвечает за состояние, деньги, Telegram actions и проверяемые факты.**

### LLM может

- написать ответ;
- вернуть `no_reply`;
- выделить новые facts о собеседнике;
- сформировать `MediaIntent`;
- сформировать `OfferIntent`;
- предложить мягкий gift ask в `PATRON`;
- предложить handoff anon → DM;
- учитывать подтвержденные кодом события.

### LLM не может

- сама отправлять `next/search/stop/link`;
- считать Gift полученным;
- выбирать конкретный `media_asset_id`;
- помечать Offer как paid;
- выполнять fulfillment;
- менять runtime config;
- переключать модель/канал;
- читать чужие dialogs/contacts;
- выполнять произвольные Telegram tools.

Запрещенные поля/команды в LLM output:

```text
next_room
search_room
stop_room
payment_success
selected_media_id
gift_received
end_conversation
set_model
set_price
```

---

## 4. Telegram topology

Система использует несколько типов Telegram сущностей.

```text
                         OWNER
                           │
                  Telegram Control Bot
                           │
                     AdminCommandBus
                           │
                           ▼
                    ANONKA RUNTIME
                           │
      ┌────────────────────┼────────────────────┐
      │                    │                    │
 User Account/MTProto   Service chats       LLM Providers
      │                    │                    │
      │                    ├─ Media Vault       ├─ local
      │                    └─ Ops Log(optional) ├─ remote A
      │                                         └─ remote B
      │
      ├─ Anonymous bot/channel A
      ├─ Anonymous bot/channel B ...
      └─ Real Telegram DMs
```

### 4.1. User-account

Отдельный Telegram user-account — рабочий транспорт. Через него система:

- общается с anonymous bots;
- отвечает в DM;
- отправляет media;
- получает Gifts/Stars события;
- получает ручные outgoing владельца, если владелец вмешался в конкретный DM.

### 4.2. Control bot

Отдельный обычный Telegram Bot API bot — **единственный основной интерфейс управления**.

Saved Messages больше не является главным admin UI. Его можно оставить как аварийный fallback позже, но архитектура не зависит от него.

### 4.3. Media Vault

Приватный Telegram channel/chat с заранее загруженным контентом и семантическими tags.

### 4.4. Ops Log

Опциональный приватный Telegram channel для append-only технического журнала/важных событий. Он не является source of truth: source of truth — SQLite. Критические alerts также идут владельцу через Control Bot.

---

# ЧАСТЬ A — CHANNELS

## 5. Что такое Channel в Anonka

`Channel` — это **логический рабочий поток/источник трафика**, а не обязательно Telegram broadcast-channel.

Например:

```text
ru_anon_main
tr_anon_test
en_anon_test
```

Каждый Channel имеет собственные настройки:

```text
id
enabled
transport_type = anon
anon_peer_id / anon_bot_username
language
persona_profile_id
behavior_profile_id
model_profile_id
media_pool_id
commercial_mode
offer_price_stars
idle_timeout_seconds
search_watchdog_seconds
max_parallel_rooms
```

На первом этапе `max_parallel_rooms=1` для одного конкретного anonymous bot channel.

### Зачем Channel abstraction

Чтобы без копирования кода можно было:

- подключать другой anonymous bot;
- тестировать другой язык/рынок;
- назначить другой LLM;
- менять коммерческую стратегию;
- менять цену;
- использовать отдельный media pool;
- включать/выключать канал через Telegram control-bot;
- сравнивать метрики по каналам.

---

## 6. ChannelRuntime

Каждый enabled anon Channel имеет свой `ChannelRuntime`:

```text
ChannelRuntime
├── ChannelConfig
├── AnonAdapter
├── AnonController
├── channel lock
├── room_generation
├── watchdog
├── metrics
└── current conversation reference
```

Контроллеры разных Channel не должны делить room state.

Одновременно допускается:

```text
Channel ru_anon_main → room #101
Channel tr_anon_test → room #55
DM peer A
DM peer B
DM peer C
```

при условии, что Telegram transport и конкретные anonymous bots технически позволяют параллельную работу.

---

## 7. Origin channel

Каждая conversation хранит:

```text
origin_channel_id
current_transport = anon | dm
telegram_peer_id NULL until DM
```

После handoff в DM `origin_channel_id` **не меняется**.

Это нужно для:

- аналитики;
- выбора языка/persona/model defaults;
- attribution;
- сравнения conversion по каналам;
- сохранения behavior/model policy после handoff.

Прямой DM без handoff получает `origin_channel_id = direct_dm`.

---

## 8. Anon bot exception в Teleton

Исходный Teleton может игнорировать сообщения от bots через `message.isBot`.

Нужно заменить глобальный запрет на allowlist:

```text
if sender is bot:
    if peer_id in configured_anon_bot_peers:
        route_to_anon_adapter()
    else:
        ignore()
```

Никакой общий режим «принимать всех ботов» не нужен.

---

## 9. Anon state machine

Для каждого Channel отдельно:

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
  │ room_ready OR first_partner_message
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

`ENDED` относится к archived conversation, а не к Channel controller.

---

## 10. AnonAdapter

Конкретную механику каждого anonymous bot инкапсулирует adapter.

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

Интерфейс:

```ts
interface AnonAdapter {
  search(): Promise<void>;
  next(): Promise<void>;
  stop(): Promise<void>;
  requestLink(): Promise<void>;
  reconcile(): Promise<ObservedAnonState>;
}
```

Adapter может использовать текстовые команды, reply keyboard, inline buttons, edited messages или raw MTProto updates.

Перед production для каждого нового anon bot нужен protocol reconnaissance.

---

## 11. Stale generation protection

У каждого Channel монотонный `room_generation`.

Каждый LLM job хранит snapshot:

```text
channel_id
conversation_id
room_generation
conversation_version
```

Перед send:

```text
if snapshot != current state:
    drop result
```

Generation инвалидируется **до** next/stop/confirmed handoff.

---

# ЧАСТЬ B — CONVERSATIONS И HANDOFF

## 12. Conversation = один человек

Conversation привязан к человеку, а не к Telegram transport.

До handoff:

```text
conversation_id=184
origin_channel_id=ru_anon_main
current_transport=anon
telegram_peer_id=NULL
```

После handoff:

```text
conversation_id=184
origin_channel_id=ru_anon_main
current_transport=dm
telegram_peer_id=123456789
```

Сохраняются:

- history;
- facts;
- summary;
- persona/behavior snapshots;
- model profile;
- sent media;
- active Offer;
- commercial mode;
- adult eligibility state;
- attribution к Channel.

---

## 13. Параллельность DM

Разные DM работают параллельно, но каждый conversation последовательно.

На conversation:

```text
history
facts
summary
debounce
lock
version
pending LLM job
active Offer
sent media set
manual override
last activity
```

Контексты разных людей никогда не смешиваются.

---

## 14. Handoff anon → DM

LLM может вернуть только:

```json
{"handoff_intent":"offer"}
```

Код:

```text
requestLink()
→ HANDOFF_PENDING
→ create handoff record
→ wait for reliable DM correlation
```

Порядок matching:

1. token/prefilled marker, если anon flow позволяет;
2. другой уникальный технический признак;
3. temporal correlation только если она однозначна.

Нельзя считать любой новый DM во время pending handoff тем же человеком.

После confirmed handoff:

1. bind `telegram_peer_id`;
2. switch `current_transport=dm`;
3. сохранить ту же conversation;
4. invalidate anon generation;
5. освободить Channel room;
6. Channel начинает следующий search;
7. DM продолжает независимо.

---

## 15. Manual owner intervention

Если владелец пишет вручную с user-account в конкретный DM:

```text
save source=manual
invalidate conflicting AI job
set MANUAL_OVERRIDE
```

Программные outgoing должны коррелироваться с outbox/message id и не активировать manual override.

Control Bot не считается сообщением conversation.

---

# ЧАСТЬ C — MODEL ROUTER И РАЗНЫЕ МОДЕЛИ

## 16. Модели не хардкодятся

Никакого `DeepSeek`/`Qwen`/другого имени модели в conversation core.

Базовый provider contract:

```ts
interface LLMProvider {
  generate(request: LLMRequest): Promise<LLMRawResponse>;
}
```

Провайдеры/endpoint/model задаются конфигом.

Пример:

```text
provider=openai_compatible
base_url=http://127.0.0.1:1234/v1
api_key=...
model=...
```

или remote endpoint с тем же contract.

---

## 17. ModelProfile

`ModelProfile` описывает набор моделей **по задачам**.

```text
model_profile: chat_local

chat:
  provider: local
  model: qwen-...
  temperature: 0.9
  max_output_tokens: 160
  reasoning: off

summary:
  provider: local
  model: qwen-...
  temperature: 0.2
  max_output_tokens: 500

repair:
  provider: local
  model: qwen-...
  temperature: 0.1
  max_output_tokens: 250

fallback_chat:
  provider: remote_optional
  model: ...
```

`chat`, `summary`, `repair` могут указывать как на одну модель, так и на разные.

LATER можно добавить:

```text
vision
stt
translation
```

не меняя conversation core.

---

## 18. Модель на Channel

Каждый Channel имеет `model_profile_id`.

Пример:

```text
ru_anon_main → model_profile=local_fast_ru
tr_anon_test → model_profile=remote_multilingual
```

Conversation при создании получает snapshot default model profile:

```text
conversation.model_profile_id
```

После handoff в DM он сохраняется.

Admin может:

- изменить default модели для новых conversations данного Channel;
- явно переключить конкретную conversation;
- при необходимости применить новый profile ко всем активным conversations осознанной командой.

Никаких неявных смен модели посреди разговора.

---

## 19. ModelRouter

```text
LLM task
→ resolve conversation/channel
→ resolve ModelProfile
→ choose task model
→ capability check
→ provider call
→ normalized result
```

Модель выбирается по:

1. `conversation.model_profile_id`;
2. task (`chat|summary|repair|...`);
3. provider health;
4. capability requirements.

---

## 20. Capability profile провайдера

Для каждого provider/model фиксировать:

```text
supports_json_schema
supports_json_object
supports_reasoning_toggle
supports_usage
supports_cached_tokens
supports_streaming
```

Structured output strategy:

```text
native JSON Schema
→ JSON object mode
→ plain text JSON + validation
→ one repair
→ safe text-only fallback
```

Если output невалиден, никакие media/payment/system actions не выполняются.

---

## 21. Fallback policy

Fallback разрешен только при технической проблеме:

- timeout;
- transient provider 5xx;
- connection error;
- rate limit;
- недоступность локального сервера.

Fallback **не используется для обхода safety refusal/политик провайдера**.

Все fallback events логируются.

---

## 22. Generation defaults

Для обычного Telegram/RP диалога baseline:

```text
temperature ≈ 0.9
thinking/reasoning = off
короткий output
```

Точные значения принадлежат ModelProfile, а не hardcoded core.

Логировать на каждый LLM call:

```text
provider
model
model_profile_id
task
channel_id
conversation_id
prompt_version
persona_version
behavior_policy_version
temperature
latency_ms
input_tokens
output_tokens
cached_tokens if available
fallback_used
```

---

# ЧАСТЬ D — CONTEXT, PERSONA, MEMORY

## 23. Одна фиксированная персона

Персона отделена от модели.

```text
Persona != ModelProfile != BehaviorProfile
```

Persona содержит:

- постоянное имя/возраст/биографию;
- характер;
- Telegram texting style;
- типичную длину сообщений;
- сленг/мат/эмодзи;
- инициативность;
- few-shot examples;
- запрет assistant-style канцелярита.

Разные Channel могут использовать разные localization/behavior overlays, не создавая новую девушку.

---

## 24. Prompt assembly

Порядок:

```text
1. SYSTEM CORE
2. PERSONA
3. CHANNEL POLICY / LANGUAGE
4. BEHAVIOR PROFILE
5. FEW-SHOT EXAMPLES
6. RUNTIME CONTEXT
7. KNOWN FACTS ABOUT USER
8. ROLLING SUMMARY
9. RECENT MESSAGES
10. CURRENT BATCH
```

Стабильные блоки первыми для prefix caching.

---

## 25. ChatDecision

Нормализованный output:

```ts
type ChatDecision = {
  response_mode: "reply" | "no_reply";
  text?: string;
  learned_facts: FactUpdate[];
  media_intent?: MediaIntent;
  offer_intent?: MediaIntent;
  soft_gift_ask: boolean;
  handoff_intent: "none" | "offer";
};
```

Fact extraction делается в основном chat call, а не отдельным запросом на каждое сообщение.

---

## 26. Память

Три уровня:

### Global persona memory

Только постоянные факты персонажа/политики. Не содержит персональные данные собеседников.

### Per-conversation facts

```text
name
age
gender
city
work
interests
preferences
important events
```

### Rolling summary + recent messages

Не отправлять всю историю с начала.

Baseline:

```text
anon recent: ~20–30 messages
dm recent:   ~30–50 messages
summary when unsummarized >= 40 or context soft limit reached
```

Персональные facts никогда не хранятся в глобальной Teleton memory.

---

## 27. Debounce и concurrency

```text
incoming
→ persist
→ per-conversation debounce ~1.8s after last message
→ build one batch
→ one chat call
```

MUST:

- per-conversation lock;
- per-Channel controller lock;
- global LLM semaphore;
- stale conversation version guard;
- bounded retries;
- graceful cancellation.

---

# ЧАСТЬ E — TELEGRAM CONTROL BOT

## 28. Control Bot — отдельный control plane

Управление идет через отдельного Bot API бота.

Требования:

```text
CONTROL_BOT_TOKEN
OWNER_TELEGRAM_ID
```

Принимать команды только если:

```text
chat is private
AND from_user.id == OWNER_TELEGRAM_ID
```

Все остальные users получают отказ/игнор.

Bot не ведет пользовательские conversations и не участвует в persona dialogue.

---

## 29. Control Bot UI

Основной UX — команды + inline keyboards.

Главный экран `/status` показывает:

```text
runtime up/down
Telegram user session status
enabled Channels
state каждого Channel
active anon rooms
active DMs
LLM provider health
model profile каждого Channel
queue depth
waiting/paid/blocked Offers
last Gift
last critical error
```

---

## 30. Команды Control Bot

Минимальный набор:

```text
/status

/channels
/channel <id>
/channel_start <id>
/channel_stop <id>
/channel_next <id>

/models
/model <channel_id> <model_profile_id>
/conversation_model <conversation_id> <model_profile_id>

/mode <channel_id> direct|patron
/price <channel_id> <stars>
/offers <channel_id> on|off
/media <channel_id> on|off

/dm_pause <conversation_id>
/dm_resume <conversation_id>

/media_reindex
/reload_prompts

/errors
/logs
/panic
```

Inline buttons должны покрывать частые операции без ручного ввода id.

---

## 31. Семантика admin operations

### `channel_stop`

- прекращает новый search только данного Channel;
- активные DM продолжаются;
- другие Channel не затрагиваются.

### `channel_next`

- сначала invalidate `room_generation`;
- затем controlled skip;
- не затрагивает DM.

### `model`

- меняет default `model_profile_id` для **новых** conversations Channel;
- активные conversations не переключаются автоматически.

### `conversation_model`

- явный override одной conversation;
- invalidate pending LLM job;
- следующий turn использует новый profile.

### `price`

- влияет только на новые Offers;
- существующий Offer хранит snapshot цены.

### `offers off`

- запрещает новые Offers;
- уже PAID fulfillment выполняется всегда.

### `media off`

- запрещает новые обычные media sends;
- не блокирует уже оплаченный fulfillment.

### `panic`

Аварийный режим:

```text
disable all anon search
disable new AI replies
disable new offers/media intents
keep persistence/recovery/admin bot alive
never undo already-confirmed payment state
```

Выход из panic — только явной admin command.

---

## 32. AdminCommandBus

Control Bot не изменяет состояние напрямую.

```text
Bot Update
→ AdminAuth
→ AdminCommandParser
→ AdminCommandBus
→ domain service
→ SQLite transaction
→ result
→ Bot response
```

Это гарантирует, что те же операции можно потом вызывать из CLI/WebUI без дублирования business logic.

Каждая admin mutation пишет `admin_audit_events`.

---

## 33. Alerts через Control Bot

Владелец получает push-события:

```text
channel watchdog failed
Telegram session disconnected
LLM provider unavailable/fallback activated
repeated generation failures
Gift received
Offer paid
fulfillment blocked
Media Vault asset missing
DB/recovery error
adult eligibility violation blocked
```

Нельзя спамить каждым обычным сообщением/LLM call.

Alert service должен иметь dedupe/rate limit.

---

# ЧАСТЬ F — MEDIA VAULT

## 34. Media Vault

Canonical binary storage — private Telegram channel/chat.

SQLite хранит индекс:

```text
source_chat_id
source_message_id
media_type
access_class
tags
pool_id
series
description
enabled
missing
use_count
```

Перед send source message refetch заново.

---

## 35. Media pools

Чтобы Channel могли использовать разные наборы контента, asset имеет `pool_id`.

Пример:

```text
pool=default
pool=ru_main
pool=tr_test
```

Один физический Media Vault может содержать несколько pools.

Не обязательно заводить отдельный Telegram channel на каждый pool.

---

## 36. Семантическая разметка

Пример caption:

```text
#anonka_media
pool=default
type=photo
access=teaser
content=selfie,cleavage
view=front
outfit=shirt
scene=home
series=home_02
```

MUST:

```text
pool
type=photo|video|video_note
access=casual|teaser|paid
content=<tags>
```

LLM никогда не получает полный каталог и не выбирает exact asset id.

---

## 37. MediaSelector

```text
MediaIntent
→ filter enabled
→ filter pool
→ filter access
→ filter transport capability
→ filter required tags
→ exclude already sent
→ score
→ random top-N
→ selected asset
```

Если нет семантически подходящего media — `MEDIA_NOT_AVAILABLE`, без нерелевантной подмены.

---

# ЧАСТЬ G — DIRECT_SALE, PATRON, GIFTS

## 38. Commercial mode

Behavior mode принадлежит Channel default и snapshot conversation:

```text
DIRECT_SALE
PATRON
```

### DIRECT_SALE

```text
OfferIntent
→ MediaSelector reserve exact compatible unsent asset
→ snapshot Channel price
→ Offer WAITING
→ verified Gift from bound DM peer
→ PAID
→ code-side fulfillment
```

### PATRON

Gift считается support event. LLM может мягко просить/реагировать, но Gift не превращается автоматически в покупку конкретного asset без отдельного Offer.

---

## 39. GiftDetector

Нужен реальный MTProto fixture до финальной реализации.

Сохранять максимально надежно:

```text
stable Telegram event key
sender_peer_id
gift ref/id
gift stars/value
received_at
raw event snapshot for debugging
```

Если sender/value нельзя определить надежно — автоматическая оплата не подтверждается.

---

## 40. Gift matching

```text
Offer.status == waiting
AND conversation.telegram_peer_id == gift.sender_peer_id
AND gift.value >= offer.required_stars
AND gift not already consumed
→ PAID
```

Один Gift не оплачивает два Offers.

Duplicate event не выполняет fulfillment повторно.

---

## 41. Adult eligibility gate

Любой explicit/paid adult flow проходит через hard code-side gate.

```text
adult_status = unknown | verified | blocked
```

До `verified` код запрещает:

- explicit paid asset selection;
- explicit DIRECT_SALE fulfillment;
- adult-only media send.

LLM не может сама выставить `verified`.

Механизм проверки eligibility реализуется отдельно, но gate должен существовать в доменной модели с первого этапа.

---

# ЧАСТЬ H — PERSISTENCE

## 42. SQLite source of truth

```sql
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
PRAGMA busy_timeout=5000;
```

Основные таблицы:

```text
channels
model_profiles
conversations
messages
conversation_facts
conversation_summaries
handoffs
media_assets
conversation_media
offers
gifts
runtime_config
admin_audit_events
domain_events
outbox
```

---

## 43. `channels`

```text
id TEXT PK
enabled BOOL
transport_type TEXT
anon_peer_id TEXT NULL
language TEXT
persona_profile_id TEXT
behavior_profile_id TEXT
model_profile_id TEXT
media_pool_id TEXT
commercial_mode TEXT
offer_price_stars INTEGER
idle_timeout_seconds INTEGER
search_watchdog_seconds INTEGER
created_at
updated_at
```

---

## 44. `model_profiles`

```text
id TEXT PK
config_json TEXT
created_at
updated_at
```

`config_json` содержит task → provider/model/settings mappings.

Секретные API keys не хранятся в SQLite; только secret references/env.

---

## 45. `conversations`

```text
id INTEGER PK
origin_channel_id TEXT
current_transport anon|dm
state active|handoff_pending|ended
telegram_peer_id INTEGER NULL
anon_generation INTEGER NULL
persona_profile_id TEXT
behavior_profile_id TEXT
model_profile_id TEXT
commercial_mode direct|patron
adult_status unknown|verified|blocked
last_activity_at
manual_override_until NULL
created_at
updated_at
ended_at NULL
end_reason NULL
```

Не более одной active DM conversation на Telegram peer.

---

## 46. Outbox и recovery

Все важные side effects выполняются через durable outbox:

```text
DB transaction
→ state change + outbox action
→ worker executes Telegram send
→ mark delivered
```

Особенно:

- paid media fulfillment;
- handoff command;
- admin-critical notifications.

После crash система поднимает:

```text
pending incoming messages
pending outbox
paid but unfulfilled Offers
channel states needing reconcile
```

---

# ЧАСТЬ I — OBSERVABILITY

## 47. Domain events

Минимум:

```text
conversation_created
anon_room_started
anon_room_ended
handoff_offered
handoff_confirmed
llm_call
llm_fallback
media_sent
offer_created
gift_received
offer_paid
offer_fulfilled
fulfillment_blocked
admin_command
error
```

Каждый event включает `channel_id` и `conversation_id`, где применимо.

---

## 48. Метрики по Channel/Model

Считать:

```text
rooms started
messages received/sent
handoff rate
DM continuation rate
Gift count/value
Offer conversion
media sends
LLM latency
LLM error rate
fallback rate
input/output tokens
estimated cost
conversation duration
```

Это позволяет A/B сравнивать модели и Channel без изменения core.

---

# ЧАСТЬ J — ЧТО НЕ СТРОИМ СЕЙЧАС

## 49. Не нужно для MVP

- микросервисы;
- Postgres;
- Redis;
- Kubernetes;
- Celery/RQ;
- vector DB для обычного диалога;
- runtime image/video generation;
- несколько визуально разных девушек;
- marketplace;
- autonomous agent tool loop;
- MCP как обязательная часть;
- WebUI как primary admin;
- сложная relationship simulation;
- автоматическое vision tagging всего Vault.

Базовый target:

```text
1 Node.js/TypeScript process
+ Teleton/GramJS Telegram user session
+ separate Telegram Control Bot
+ SQLite/WAL
+ ModelRouter
+ one or more configurable Channels
+ Media Vault
```

---

# ЧАСТЬ K — TARGET MODULE BOUNDARIES

## 50. Целевая схема модулей

Названия могут меняться, границы ответственности — нет.

```text
src/
├── infrastructure/
│   ├── telegram/
│   │   ├── user-session/
│   │   ├── dm-adapter/
│   │   ├── anon-adapters/
│   │   ├── media-sender/
│   │   └── gift-detector/
│   ├── control-bot/
│   ├── llm-providers/
│   └── sqlite/
│
├── domain/
│   ├── channels/
│   ├── conversations/
│   ├── handoff/
│   ├── media/
│   ├── commerce/
│   └── admin/
│
├── application/
│   ├── event-router/
│   ├── context-builder/
│   ├── model-router/
│   ├── llm-service/
│   ├── decision-validator/
│   ├── action-coordinator/
│   ├── recovery/
│   └── analytics/
│
└── prompts/
    ├── system/
    ├── persona/
    ├── behavior/
    ├── channel/
    └── examples/
```

Teleton existing modules можно временно использовать напрямую и постепенно оборачивать adapters. Не требуется сначала физически разнести весь проект по этим папкам.

---

# ЧАСТЬ L — MIGRATION FROM TELETON

## 51. Порядок миграции

### Phase 0 — transport spike

До большого удаления кода подтвердить:

1. dedicated user-account стабильно получает/отправляет обычный DM;
2. configured anonymous bot проходит patched bot filter;
3. видны нужные NewMessage/MessageEdited/buttons/raw events;
4. photo/video/video_note реально отправляются;
5. реальный Gift дает sender/value/stable event key, достаточные для matching.

### Phase 1 — isolate infrastructure

- зафиксировать Telegram bridge/session/queue primitives;
- отключить autonomous AgentRuntime из production path;
- отключить LLM-accessible Telegram tools;
- отключить TON/MCP/general-agent initialization;
- оставить provider adapters и SQLite primitives.

### Phase 2 — Channels + Control Bot

- таблица/config `channels`;
- `ChannelManager`;
- per-channel `AnonController`;
- отдельный private Control Bot;
- `/status`, start/stop/next;
- admin audit.

### Phase 3 — ModelRouter + ChatDecision

- ModelProfile;
- per-channel model assignment;
- structured ChatDecision;
- validation/repair/text-only fallback;
- logging provider/model usage.

### Phase 4 — conversations/memory/handoff

- per-conversation facts;
- rolling summary;
- anon→DM continuity;
- direct DM;
- manual override;
- stale guards.

### Phase 5 — Media Vault + commerce

- MediaIndexer;
- MediaSelector;
- Gifts;
- DIRECT_SALE;
- PATRON;
- adult eligibility gate;
- durable fulfillment.

### Phase 6 — cleanup

После доказанного нового runtime удалить реально неиспользуемые:

- TON/DEX/DNS/wallet code;
- generic agent tools;
- MCP runtime;
- WebUI/marketplace, если не нужен;
- глобальную user-memory логику, конфликтующую с conversation isolation.

Не удалять инфраструктуру до того, как новый path покрыт tests/spike.

---

## 52. Definition of Done архитектурного перехода

Переход на новую архитектуру считается завершенным, когда:

1. production path не использует autonomous AgentRuntime;
2. anonymous bot allowlist работает;
3. каждый Channel имеет независимый controller/state;
4. разные Channel реально могут иметь разные ModelProfiles;
5. Control Bot полностью управляет channels/models/modes/prices;
6. DM contexts изолированы;
7. anon→DM сохраняет conversation;
8. LLM выдает только ChatDecision;
9. Telegram/system/payment actions выполняет ActionCoordinator/code-side services;
10. Media Vault выбирается семантически кодом;
11. Gift matching идемпотентен;
12. adult eligibility gate нельзя обойти через prompt;
13. crash recovery не теряет paid fulfillment;
14. SQLite остается source of truth;
15. метрики позволяют сравнивать Channel и ModelProfile.

---

## 53. Короткая итоговая схема

```text
                         TELEGRAM CONTROL BOT
                                  │
                           AdminCommandBus
                                  │
                                  ▼
┌──────────────────────────── ANONKA CORE ────────────────────────────┐
│                                                                    │
│ ChannelManager                                                     │
│   ├─ Channel A → AnonController A ─┐                               │
│   └─ Channel B → AnonController B ─┼─→ ConversationService         │
│                                    │          │                    │
│ Real DMs ──────────────────────────┘          ▼                    │
│                                         ContextBuilder             │
│                                              │                     │
│                                  conversation.model_profile        │
│                                              ▼                     │
│                                          ModelRouter               │
│                                              │                     │
│                                   local / remote providers         │
│                                              │                     │
│                                              ▼                     │
│                                         ChatDecision               │
│                                              │                     │
│                                      DecisionValidator             │
│                                              │                     │
│                                      ActionCoordinator             │
│                                    ┌─────────┼─────────┐           │
│                                    ▼         ▼         ▼           │
│                                 Telegram   Media    Commerce        │
│                                    │       Vault      Gifts         │
│                                    └─────────┬─────────┘           │
│                                              ▼                     │
│                                         SQLite/WAL                 │
└────────────────────────────────────────────────────────────────────┘
```

Это и есть целевая архитектура Anonka. Все последующие изменения кода должны проверяться против нее.