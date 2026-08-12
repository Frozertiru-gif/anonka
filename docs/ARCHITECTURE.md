# Anonka — полная целевая архитектура

> Статус: каноническая архитектурная спецификация проекта.  
> Репозиторий: `Frozertiru-gif/anonka`  
> Назначение: зафиксировать согласованную архитектуру до большого рефакторинга и дать Codex/разработчику документ, по которому систему можно реализовывать по этапам без повторного придумывания решений.

---

## 1. Что строим

`anonka` — постоянно работающий Python-процесс под **отдельным пользовательским Telegram-аккаунтом** через Telethon.

Аккаунт предназначен именно для этого эксперимента, поэтому система может обслуживать обычные входящие DM этого аккаунта, а не только пользователей, которые гарантированно пришли через handoff из анончата. Если кому-то переслали/дали ссылку на аккаунт и он написал напрямую, для него просто создается новая независимая DM-conversation.

Система одновременно должна:

1. Вести один текущий разговор через существующего Telegram-бота анонимного чата.
2. Параллельно вести любое разумное количество обычных личных переписок Telegram.
3. Самостоятельно управлять анончатом: search / room / next / stop / link / timeout / reconciliation.
4. Не смешивать контекст разных людей.
5. При anon → DM сохранять тот же логический conversation и весь его полезный контекст.
6. После успешного перехода человека в DM сразу освобождать анончат и искать следующего, при этом старый DM продолжает жить отдельно.
7. Работать через сменный LLM-provider: DeepSeek по умолчанию, локальная OpenAI-compatible модель — без переделки Telegram/DB/media-логики.
8. Генерировать в runtime только текст. Фото, видео и Telegram video notes/«кружки» готовятся заранее и хранятся в Media Vault.
9. Понимать, **что именно находится на каждом медиа**, через ручную семантическую разметку.
10. Поддерживать два режима коммерческого поведения: жесткий фиксированный обмен `DIRECT_SALE` и мягкий режим подарков/«папика» `PATRON`.

В проекте используется **одна фиксированная девушка/персонаж**. Не нужны `persona_id`, выбор девушек, паки разных персонажей, marketplace или multi-persona framework.

---

## 2. Поведение персонажа и раскрытие AI-природы

Персонаж должен вести полноценный обычный диалог в женском образе: иметь постоянное имя, возраст, характер, манеру речи, биографические детали и последовательное поведение.

### В анончате

По умолчанию **нет обязательного раннего disclosure, что это AI**. В anonymous transport персонаж сначала ведет обычный живой диалог, знакомится, интересует собеседника, узнает факты и при необходимости переводит разговор в DM.

Не создавать технических полей вроде:

```text
disclosure_sent_at
is_disclosed
must_disclose_after_n_messages
```

и не делать жесткий code-side таймер раскрытия.

### В DM

Раскрытие AI-природы — часть **поведенческой стратегии/промпта**, а не state machine приложения. Базовая идея: раскрывать это уже после перехода в личку и после нормального знакомства, но точное время/манеру можно менять в экспериментах.

То есть:

```text
anon: обычный диалог без обязательного AI-disclosure
↓
handoff
↓
dm: disclosure может произойти естественно позже
```

Если стратегия меняется, меняется prompt/runtime behavior policy. Отдельной жесткой доменной сущности для disclosure не требуется. Если раскрытие уже произошло, это и так видно из обычной истории сообщений.

---

## 3. Главный архитектурный принцип

> **LLM отвечает за язык, смысл, характер и семантические намерения. Код отвечает за состояние системы и все проверяемые действия.**

### LLM делает

- пишет обычные реплики;
- может решить `no_reply`;
- извлекает новые факты о собеседнике из того же основного response call;
- формирует `MediaIntent` — какой контент требуется;
- формирует `OfferIntent` для режима фиксированной продажи;
- может выразить soft gift request для режима `PATRON`;
- может предложить handoff в DM;
- учитывает подтвержденные кодом события: реально отправленное медиа, реально полученный Gift, состоявшийся handoff, выполненный Offer.

### Код делает

- search / next / stop / link;
- определение room state;
- таймер 10 минут;
- SEARCHING watchdog;
- обработку service events анон-бота;
- переключение state machine;
- cancellation/stale guards;
- SQLite persistence;
- выбор конкретного media asset;
- проверку Gift;
- Offer status;
- fulfillment;
- retry/FloodWait/backoff;
- idempotency;
- recovery после crash;
- admin commands;
- runtime mode/price;
- аналитические события.

LLM **не должна** возвращать команды `next_room`, `payment_success`, `selected_media_id`, `search_room`, `end_conversation` и т.п.

---

## 4. Что НЕ строим сейчас

Для первой рабочей версии не нужны:

- несколько девушек;
- runtime image/video generation;
- Telegram Business Bot без доказанной необходимости;
- Postgres;
- Redis;
- Celery/RQ;
- микросервисы;
- Kubernetes;
- vector DB/RAG для обычного диалога;
- автоматическое vision-тегирование Vault;
- web-admin;
- distributed workers;
- сложная числовая симуляция отношений как обязательный блок.

База:

```text
1 Python process
+ Telethon
+ asyncio
+ SQLite/WAL
+ provider-agnostic LLM
+ private Telegram Media Vault
```

---

## 5. Текущее состояние репозитория и направление рефакторинга

Существующий проект использовать как каркас, а не переписывать с нуля.

Сейчас основные проблемы:

- `handlers.py` сразу вызывает ReplyService;
- фильтр заточен под один username;
- history RAM-only;
- после restart контекст теряется;
- Grok/xAI naming зашит в LLM layer;
- client синхронный;
- LLM участвует в `action=end`;
- короткие `ок/пон` могут завершать разговор;
- фиксированный delay добавляется поверх latency;
- нет независимых DM contexts;
- нет полноценного anon controller;
- нет persistence/handoff/media/gifts/outbox/recovery.

Сохраняем Python, Telethon, asyncio, composition root и идею разбиения по модулям. Меняем ответственность.

---

## 6. Верхнеуровневая схема

```text
                        TELEGRAM USER ACCOUNT
                                 │
                           Telethon Client
                                 │
         ┌───────────────────────┼────────────────────────┐
         │                       │                        │
      ANON BOT                 REAL DMs               MEDIA VAULT
         │                       │                        │
    AnonAdapter              DMAdapter              MediaIndexer
         │                       │                        │
         └──────────────┬────────┘                        │
                        ▼                                 │
                   EventRouter                            │
                        │                                 │
            ┌───────────┼──────────────┐                  │
            │           │              │                  │
      AnonController ConversationSvc GiftDetector         │
            │           │              │                  │
            │       Debounce/Locks      │                  │
            │           │              │                  │
            │      ContextBuilder       │                  │
            │           │              │                  │
            │       LLMService          │                  │
            │           │              │                  │
            │      ChatDecision         │                  │
            │           │              │                  │
            │    ActionCoordinator      │                  │
            │      │     │      │       │                  │
            │     text  media  offer  handoff              │
            │            │      │                          │
            │            ▼      ▼                          │
            │       MediaSelector / OfferService           │
            │            │      │                          │
            └────────────┴──────┴──────────────────────────┘
                                 │
                            SQLite / WAL
```

---

# ЧАСТЬ A — TELEGRAM И ANON CONTROLLER

## 7. Telegram topology

Один отдельный user-account взаимодействует с:

1. anonymous bot chat;
2. обычными DM;
3. private Media Vault;
4. Saved Messages для admin/runtime control.

Поскольку аккаунт отдельный, **новый обычный DM без handoff тоже обслуживается**: создается новая DM-conversation с пустыми facts и своей памятью.

Исключения маршрутизации: self/Saved Messages, Vault, системные/служебные чаты, сам anon-bot transport.

---

## 8. Что известно о новом анонимном собеседнике

При старте комнаты нет анкеты и исходных данных:

```text
facts = {}
```

Имя, возраст, пол, город, работа, интересы и т.п. выясняются только из переписки.

Не проектировать архитектуру так, будто anon-bot отдает профиль.

---

## 9. Anon state machine

Минимум:

```text
STOPPED
SEARCHING
ROOM_ACTIVE
HANDOFF_PENDING
SKIPPING
```

Переходы:

```text
STOPPED
  │ start
  ▼
SEARCHING
  │ room_ready OR first_partner_message
  ▼
ROOM_ACTIVE
  │
  ├── idle_timeout(10m) ───────► SKIPPING ─► SEARCHING
  ├── partner_left/skipped ─────► SEARCHING
  ├── manual_next ──────────────► SKIPPING ─► SEARCHING
  ├── handoff_intent ───────────► HANDOFF_PENDING
  │                                 │
  │                                 ├── dm_confirmed ─► SEARCHING
  │                                 ├── partner_left ─► SEARCHING
  │                                 └── idle_timeout ─► SKIPPING ─► SEARCHING
  └── manual_stop ──────────────► STOPPED
```

`ENDED` — состояние конкретной archived conversation, а не глобального controller.

---

## 10. Определение ROOM_READY

`AnonAdapter` должен инкапсулировать конкретную механику выбранного anonymous bot.

Поддержать два режима.

### A. Есть надежный технический сигнал

Например:

- системное сообщение;
- edit сообщения;
- изменение reply/inline keyboard;
- raw update;
- другой наблюдаемый признак.

Тогда:

```text
SEARCHING
→ ROOM_READY
→ create conversation
→ ROOM_ACTIVE
→ optional opener through LLM
```

### B. Надежного сигнала нет

```text
SEARCHING
→ first real partner message
→ create conversation
→ ROOM_ACTIVE
→ debounce
→ LLM
```

До реализации нужен короткий protocol reconnaissance конкретного бота: несколько циклов search/room/skip/link с логированием NewMessage, MessageEdited, markup и raw update types.

---

## 11. Нормализованные Anon events

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

`AnonController` не разбирает текст конкретного бота сам.

---

## 12. Команды anonymous bot

Boot config:

```text
ANON_SEARCH_COMMAND
ANON_NEXT_COMMAND
ANON_STOP_COMMAND
ANON_LINK_COMMAND
```

Интерфейс:

```python
await anon_adapter.search()
await anon_adapter.next()
await anon_adapter.stop()
await anon_adapter.request_link()
```

Внутри это может быть текстовая команда или click по кнопке.

---

## 13. Reconciliation фактического состояния

Фактическое состояние Telegram/anon-bot имеет приоритет над локальным предположением.

Примеры:

- владелец сам нажал Next;
- бот сам начал новый search;
- кнопки поменялись;
- сообщение было edited;
- команда ушла, но ответ задержался.

Нужно слушать нужные `NewMessage`/`MessageEdited`/raw updates и выполнять:

```python
anon_controller.reconcile(observed_state)
```

Идемпотентно.

Нельзя считать, что отправленный `/next` автоматически означает подтвержденный `SEARCHING`.

---

## 14. SEARCHING watchdog

Нужен отдельный watchdog, потому что room idle timeout не покрывает зависший search.

```text
ANON_SEARCH_WATCHDOG_SECONDS=90
```

Flow:

```text
SEARCHING
→ watchdog elapsed
→ reconcile_state()
→ реально search идет: wait/backoff
→ search остановлен: retry search
→ unknown: bounded retry + log/alert
```

Никакого бесконечного спама командами.

---

## 15. 10-минутный idle timeout

```text
ANON_IDLE_TIMEOUT_SECONDS=600
```

Это 10 минут **с последней значимой активности**, а не с момента знакомства.

Обновляют `last_activity_at`:

- partner message;
- успешно отправленный AI reply;
- ручное сообщение владельца.

Не обновляют служебные Telegram events.

При timeout:

```text
invalidate generation
→ SKIPPING
→ next()
→ close conversation(reason=idle_timeout)
→ SEARCHING
```

Без LLM.

---

## 16. Stale generation protection

Каждая anon room имеет монотонный `room_generation`.

```text
A generation=41
B generation=42
```

Каждый LLM job сохраняет snapshot.

Перед send:

```python
if job.room_generation != current_generation:
    drop_response()
```

Generation инвалидируется **до** next/stop/handoff-confirmed.

Даже если async task удалось cancel, guard все равно обязателен.

---

## 17. Capability matrix транспорта

Не путать возможности anon и DM.

### Anonymous transport

MUST:

```text
text        supported
video_note  supported
search      supported
next        supported
stop        supported
link        supported
```

Поддержку `photo`/обычного `video` определить в protocol reconnaissance и хранить как capability, а не предполагать.

Кружки **должны быть доступны в анончате** через AnonAdapter/MediaSender; не ограничивать video notes только DM.

### DM transport

```text
text        supported
photo       supported
video       supported
video_note  supported
Gift events supported через MTProto/Telethon adapter
```

MediaSender сначала смотрит capability текущего transport, затем отправляет.

---

# ЧАСТЬ B — CONVERSATIONS, DM И HANDOFF

## 18. Conversation = один человек

Logical conversation привязан к человеку, а не к transport.

До handoff:

```text
conversation #184
channel=anon
telegram_peer_id=NULL
```

После подтвержденного handoff:

```text
conversation #184
channel=dm
telegram_peer_id=123456789
```

История, facts, summary, behavior mode, sent media и active offer сохраняются.

Следующий anon человек получает новый conversation.

---

## 19. Прямой новый DM без handoff

Поскольку аккаунт отдельный, любой новый нормальный DM может быть самостоятельным знакомством.

Если пришел новый peer и он **не был надежно сопоставлен** с pending handoff:

```text
create Conversation(channel=dm, facts={})
```

и начать обычный DM pipeline.

Не игнорировать такой DM и не требовать ручного включения.

---

## 20. Transport snapshot сообщений

Каждое сообщение хранит:

```text
transport=anon|dm
```

чтобы после handoff история не теряла происхождение.

---

## 21. Параллельность

Одновременно:

```text
Anon #205 active
DM #184 active
DM #173 active
DM #151 active
...
```

У каждой conversation свои:

- history;
- facts;
- summary;
- behavior_mode;
- debounce;
- lock;
- pending LLM version;
- active offer;
- sent media set;
- last activity;
- manual override.

Контексты никогда не смешиваются.

---

## 22. Handoff anon → DM

LLM может вернуть:

```json
{"handoff_intent":"offer"}
```

Код:

```text
request_link()
→ HANDOFF_PENDING
→ handoff record
→ продолжать текущий anon разговор
```

### Matching нового DM

Порядок надежности:

1. token/prefilled text, если конкретный flow технически позволяет;
2. другой уникальный признак;
3. temporal correlation только когда она действительно однозначна.

Так как ссылку на аккаунт могут переслать другу, **не надо слепо считать любой новый DM во время HANDOFF_PENDING тем же человеком**.

Если сопоставление неоднозначно:

- pending handoff остается `ambiguous/pending`;
- новый DM получает собственную новую conversation;
- никакого автоматического смешивания памяти.

Если correlation подтверждена — bind существующую anon conversation к peer.

---

## 23. После подтвержденного handoff

Код автоматически:

1. bind `telegram_peer_id`;
2. `channel=dm`;
3. сохраняет тот же context/facts/summary/media/offers;
4. invalidate anon generation;
5. освобождает anon transport;
6. запускает поиск следующего человека;
7. DM продолжает независимо.

LLM не командует «ищи нового» — это code-side transition.

---

## 24. Offer, созданный еще в анонке

Фиксированный Offer **можно сформировать до перехода в DM**, если разговор к этому пришел.

Тогда:

```text
anon OfferIntent
→ reserve asset
→ snapshot price
→ create waiting Offer without peer payment binding
→ initiate /link if needed
→ handoff
→ bind same Offer to DM conversation peer
→ ждать Gift уже от известного peer
```

В анонке Gift нельзя надежно связать с неизвестным Telegram peer, поэтому payment confirmation выполняется после того, как conversation получила реальный `telegram_peer_id`.

---

## 25. Handoff timeout

Если человек не пришел в DM, idle timeout продолжает действовать.

```text
handoff expired
→ close/skip
→ SEARCHING
```

Если он продолжает писать в анонке — `last_activity_at` обновляется и разговор продолжается.

---

## 26. Ручные сообщения владельца и MANUAL_OVERRIDE

EventRouter обрабатывает релевантные outgoing messages user-account.

Если владелец написал вручную:

1. найти conversation;
2. сохранить `role=assistant, source=manual`;
3. update last_activity;
4. invalidate conflicting AI job;
5. включить per-conversation cooldown.

```text
MANUAL_OVERRIDE_SECONDS=60
```

В этот период incoming сохраняются, но AI не отправляет параллельный ответ. Потом auto-resume или `.dm resume`.

### Не перепутать программный send с ручным

Сообщение из нашего outbox не должно возвращаться как outgoing event и ошибочно активировать MANUAL_OVERRIDE.

Нужна корреляция:

```text
outbox action
→ telegram_message_id / local pending-send registry
→ outgoing event recognized as source=llm/system
```

Только неизвестный собственный outgoing считается `source=manual`.

---

# ЧАСТЬ C — MESSAGE PIPELINE И LLM

## 27. Debounce

```text
incoming
→ pending batch
→ 1.8s after LAST message
→ combine
→ one LLM call
```

```text
MESSAGE_DEBOUNCE_MS=1800
```

Per-conversation последовательно; разные conversations параллельно.

---

## 28. `no_reply`

```python
response_mode: "reply" | "no_reply"
```

`no_reply`:

- не закрывает conversation;
- не мешает сохранению facts;
- не используется для service events;
- не означает жесткое code-rule «на ага всегда молчать».

---

## 29. Incoming media policy

MVP не обязан иметь STT/vision.

### Voice / audio message

Если приходит голосовое, а STT не подключен:

- сохранить metadata/kind в messages/events;
- **не отправлять аудио в LLM как будто оно текст**;
- кодом отправить короткий настраиваемый fallback, например:

```text
я гс не могу послушать, напиши текстом)
```

`VOICE_FALLBACK_TEXT` хранить в config/prompt assets и можно менять без изменения pipeline.

### Фото/стикер/GIF от пользователя без vision

- handler не падает;
- сохранить факт получения;
- либо `no_reply`, либо короткий configured fallback;
- vision можно добавить LATER отдельным adapter, не меняя core conversation architecture.

---

## 30. MessageEdited

Если partner редактирует текст до ответа:

- обновить/версионировать соответствующее message в SQLite;
- stale текущий debounce/job;
- следующий ContextBuilder использует актуальную версию.

Для уже отправленного AI reply history не переписывается задним числом; edit просто фиксируется как событие.

---

## 31. Provider-agnostic LLM

```python
class LLMProvider(Protocol):
    async def generate(
        self,
        messages: list[LLMMessage],
        settings: GenerationSettings,
    ) -> LLMRawResponse:
        ...
```

Первая реализация:

```text
OpenAICompatibleProvider
```

DeepSeek:

```dotenv
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-v4-flash
LLM_THINKING=disabled
```

Локальная модель:

```dotenv
LLM_BASE_URL=http://127.0.0.1:1234/v1
LLM_MODEL=<local-model>
```

Telegram/DB/media/gift/controller не меняются.

Optional later:

```text
primary=local
fallback=deepseek
```

Fallback отключаемый.

---

## 32. DeepSeek default policy

Для обычных turn:

```text
DeepSeek V4 Flash
thinking OFF
short max output
```

Escalation/reasoning — только LATER, если метрики покажут пользу.

---

## 33. Нормализованный ChatDecision

```python
class FactUpdate(BaseModel):
    key: str
    value: str | int | float | bool
    confidence: float = 1.0

class MediaIntent(BaseModel):
    media_type: Literal["photo", "video_note", "video", "any"] = "any"
    access: Literal["casual", "teaser", "paid", "any"] = "any"
    content: list[str] = []
    view: list[str] = []
    outfit: list[str] = []
    scene: list[str] = []

class ChatDecision(BaseModel):
    response_mode: Literal["reply", "no_reply"] = "reply"
    text: str | None = None
    learned_facts: list[FactUpdate] = []
    media_intent: MediaIntent | None = None
    offer_intent: MediaIntent | None = None
    soft_gift_ask: bool = False
    handoff_intent: Literal["none", "offer"] = "none"
```

Никаких:

```text
next_room
stop_room
search_room
payment_success
selected_media_id
end_conversation
```

---

## 34. Structured output validation

1. Pydantic.
2. Максимум один cheap repair/retry.
3. Если можно безопасно достать только текст — отправить текст, actions игнорировать.
4. Невалидный raw output никогда не запускает media/payment/Telegram action.

---

## 35. Concurrency

MUST:

- asyncio;
- lock на conversation;
- отдельный lock AnonController;
- `AsyncOpenAI`/async HTTP;
- global semaphore;
- async debounce/timers;
- graceful cancellation;
- stale version guard.

```text
LLM_MAX_CONCURRENCY=4
```

---

# ЧАСТЬ D — PERSONA, ПАМЯТЬ И ПОВЕДЕНЧЕСКИЕ РЕЖИМЫ

## 36. Одна фиксированная персона

Prompt assets:

```text
app/llm/prompts/system.md
app/llm/prompts/persona.md
app/llm/prompts/examples.json
```

Persona задает постоянные:

- имя;
- возраст;
- внешние/биографические факты;
- характер;
- стиль речи;
- длину сообщений;
- сленг/мат/эмодзи;
- инициативность;
- few-shot style examples;
- отсутствие assistant-style фраз и канцелярита.

Отдельно от persona подключается **behavior policy**, чтобы менять коммерческий режим и стратегию раскрытия AI без создания новой девушки.

---

## 37. Контекст LLM

```text
1. SYSTEM CORE
2. PERSONA
3. BEHAVIOR MODE
4. FEW-SHOT EXAMPLES
5. CURRENT RUNTIME CONTEXT
6. KNOWN FACTS ABOUT USER
7. ROLLING SUMMARY
8. RECENT MESSAGES
9. CURRENT BATCH
```

Стабильные части идут первыми для provider-side prefix caching.

---

## 38. Факты о собеседнике

Старт:

```text
facts={}
```

В том же reply call LLM может извлечь:

```text
name
age
gender
city
work
interests
important events
preferences
```

Факт:

```text
key
value
confidence
source_message_id
updated_at
```

Нет отдельного extraction call на каждое сообщение.

---

## 39. Context budgets

Anon:

```text
recent ~20–30 messages
facts only known
summary only after threshold
```

DM:

```text
recent ~30–50
facts
rolling summary
```

Не отправлять всю историю с начала знакомства.

---

## 40. Summary policy

```text
unsummarized_messages >= 40
OR estimated_context > soft_limit
→ summarize older slice once
```

Редкий отдельный LLM call, не каждый turn.

---

## 41. Identity reveal policy

Не кодировать disclosure как жесткую state machine.

В prompt/behavior config должен быть сменный текст стратегии. Базовая текущая политика:

```text
anon: не инициировать раскрытие AI, вести обычное знакомство
DM: раскрытие разрешено позже и естественно, timing гибкий
```

Для экспериментов можно менять стратегию prompt-файлом/runtime config без DB-поля `disclosed`.

---

## 42. Два коммерческих режима

У одной и той же девушки два режима **поведения**, а не два персонажа.

```text
DIRECT_SALE
PATRON
```

Текущий global mode хранится в `runtime_config`, а при создании conversation делается **behavior_mode snapshot**, чтобы один человек не получил внезапную смену логики посреди разговора. При необходимости админ может явно override конкретную conversation позже.

### 42.1. `DIRECT_SALE`

Жесткая фиксированная механика:

```text
пользователь просит paid media
→ OfferIntent
→ MediaSelector резервирует подходящий asset
→ code snapshot текущей цены
→ Offer WAITING
→ нужен Gift >= required_stars
→ PAID
→ reserved media send
```

Цена и fulfillment полностью детерминированы кодом.

### 42.2. `PATRON`

Мягкий режим «папик/патрон» для будущего эксперимента.

Главная разница: **нет обязательного жесткого “конкретный файл = конкретная цена” на каждую просьбу**.

LLM может:

- мягко просить подарки;
- напоминать о подарках;
- эмоционально реагировать на поддержку;
- отправлять допустимые casual/teaser media по обычному MediaIntent;
- использовать `soft_gift_ask=true` для аналитики/контроля.

Код при этом все равно:

- только сам детектирует реальный Gift;
- не позволяет LLM придумать, что подарок пришел;
- пишет `gift_received`;
- возвращает факт Gift в следующий context.

В `PATRON` по умолчанию Gift считается **поддержкой**, а не автоматической покупкой конкретного asset. Если позже понадобится условный reward threshold, это добавляется отдельной `PatronPolicy`, не ломая DIRECT_SALE.

Никакой подробной психологии этого режима сейчас не разрабатывать: пока заложить интерфейс, prompt policy и аналитику.

### Runtime

```text
.mode direct
.mode patron
```

По умолчанию `.mode` меняет режим для **новых** conversations. Это удобно для тестов и не ломает текущие активные диалоги.

---

## 43. Dynamic relationship state

`interest/trust/flirt/irritation` — LATER/SHOULD. Не блокирует MVP.

---

## 44. Human-like delivery

Не:

```text
LLM latency + random 3..10s
```

А target total:

```text
short   0.8–1.8s
normal  1.5–3.0s
long    2.5–5.0s
```

```text
sleep=max(0, target_total-generation_elapsed)
```

Typing action — где transport позволяет.

---

# ЧАСТЬ E — MEDIA VAULT

## 45. Canonical storage

Один private Telegram channel/chat.

SQLite хранит индекс, не бинарные файлы.

Ключ:

```text
source_chat_id
source_message_id
```

Перед отправкой source message fetch заново → актуальный media object → send/copy.

При expired file reference: refetch + bounded retry.

---

## 46. Автоматический индексатор

Vault должен работать удобно с телефона.

Основной режим:

- `NewMessage` в Vault с `#anonka_media` → parse/upsert;
- `MessageEdited` caption → update metadata;
- удаление source message → asset disabled/marked missing;
- invalid caption → log + excluded from selection.

`.media reindex` остается как full repair/admin command, но **не является обязательной операцией после каждого нового файла**.

---

## 47. Разметка медиа

Пример:

```text
#anonka_media
type=photo
access=paid
content=breasts,topless
view=front
outfit=none
scene=bedroom
series=bedroom_01
```

Кружок:

```text
#anonka_media
type=video_note
access=teaser
content=face,cleavage
view=front
outfit=shirt
scene=home
series=home_02
```

MUST:

```text
type=photo|video|video_note
access=casual|teaser|paid
content=one or more tags
```

Optional:

```text
view
outfit
scene
series
description
```

`description` короткая ручная подсказка, но весь каталог никогда не отправляется LLM.

---

## 48. Минимальная taxonomy

```text
content:
  selfie
  face
  full_body
  cleavage
  breasts
  butt
  lingerie
  nude

view:
  front
  back
  side
  closeup

outfit:
  casual
  shirt
  dress
  lingerie
  none

scene:
  bedroom
  bathroom
  home
  outside
```

Расширяется без DB migration.

---

## 49. MediaSelector

LLM возвращает только intent.

MUST filters:

- enabled;
- access;
- media type;
- required content tags;
- not already sent to this conversation;
- current transport capability supports asset type.

Пример score:

```text
exact content      +10
exact view          +5
exact outfit        +5
exact media type    +3
same series         +2
already sent       EXCLUDE
high usage          -1
```

Random top-N среди равноценных кандидатов.

---

## 50. Fallback media

Допустимо:

```text
requested video_note + breasts
→ none
→ photo + breasts
```

если policy явно разрешает смену media type.

Недопустимо:

```text
breasts → butt-only
```

Если ничего нет:

```text
MEDIA_NOT_AVAILABLE
```

---

## 51. Series continuity

Nullable. SHOULD.

Selector может предпочитать ту же series/scene/outfit для визуальной непрерывности.

---

## 52. Что реально отправлено

После успешного send:

- insert `conversation_media`;
- сохранить `metadata_snapshot_json`;
- создать domain event `media_sent`.

Следующий ContextBuilder получает компактное описание **реально отправленного** asset.

Это позволяет понимать:

```text
а есть такая же сзади?
```

---

## 53. Reserved asset исчез из Vault

Если конкретный asset был зарезервирован Offer, но до fulfillment удален/сломался:

1. refetch source;
2. если missing — попытаться найти **семантически эквивалентный** unsent asset по сохраненному `media_intent_snapshot`;
3. не заменять его нерелевантным контентом;
4. если эквивалента нет → `FULFILLMENT_BLOCKED` + admin alert/event.

---

# ЧАСТЬ F — DIRECT_SALE, GIFTS И PATRON EVENTS

## 54. Access classes

```text
casual
teaser
paid
```

`paid` в DIRECT_SALE — только после подтвержденного Gift.

---

## 55. Offer flow DIRECT_SALE

```text
OfferIntent
→ MediaSelector exact compatible unsent asset
→ no asset: no offer
→ snapshot current price
→ create Offer(selected_asset_id, price, intent)
→ wait valid Gift from bound DM peer
→ PAID
→ fulfill reserved media
```

Offer хранит:

```text
required_stars_snapshot
selected_asset_id
media_intent_snapshot
status
```

`.price` не меняет уже созданный Offer.

---

## 56. GiftDetector

Детектирует только Telegram/MTProto event.

Нужно получить, насколько позволяет установленная Telethon/MTProto версия:

```text
telegram_message_id/stable key
sender_peer_id
gift id/ref
gift stars/value
received_at
```

До финальной реализации:

- поймать реальный Gift fixture;
- сохранить raw update;
- подтвердить поля;
- написать integration test.

Если value нельзя надежно определить — не засчитывать автоматически.

---

## 57. Gift matching DIRECT_SALE

```text
waiting Offer
AND conversation.peer == gift.sender
AND gift.value >= required_stars
→ PAID
```

Edge cases:

- insufficient Gift → record, Offer WAITING;
- Gift без Offer → unmatched;
- Gift after expired/cancelled → old Offer не воскресает;
- wrong peer → не оплачивает;
- duplicate event → один раз;
- один Gift не match к двум Offers.

MVP не суммирует несколько мелких Gifts автоматически.

---

## 58. Gift в PATRON

В `PATRON` Gift по умолчанию:

```text
Gift event
→ dedupe
→ record support
→ event gift_support_received
→ compact fact into next LLM context
```

Не создается автоматический purchase/fulfillment, если не было отдельного DIRECT-style Offer.

Так режим остается мягким и не превращается в ту же фиксированную продажу под другим названием.

---

## 59. Fulfillment DIRECT_SALE

Без LLM:

```text
Gift
→ dedupe/match
→ transaction WAITING→PAID
→ outbox SEND_MEDIA
→ MediaSender
→ conversation_media
→ FULFILLED
```

Следующий обычный LLM context знает: Gift получен, зарезервированное медиа реально доставлено.

---

## 60. Crash между Gift и send

После restart:

```sql
SELECT offers
WHERE status='paid'
AND fulfilled_at IS NULL
```

RecoveryService продолжает fulfillment.

---

# ЧАСТЬ G — RUNTIME CONTROL

## 61. Runtime config

SQLite `runtime_config`:

```text
offer_price_stars
commercial_mode = direct | patron
anon_enabled
offers_enabled
media_enabled
identity_reveal_strategy   # prompt-level policy, не per-conversation disclosure flag
```

Infrastructure `.env`, runtime behavior — DB/config.

---

## 62. Admin Saved Messages

```text
.anon start
.anon stop
.anon next
.anon status

.mode direct
.mode patron
.price 30
.offers on
.offers off
.media on
.media off
.media reindex

.status
.dm pause <peer/conversation>
.dm resume <peer/conversation>
```

Admin commands распознаются только от self-account, не идут LLM и не пересылаются людям.

---

## 63. Семантика переключателей

`.anon stop`:

- останавливает поиск/anon controller;
- DM продолжают работать.

`.anon next`:

- invalidate generation первым;
- затем controlled skip;
- DM не затрагивает.

`.offers off`:

- запрет новых DIRECT_SALE Offers;
- existing WAITING живут до expiry по default;
- PAID fulfillment всегда выполняется.

`.media off`:

- запрет новых обычных media sends/intents;
- **не блокирует уже оплаченный fulfillment**.

`.price N`:

- только новые Offers.

`.mode direct|patron`:

- задает default для новых conversations;
- existing conversation сохраняет `behavior_mode_snapshot`.

---

# ЧАСТЬ H — SQLITE

## 64. SQLite settings

```sql
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
PRAGMA busy_timeout=5000;
```

Один процесс + SQLite достаточно.

---

## 65. `conversations`

```text
id                    INTEGER PK
channel               anon | dm
state                 active | handoff_pending | ended
telegram_peer_id      INTEGER NULL
anon_generation       INTEGER NULL
behavior_mode         direct | patron
created_at
updated_at
last_activity_at
manual_override_until NULL
ended_at              NULL
end_reason            NULL
```

Индексы:

```text
(channel,state)
telegram_peer_id
```

Не более одной active DM conversation на peer.

---

## 66. `messages`

```text
id
conversation_id FK
role             user | assistant | system
transport        anon | dm
kind             text | service | photo | video | video_note | voice | sticker | gift | internal
source           partner | llm | manual | system
telegram_chat_id NULL
telegram_message_id NULL
text             NULL
needs_response   BOOL
handled_at       NULL
edited_at        NULL
created_at
```

`needs_response/handled_at` нужны для crash recovery между сохранением incoming и вызовом LLM.

Dedupe по Telegram message key.

---

## 67. `conversation_facts`

```text
conversation_id FK
key
value_json
confidence
source_message_id NULL
updated_at
PRIMARY KEY(conversation_id,key)
```

---

## 68. `conversation_summaries`

```text
id
conversation_id FK
through_message_id
summary_text
created_at
```

Версии сохраняются.

---

## 69. `handoffs`

```text
id
conversation_id FK
state pending | confirmed | expired | ambiguous
anon_generation
created_at
deadline_at
handoff_token NULL
dm_peer_id NULL
confirmed_at NULL
```

---

## 70. `media_assets`

```text
id
source_chat_id
source_message_id
media_type
access_class
tags_json
series NULL
description NULL
enabled
missing BOOL
use_count
created_at
updated_at
UNIQUE(source_chat_id,source_message_id)
```

---

## 71. `conversation_media`

```text
id
conversation_id FK
media_asset_id FK
reason casual | teaser | paid | manual
transport anon | dm
telegram_message_id NULL
metadata_snapshot_json
sent_at
UNIQUE(conversation_id,media_asset_id)
```

---

## 72. `offers`

```text
id
conversation_id FK
status waiting | paid | fulfilled | expired | cancelled | fulfillment_blocked
required_stars
media_intent_json
selected_asset_id FK
created_at
expires_at NULL
paid_at NULL
fulfilled_at NULL
```

MVP: максимум один `waiting` DIRECT Offer на conversation.

---

## 73. `gifts`

```text
id
telegram_chat_id
telegram_message_id
gift_ref NULL
sender_peer_id
gift_stars NULL
received_at
matched_offer_id NULL
purpose purchase | patron_support | unmatched
UNIQUE(telegram_chat_id,telegram_message_id)
```

---

## 74. `runtime_config`

```text
key TEXT PK
value_json
updated_at
```

---

## 75. `events`

```text
id
conversation_id NULL
event_type
payload_json
created_at
```

---

## 76. `outbox`

```text
id
conversation_id NULL
action_type
payload_json
idempotency_key UNIQUE
status pending | processing | sent | done | failed | uncertain
attempts
available_at
telegram_message_id NULL
last_error NULL
created_at
completed_at NULL
```

Actions:

```text
send_text
send_media
anon_search
anon_next
anon_stop
anon_link
```

---

## 77. `app_state`

```text
key TEXT PK
value_json
updated_at
```

Минимум:

```text
anon_controller_state
current_anon_conversation_id
current_anon_generation
last_search_action_at
```

---

# ЧАСТЬ I — IDEMPOTENCY И RECOVERY

## 78. Incoming exactly-once-ish

Цель: idempotent at-least-once.

```text
receive Telegram event
→ dedupe
→ save message/event
→ commit
→ schedule processing
```

Если process crash после save, но до LLM:

```text
handled_at=NULL AND needs_response=1
```

Startup recovery снова ставит эти сообщения в pipeline/debounce.

Вопрос пользователя не теряется.

---

## 79. Outgoing outbox

```text
create outbox
→ send
→ capture telegram message id
→ mark sent/done
```

Программный outgoing correlation используется также для отличия от manual owner messages.

---

## 80. Crash после фактического Telegram send, но до DB commit

Это окно неопределенной доставки.

Нельзя слепо повторять все `processing` actions.

Для `uncertain`:

- проверить последние исходящие сообщения/доступный transport state;
- сопоставить payload/time/message characteristics;
- где доступен устойчивый Telegram operation identifier — использовать его;
- только после reconciliation решать resend.

Цель — минимизировать дубли, понимая, что абсолютный exactly-once поверх Telegram не гарантируется.

---

## 81. Retry LLM

Только transient:

```text
timeout
connection reset
5xx
429
```

```text
2–3 attempts
exponential backoff + jitter
```

LLM timeout не является причиной skip человека.

---

## 82. Retry Telegram

FloodWait:

- outbox остается;
- `available_at` переносится;
- retry позже.

Media ref:

- refetch source;
- bounded retry.

---

## 83. Startup recovery

1. open DB;
2. migrations/WAL;
3. process lock;
4. Telethon session;
5. resolve self/anon/Vault peers;
6. recover incomplete incoming (`handled_at=NULL`);
7. reconcile uncertain outbox;
8. recover PAID not FULFILLED;
9. restore DM conversations;
10. restore anon saved state;
11. reconcile actual anon-bot state;
12. restore timers/debounce;
13. start Vault live indexer.

---

# ЧАСТЬ J — ANALYTICS

## 84. Events

```text
app_started
anon_search_started
anon_search_watchdog
anon_room_started
anon_message_received
anon_reply_sent
anon_no_reply
anon_idle_timeout
anon_partner_left
anon_manual_skip
handoff_offered
handoff_link_requested
handoff_confirmed
handoff_expired
handoff_ambiguous
dm_started
dm_direct_started
dm_message_received
manual_message_sent
manual_override_started
behavior_mode_assigned
soft_gift_ask
offer_created
offer_price_snapshot
gift_received
gift_unmatched
gift_insufficient
gift_support_received
offer_paid
offer_expired
media_selected
media_sent
media_unavailable
media_fulfillment_blocked
vault_asset_indexed
vault_asset_updated
llm_request
llm_error
llm_schema_error
telegram_flood_wait
```

---

## 85. Метрики

```text
anon rooms → handoff rate
handoff → DM rate
direct DM starts
DM → offer rate
DIRECT_SALE conversion by price
PATRON gift rate
messages before handoff
messages before gift/offer
idle/skip rate
media category demand
LLM calls/conversation
cost/conversation
conversion by behavior_mode
```

---

## 86. Usage accounting

Сохранять, если provider возвращает:

```text
input_tokens
cached_input_tokens
output_tokens
model
latency_ms
```

Стоимость считать по фактическому usage.

Примерный объем при 20 LLM turns, 2000 input tokens/turn и 80 output:

```text
1 conversation:   ~40k input + 1.6k output
100:              ~4M input + 0.16M output
1000:             ~40M input + 1.6M output
```

Фактический cost:

```text
miss_input_cost + cached_input_cost + output_cost
```

Главные рычаги экономии: debounce, no_reply, short context, rare summaries, no LLM on timers/Gifts/media lookup, thinking off, local model option.

---

# ЧАСТЬ K — CONFIG / DEPLOYMENT / FILES

## 87. `.env`

```dotenv
TG_API_ID=
TG_API_HASH=
TG_SESSION_NAME=anonka_session

ANON_BOT_USERNAME=
ANON_SEARCH_COMMAND=
ANON_NEXT_COMMAND=
ANON_STOP_COMMAND=
ANON_LINK_COMMAND=/link
ANON_IDLE_TIMEOUT_SECONDS=600
ANON_SEARCH_WATCHDOG_SECONDS=90

MEDIA_VAULT_CHAT_ID=

LLM_PROVIDER=openai_compatible
LLM_BASE_URL=https://api.deepseek.com
LLM_API_KEY=
LLM_MODEL=deepseek-v4-flash
LLM_TIMEOUT_SECONDS=45
LLM_MAX_OUTPUT_TOKENS=500
LLM_MAX_CONCURRENCY=4
LLM_THINKING=disabled

MESSAGE_DEBOUNCE_MS=1800
MANUAL_OVERRIDE_SECONDS=60
VOICE_FALLBACK_TEXT=я гс не могу послушать, напиши текстом)
DATABASE_PATH=data/anonka.sqlite3
LOG_LEVEL=INFO
DRY_RUN=false
```

Mode/price/toggles — runtime_config.

---

## 88. Secrets

MUST:

- `.env` gitignored;
- `.session` gitignored;
- SQLite gitignored;
- API keys not logged;
- Telegram session = password-level secret;
- Vault private;
- plaintext chats not spammed into console logs;
- safe SQLite backups.

---

## 89. Deployment

```text
one Windows/Linux PC or VPS
one Python process
one Telethon session
one SQLite DB
```

Process/DB lock prevents accidental second active instance.

---

## 90. Target directory tree

```text
ai_chat_experiment/
├── app/
│   ├── main.py
│   ├── config.py
│   ├── logging_setup.py
│   ├── domain/
│   │   ├── models.py
│   │   ├── enums.py
│   │   └── events.py
│   ├── persistence/
│   │   ├── db.py
│   │   ├── migrations.py
│   │   └── repositories.py
│   ├── tg/
│   │   ├── client.py
│   │   ├── router.py
│   │   ├── sender.py
│   │   └── typing.py
│   ├── anon/
│   │   ├── adapter.py
│   │   ├── parser.py
│   │   ├── controller.py
│   │   ├── state.py
│   │   ├── reconciliation.py
│   │   └── timers.py
│   ├── dm/
│   │   ├── adapter.py
│   │   ├── handoff.py
│   │   └── manual_override.py
│   ├── conversation/
│   │   ├── service.py
│   │   ├── debounce.py
│   │   ├── context.py
│   │   ├── facts.py
│   │   ├── summary.py
│   │   └── incoming_media.py
│   ├── llm/
│   │   ├── base.py
│   │   ├── openai_compatible.py
│   │   ├── service.py
│   │   ├── schemas.py
│   │   └── prompts/
│   │       ├── system.md
│   │       ├── persona.md
│   │       ├── examples.json
│   │       └── modes/
│   │           ├── direct_sale.md
│   │           ├── patron.md
│   │           └── identity_policy.md
│   ├── media/
│   │   ├── catalog.py
│   │   ├── indexer.py
│   │   ├── tags.py
│   │   ├── selector.py
│   │   └── sender.py
│   ├── commerce/
│   │   ├── offers.py
│   │   ├── gifts.py
│   │   └── modes.py
│   ├── admin/
│   │   └── commands.py
│   ├── analytics/
│   │   └── events.py
│   └── runtime/
│       ├── outbox.py
│       ├── recovery.py
│       ├── scheduler.py
│       └── instance_lock.py
├── data/
│   └── anonka.sqlite3
├── tests/
├── .env
├── .env.example
├── requirements.txt
└── run.py
```

Создавать по этапам, не десятки пустых файлов сразу.

---

# ЧАСТЬ L — SEQUENCE FLOWS

## 91. Новый anon

```text
SEARCHING
→ ROOM_READY (если detectable)
→ create facts={}
→ assign behavior_mode snapshot
→ ROOM_ACTIVE
→ optional opener LLM
```

или:

```text
SEARCHING
→ first partner message
→ create conversation
→ debounce
→ LLM
```

---

## 92. Idle

```text
10m no meaningful activity
→ invalidate generation
→ next
→ close old
→ SEARCHING
```

---

## 93. Partner skips

```text
PARTNER_LEFT
→ invalidate
→ cancel timer/job
→ close old
→ reconcile/search next
```

---

## 94. Handoff

```text
LLM handoff_intent
→ /link
→ HANDOFF_PENDING
→ reliable DM match
→ same conversation channel=dm
→ bind peer
→ invalidate anon
→ search next
```

Неоднозначный новый DM не смешивается автоматически с pending handoff.

---

## 95. Direct DM

```text
new DM peer
→ no reliable pending handoff match
→ create new DM conversation(facts={})
→ assign behavior mode
→ normal LLM pipeline
```

---

## 96. Кружок в анончате

```text
LLM MediaIntent(video_note,...)
→ MediaSelector
→ transport capability says anon video_note supported
→ fetch Vault source
→ AnonAdapter/MediaSender sends video_note
→ conversation_media snapshot
```

---

## 97. Voice received

```text
voice message
→ save kind=voice
→ no STT
→ send configured VOICE_FALLBACK_TEXT
→ mark handled
```

---

## 98. DIRECT_SALE

```text
request paid media
→ OfferIntent
→ reserve matching asset
→ price snapshot
→ if anon, optionally handoff
→ real DM peer known
→ Gift >= required
→ PAID
→ send reserved asset
```

---

## 99. PATRON

```text
conversation mode=PATRON
→ LLM may soft_gift_ask
→ code only logs intent
→ user sends Gift
→ GiftDetector verifies event
→ record patron_support
→ next LLM context knows support happened
→ no automatic fixed asset purchase by default
```

---

## 100. Crash after incoming save

```text
message saved needs_response=1
→ PROCESS CRASH
→ restart
→ handled_at NULL recovery
→ requeue
→ LLM
```

---

## 101. Crash after Gift

```text
Offer PAID
media not sent
→ crash
→ restart
→ recovery PAID&&!FULFILLED
→ send/reconcile
```

---

# ЧАСТЬ M — TESTING

## 102. Unit MUST

- anon state transitions;
- facts start empty;
- room ready/no-room-ready paths;
- idle timeout;
- search watchdog;
- observed reconciliation;
- repeated partner_left idempotent;
- stale generation dropped;
- debounce;
- parallel contexts never mix;
- direct new DM creates new conversation;
- ambiguous handoff does not steal direct DM;
- manual outgoing stored;
- programmatic outgoing does not trigger manual override;
- manual override blocks duplicate AI reply;
- no_reply does not end conversation;
- edited incoming stales pending job;
- voice fallback works without LLM/STT;
- media parser/indexer;
- Vault NewMessage/Edited auto-upsert;
- deleted Vault asset disabled;
- anon video_note capability works;
- selector exact tags;
- no repeat;
- breasts never silently maps to butt-only;
- actual sent metadata enters later context;
- DIRECT_SALE price snapshot;
- behavior mode snapshot stable;
- `.mode` affects new conversations;
- PATRON Gift does not accidentally fulfill a nonexistent direct Offer;
- wrong/insufficient/unmatched/duplicate Gift;
- paid fulfillment ignores `.media off`;
- missing reserved asset uses only semantic equivalent or blocks;
- incoming crash recovery;
- paid crash recovery;
- outbox uncertainty reconciliation;
- second instance lock.

---

## 103. Integration SHOULD

- fake OpenAI-compatible server;
- fake Telethon messages;
- real anon-bot fixtures;
- MessageEdited/markup/raw updates;
- real captured Gift fixture;
- Vault live index events;
- media send in DM and anon video_note;
- restart after critical DB transitions;
- FloodWait;
- expired media reference;
- invalid LLM JSON;
- local-model compatibility.

---

## 104. DRY_RUN

- DB/state machine real;
- outgoing actions logged but not sent;
- real or fake LLM;
- fixture playback for anon/Gift/media.

---

# ЧАСТЬ N — DEPENDENCIES И ВЕРСИИ

## 105. Dependencies

Runtime:

```text
telethon
openai
python-dotenv
pydantic>=2
aiosqlite
```

Dev:

```text
pytest
pytest-asyncio
```

Migrations: простой ordered SQL runner сначала достаточно.

---

## 106. Version pinning

Перед adapter-sensitive реализацией зафиксировать версии.

Особенно проверить на установленной версии:

- Gift service/raw update fields;
- video-note resend semantics;
- anon bot update behavior;
- file references;
- DeepSeek structured output/thinking params.

Домен не должен зависеть от конкретного нестабильного имени raw Telethon class.

Официальные точки проверки при реализации:

- `https://core.telegram.org/api`
- `https://core.telegram.org/api/gifts`
- `https://core.telegram.org/api/links`
- `https://docs.telethon.dev/`
- `https://api-docs.deepseek.com/`

---

# ЧАСТЬ O — ПЛАН РЕФАКТОРИНГА

## 107. Этап 1 — persistence/domain

- SQLite/WAL;
- migrations;
- conversations/messages/events;
- incoming handled state;
- repositories;
- instance lock.

## 108. Этап 2 — provider-neutral async LLM

- XAI → LLM config;
- AsyncOpenAI;
- OpenAICompatibleProvider;
- ChatDecision;
- no_reply;
- remove action=end.

## 109. Этап 3 — ConversationService

- locks;
- debounce;
- facts/context;
- target delivery timing;
- direct DM creation;
- outgoing/manual ingestion;
- manual override;
- edited-message handling;
- voice fallback.

## 110. Этап 4 — AnonAdapter/Controller

- protocol reconnaissance;
- parser/events;
- buttons/commands;
- state machine;
- reconciliation;
- idle timeout;
- search watchdog;
- generation guard;
- capability matrix including video_note.

## 111. Этап 5 — DM/Handoff

- DM router;
- direct DM conversations;
- handoff matching;
- ambiguity handling;
- same-conversation migration;
- auto-search next.

## 112. Этап 6 — Persona/behavior modes

- persona prompt;
- few-shot examples;
- identity policy prompt;
- `DIRECT_SALE` mode prompt;
- `PATRON` mode prompt;
- behavior_mode snapshot;
- summary thresholds.

## 113. Этап 7 — Media Vault

- live indexer;
- reindex repair;
- tags;
- selector;
- no-repeat;
- video notes anon+DM;
- actual-sent snapshot;
- missing asset handling.

## 114. Этап 8 — Gifts/commerce

- runtime price/mode;
- direct Offer reservation;
- Gift fixture;
- GiftDetector;
- DIRECT matching;
- PATRON support events;
- fulfillment/recovery.

## 115. Этап 9 — hardening

- full outbox;
- uncertain send reconciliation;
- retry/backoff/FloodWait;
- startup recovery;
- backup.

## 116. Этап 10 — analytics/admin

- Saved Messages controls;
- price/mode experiment metrics;
- cost reports.

---

# ЧАСТЬ P — MUST / SHOULD / LATER

## 117. MUST MVP

- one dedicated Telethon user-account;
- one anonymous bot adapter;
- all normal direct DMs supported;
- empty facts on new person;
- anon state machine;
- observed reconciliation;
- 10m idle skip;
- search watchdog;
- SQLite restart-safe history;
- incoming handled/recovery state;
- one conversation/person;
- anon→DM same context;
- safe ambiguous handoff behavior;
- parallel DMs;
- provider-neutral async LLM;
- DeepSeek V4 Flash default, thinking off;
- local OpenAI-compatible switch;
- debounce;
- no_reply;
- one persona;
- flexible delayed AI disclosure policy without per-conversation disclosure flags;
- DIRECT_SALE + PATRON behavior modes;
- behavior mode snapshot;
- facts in normal reply call;
- voice fallback without STT;
- manual outgoing/override;
- programmatic outgoing correlation;
- stale generation guard;
- Media Vault;
- live auto-index;
- semantic tags;
- anon video_note support;
- local selector;
- sent metadata feedback;
- no-repeat;
- runtime price/mode;
- Direct Offer snapshot;
- GiftDetector;
- Gift edge cases;
- Patron support events;
- code-side fulfillment;
- crash recovery;
- admin controls;
- analytics.

## 118. SHOULD

- rolling summary;
- series continuity;
- full outbox uncertainty reconciliation;
- automatic DB backup;
- smarter in-flight cancellation;
- local primary + DeepSeek fallback;
- richer status/reporting.

## 119. LATER

- STT for voice;
- vision for incoming images;
- numeric relationship state;
- richer PatronPolicy/reward mechanics;
- automatic vision tagging Vault;
- cumulative Gifts;
- Postgres/Redis/workers;
- web dashboard;
- Business Bot;
- runtime image/video generation;
- multiple personas.

---

# ЧАСТЬ Q — DEFINITION OF DONE

## 120. Первая полноценная версия готова, если

```text
1. Process запускается и восстанавливает DB/state.
2. Anon search запускается/восстанавливается без blind next spam.
3. Новый anon создается с facts={}.
4. AI ведет обычный женский разговор; в анонке нет обязательного раннего AI-disclosure.
5. Быстрые сообщения debounce в один LLM call.
6. Узнанные имя/возраст/пол/город сохраняются.
7. no_reply не завершает conversation.
8. Voice без STT получает короткий configured ответ и не ломает pipeline.
9. 10m idle делает code-side next.
10. Search watchdog восстанавливает зависший search.
11. Partner skip invalidates stale LLM reply.
12. Manual next/stop синхронизируется observed state.
13. Ручное owner message входит в history и включает override.
14. Programmatic outgoing не ошибочно считается ручным.
15. Handoff сохраняет тот же conversation.
16. После handoff anon сразу ищет нового.
17. Прямой новый DM без handoff тоже получает свою conversation.
18. Неоднозначный DM не смешивается с pending anon handoff.
19. Старые DM + новый anon работают параллельно.
20. DeepSeek можно заменить локальной OpenAI-compatible моделью конфигом.
21. В Vault новый captioned asset индексируется автоматически.
22. LLM выбирает MediaIntent, код — конкретный asset.
23. Semantic request не заменяется нерелевантной категорией.
24. Кружок можно отправить через anon transport.
25. Реально отправленные media metadata входят в следующий context.
26. DIRECT_SALE резервирует asset и snapshot цены.
27. Offer может начаться в anon и продолжиться после handoff в DM.
28. Gift засчитывается только проверенным кодом.
29. Wrong/insufficient/duplicate/unmatched Gift не дает paid media.
30. PAID fulfillment выполняется без LLM и переживает crash.
31. Удаленный reserved asset не заменяется случайным нерелевантным media.
32. PATRON mode умеет soft gift ask и учитывает Gifts как поддержку без обязательной жесткой покупки.
33. `.mode direct|patron` меняет default новых conversations без ломания активных.
34. `.price` меняет только новые Direct Offers.
35. `.media off` не блокирует уже оплаченный fulfillment.
36. Incoming message, сохраненный перед crash, после restart не теряется.
37. Uncertain outgoing не дублируется слепым retry.
38. Аналитика различает DIRECT_SALE/PATRON и считает conversion/cost.
```

Если эти пункты выполняются, реализация соответствует текущей согласованной архитектуре без ненужного раздувания.