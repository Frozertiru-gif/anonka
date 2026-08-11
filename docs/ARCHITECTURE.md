# Anonka — полная целевая архитектура

> Статус: каноническая архитектурная спецификация проекта.  
> Репозиторий: `Frozertiru-gif/anonka`  
> Назначение: зафиксировать согласованную архитектуру до большого рефакторинга и дать Codex/разработчику документ, по которому систему можно реализовывать по этапам без повторного придумывания решений.

---

## 1. Цель проекта

`anonka` — постоянно работающий Python-процесс под **одним пользовательским Telegram-аккаунтом** через Telethon.

Система должна одновременно решать две задачи:

1. Вести один текущий разговор через существующего Telegram-бота анонимного чата.
2. Параллельно вести любое разумное количество обычных личных переписок Telegram с людьми, которые перешли из анончата в ЛС.

В проекте используется **одна фиксированная AI-девушка/персонаж**. Multi-persona, выбор девушек, паки разных персонажей, marketplace и любая подобная архитектура не нужны.

Персонаж прямо позиционируется как AI. Цель проекта — автоматизация общения и эксперимент с поведением пользователей, а не техническая имитация реального человека.

Фото, видео и Telegram video notes/«кружки» **не генерируются во время диалога**. Они заранее готовятся внешними сервисами и хранятся в Media Vault.

---

## 2. Главный принцип: максимум логики в коде

Основное архитектурное правило:

> **LLM отвечает за язык, смысл реплики и семантическое намерение. Код отвечает за состояние системы, таймеры, Telegram-действия, выбор файлов, оплату, повторы и восстановление.**

### LLM разрешено

- написать обычную реплику;
- решить, что на конкретную реплику лучше вообще не отвечать;
- извлечь новые факты о собеседнике из текущего разговора;
- выразить намерение предложить переход в ЛС;
- выразить `MediaIntent`: какой тип/содержание медиа требуется;
- выразить `OfferIntent`: что пользователь просит платное медиа подходящей семантики;
- учитывать подтвержденные кодом события: переход в ЛС, реально отправленное медиа, полученный Gift, выполненный offer.

### LLM НЕ разрешено

- считать таймеры;
- определять, существует ли сейчас анонимная комната;
- самостоятельно выполнять поиск нового собеседника;
- выполнять `/next`, `/stop`, `/search`, `/link`;
- сбрасывать контекст;
- выбирать конкретный `message_id`/файл из Media Vault;
- определять, реально ли получен Telegram Gift;
- считать оплату успешной;
- изменять цену;
- менять SQLite;
- управлять FloodWait/retry/backoff;
- решать идемпотентность;
- отправлять старый ответ после смены комнаты;
- завершать разговор только потому, что пользователь написал `ок`, `пон`, `ага` и т.п.;
- самостоятельно решать, что «пора искать следующего» после handoff — это следствие подтвержденного state transition и делает код.

Чем больше детерминированной работы можно надежно выполнить кодом, тем меньше она должна попадать в LLM.

---

## 3. Что НЕ строим сейчас

Для первой рабочей версии не нужны:

- несколько AI-персонажей;
- `persona_id` и каталог девушек;
- runtime-генерация изображений/видео;
- Telegram Business Bot без доказанной технической необходимости;
- Postgres;
- Redis;
- Celery/RQ;
- микросервисы;
- Kubernetes;
- vector DB;
- embeddings/RAG для обычного чата;
- автоматическое vision-тегирование медиатеки;
- web-admin;
- распределенные воркеры;
- отдельная checkout/invoice система, пока GiftDetector решает задачу;
- обязательная сложная числовая «психология» персонажа.

Начальная целевая система:

```text
1 Python process
+ Telethon
+ asyncio
+ SQLite/WAL
+ provider-agnostic LLM
+ private Telegram Media Vault
```

---

## 4. Что есть сейчас и почему этого недостаточно

Существующий проект полезен как каркас, но сейчас фактически является одиночным автоответчиком:

- `app/tg/handlers.py` получает входящее сообщение и сразу вызывает `ReplyService`;
- `app/tg/filters.py` ориентируется на один `TG_TARGET_USERNAME`;
- `app/chat/session.py` хранит историю в RAM;
- состояние сведено примерно к `active/ended`;
- после перезапуска контекст исчезает;
- `GrokClient` синхронно вызывает OpenAI-compatible API и заточен именами под xAI;
- LLM возвращает `action=end`, то есть сейчас модель участвует в управлении жизненным циклом;
- короткие `ок`/`пон` могут автоматически завершать разговор;
- фиксированная задержка добавляется поверх времени генерации;
- нет независимых DM-контекстов;
- нет полноценного anon state machine;
- нет SQLite persistence;
- нет handoff;
- нет Media Vault/indexer/selector;
- нет Offers/Gifts;
- нет outbox/recovery/analytics.

**Переписывать проект с нуля не надо.** Сохраняются Python, Telethon, asyncio, composition root и общее разбиение на Telegram/LLM/services. Меняется ответственность модулей.

---

## 5. Верхнеуровневая схема

```text
                         TELEGRAM ACCOUNT
                               │
                         Telethon Client
                               │
          ┌────────────────────┼────────────────────┐
          │                    │                    │
      ANON BOT               REAL DMs           MEDIA VAULT
          │                    │                    │
     AnonAdapter            DMAdapter           MediaCatalog
          │                    │                    │
          └────────────┬───────┘                    │
                       ▼                            │
                  EventRouter                       │
                       │                            │
            ┌──────────┼───────────────┐            │
            │          │               │            │
     AnonController ConversationSvc GiftDetector    │
            │          │               │            │
            │      Debounce/Locks       │            │
            │          │               │            │
            │     ContextBuilder        │            │
            │          │               │            │
            │       LLMService          │            │
            │          │               │            │
            │    ChatDecision           │            │
            │          │               │            │
            │    ActionCoordinator      │            │
            │      │      │      │      │            │
            │     text   media  offer handoff        │
            │             │      │                   │
            │             ▼      ▼                   │
            │        MediaSelector / OfferService    │
            │             │      │                   │
            └─────────────┴──────┴───────────────────┘
                              │
                         SQLite / WAL
```

---

## 6. Telegram topology

Один user-account через Telethon взаимодействует с:

1. **Anonymous bot chat** — транспорт текущей анонимной комнаты.
2. **Обычными DM** — реальные личные чаты пользователей.
3. **Private Media Vault** — приватный канал/чат с заранее подготовленными медиа.
4. **Saved Messages** — минимальный admin/runtime control.

Отдельный Business Bot не добавлять, пока user-account + MTProto/Telethon покрывает необходимые функции.

---

# ЧАСТЬ A. АНОНИМНЫЙ ЧАТ

## 7. Важное свойство конкретной анонки

При нахождении собеседника **никаких исходных данных нет**:

```text
name   = unknown
age    = unknown
gender = unknown
city   = unknown
```

В реальном контексте лучше вообще не передавать список `unknown` — при создании conversation просто:

```text
facts = {}
```

Имя, возраст, пол, город, работа, интересы и любые другие сведения узнаются только естественно из переписки.

Нельзя проектировать архитектуру так, будто anonymous bot отдает анкету пользователя.

---

## 8. Anon state machine

Минимальные состояния контроллера:

```text
STOPPED
SEARCHING
ROOM_ACTIVE
HANDOFF_PENDING
SKIPPING
```

`ENDED` не нужен как глобальное состояние контроллера: законченная anonymous conversation архивируется, а контроллер продолжает работать.

### Переходы

```text
STOPPED
  │ .anon start
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

---

## 9. Как понять, что новый собеседник реально найден

Пользователь уточнил: визуально при нахождении собеседника может не появляться отдельная анкета/данные, а сам диалог просто становится доступен.

Поэтому `AnonAdapter` обязан поддерживать два варианта.

### Вариант A — найден надежный технический сигнал

Это может быть:

- системное сообщение;
- изменение текста сообщения бота;
- изменение inline/reply keyboard;
- `MessageEdited`;
- callback/state update;
- другой устойчивый MTProto/Telethon-признак.

Тогда Adapter генерирует:

```text
ROOM_READY
```

и при необходимости AI может первой начать разговор.

### Вариант B — надежного сигнала нет

Тогда:

```text
SEARCHING
→ первое реальное сообщение собеседника
→ create conversation
→ ROOM_ACTIVE
→ DeepSeek activates
```

До фактического появления partner message LLM не вызывается.

### Обязательный предварительный этап реализации

Перед окончательным кодированием `AnonAdapter` нужно сделать короткий **protocol reconnaissance** конкретного анон-бота:

- записать несколько циклов search → room → skip → search;
- залогировать `NewMessage`, `MessageEdited`, reply markup, callback/raw update типы;
- определить реальные команды/кнопки `search/next/stop/link`;
- определить, начинает ли бот новый поиск автоматически после skip;
- определить надежный признак `ROOM_READY`, если он существует.

Вся эта специфика остается внутри `AnonAdapter`; остальное приложение работает с нормализованными событиями.

---

## 10. Нормализованные события AnonAdapter

Пример:

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

`AnonController` не должен парсить тексты конкретного бота сам.

---

## 11. Команды анон-боту

Boot-time config:

```text
ANON_SEARCH_COMMAND
ANON_NEXT_COMMAND
ANON_STOP_COMMAND
ANON_LINK_COMMAND
```

Если бот использует кнопки, Adapter внутри делает click, но наружный интерфейс остается одинаковым:

```python
await anon_adapter.search()
await anon_adapter.next()
await anon_adapter.stop()
await anon_adapter.request_link()
```

---

## 12. Постоянная reconciliation фактического состояния

**Фактическое состояние Telegram/анон-бота имеет приоритет над локальным предположением.**

Это нужно не только после restart.

Примеры:

- пользователь сам вручную нажал «Следующий»;
- бот автоматически начал новый поиск;
- сообщение бота было отредактировано;
- кнопки изменились;
- команда отправилась, но результат пришел позже;
- локально считали `ROOM_ACTIVE`, а бот уже перешел в search.

`AnonAdapter` должен слушать не только обычные incoming `NewMessage`, но при необходимости `MessageEdited`/raw updates и обновлять наблюдаемое состояние.

`AnonController.reconcile(observed_state)` переводит локальный state machine в подтвержденное состояние идемпотентно.

Нельзя строить логику только по принципу «мы отправили `/next`, значит теперь точно SEARCHING`».

---

## 13. Watchdog состояния SEARCHING

10-минутный room timeout не решает ситуацию, когда поиск завис.

Нужна настройка:

```text
ANON_SEARCH_WATCHDOG_SECONDS
```

Стартовый ориентир: 60–120 секунд, затем откалибровать под конкретный бот.

Flow:

```text
SEARCHING
↓
watchdog elapsed, room не подтверждена
↓
AnonAdapter.reconcile_state()
↓
если поиск действительно идет -> просто продолжать ждать / увеличить interval
если поиск остановлен -> повторить search
если состояние неизвестно -> bounded retry + backoff
```

Запрещено спамить `/search`/`/next` бесконечно.

Нужны:

```text
max immediate retries
exponential/backoff delay
last_search_action_at
```

---

## 14. 10-минутный idle timeout комнаты

Стартовое значение:

```text
ANON_IDLE_TIMEOUT_SECONDS = 600
```

Это **таймер неактивности**, не «10 минут с момента знакомства».

`last_activity_at` обновляется при:

- реальном partner message;
- фактическом AI message, который успешно ушел;
- ручном сообщении владельца в этот разговор.

Служебные события Telegram не продлевают комнату.

Если 10 минут значимой активности нет:

```text
ROOM_ACTIVE / HANDOFF_PENDING
↓
invalidate room generation
↓
SKIPPING
↓
AnonAdapter.next()
↓
conversation end_reason=idle_timeout
↓
SEARCHING
```

LLM не вызывается.

---

## 15. Защита от старого ответа после смены собеседника

Критический race:

```text
A пишет
→ LLM начала думать
→ A ушел
→ появился B
→ старый ответ A готов
```

Он не должен уйти B.

Каждая anonymous room получает монотонный:

```text
room_generation
```

Пример:

```text
A generation=41
B generation=42
```

Каждый LLM job сохраняет snapshot generation.

Перед любой отправкой в anon transport:

```python
if job.room_generation != anon_controller.current_generation:
    drop_response()
```

При `partner_left`, `manual_next`, `stop`, `handoff_confirmed` generation инвалидируется **до** перехода к следующей комнате.

Если async generation можно безопасно отменить — task отменяется; generation guard все равно остается обязательным как последняя защита.

---

# ЧАСТЬ B. CONVERSATIONS И ЛС

## 16. Conversation = один человек, а не один транспорт

Один человек должен иметь **один непрерывный logical conversation**, даже если разговор начался в анонке, а продолжился в DM.

До handoff:

```text
conversation #184
channel = anon
telegram_peer_id = NULL
```

После подтвержденного handoff:

```text
conversation #184
channel = dm
telegram_peer_id = 123456789
```

История, facts, summary, sent media и active offer сохраняются.

Следующий новый анонимный человек получает новый `conversation_id`.

---

## 17. Transport snapshot у каждого сообщения

У сообщения обязательно хранится:

```text
transport = anon | dm
```

Поэтому после handoff можно восстановить, какие реплики были в anonymous bot и какие уже в личке.

---

## 18. Параллельные разговоры

Одновременно допустимо:

```text
anon #205 active
DM #184 active
DM #173 active
DM #151 active
...
```

Каждая conversation имеет отдельные:

- history;
- facts;
- summary;
- debounce buffer;
- async lock;
- pending generation version;
- active offer;
- sent media history;
- last activity;
- manual override state.

Контексты не смешиваются.

---

## 19. Handoff anon → DM

AI может семантически предложить переход:

```json
{"handoff_intent":"offer"}
```

Но сама модель не вызывает Telegram-команды.

Код:

```text
handoff_intent
→ AnonAdapter.request_link()   # например /link
→ state = HANDOFF_PENDING
→ создать handoff record
→ продолжать обрабатывать сообщения этой комнаты
```

### Подтверждение перехода

Обычный новый DM сам по себе может не содержать ссылку на anonymous room.

Порядок сопоставления:

1. **Уникальный token/prefilled text**, если конкретный link flow технически позволяет его передать.
2. Если bot просто отдает прямую ссылку на профиль — **temporal correlation**, потому что одновременно существует максимум один active `HANDOFF_PENDING`.
3. Кандидат: новый неизвестный DM peer, появившийся в handoff window и не имеющий существующей активной conversation.
4. Если одновременно возникли несколько неизвестных новых DM и соответствие неоднозначно — не угадывать. `handoff.state=ambiguous`, требуется ручное подтверждение.

Старый существующий DM нельзя случайно привязать к pending handoff.

### После `dm_confirmed`

Код автоматически:

1. привязывает `telegram_peer_id` к текущей conversation;
2. меняет `channel=dm`;
3. сохраняет тот же context/facts/summary/offers/media history;
4. инвалидирует old anon generation;
5. освобождает anon transport;
6. переводит AnonController в поиск следующего человека;
7. DM продолжает жить независимо.

**LLM не отдает отдельную команду «ищи нового».** Это обязательное code-side следствие подтвержденного handoff.

---

## 20. Handoff timeout

Если переход предложен, но человек не написал в ЛС, idle timeout продолжает действовать.

При истечении:

```text
handoff=expired
conversation end_reason=idle_timeout/handoff_expired
AnonAdapter.next()
SEARCHING
```

Если пользователь продолжает писать в анонке во время `HANDOFF_PENDING`, сообщения обрабатываются нормально и `last_activity_at` обновляется.

---

## 21. Ручные сообщения владельца и MANUAL_OVERRIDE

Поскольку используется **user-account**, владелец может сам открыть Telegram и что-то написать вручную.

Это обязательно учитывать.

### Все исходящие сообщения аккаунта — события

EventRouter должен обрабатывать не только incoming, но и релевантные outgoing messages.

Если сообщение отправлено вручную, а не нашим outbox:

1. найти соответствующую conversation;
2. записать сообщение в SQLite как `role=assistant`, `source=manual`;
3. обновить `last_activity_at`;
4. отменить/сделать stale конфликтующий pending AI response;
5. включить для этой conversation временный `MANUAL_OVERRIDE`.

### MANUAL_OVERRIDE

Это **не отдельный глобальный режим приложения**, а per-conversation cooldown.

Стартовый параметр:

```text
MANUAL_OVERRIDE_SECONDS = 60
```

Пока override активен:

- incoming сообщения сохраняются;
- AI не должна внезапно отправить параллельный ответ;
- после таймаута автоматика возобновляется;
- admin-командой можно resume раньше.

Если владелец вручную нажал кнопки/команды анончата, observed-state reconciliation синхронизирует AnonController.

---

# ЧАСТЬ C. ОБРАБОТКА СООБЩЕНИЙ И LLM

## 22. Debounce пачек сообщений

Telegram-пользователь часто пишет:

```text
слушай
короче
я вчера
увидел ее
ахах
```

Нельзя делать пять LLM calls.

Для каждой conversation:

```text
incoming
→ append pending batch
→ wait after LAST message
→ combine
→ one LLM call
```

Старт:

```text
MESSAGE_DEBOUNCE_MS = 1800
```

Новый message перезапускает debounce timer.

Per-conversation обработка строго последовательна; разные conversations могут обрабатываться параллельно.

---

## 23. `no_reply`

Иногда естественная реакция — ничего не отправлять.

Поэтому ответ LLM не должен требовать обязательный `text`.

```python
class ChatDecision(BaseModel):
    response_mode: Literal["reply", "no_reply"] = "reply"
    text: str | None = None
    ...
```

Правила:

- `no_reply` не означает завершение conversation;
- входящее сообщение все равно сохраняется;
- learned facts все равно могут примениться;
- таймер activity остается корректным;
- `no_reply` нельзя использовать вместо обработки service events — service events вообще не должны идти в обычный LLM pipeline;
- код не должен жестко игнорировать все `ага/ахах`: контекст может требовать ответа, поэтому для обычного текста это семантическое решение модели.

---

## 24. Concurrency model

Используем `asyncio`.

MUST:

- `asyncio.Lock` на conversation;
- отдельный lock у AnonController;
- `AsyncOpenAI`/асинхронный HTTP;
- global `asyncio.Semaphore` для LLM;
- async debounce/timers;
- graceful cancellation на shutdown;
- stale-generation/version guard перед отправкой.

Старт:

```text
LLM_MAX_CONCURRENCY = 4
```

---

## 25. Provider-agnostic LLM layer

Ни Telegram, ни conversation, ни media code не должны знать, что backend — DeepSeek.

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

Она покрывает DeepSeek и большинство локальных OpenAI-compatible серверов.

### DeepSeek

```dotenv
LLM_PROVIDER=openai_compatible
LLM_BASE_URL=https://api.deepseek.com
LLM_API_KEY=...
LLM_MODEL=deepseek-v4-flash
LLM_THINKING=disabled
```

### Локальная модель

```dotenv
LLM_PROVIDER=openai_compatible
LLM_BASE_URL=http://127.0.0.1:1234/v1
LLM_API_KEY=local
LLM_MODEL=<model-name>
```

Остальной проект не меняется.

Optional later:

```text
primary=local
fallback=deepseek
```

Но fallback должен быть отключаемым.

---

## 26. DeepSeek default policy

Для обычного Telegram-чата:

```text
DeepSeek V4 Flash
thinking/reasoning OFF
короткий max output
```

Reasoning не нужен по умолчанию для бытовых сообщений и только увеличивает latency/стоимость.

Отдельный escalation path для сложных запросов — LATER, только если метрики реально покажут пользу.

---

## 27. Нормализованный ChatDecision

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
    handoff_intent: Literal["none", "offer"] = "none"
```

Никогда не добавлять в эту схему:

```text
next_room
stop_room
search_room
payment_success
selected_media_id
end_conversation
```

---

## 28. Structured-output validation

1. Pydantic validation.
2. Максимум один дешевый repair/retry при полностью сломанной структуре.
3. Если удалось безопасно извлечь только обычный текст — разрешено отправить текст, но **игнорировать все непровалидированные действия**.
4. Никогда не выполнять Telegram/media/payment action из невалидного сырого JSON.

---

# ЧАСТЬ D. ПЕРСОНА, КОНТЕКСТ И ПАМЯТЬ

## 29. Одна фиксированная персона

Не создавать generic persona framework.

Хранение:

```text
app/llm/prompts/system.md
app/llm/prompts/persona.md
app/llm/prompts/examples.json
```

Persona задает:

- что это AI-девушка;
- имя/возраст/базовую биографию самой AI-персоны после окончательного выбора;
- стиль речи;
- среднюю длину сообщений;
- сленг/мат/эмодзи;
- инициативность;
- характер;
- отсутствие assistant-style фраз;
- отсутствие списков/канцелярита в обычном разговоре;
- несколько качественных few-shot примеров;
- не повторять «я AI» в каждом сообщении, но и не отрицать AI-природу.

---

## 30. Слои LLM-контекста

Порядок:

```text
1. SYSTEM CORE
2. PERSONA / BEHAVIOR
3. FEW-SHOT STYLE EXAMPLES
4. CURRENT RUNTIME CONTEXT
5. KNOWN FACTS ABOUT USER
6. ROLLING SUMMARY
7. RECENT MESSAGES
8. CURRENT MESSAGE BATCH
```

Стабильные пункты 1–3 идут в начале, чтобы максимизировать provider-side prefix/context caching там, где backend это поддерживает.

---

## 31. Факты о собеседнике

Новая anonymous conversation:

```text
facts = {}
```

Нет обязательной анкеты.

Если в обычной переписке выясняется:

```text
имя
возраст
пол
город
работа
интересы
события
предпочтения
```

они извлекаются **в том же LLM call**, который генерирует ответ.

Не делать отдельный extraction request на каждую реплику.

Факт хранит:

```text
key
value
confidence
source_message_id
updated_at
```

Неизвестные поля не передаются модели вообще.

---

## 32. Anonymous context budget

Для короткоживущей анонки:

- recent: ориентир 20–30 сообщений;
- facts: только реально узнанные;
- summary обычно не нужен до threshold;
- законченная conversation без handoff больше не участвует в LLM.

---

## 33. DM context budget

Для долгого DM:

- recent: ориентир 30–50 сообщений;
- durable facts;
- rolling summary;
- optional relationship state позже.

Не отправлять всю историю с начала знакомства.

---

## 34. Summary policy

Суммаризация запускается кодом только по threshold, например:

```text
unsummarized_messages >= 40
OR estimated_context_size > soft_limit
```

Тогда старый slice сворачивается один раз.

Summary — редкий дополнительный LLM-call, а не операция после каждой реплики.

---

## 35. Dynamic relationship state

Параметры вроде:

```text
interest
trust
irritation
flirt
```

можно добавить позже, но это **SHOULD/LATER**, не MUST.

Сначала проверить качество простой схемы:

```text
persona + few-shot + facts + summary + recent history
```

---

## 36. Human-like delivery

Не использовать старую схему:

```text
LLM latency + random 3..10 sec
```

Нужно задавать target total response time.

Стартовые ориентиры:

```text
short:   0.8–1.8s
normal:  1.5–3.0s
long:    2.5–5.0s
```

```text
additional_sleep = max(0, target_total - generation_elapsed)
```

Во время generation/delay использовать typing action, если это корректно для конкретного transport.

---

# ЧАСТЬ E. MEDIA VAULT

## 37. Media Vault

Canonical media storage — один приватный Telegram channel/chat.

Runtime generation отсутствует.

Преимущества:

- большие видео уже находятся в Telegram;
- можно пополнять библиотеку с телефона;
- локальный диск не обязан хранить все файлы;
- приложение хранит индекс;
- перед отправкой source message можно получить заново и тем самым обновить media/file reference.

---

## 38. Что хранить в SQLite

Не сериализовать Telegram media object «навечно».

Хранить:

```text
source_chat_id
source_message_id
```

Перед отправкой:

```text
fetch source message
→ получить актуальный media object
→ send/copy в target chat
```

Если file reference устарел — refetch source и один ограниченный retry.

---

## 39. Кружки

Video notes сохраняются в Vault как video note, если возможно.

`MediaSender` обязан сохранять тип `video_note`, а не превращать кружок в обычное видео.

---

## 40. Разметка медиа

Каждое media message в Vault имеет machine-readable caption.

Рекомендуемый формат:

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

### MUST

```text
type    = photo | video_note | video
access  = casual | teaser | paid
content = one or more semantic tags
```

### Optional

```text
view
outfit
scene
series
description
```

`description` — короткая ручная поясняющая строка для редких случаев, где одних тегов мало. Она хранится в каталоге, но **весь каталог описаний никогда не отправляется LLM**.

---

## 41. Минимальная taxonomy

Начальный словарь:

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

Словарь расширяется конфигом/кодом без миграции схемы БД.

Не создавать 30 обязательных колонок.

---

## 42. MediaIndexer

1. Читает Vault.
2. Ищет `#anonka_media`.
3. Парсит caption.
4. Валидирует MUST поля/tags.
5. Upsert `(source_chat_id, source_message_id)`.
6. Невалидный asset логируется и не участвует в выборе.
7. `.media reindex` перечитывает metadata.
8. Временная Telegram-ошибка не должна автоматически удалять asset из DB.

---

## 43. LLM не выбирает файл

LLM возвращает только семантику:

```json
{
  "media_intent": {
    "media_type": "photo",
    "access": "paid",
    "content": ["breasts"],
    "view": ["front"]
  }
}
```

Она **не видит** `message_id`, filenames и полный каталог.

---

## 44. MediaSelector

MUST фильтры:

- `enabled=true`;
- подходящий `access`;
- подходящий `media_type`;
- обязательные `content` tags совпадают;
- asset еще не отправлялся этой conversation.

Пример scoring:

```text
exact content      +10
exact view          +5
exact outfit        +5
exact media type    +3
same series         +2
already sent       EXCLUDE
high global usage   -1
```

Выбирать случайно из top-N сопоставимых кандидатов, чтобы не отправлять всем всегда один и тот же asset.

---

## 45. Fallback media matching

Fallback только явный и ограниченный.

Допустимо:

```text
video_note + breasts
→ none
photo + breasts
→ found
```

Недопустимо:

```text
request=breasts
→ отправить butt-only asset просто потому, что он есть
```

Если релевантного asset нет:

```text
MEDIA_NOT_AVAILABLE
```

Код ничего случайного не отправляет.

---

## 46. Series continuity

`series` nullable.

Если используется, selector может предпочитать текущую серию/локацию/одежду для визуальной непрерывности.

Это SHOULD, а не обязательный MVP-блок.

---

## 47. Что реально было отправлено — вернуть в контекст

Критически важно различать:

```text
LLM хотела отправить X
```

и

```text
код реально отправил конкретный asset Y
```

После успешной отправки MediaSender записывает `conversation_media` и внутреннее domain event, например:

```json
{
  "event":"media_sent",
  "media_type":"photo",
  "access":"paid",
  "content":["breasts"],
  "view":["front"],
  "outfit":["lingerie"],
  "scene":["bedroom"],
  "series":"bedroom_01"
}
```

На **следующем** обычном LLM-call ContextBuilder добавляет компактный факт о реально отправленном медиа.

Это позволяет модели корректно понимать:

> «а есть такая же сзади?»

без отправки полного Media Vault в контекст.

---

# ЧАСТЬ F. OFFERS И TELEGRAM GIFTS

## 48. Access classes

```text
casual
teaser
paid
```

`casual/teaser` могут быть отправлены сразу согласно local policy.

`paid` — только после подтвержденного Gift.

---

## 49. Offer flow

Для платного запроса лучше **зарезервировать конкретный asset до оплаты**.

```text
user context/request
→ LLM OfferIntent
→ MediaSelector finds compatible unsent asset
→ if none: offer not created
→ read current runtime minimum Gift price
→ create Offer(price_snapshot, selected_asset_id, intent_snapshot)
→ wait Gift
```

Offer хранит:

```text
required_stars_snapshot
selected_asset_id
media_intent_snapshot
status
```

Изменение `.price` не меняет существующий offer.

---

## 50. Цена через Gifts

Runtime config:

```text
offer_price_stars = 30 / 50 / ...
```

Фактически Telegram Gifts имеют доступные платформой номиналы, поэтому базовая policy:

```text
single received Gift with known star value >= required_stars_snapshot
→ payment satisfied
```

Перед production-like запуском GiftAdapter должен подтвердить, какие поля и номиналы реально приходят на установленной версии Telethon/MTProto.

Если exact 30/50 Gift недоступен, UI/персонаж должен ориентироваться на существующий подходящий Gift, а snapshot policy остается `>= threshold`.

---

## 51. GiftDetector

GiftDetector работает только по Telegram event данным.

Нужно получить, насколько позволяет установленная версия Telethon/MTProto:

```text
telegram_chat_id
telegram_message_id / stable event key
sender_peer_id
gift identifier
gift star value
received_at
```

До реализации обязательно:

- поймать реальный Gift service message;
- сохранить raw fixture;
- проверить exact Telethon type/fields;
- написать integration test.

Если `gift_stars` нельзя надежно определить — **не считать payment автоматически** до появления корректного adapter mapping.

---

## 52. Gift edge cases

### Gift от нужного peer + достаточная стоимость

```text
active waiting offer
sender matches conversation peer
stars >= required
→ PAID
```

### Gift дешевле required

```text
record gift
keep offer WAITING
no media fulfillment
```

Не делать скрытое накопление нескольких gifts в MVP.

### Gift без active offer

```text
record as unmatched
matched_offer_id=NULL
nothing is sent
```

### Gift после expired/cancelled offer

Не «воскрешать» старый offer автоматически.

### Gift от другого peer

Никогда не оплачивает чужой offer.

### Duplicate Gift/update

Один event может учитываться один раз:

```text
UNIQUE(telegram_chat_id, telegram_message_id)
```

или другой подтвержденный stable key.

### Gift уже использован

`matched_offer_id` не может быть перепривязан ко второму offer.

---

## 53. Fulfillment после оплаты

LLM не вызывается.

```text
Gift received
→ dedupe
→ match waiting Offer
→ DB transaction Offer WAITING -> PAID
→ enqueue SEND_MEDIA(selected_asset_id)
→ MediaSender
→ conversation_media
→ Offer FULFILLED
```

После этого следующий обычный LLM context получает компактный system/domain fact:

```text
agreed gift received; reserved media was delivered
```

---

## 54. Crash между payment и send

```text
Gift recorded
Offer=PAID
PROCESS CRASH
media not sent
```

После restart:

```text
SELECT offers
WHERE status='paid'
AND fulfilled_at IS NULL
```

RecoveryService повторно ставит fulfillment в outbox.

Оплата не теряется.

---

# ЧАСТЬ G. RUNTIME CONTROL

## 55. Runtime config

Boot-time infrastructure — `.env`.

Меняемые на ходу значения — SQLite `runtime_config`.

Минимум:

```text
offer_price_stars
anon_enabled
offers_enabled
media_enabled
```

---

## 56. Точная семантика переключателей

### `.anon stop`

- прекращает автоматический поиск новых anon rooms;
- завершает/останавливает anon controller согласно выбранной безопасной policy;
- **существующие DM продолжают работать**;
- не отключает LLM глобально.

### `.anon next`

- сначала инвалидирует текущий `room_generation`;
- отменяет stale pending reply;
- затем выполняет controlled skip/next;
- не влияет на DM.

### `.offers off`

- запрещает создание новых Offers;
- существующие `WAITING` можно либо оставить действующими до expiry, либо отдельно отменить командой — policy должна быть явной;
- уже `PAID` offer обязательно исполняется.

Рекомендуемый default: existing waiting offers остаются действующими до собственного expiry.

### `.media off`

- запрещает новые casual/teaser sends и новые media intents;
- **не должен блокировать fulfillment уже PAID offer**, иначе можно получить оплату и не отправить зарезервированный asset.

### `.price N`

- меняет только новые Offers;
- старые используют `required_stars_snapshot`.

---

## 57. Admin interface

Минимальный надежный вариант — **Saved Messages** собственного Telegram-аккаунта.

Команды:

```text
.anon start
.anon stop
.anon next
.anon status

.price 30
.offers on
.offers off
.media on
.media off
.media reindex

.status
.dm resume <peer/conversation>
.dm pause <peer/conversation>
```

Admin commands:

- распознаются только от self-account;
- никогда не идут в LLM;
- никогда не пересылаются собеседникам.

CLI можно оставить как дополнительный offline diagnostic tool.

---

# ЧАСТЬ H. PERSISTENCE

## 58. SQLite

```sql
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
PRAGMA busy_timeout=5000;
```

Один процесс + SQLite достаточно.

---

## 59. `conversations`

```text
id                    INTEGER PK
channel               anon | dm
state                 active | handoff_pending | ended
telegram_peer_id      INTEGER NULL
anon_generation       INTEGER NULL
created_at
updated_at
last_activity_at
manual_override_until NULL
ended_at              NULL
end_reason            NULL
```

Индексы:

```text
(channel, state)
telegram_peer_id
```

Не более одной активной DM conversation на один peer.

---

## 60. `messages`

```text
id
conversation_id FK
role             user | assistant | system
transport        anon | dm
kind             text | service | media | gift | internal
source           partner | llm | manual | system
telegram_chat_id NULL
telegram_message_id NULL
text             NULL
created_at
```

Dedupe по Telegram message key, когда он существует.

---

## 61. `conversation_facts`

```text
conversation_id FK
key
value_json
confidence
source_message_id NULL
updated_at
PRIMARY KEY(conversation_id, key)
```

Не создавать колонку для каждого нового свойства человека.

---

## 62. `conversation_summaries`

```text
id
conversation_id FK
through_message_id
summary_text
created_at
```

Хранить версии.

---

## 63. `handoffs`

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

## 64. `media_assets`

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
use_count
created_at
updated_at
UNIQUE(source_chat_id, source_message_id)
```

---

## 65. `conversation_media`

```text
id
conversation_id FK
media_asset_id FK
reason casual | teaser | paid | manual
telegram_message_id NULL
metadata_snapshot_json
sent_at
UNIQUE(conversation_id, media_asset_id)
```

`metadata_snapshot_json` позволяет восстановить, **что именно реально было отправлено**, даже если caption в Vault позже изменился.

---

## 66. `offers`

```text
id
conversation_id FK
status waiting | paid | fulfilled | expired | cancelled
required_stars
media_intent_json
selected_asset_id FK
created_at
expires_at NULL
paid_at NULL
fulfilled_at NULL
```

Для MVP максимум один `waiting` offer на conversation.

---

## 67. `gifts`

```text
id
telegram_chat_id
telegram_message_id
gift_ref NULL
sender_peer_id
gift_stars NULL
received_at
matched_offer_id NULL
UNIQUE(telegram_chat_id, telegram_message_id)
```

---

## 68. `runtime_config`

```text
key TEXT PK
value_json
updated_at
```

---

## 69. `events`

```text
id
conversation_id NULL
event_type
payload_json
created_at
```

---

## 70. `outbox`

```text
id
conversation_id NULL
action_type
payload_json
idempotency_key UNIQUE
status pending | processing | done | failed
attempts
available_at
last_error NULL
created_at
completed_at NULL
```

Типы:

```text
send_text
send_media
anon_search
anon_next
anon_stop
anon_link
```

---

## 71. `app_state`

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

# ЧАСТЬ I. IDEMPOTENCY, RECOVERY, RETRIES

## 72. Exactly-once-ish semantics

Абсолютное exactly-once через Telegram не гарантируется.

Цель:

> **idempotent at-least-once + локальная дедупликация.**

Incoming:

1. dedupe Telegram event;
2. save message/event;
3. update state/activity;
4. commit.

Outgoing:

1. создать outbox row с unique `idempotency_key`;
2. dispatcher отправляет;
3. сохранить returned message id;
4. mark done.

---

## 73. Retry LLM

Только временные ошибки:

```text
timeout
connection reset
5xx
429
```

Старт:

```text
2–3 attempts
exponential backoff + jitter
```

API timeout сам по себе не является причиной автоматического skip собеседника.

---

## 74. Retry Telegram

FloodWait:

- сохранить/оставить outbox action;
- отложить до разрешенного времени;
- не спрашивать LLM, что делать.

Media reference:

- refetch source message;
- один bounded retry.

---

## 75. Startup recovery

Порядок:

1. открыть SQLite;
2. migrations;
3. WAL/foreign keys;
4. поднять Telethon session;
5. resolve own account ID, anon bot peer, Vault peer;
6. восстановить incomplete outbox;
7. восстановить `PAID && !FULFILLED` offers;
8. восстановить DM conversations;
9. прочитать сохраненное anon state;
10. **reconcile с фактическим состоянием анон-бота**, а не слепо отправлять `/next`;
11. восстановить timers/debounce после reconciliation.

---

# ЧАСТЬ J. АНАЛИТИКА И СТОИМОСТЬ

## 76. События аналитики

Без LLM:

```text
app_started
anon_search_started
anon_search_watchdog
anon_room_started
anon_first_message
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
dm_message_received
manual_message_sent
manual_override_started
offer_created
offer_price_snapshot
gift_received
gift_unmatched
gift_insufficient
offer_paid
offer_expired
media_selected
media_sent
media_unavailable
llm_request
llm_error
llm_schema_error
telegram_flood_wait
```

---

## 77. Метрики

Считать кодом:

```text
anon rooms → handoff rate
handoff → DM rate
DM → offer rate
offer 30 Stars → Gift conversion
offer 50 Stars → Gift conversion
average messages before handoff
average messages before offer
idle/skip rate
media category request frequency
LLM calls per conversation
LLM cost per conversation
```

---

## 78. Usage accounting

Сохранять provider usage, если доступно:

```text
input_tokens
cached_input_tokens
output_tokens
model
latency_ms
```

Это источник истины по расходам.

---

## 79. Примерная модель стоимости LLM

Точные тарифы провайдера меняются, поэтому архитектура **не должна зашивать цену в код**. Расчет ниже — методика, а не постоянная тарифная константа.

Для оценки допустим:

```text
1 conversation ≈ 20 LLM turns after debounce
average effective input ≈ 2,000 tokens/turn
average output ≈ 80 tokens/turn
```

Тогда на один разговор:

```text
input  ≈ 40,000 tokens
output ≈ 1,600 tokens
```

На 100 разговоров:

```text
input  ≈ 4.0M tokens
output ≈ 0.16M tokens
```

На 1000 разговоров:

```text
input  ≈ 40M tokens
output ≈ 1.6M tokens
```

Фактическая стоимость считается:

```text
(cost_input_miss × miss_tokens)
+ (cost_input_cache × cached_tokens)
+ (cost_output × output_tokens)
```

Главные рычаги экономии:

1. debounce;
2. `no_reply` там, где он семантически уместен;
3. никакой LLM на timers/search/next/stop/Gifts/media lookup;
4. facts внутри основного reply call;
5. stable prompt prefix;
6. ограниченный recent history;
7. summary по threshold;
8. короткий max output;
9. thinking OFF;
10. локальный MediaSelector;
11. возможность локальной LLM.

Для реального бюджета использовать только фактические `usage` логи выбранного provider.

---

# ЧАСТЬ K. CONFIG, SECRETS, DEPLOYMENT

## 80. Boot-time `.env`

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
DATABASE_PATH=data/anonka.sqlite3
LOG_LEVEL=INFO
DRY_RUN=false
```

Runtime `price/on/off` не хранить в `.env`.

---

## 81. Secrets

MUST:

- `.env` gitignored;
- Telethon `.session` gitignored;
- SQLite DB gitignored;
- API key не попадает в logs;
- Telegram session file считать секретом уровня пароля;
- Vault приватный;
- полный plaintext чатов в console logs по умолчанию не печатать;
- делать безопасный backup SQLite.

---

## 82. Deployment

MVP:

```text
один Windows/Linux ПК или VPS
один Python process
одна Telethon session
одна SQLite DB
```

Не запускать два активных экземпляра с одной и той же session/DB без отдельной leader-lock архитектуры.

Добавить простой process lock/DB lock, чтобы случайно не поднять второй экземпляр.

---

# ЧАСТЬ L. ФАЙЛОВАЯ СТРУКТУРА

## 83. Целевая структура

```text
ai_chat_experiment/
├── app/
│   ├── main.py
│   ├── config.py
│   ├── logging_setup.py
│   │
│   ├── domain/
│   │   ├── models.py
│   │   ├── enums.py
│   │   └── events.py
│   │
│   ├── persistence/
│   │   ├── db.py
│   │   ├── migrations.py
│   │   └── repositories.py
│   │
│   ├── tg/
│   │   ├── client.py
│   │   ├── router.py
│   │   ├── sender.py
│   │   └── typing.py
│   │
│   ├── anon/
│   │   ├── adapter.py
│   │   ├── parser.py
│   │   ├── controller.py
│   │   ├── state.py
│   │   ├── reconciliation.py
│   │   └── timers.py
│   │
│   ├── dm/
│   │   ├── adapter.py
│   │   ├── handoff.py
│   │   └── manual_override.py
│   │
│   ├── conversation/
│   │   ├── service.py
│   │   ├── debounce.py
│   │   ├── context.py
│   │   ├── facts.py
│   │   └── summary.py
│   │
│   ├── llm/
│   │   ├── base.py
│   │   ├── openai_compatible.py
│   │   ├── service.py
│   │   ├── schemas.py
│   │   └── prompts/
│   │       ├── system.md
│   │       ├── persona.md
│   │       └── examples.json
│   │
│   ├── media/
│   │   ├── catalog.py
│   │   ├── indexer.py
│   │   ├── tags.py
│   │   ├── selector.py
│   │   └── sender.py
│   │
│   ├── commerce/
│   │   ├── offers.py
│   │   └── gifts.py
│   │
│   ├── admin/
│   │   └── commands.py
│   │
│   ├── analytics/
│   │   └── events.py
│   │
│   └── runtime/
│       ├── outbox.py
│       ├── recovery.py
│       ├── scheduler.py
│       └── instance_lock.py
│
├── data/
│   └── anonka.sqlite3
├── tests/
├── .env
├── .env.example
├── requirements.txt
└── run.py
```

Вводить структуру поэтапно, а не создавать десятки пустых файлов одним коммитом.

---

# ЧАСТЬ M. SEQUENCE FLOWS

## 84. Новый anonymous conversation

Если есть room-ready signal:

```text
admin/start
→ AnonController SEARCHING
→ AnonAdapter.search
→ observed ROOM_READY
→ create Conversation(channel=anon, facts={})
→ ROOM_ACTIVE
→ optional first LLM opener
```

Если сигнала нет:

```text
SEARCHING
→ first partner message
→ create Conversation(facts={})
→ ROOM_ACTIVE
→ debounce
→ LLM
```

---

## 85. Пачка сообщений

```text
msg1
→ pending batch
msg2 0.4s later
→ reset debounce
msg3 0.7s later
→ reset debounce
1.8s silence
→ combine
→ one LLM call
→ validate ChatDecision
→ apply facts/intents
→ target delay/typing
→ send or no_reply
```

---

## 86. Idle skip

```text
ROOM_ACTIVE
→ no meaningful activity 600s
→ invalidate generation
→ close conversation
→ AnonAdapter.next
→ observed SEARCHING
```

---

## 87. Partner skips first

```text
observed PARTNER_LEFT
→ invalidate generation
→ cancel timer/stale task
→ close conversation
→ if bot already searches: reconcile only
→ else search next
```

---

## 88. Search watchdog

```text
SEARCHING
→ 90s without room
→ reconcile observed bot state
→ search still active: wait/backoff
→ stopped: retry search
→ unknown: bounded retry, log/alert
```

---

## 89. Handoff

```text
LLM handoff_intent
→ code /link
→ HANDOFF_PENDING
→ new unknown DM appears
→ correlate/confirm
→ same conversation channel=dm
→ bind peer_id
→ invalidate anon generation
→ AnonController starts next search
→ DM continues
```

---

## 90. Несколько параллельных DM

```text
DM #184 → lock #184 → LLM A
Anon #201 → lock #201 → LLM B
DM #173 → lock #173 → LLM C

Global semaphore limits total LLM concurrency.
```

---

## 91. Manual owner message

```text
LLM job pending
→ owner manually sends text in Telegram
→ outgoing event detected
→ persist manual text
→ mark pending AI job stale
→ MANUAL_OVERRIDE 60s
→ no duplicate AI reply
→ auto-resume after cooldown
```

---

## 92. Semantic media request

```text
USER asks specific media
→ LLM MediaIntent
→ MediaSelector
→ exact tags / allowed fallback
→ exclude sent
→ casual/teaser: send
→ paid: create Offer reservation
```

---

## 93. Gift → paid media

```text
Offer WAITING price=50 asset=731
→ Gift from same DM peer value>=50
→ dedupe
→ transaction Offer=PAID + Gift matched
→ outbox SEND_MEDIA 731
→ fetch fresh source media
→ send
→ conversation_media metadata snapshot
→ Offer=FULFILLED
```

---

## 94. Restart после Gift

```text
Offer=PAID
fulfilled_at=NULL
PROCESS CRASH
→ restart
→ RecoveryService
→ re-enqueue SEND_MEDIA
→ fulfill
```

---

## 95. Старый LLM ответ после anon skip

```text
job generation=40
→ room generation becomes 41
→ job finishes
→ pre-send guard sees mismatch
→ DROP
```

---

# ЧАСТЬ N. TESTING

## 96. Unit tests MUST

- anon state transitions;
- room creation without profile metadata;
- idle timeout;
- SEARCHING watchdog;
- observed-state reconciliation;
- repeated `partner_left` idempotent;
- stale generation dropped;
- debounce batches messages;
- no context mixing;
- manual outgoing message stored;
- manual override blocks duplicate AI response;
- `no_reply` does not end conversation;
- facts upsert;
- handoff confirmation/expiry/ambiguity;
- media caption parser;
- selector exact tags;
- no repeat to same conversation;
- `breasts` request never silently selects `butt`-only asset;
- real sent-media metadata appears in subsequent context;
- offer price snapshot survives `.price` change;
- wrong-peer Gift cannot pay offer;
- insufficient Gift stays waiting;
- unmatched Gift sends nothing;
- expired offer not resurrected;
- duplicate Gift not double-counted;
- PAID fulfillment ignores `.media off` and still completes;
- paid-but-unfulfilled recovery;
- outbox idempotency;
- second app instance lock.

---

## 97. Integration tests SHOULD

- fake OpenAI-compatible server;
- fake Telethon messages;
- real captured anonymous-bot fixtures;
- `MessageEdited`/reply-markup state fixture;
- real captured Gift raw fixture;
- media Vault fetch/send mock;
- restart after every critical DB transition;
- FloodWait simulation;
- expired file reference simulation;
- invalid LLM JSON;
- local-model compatibility test.

---

## 98. DRY_RUN

Существующий `DRY_RUN` сохранить и расширить:

- state machine и DB работают реально;
- outgoing Telegram actions не отправляются;
- actions логируются;
- LLM можно использовать реальную или `FakeLLMProvider`;
- Gift/media fixtures можно проигрывать локально.

---

# ЧАСТЬ O. LOGGING

## 99. Structured logging

Поля:

```text
conversation_id
telegram_peer_id
anon_generation
event_type
llm_model
latency_ms
outbox_id
offer_id
```

Не логировать secrets.

Полные тексты чатов в console logs по умолчанию не нужны — они уже в SQLite.

---

# ЧАСТЬ P. DEPENDENCIES

## 100. Runtime dependencies

Минимум:

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

Не добавлять framework без необходимости.

Migrations можно начать простым `schema_version + ordered SQL migrations`; Alembic не обязателен для такого MVP.

---

# ЧАСТЬ Q. ПЛАН РЕФАКТОРИНГА

## 101. Этап 1 — persistence/domain

- SQLite/WAL;
- migrations;
- conversations/messages/events;
- repositories;
- instance lock;
- убрать RAM-only историю как источник истины.

## 102. Этап 2 — provider-agnostic async LLM

- `XAI_*` → `LLM_*`;
- `GrokClient` → `OpenAICompatibleProvider`;
- `AsyncOpenAI`;
- Pydantic ChatDecision;
- убрать `action=end`;
- добавить `no_reply`.

## 103. Этап 3 — ConversationService

- locks;
- debounce;
- facts;
- ContextBuilder;
- recent history;
- target delivery timing;
- outgoing/manual event ingestion;
- manual override.

## 104. Этап 4 — AnonAdapter/Controller

- protocol reconnaissance конкретного bot;
- event parser;
- commands/buttons;
- state machine;
- observed-state reconciliation;
- idle timeout;
- SEARCHING watchdog;
- generation guard;
- admin start/stop/next.

## 105. Этап 5 — DM/Handoff

- routing ordinary DM by peer ID;
- pending handoff;
- temporal/token correlation;
- ambiguity handling;
- same conversation migration anon→dm;
- auto-search next after confirmed DM.

## 106. Этап 6 — persona/context/summary

- prompt files;
- few-shot examples;
- separate anon/DM budgets;
- rolling summary threshold;
- stable prefix ordering.

## 107. Этап 7 — Media Vault

- channel indexer;
- tags;
- selector;
- no-repeat;
- actual-sent metadata snapshot;
- video note send;
- refetch expired media reference.

## 108. Этап 8 — Offers/Gifts

- runtime price;
- asset reservation;
- Gift raw fixture;
- GiftDetector;
- edge-case policies;
- fulfillment/recovery.

## 109. Этап 9 — Outbox/hardening

- idempotent outgoing actions;
- retry/backoff;
- FloodWait;
- startup reconciliation;
- backup procedure.

## 110. Этап 10 — Analytics/admin

- Saved Messages commands;
- funnel events;
- cost metrics;
- price experiments.

---

# ЧАСТЬ R. MUST / SHOULD / LATER

## 111. MUST для рабочего MVP

- one Telethon user-account;
- one anonymous bot adapter;
- no assumed profile metadata;
- anon state machine;
- continuous observed-state reconciliation;
- 10-minute idle skip;
- SEARCHING watchdog;
- SQLite restart safety;
- one conversation per person;
- anon→DM handoff preserving same context;
- parallel DMs;
- provider-neutral async LLM;
- DeepSeek V4 Flash default, thinking off;
- easy local OpenAI-compatible switch;
- debounce;
- `no_reply`;
- persona/few-shot;
- facts extracted in normal reply call;
- manual outgoing event capture;
- MANUAL_OVERRIDE;
- stale generation guard;
- Media Vault;
- semantic tags;
- local MediaSelector;
- actual-sent media metadata fed back into future context;
- no-repeat;
- runtime Gift threshold/price;
- Offer with price+asset snapshot;
- GiftDetector with strict peer/dedupe matching;
- Gift edge cases;
- fulfillment without LLM;
- crash recovery;
- admin start/stop/next/price/reindex;
- runtime-toggle semantics;
- event analytics.

## 112. SHOULD после первого работающего цикла

- rolling summary;
- outbox for every outgoing action;
- series continuity;
- smarter cancellation of in-flight LLM;
- detailed provider cost reports;
- automatic DB backup;
- local primary + DeepSeek fallback option;
- richer status command.

## 113. LATER

- numeric relationship state;
- automatic vision tagging;
- cumulative gifts;
- multiple personas;
- Postgres;
- Redis;
- distributed workers;
- web dashboard;
- Business Bot;
- runtime media generation.

---

# ЧАСТЬ S. ВЕРСИИ И ВНЕШНИЕ API

## 114. Version pinning

Telegram/Telethon/DeepSeek API меняются, поэтому перед реализацией adapter-sensitive частей нужно зафиксировать версии в `requirements.txt`/lock file.

Особенно чувствительны:

- Telethon Gift service-message types;
- raw MTProto update types;
- video-note/media resend semantics;
- DeepSeek thinking/structured-output параметры.

Не строить доменную архитектуру вокруг нестабильного конкретного имени Telethon raw class. Это detail Adapter layer.

---

## 115. Рекомендуемые официальные источники для проверки при реализации

Проверять актуальное состояние на дату реализации:

- Telegram MTProto/API: `https://core.telegram.org/api`
- Telegram Gifts/Stars: `https://core.telegram.org/api/gifts`
- Telegram API links: `https://core.telegram.org/api/links`
- Telethon docs: `https://docs.telethon.dev/`
- DeepSeek API docs: `https://api-docs.deepseek.com/`
- DeepSeek thinking mode: `https://api-docs.deepseek.com/guides/thinking_mode`
- DeepSeek multi-round chat: `https://api-docs.deepseek.com/guides/multi_round_chat`
- DeepSeek pricing: `https://api-docs.deepseek.com/quick_start/pricing/`

Документ фиксирует архитектурный контракт. Exact raw field names и актуальные тарифы всегда подтверждаются официальной документацией и fixture tests непосредственно перед реализацией.

---

# ЧАСТЬ T. DEFINITION OF DONE

## 116. Первая полноценная версия считается готовой, если

```text
1. Приложение запускается и восстанавливает SQLite state.
2. Начинает/восстанавливает поиск в анончате.
3. Новый человек появляется без исходной анкеты; создается facts={}. 
4. AI ведет обычный разговор.
5. Быстрые сообщения объединяются debounce.
6. Имя/возраст/город и другие факты сохраняются, если реально всплыли.
7. LLM может выбрать no_reply без завершения разговора.
8. Через 10 минут неактивности код скипает комнату без LLM.
9. Если SEARCHING завис, watchdog делает reconcile/retry без спама.
10. Если человек скипнул, старый pending LLM ответ никогда не уходит следующему.
11. Если владелец вручную нажал next/stop, observed state корректно синхронизируется.
12. Если владелец вручную написал человеку, сообщение входит в историю и AI временно не дублирует ответ.
13. AI может предложить переход; код вызывает /link.
14. После подтвержденного нового DM тот же conversation продолжает жить в ЛС.
15. AnonController сразу начинает искать следующего человека.
16. Старый DM и новый anon работают параллельно.
17. LLM возвращает MediaIntent, но никогда не выбирает message_id.
18. MediaSelector подбирает релевантный unsent asset по тегам.
19. Запрос груди не превращается автоматически в нерелевантный butt-only asset.
20. После отправки в будущий контекст попадают metadata реально отправленного asset.
21. Для paid media создается Offer с asset+price snapshot.
22. .price меняет только новые Offers.
23. Gift от нужного peer и достаточной стоимости локально переводит Offer в PAID.
24. Недостаточный/unmatched/wrong-peer/duplicate Gift не приводит к ошибочной выдаче.
25. PAID fulfillment выполняется кодом без дополнительного LLM call.
26. .media off не ломает fulfillment уже оплаченного Offer.
27. Crash между Gift и send восстанавливается после restart.
28. .anon stop не отключает существующие DM.
29. DeepSeek можно заменить локальным OpenAI-compatible endpoint конфигурацией.
30. Реальная стоимость считается по usage logs, а не по догадкам.
```

Если выполняются эти 30 пунктов, система соответствует согласованной архитектуре и не содержит ненужного раздувания для текущей задачи.
