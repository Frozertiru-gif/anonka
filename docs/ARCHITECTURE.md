# Anonka — целевая архитектура

> Статус: согласованная архитектурная спецификация для следующей версии проекта.  
> Репозиторий: `Frozertiru-gif/anonka`  
> Цель документа: зафиксировать все решения по архитектуре до начала большого рефакторинга.

---

## 1. Что строим

`anonka` — один постоянно работающий Python-процесс под пользовательским Telegram-аккаунтом через Telethon.

Система должна:

1. Общаться через существующего Telegram-бота анонимных знакомств/анончата.
2. В каждый момент времени обслуживать один активный анонимный диалог этого бота.
3. Самостоятельно управлять жизненным циклом анончата: начать поиск, остановить поиск, перейти к следующему собеседнику, понять завершение/скип, обработать таймаут.
4. Вести каждый новый анонимный разговор в отдельном контексте без данных предыдущего человека.
5. По ходу обычной переписки узнавать имя, возраст, пол, город и другие факты о собеседнике. При старте комнаты никаких таких данных нет.
6. Уметь предложить переход в обычный личный чат Telegram и перенести туда весь полезный контекст текущего человека.
7. После подтвержденного перехода в ЛС немедленно освобождать анончат и искать следующего человека, не прекращая общение в уже открытых ЛС.
8. Одновременно вести много независимых личных диалогов и один анонимный поток.
9. Использовать одну фиксированную AI-девушку/персонажа. Multi-persona, выбор девушек и marketplace не нужны.
10. Прямо позиционировать персонажа как AI. Проект не должен строиться на техническом притворстве реальным человеком.
11. Генерировать в runtime только текст. Фото, видео и Telegram video notes/«кружки» готовятся заранее внешними сервисами.
12. Хранить подготовленные медиа в приватном Telegram-канале/чате и отправлять оттуда.
13. Понимать семантику медиа по тегам, а не выбирать случайный файл.
14. Считать получение подходящего Telegram Gift от конкретного пользователя фактом оплаты текущего предложения.
15. Позволять менять цену предложения во время работы, не меняя промпт и код. Уже созданное предложение сохраняет цену-снимок.
16. Быть экономным по LLM: batching сообщений, короткий контекст, summary/facts, никаких лишних LLM-вызовов там, где задачу надежно решает код.
17. Позволять заменить DeepSeek на локальную OpenAI-compatible модель без переделки остального приложения.
18. Переживать перезапуск процесса без потери активных DM-контекстов, оплаченных предложений и состояния анончата.

---

## 2. Главный архитектурный принцип

**LLM отвечает за язык и семантику. Код отвечает за состояние системы и действия.**

LLM разрешено:

- написать текст ответа;
- извлечь новые факты из текущего разговора в структурированном виде;
- выразить намерение предложить переход в ЛС;
- выразить намерение отправить/предложить медиа определенного типа и содержания;
- при необходимости сформировать обычную реплику с учетом уже подтвержденных событий.

LLM не разрешено напрямую:

- решать, существует ли активная комната;
- считать таймеры;
- решать, прошли ли 10 минут;
- определять, что Telegram Gift реально получен;
- выбирать `message_id` конкретного медиа;
- выбирать конкретный файл из канала;
- самостоятельно менять SQLite;
- самостоятельно выполнять `/next`, `/stop`, `/search`, `/link`;
- сбрасывать контекст;
- считать оплату успешной;
- самостоятельно завершать разговор только потому, что собеседник написал «ок»/«пон»;
- управлять ретраями Telegram/LLM;
- решать проблему FloodWait;
- обеспечивать идемпотентность.

Все это — детерминированная логика приложения.

---

## 3. Что не нужно сейчас

Не проектировать в MVP:

- несколько AI-девушек;
- `persona_id`, каталоги персонажей, переключение персонажей;
- генерацию фото/видео в runtime;
- отдельный Telegram Business Bot без доказанной необходимости;
- Postgres;
- Redis;
- Celery/RQ;
- микросервисы;
- Kubernetes/Docker Swarm;
- vector DB;
- embeddings/RAG для обычного диалога;
- автоматическое vision-тегирование медиатеки;
- сложный web-admin;
- много процессов/воркеров;
- отдельную платежную систему, invoice flow и checkout, пока GiftDetector решает задачу;
- сложную «психологическую симуляцию» персонажа как обязательную часть MVP.

Один процесс + Telethon + SQLite + LLM + приватный media channel достаточно.

---

## 4. Текущее состояние репозитория и что в нем не подходит целевой задаче

Текущий проект полезен как каркас, но архитектурно пока является одиночным автоответчиком:

- `app/tg/handlers.py` обрабатывает входящее сообщение и сразу вызывает `ReplyService`.
- `app/tg/filters.py` фильтрует сообщения по одному `TG_TARGET_USERNAME`.
- `app/chat/session.py` хранит историю только в RAM.
- Состояние фактически сведено к `active/ended`.
- После перезапуска память исчезает.
- `app/llm/grok_client.py` синхронно вызывает OpenAI-compatible API и заточен по именам под xAI/Grok.
- LLM возвращает `action=continue/end`, то есть модель сейчас участвует в управлении жизненным циклом диалога.
- `safety/validators.py` завершает разговор на коротких репликах вроде `ок`/`пон`; для естественного чата это необходимо убрать.
- Фиксированная задержка после LLM-запроса добавляет лишнюю латентность.
- Нет независимых DM-контекстов.
- Нет state machine анончата.
- Нет persistence, handoff, media index, gifts/offers, outbox, analytics.

Проект **не надо переписывать с нуля**. Сохраняем Python, Telethon, asyncio, общую идею разбиения на `tg/`, `chat/`, `llm/`, `services/`, но меняем ответственность модулей.

---

## 5. Верхнеуровневая схема

```text
                         TELEGRAM ACCOUNT
                               │
                         TelethonClient
                               │
                    ┌──────────┴──────────┐
                    │                     │
              ANON BOT EVENTS           REAL DMs
                    │                     │
                AnonAdapter             DMAdapter
                    │                     │
                    └──────────┬──────────┘
                               │
                         EventRouter
                               │
              ┌────────────────┼─────────────────┐
              │                │                 │
        AnonController  ConversationService  GiftDetector
              │                │                 │
              │                ▼                 │
              │          Debounce/Locks          │
              │                │                 │
              │          ContextBuilder          │
              │                │                 │
              │                ▼                 │
              │            LLMService            │
              │                │                 │
              │      ┌─────────┴─────────┐       │
              │      │                   │       │
              │ DeepSeek/OpenAI      Local OpenAI│
              │ compatible              compatible│
              │      │                   │       │
              │      └─────────┬─────────┘       │
              │                │                 │
              │         NormalizedResponse       │
              │                │                 │
              │         ActionCoordinator        │
              │        ┌───────┼────────┐        │
              │        │       │        │        │
              │       text   media    handoff    │
              │                │        │        │
              │                ▼        │        │
              │          MediaService    │        │
              │                │        │        │
              │         Telegram Vault   │        │
              │                         │        │
              └───────────────┬─────────┴────────┘
                              │
                         SQLite/WAL
                    state/history/facts/
                media/offers/gifts/events/outbox
```

---

## 6. Telegram topology

Используется **один пользовательский Telegram-аккаунт через Telethon**.

Он взаимодействует сразу с тремя типами чатов:

1. **Anonymous bot chat** — технический транспорт анонимной комнаты.
2. **Обычные личные сообщения** — реальные DM после перехода.
3. **Private Media Vault** — приватный канал/чат с заранее подготовленными фото/кружками.

Отдельный Business Bot в текущей архитектуре не нужен. Добавлять его только если впоследствии будет обнаружено конкретное ограничение user-account/MTProto, которое нельзя надежно решить Telethon.

---

## 7. Анончат: state machine

### 7.1. Состояния

Минимальный набор:

```text
STOPPED
SEARCHING
ROOM_ACTIVE
HANDOFF_PENDING
SKIPPING
```

`ENDED` для самого контроллера не нужен: законченный анонимный разговор становится архивной `conversation`, а контроллер продолжает жить.

### 7.2. Переходы

```text
STOPPED
  │ start
  ▼
SEARCHING
  │ room_ready / first_partner_message
  ▼
ROOM_ACTIVE
  │
  ├── inactivity_timeout(10m) ──► SKIPPING ──► SEARCHING
  ├── partner_left ──────────────► SEARCHING
  ├── partner_skipped ───────────► SEARCHING
  ├── manual_next ───────────────► SKIPPING ──► SEARCHING
  ├── handoff_intent ────────────► HANDOFF_PENDING
  │                                  │
  │                                  ├── dm_confirmed ─► SEARCHING
  │                                  ├── partner_left ─► SEARCHING
  │                                  └── timeout ──────► SKIPPING ─► SEARCHING
  └── manual_stop ───────────────► STOPPED
```

### 7.3. Важное ограничение конкретного анончата

При нахождении собеседника **нет имени, пола, возраста, города или профиля**. Новый разговор начинается с пустого набора фактов.

```text
facts = {}
```

Любые сведения появляются только из переписки.

### 7.4. Как понять, что комната готова

`AnonAdapter` не должен предполагать наличие метаданных.

Он должен поддержать два режима:

**Режим A — есть машинно распознаваемый сигнал готовой комнаты.**  
Например системное сообщение, изменение кнопок, edit сообщения бота или другой устойчивый признак. Тогда создается `ROOM_READY` и при желании LLM может первой написать opener.

**Режим B — надежного сигнала нет.**  
Тогда переход `SEARCHING -> ROOM_ACTIVE` происходит по первому реальному сообщению собеседника. До этого LLM не вызывается.

Конкретная механика анон-бота должна быть инкапсулирована только в `AnonAdapter`, чтобы остальная система не зависела от текста/кнопок конкретного сервиса.

### 7.5. Команды анон-боту

Все команды конфигурируемы:

```text
ANON_SEARCH_COMMAND
ANON_NEXT_COMMAND
ANON_STOP_COMMAND
ANON_LINK_COMMAND
```

Если конкретный бот использует кнопки, `AnonAdapter` может выполнять click по найденной кнопке вместо текстовой команды. Контроллер при этом вызывает одинаковые методы:

```python
await anon_adapter.search()
await anon_adapter.next()
await anon_adapter.stop()
await anon_adapter.request_link()
```

### 7.6. 10-минутный таймаут

Это **таймер неактивности**, а не отдельное решение LLM.

По умолчанию:

```text
ANON_IDLE_TIMEOUT_SECONDS = 600
```

`last_activity_at` обновляется на значимых сообщениях собеседника и наших фактических ответах. Служебный шум Telegram не продлевает комнату.

Если 10 минут ничего не происходит:

```text
ROOM_ACTIVE/HANDOFF_PENDING
    ↓
SKIPPING
    ↓
AnonAdapter.next()
    ↓
закрыть старую conversation reason=idle_timeout
    ↓
SEARCHING
```

LLM при этом не вызывается.

### 7.7. Что происходит после подтвержденного перехода в ЛС

После `dm_confirmed` код сам:

1. Привязывает текущий логический conversation к реальному `telegram_peer_id`.
2. Переводит транспорт разговора в `dm`.
3. Сохраняет историю, facts, summary и активное предложение.
4. Закрывает anonymous room transport.
5. Сбрасывает состояние анон-контроллера.
6. Немедленно запускает поиск следующего человека.

**DeepSeek не должен выдавать отдельную команду «ищи следующего». Это следствие подтвержденного state transition и выполняется кодом автоматически.**

---

## 8. Защита от старых ответов LLM

Критический сценарий:

```text
человек A пишет
↓
LLM начала генерацию
↓
A скипнул
↓
нашелся B
↓
старый ответ A готов
```

Он не должен уйти B.

Для анончата используется монотонный `room_generation`:

```text
room A generation=41
room B generation=42
```

Каждый LLM job получает snapshot generation.

Перед отправкой:

```python
if job.room_generation != anon_controller.current_generation:
    discard_response()
```

Также при `partner_left`, `manual_next`, `handoff_confirmed`, `stop` ожидающая async task отменяется, если это безопасно.

---

## 9. Conversation model

### 9.1. Логический conversation

Conversation — это **один конкретный человек и один непрерывный контекст**, независимо от того, начался он в анонке или продолжился в ЛС.

Лучше не создавать новый LLM-контекст при handoff. Сохраняется тот же `conversation_id`, меняется транспорт:

```text
conversation #184
channel = anon
peer_id = NULL
        ↓ handoff
conversation #184
channel = dm
peer_id = 123456789
```

Следующий анонимный человек получает новый `conversation #185`.

Так не нужен искусственный «копипаст контекста» между двумя сущностями.

### 9.2. Сообщения обязаны хранить transport snapshot

Каждая запись сообщения содержит:

```text
transport = anon | dm
```

Поэтому история все равно показывает, где именно была отправлена каждая реплика.

### 9.3. Параллельность

Одновременно допустимо:

```text
anon conversation #201 active
DM #184 active
DM #173 active
DM #146 active
...
```

У каждой conversation свои:

- history;
- facts;
- summary;
- debounce;
- async lock;
- active offer;
- sent media set;
- last activity;
- pending LLM job/version.

---

## 10. Handoff anon -> DM

Это одна из немногих частей, где есть ограничение Telegram: обычный новый DM сам по себе не обязан сообщать, из какой анонимной комнаты пришел человек.

### 10.1. Предпочтительный механизм

Если текущий anonymous bot через `/link` умеет дать человеку прямую ссылку на профиль, используем именно эту механику.

При намерении перейти в ЛС:

```text
LLM: handoff_intent=offer
↓
код: AnonAdapter.request_link()
↓
state=HANDOFF_PENDING
↓
создать handoff record с deadline
```

### 10.2. Сопоставление DM

Порядок надежности:

1. **Уникальный token/prefilled text**, если конкретная ссылка/бот позволяет его передать.
2. Если token передать невозможно — temporal correlation, потому что в анонке одновременно только один `HANDOFF_PENDING`.
3. Кандидатом считается новый DM peer, у которого еще нет существующего conversation и который появился в handoff window.
4. Если одновременно появились несколько неизвестных новых DM и нельзя однозначно выбрать — не гадать. Состояние помечается `ambiguous`, требуется ручное подтверждение/не выполняется автоматическая миграция.

Существующие старые DM не должны случайно поглотить pending handoff.

### 10.3. Handoff timeout

Если человек не написал в ЛС и 10-минутный inactivity timeout истек, текущая анонимная комната скипается, handoff закрывается как `expired`, начинается новый поиск.

---

## 11. Debounce входящих сообщений

Люди в Telegram часто пишут пачкой:

```text
слушай
короче
я вчера
увидел ее
ахах
```

Нельзя делать пять LLM-вызовов.

Для каждой conversation существует `MessageDebouncer`:

```text
incoming msg
↓
append to pending batch
↓
wait 1.5-2.5 sec after LAST message
↓
combine batch
↓
one LLM call
```

Настройка:

```text
MESSAGE_DEBOUNCE_MS = 1800   # стартовое значение
```

Новый message во время debounce перезапускает timer.

Если сообщение приходит, когда generation уже идет, возможны два режима:

- для MVP: дождаться текущей generation, затем обработать накопленный следующий batch;
- SHOULD: помечать текущий job stale и отменять до отправки, если новый текст делает ответ явно устаревшим.

Per-conversation обработка строго последовательна. Разные DM conversations могут выполняться параллельно.

---

## 12. Concurrency model

Используем `asyncio`.

### MUST

- один `asyncio.Lock` на conversation;
- отдельный lock/state machine у `AnonController`;
- `AsyncOpenAI`/асинхронный HTTP вместо синхронного `OpenAI`, чтобы не блокировать Telethon event loop;
- глобальный `asyncio.Semaphore` для ограничения одновременных LLM запросов;
- все долгие timer/debounce jobs — async tasks;
- на shutdown tasks корректно отменяются.

Стартовая настройка:

```text
LLM_MAX_CONCURRENCY = 4
```

Меняется по реальной нагрузке.

---

## 13. LLM provider abstraction

Ни ConversationService, ни Telegram код не должны знать слово DeepSeek.

Интерфейс:

```python
class LLMProvider(Protocol):
    async def generate(
        self,
        messages: list[LLMMessage],
        settings: GenerationSettings,
    ) -> LLMRawResponse:
        ...
```

Реализации:

```text
OpenAICompatibleProvider
```

На первом этапе одной реализации достаточно, потому что и DeepSeek, и большинство локальных серверов поддерживают OpenAI-compatible API.

Конфиг:

```dotenv
LLM_PROVIDER=openai_compatible
LLM_BASE_URL=https://api.deepseek.com
LLM_API_KEY=...
LLM_MODEL=deepseek-v4-flash
LLM_TIMEOUT_SECONDS=45
LLM_MAX_OUTPUT_TOKENS=500
LLM_THINKING=disabled
```

Переключение на локальную модель:

```dotenv
LLM_PROVIDER=openai_compatible
LLM_BASE_URL=http://127.0.0.1:1234/v1
LLM_API_KEY=local
LLM_MODEL=<local-model-name>
```

Telegram, SQLite, MediaService, GiftDetector, handoff и state machine не меняются.

### DeepSeek default

Для обычного чата стартовый профиль:

```text
DeepSeek V4 Flash
thinking/reasoning = OFF
короткий max output
```

Thinking не нужен для бытовых сообщений. Отдельный escalation path можно добавить позже, если измерения покажут пользу.

---

## 14. Нормализованный ответ LLM

Модель не должна возвращать `end` и напрямую управлять приложением.

Пример целевой Pydantic-схемы:

```python
class FactUpdate(BaseModel):
    key: str
    value: str | int | float | bool
    confidence: float = 1.0

class MediaIntent(BaseModel):
    media_type: Literal["photo", "video_note", "any"] = "any"
    access: Literal["casual", "teaser", "paid", "any"] = "any"
    content: list[str] = []
    view: list[str] = []
    outfit: list[str] = []
    scene: list[str] = []

class ChatDecision(BaseModel):
    text: str
    learned_facts: list[FactUpdate] = []
    media_intent: MediaIntent | None = None
    offer_intent: MediaIntent | None = None
    handoff_intent: Literal["none", "offer"] = "none"
```

Нет полей:

```text
next_room
stop_room
payment_success
selected_media_id
end_conversation
```

Это зона кода.

### Ошибка structured output

1. Валидируем через Pydantic.
2. Максимум один cheap repair/retry, если response вообще нельзя использовать.
3. Если текст можно безопасно извлечь, отправляем только текст и игнорируем действия.
4. Никогда не выполнять непровалидированное действие из сырого текста.

---

## 15. Персонаж и поведение

У нас **одна девушка**. Не нужен generic `personas` framework.

Хранить статическую настройку отдельно от кода, например:

```text
app/prompts/persona.md
app/prompts/examples.json
```

### Слои контекста

```text
1. SYSTEM CORE
2. CHARACTER / BEHAVIOR
3. FEW-SHOT STYLE EXAMPLES
4. CURRENT RUNTIME FACTS (price, channel, active offer)
5. KNOWN FACTS ABOUT THIS USER
6. ROLLING SUMMARY
7. RECENT MESSAGES
8. CURRENT MESSAGE BATCH
```

Первые 1-3 — максимально стабильный prefix.

### Persona должна задавать

- что это AI-девушка;
- базовое имя/возраст/биографию персонажа, когда они будут окончательно выбраны;
- стиль речи;
- типичную длину сообщения;
- отношение к сленгу/мату/эмодзи;
- инициативность;
- few-shot примеры реальных желаемых ответов;
- запрет на assistant-style фразы типа «чем еще помочь?»;
- запрет на списки/формальный стиль в обычном чате;
- правило не повторять disclosure в каждом сообщении, но не отрицать свою AI-природу.

### Dynamic mood/relationship state

Можно добавить позже (`interest`, `trust`, `irritation` и т.п.), но это **SHOULD/LATER**, а не обязательная часть MVP. Сначала измерить качество простой persona + facts + history.

---

## 16. Факты о собеседнике

При старте anonymous conversation:

```text
facts = {}
```

Нет скрытой анкеты и нет обязательного опроса.

Если в разговоре естественно выясняется:

```text
имя
возраст
пол
город
работа
интересы
важные события
предпочтения
```

LLM в **том же основном запросе**, в котором пишет ответ, может вернуть `learned_facts`.

Не делать второй отдельный extraction call на каждую реплику.

### Пример

```text
USER: мне 24 вообще
```

```json
{
  "text": "а, тогда плюс-минус ровесники)",
  "learned_facts": [
    {"key":"age","value":24,"confidence":1.0}
  ]
}
```

Facts сохраняются локально.

Неизвестные поля не передавать в LLM как длинный список `unknown`; просто отсутствуют.

---

## 17. Контекст и память

### 17.1. Anonymous conversation

Анончат короткоживущий, поэтому экономим:

- recent: ориентир 20-30 сообщений;
- facts: только реально узнанное;
- summary обычно не нужен до достижения threshold;
- после окончания без handoff разговор можно архивировать и больше не использовать в LLM.

### 17.2. DM conversation

Для долгого общения:

- recent: ориентир 30-50 сообщений;
- durable facts;
- rolling summary;
- optional relationship state позже.

Не отправлять всю историю целиком.

### 17.3. Summary policy

Summary обновляется **по коду при достижении порога**, а не каждый turn.

Например:

```text
если unsummarized_messages >= 40
или estimated_context_size > soft_limit
→ summarize older slice once
```

Суммаризация может использовать тот же дешевый provider. Это отдельный редкий LLM call, а не постоянный налог.

---

## 18. Human-like delivery без тупой задержки

Текущая схема `LLM latency + random 3-10s` дает лишнюю задержку.

Нужно считать **целевое общее время ответа**.

Пример:

```text
короткий ответ: target 0.8-1.8s
обычный:        target 1.5-3.0s
длинный:        target 2.5-5.0s
```

Если LLM уже думала 2.2 секунды при target=2.5:

```text
additional_delay = 0.3s
```

Формула:

```text
sleep = max(0, target_total_delay - generation_elapsed)
```

Во время ожидания/генерации можно использовать Telegram typing action.

Не использовать LLM для расчета задержки.

---

## 19. Media Vault

### 19.1. Источник

Один приватный Telegram channel/chat является canonical Media Vault.

Runtime-генерации нет.

Преимущества:

- медиа заранее загружено в Telegram;
- можно пополнять с телефона;
- локальный диск не обязан хранить все видео;
- приложение хранит только индекс и source message ID;
- при отправке можно заново получить source message и использовать свежее media reference.

### 19.2. Не хранить вечный serialized media object

В SQLite хранятся:

```text
source_chat_id
source_message_id
```

Перед отправкой:

```text
fetch source message
↓
получить актуальный media object
↓
send/copy media в target DM
```

Это устойчивее к истечению file references.

### 19.3. Video notes

Кружки сохраняются в vault именно как video note, если это возможно. `MediaSender` должен сохранять требуемый тип при повторной отправке.

---

## 20. Семантическая разметка медиа

LLM не должна видеть 500 `message_id` и описания всех файлов.

В private channel каждое медиа имеет caption с машинно-читаемыми тегами.

Рекомендуемый формат — key/value, потому что он менее двусмысленный, чем свободные хэштеги:

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

Для кружка:

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

### MUST поля

```text
type      = photo | video_note | video
access    = casual | teaser | paid
content   = один или несколько тегов
```

### Optional поля

```text
view
outfit
scene
series
```

Не делать десятки обязательных полей.

### Минимальная taxonomy

Стартовый словарь может содержать, например:

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

Словарь расширяется конфигом без миграции БД.

---

## 21. Media indexing

`MediaIndexer`:

1. Читает сообщения vault channel.
2. Находит marker `#anonka_media`.
3. Парсит metadata.
4. Валидирует обязательные поля и allowed tags.
5. Upsert в `media_assets` по `(source_chat_id, source_message_id)`.
6. Не удаляет asset автоматически при временной ошибке Telegram.
7. При ручном reindex обновляет metadata.

Невалидный caption не падает всем приложением — asset помечается/логируется как invalid и не участвует в выборе.

---

## 22. MediaIntent и MediaSelector

LLM возвращает **намерение**, не файл.

Пример:

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

Далее работает локальный `MediaSelector`.

### Фильтры

MUST:

- `enabled=true`;
- правильный `access`;
- подходящий `media_type`;
- asset не был отправлен этой conversation;
- обязательные content tags совпадают.

### Скоринг

Пример:

```text
exact content tag      +10
exact view             +5
exact outfit           +5
requested media type   +3
same active series     +2
already sent           EXCLUDE
very high global usage -1
```

Выбрать случайный элемент из top-N равных кандидатов, чтобы не повторять один и тот же файл всем.

### Fallback

Fallback должен быть явным и ограниченным.

Например:

```text
requested video_note + breasts
↓ none
photo + breasts
↓ found
```

Но нельзя автоматически превращать `breasts` в `butt` только потому, что что-то есть в каталоге.

Если релевантного asset нет — `MEDIA_NOT_AVAILABLE`. Код не должен отправлять случайное нерелевантное медиа.

### Series

`series` nullable. Это полезная, но не обязательная функция для визуальной непрерывности одного места/одежды. MVP может сначала не учитывать series, но поле лучше сразу заложить.

---

## 23. Бесплатные и платные медиа

`access`:

```text
casual
teaser
paid
```

### Casual/teaser

Может отправляться сразу после валидного `media_intent` согласно локальной политике.

### Paid

Не отправляется до подтвержденного Gift.

LLM может создать `offer_intent`, но **price и конкретный asset контролирует код**.

---

## 24. Offer flow

Лучше резервировать конкретный media asset **до** оплаты, чтобы после Gift пользователь получил именно то, о чем шла речь.

Flow:

```text
user asks/request context
↓
LLM returns offer_intent MediaIntent
↓
MediaSelector finds compatible unsent asset
↓
if none -> no offer is created
↓
read current runtime price
↓
create Offer(price_snapshot, selected_asset_id)
↓
LLM text/next text references current offer price
↓
wait Gift
```

У active offer всегда фиксировано:

```text
required_stars_snapshot
selected_asset_id
media_intent_snapshot
```

Если runtime price изменился через минуту, старый offer не меняется.

---

## 25. Telegram Gift = payment event

Для текущего эксперимента **получение подходящего Gift от пользователя считается оплатой**.

Не нужен отдельный checkout.

`GiftDetector` должен работать только по Telegram/MTProto event данным.

Он извлекает насколько доступно в конкретной версии Telethon/MTProto:

```text
telegram_message_id / unique event key
sender_peer_id
gift identifier
gift stars/value
received_at
```

До реализации нужно отдельно подтвердить точную структуру raw service message на установленной версии Telethon и написать fixture test. Это adapter detail, а не ответственность LLM.

### Matching

Gift может закрыть только offer той conversation, чей `telegram_peer_id == gift.sender_peer_id`.

MVP policy:

```text
single gift value >= required_stars_snapshot
→ offer=PAID
```

Если у Telegram нет gift ровно на настроенные 30 Stars, пользователь может отправить ближайший подходящий Gift выше threshold. Позже можно добавить cumulative gifts, но не делать это обязательным сейчас.

### Duplicate protection

Один и тот же Gift event не может оплатить дважды:

```text
UNIQUE(telegram_chat_id, telegram_message_id)
```

или другой стабильный Telegram event key, если service message устроен иначе.

---

## 26. Fulfillment после Gift

LLM не нужна.

```text
Gift received
↓
GiftDetector
↓
match active offer
↓ transaction
Offer WAITING -> PAID
↓
enqueue SEND_MEDIA(selected_asset_id)
↓
MediaSender
↓
mark FULFILLED
↓
next normal LLM context receives system fact:
"agreed gift received; reserved media was delivered"
```

### Crash safety

Критический сценарий:

```text
Gift записан
Offer=PAID
PROCESS CRASH
media еще не отправлено
```

После restart recovery worker выполняет:

```text
SELECT offers
WHERE status='paid'
AND fulfilled_at IS NULL
```

и продолжает fulfillment.

Оплата не теряется.

---

## 27. Runtime price/config

Цена не должна быть зашита в persona prompt.

`runtime_config`:

```text
offer_price_stars = 50
offers_enabled = true
media_enabled = true
anon_enabled = true
```

Когда создается Offer:

```text
required_stars_snapshot = runtime_config.offer_price_stars
```

В ContextBuilder передается:

```text
если есть active offer -> его snapshot price
иначе -> current runtime offer price
```

Так модель не путается после изменения цены.

---

## 28. Админ-управление

Минимально надежный интерфейс — **команды в Telegram Saved Messages**, которые ловит этот же Telethon-процесс только от собственного аккаунта.

Пример:

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
```

Это code-only control. Такие команды никогда не идут в LLM и никогда не отправляются собеседникам.

Можно оставить CLI как дополнительный offline tool для reindex/db diagnostics, но не строить web panel.

---

## 29. SQLite schema

Используем SQLite в WAL mode.

На старте:

```sql
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
PRAGMA busy_timeout=5000;
```

Ниже целевая логическая схема. Типы/названия могут уточняться в миграции, но ответственность таблиц должна сохраниться.

### 29.1. `conversations`

```text
id                    INTEGER PK
channel               anon | dm
state                 active | handoff_pending | ended
telegram_peer_id      INTEGER NULL
anon_generation       INTEGER NULL
created_at            DATETIME
updated_at            DATETIME
last_activity_at      DATETIME
ended_at              DATETIME NULL
end_reason            TEXT NULL
```

Индекс:

```text
INDEX(channel, state)
INDEX(telegram_peer_id)
```

Для DM должно быть не более одной активной logical conversation на один peer.

### 29.2. `messages`

```text
id                    INTEGER PK
conversation_id       FK
role                  user | assistant | system
transport             anon | dm
kind                  text | service | media | gift | internal
telegram_chat_id      INTEGER NULL
telegram_message_id   INTEGER NULL
text                  TEXT NULL
created_at            DATETIME
```

Dedupe:

```text
UNIQUE(telegram_chat_id, telegram_message_id)
```

где оба значения существуют.

### 29.3. `conversation_facts`

```text
conversation_id       FK
key                   TEXT
value_json            TEXT
confidence            REAL
source_message_id     FK NULL
updated_at            DATETIME
PRIMARY KEY(conversation_id, key)
```

Не создавать отдельную колонку под каждое новое свойство человека.

### 29.4. `conversation_summaries`

```text
id                    INTEGER PK
conversation_id       FK
through_message_id    INTEGER
summary_text          TEXT
created_at            DATETIME
```

Храним версии, чтобы при проблеме можно было восстановить прошлую.

### 29.5. `handoffs`

```text
id                    INTEGER PK
conversation_id       FK
state                 pending | confirmed | expired | ambiguous
anon_generation       INTEGER
created_at            DATETIME
deadline_at           DATETIME
handoff_token         TEXT NULL
dm_peer_id            INTEGER NULL
confirmed_at          DATETIME NULL
```

### 29.6. `media_assets`

```text
id                    INTEGER PK
source_chat_id        INTEGER
source_message_id     INTEGER
media_type            photo | video_note | video
access_class          casual | teaser | paid
tags_json             TEXT
series                TEXT NULL
enabled               BOOL
use_count             INTEGER
created_at            DATETIME
updated_at            DATETIME
UNIQUE(source_chat_id, source_message_id)
```

### 29.7. `conversation_media`

```text
id                    INTEGER PK
conversation_id       FK
media_asset_id        FK
reason                casual | teaser | paid | manual
telegram_message_id   INTEGER NULL
sent_at               DATETIME
UNIQUE(conversation_id, media_asset_id)
```

Это предотвращает повтор одного asset одному человеку.

### 29.8. `offers`

```text
id                    INTEGER PK
conversation_id       FK
status                waiting | paid | fulfilled | expired | cancelled
required_stars        INTEGER
media_intent_json     TEXT
selected_asset_id     FK
created_at            DATETIME
expires_at            DATETIME NULL
paid_at               DATETIME NULL
fulfilled_at          DATETIME NULL
```

Нужен partial/logic constraint: максимум один `waiting` offer на conversation, если позже не появится причина поддерживать несколько одновременно.

### 29.9. `gifts`

```text
id                    INTEGER PK
telegram_chat_id      INTEGER
telegram_message_id   INTEGER
gift_ref              TEXT NULL
sender_peer_id        INTEGER
gift_stars            INTEGER NULL
received_at           DATETIME
matched_offer_id      FK NULL
UNIQUE(telegram_chat_id, telegram_message_id)
```

### 29.10. `runtime_config`

```text
key                   TEXT PK
value_json            TEXT
updated_at            DATETIME
```

### 29.11. `events`

```text
id                    INTEGER PK
conversation_id       FK NULL
event_type            TEXT
payload_json          TEXT
created_at            DATETIME
```

### 29.12. `outbox`

Для надежной отправки Telegram actions:

```text
id                    INTEGER PK
conversation_id       FK NULL
action_type           send_text | send_media | anon_search | anon_next | anon_stop | anon_link
payload_json          TEXT
idempotency_key       TEXT UNIQUE
status                pending | processing | done | failed
attempts              INTEGER
available_at          DATETIME
last_error            TEXT NULL
created_at            DATETIME
completed_at          DATETIME NULL
```

### 29.13. `app_state`

Для restart-safe runtime:

```text
key                   TEXT PK
value_json            TEXT
updated_at            DATETIME
```

Здесь хранится минимум:

```text
anon_controller_state
current_anon_conversation_id
current_anon_generation
last_search_action_at
```

---

## 30. Transactions и exactly-once-ish semantics

Абсолютное exactly-once через Telegram недостижимо, поэтому цель — **идемпотентное at-least-once с локальной дедупликацией**.

### Incoming

В транзакции:

1. Проверить Telegram message/event dedupe key.
2. Если уже обработан — return.
3. Записать incoming message/event.
4. Обновить `last_activity_at`.
5. Зафиксировать transaction.

### Outgoing

Сначала создать outbox row с уникальным `idempotency_key`, потом dispatcher отправляет.

После успешной Telegram отправки:

- сохранить Telegram message id;
- пометить outbox `done`;
- обновить соответствующий domain object.

На restart незавершенный outbox можно безопасно повторно обработать согласно типу действия и idempotency checks.

---

## 31. Retry policy

### LLM

Retry только для временных ошибок:

```text
timeout
connection reset
5xx
429/rate limit
```

Стартовая политика:

```text
max attempts: 2-3
exponential backoff + jitter
```

Не повторять бесконечно.

Если LLM недоступна, анончат не должен автоматически скипать человека только из-за API timeout.

### Telegram

`FloodWait` обрабатывается как Telegram infrastructure event. Сохраняем действие и откладываем до разрешенного времени. Не просим LLM решать это.

### Media reference

Если cached/source media reference устарел — повторно fetch source message из vault и retry send один раз.

---

## 32. Startup recovery

Порядок запуска:

1. Открыть DB, выполнить migrations.
2. Включить WAL/foreign keys.
3. Поднять Telethon session.
4. Resolve собственный account ID, anon bot peer, media vault peer.
5. Reconcile pending outbox.
6. Reconcile `offers(status=paid, fulfilled_at=NULL)`.
7. Восстановить DM conversations.
8. Восстановить anon controller state.
9. Если сохраненное состояние анонки сомнительно после долгого downtime — не отправлять blindly несколько `/next`. Сначала `AnonAdapter.reconcile_state()` по доступным признакам/последним сообщениям.
10. Запустить debouncers/timers только после reconciliation.

---

## 33. Аналитика эксперимента

Все основные бизнес-события пишет **код без LLM**.

Рекомендуемые `event_type`:

```text
app_started
anon_search_started
anon_room_started
anon_first_message
anon_message_received
anon_reply_sent
anon_idle_timeout
anon_partner_left
anon_manual_skip
handoff_offered
handoff_link_requested
handoff_confirmed
handoff_expired
dm_started
dm_message_received
offer_created
offer_price_snapshot
gift_received
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

Это позволит считать без модели:

```text
anon rooms → handoff rate
handoff → DM rate
DM → offer rate
offer 30 Stars → gift conversion
offer 50 Stars → gift conversion
average messages before handoff
average messages before offer
idle/skip rate
LLM cost per conversation
```

---

## 34. Стоимость LLM и основные рычаги экономии

Архитектура должна экономить не «хитрыми промптами», а количеством и размером вызовов.

Главные рычаги:

1. Debounce пачек сообщений.
2. Никаких LLM-вызовов на timers/search/stop/next/Gift/payment/media lookup.
3. Facts извлекаются внутри обычного response call.
4. Stable system/persona prefix.
5. Ограниченный recent history.
6. Rolling summary вместо полной истории.
7. Summary обновляется редко по threshold.
8. Короткий `max_output_tokens` для Telegram.
9. Thinking OFF для обычного чата.
10. Media selection полностью локально.
11. Возможность заменить API на локальную модель.

Поля `usage` из LLM response сохранять в analytics, если provider их возвращает:

```text
input_tokens
cached_input_tokens (если доступно)
output_tokens
model
latency_ms
```

Так реальная стоимость считается по факту, а не по предположениям.

---

## 35. Предлагаемая структура файлов

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
│   │   └── timers.py
│   │
│   ├── dm/
│   │   ├── adapter.py
│   │   └── handoff.py
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
│       └── scheduler.py
│
├── data/
│   └── anonka.sqlite3          # gitignored
├── tests/
├── .env
├── .env.example
├── requirements.txt
└── run.py
```

Это логическое целевое разбиение. Не обязательно создавать все файлы одним коммитом; вводить по этапам.

---

## 36. Конфигурация

`.env` — только secrets и boot-time infrastructure settings.

Пример целевых env:

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
DATABASE_PATH=data/anonka.sqlite3
LOG_LEVEL=INFO
DRY_RUN=false
```

Меняемые во время работы значения (`price`, offers/media/anon on/off) — в `runtime_config`, не в `.env`.

---

## 37. Секреты и файлы

MUST:

- `.env` не коммитить;
- Telethon `.session` не коммитить;
- SQLite DB не коммитить;
- API keys не писать в logs;
- media vault приватный;
- логирование полного текста переписок сделать отдельной настраиваемой опцией, а не обязательным console output;
- периодически копировать SQLite через безопасный backup mechanism;
- Telegram session file считать секретом уровня пароля аккаунта.

---

## 38. Sequence flows

### 38.1. Новый anonymous match

```text
Admin/start
→ AnonController SEARCHING
→ AnonAdapter search
→ room ready signal (если доступен)
→ create Conversation(channel=anon, facts={})
→ ROOM_ACTIVE
→ optional opener LLM
```

Если room-ready signal отсутствует:

```text
SEARCHING
→ first partner message
→ create Conversation
→ ROOM_ACTIVE
→ debounce
→ LLM
```

### 38.2. Пачка сообщений

```text
msg1
→ pending batch
msg2 after 0.4s
→ reset debounce
msg3 after 0.7s
→ reset debounce
1.8s silence
→ combine
→ one LLM request
→ validate schema
→ save facts
→ execute allowed intents
→ typing/delivery delay
→ send
```

### 38.3. Idle skip

```text
ROOM_ACTIVE
→ no meaningful activity 600s
→ generation++ / cancel stale job
→ close conversation end_reason=idle_timeout
→ AnonAdapter.next()
→ SEARCHING
```

### 38.4. Partner skips us

```text
AnonAdapter recognizes partner_left/skip
→ cancel timer
→ invalidate room_generation
→ close conversation
→ SEARCHING
→ search next if bot did not already do it automatically
```

### 38.5. Handoff

```text
LLM returns handoff_intent=offer
→ code request_link()
→ HANDOFF_PENDING
→ new unknown DM appears in handoff window
→ correlate/confirm
→ bind current conversation.telegram_peer_id
→ channel=dm
→ handoff confirmed
→ anon generation invalidated
→ AnonController SEARCHING
→ DM conversation continues independently
```

### 38.6. Новый anon while old DM continues

```text
DM #184 incoming ──► lock #184 ──► LLM job A
Anon #185 incoming ─► lock #185 ──► LLM job B
DM #173 incoming ──► lock #173 ──► LLM job C

Global LLM semaphore controls concurrency.
No context is shared between #184/#185/#173.
```

### 38.7. Semantically requested media

```text
USER: asks for specific kind of media
→ LLM MediaIntent(content=..., type=...)
→ MediaSelector exact match
→ exclude already sent
→ select top candidate
→ if casual/teaser: enqueue send
→ if paid: create/reserve offer instead
```

### 38.8. Gift -> paid media

```text
Offer waiting, price snapshot=50, asset=731
→ Telegram gift service event from same DM peer
→ dedupe gift
→ verify value >= 50
→ transaction Offer=PAID + gift matched
→ outbox SEND_MEDIA asset=731
→ send from vault
→ conversation_media insert
→ Offer=FULFILLED
```

### 38.9. Restart between payment and send

```text
DB: offer=PAID, fulfilled_at=NULL
PROCESS CRASH
→ restart
→ RecoveryService query pending paid offers
→ re-enqueue missing SEND_MEDIA
→ send
→ mark fulfilled
```

### 38.10. Old LLM response after anon skip

```text
job generation=40
→ room changes generation=41
→ job finishes
→ pre-send guard sees 40 != 41
→ DROP
```

---

## 39. Testing strategy

### Unit tests MUST

- anon state transitions;
- 10-minute timeout;
- repeated `partner_left` event is idempotent;
- stale generation response dropped;
- debounce combines messages;
- one conversation cannot mix history with another;
- facts upsert;
- media caption parser;
- media selector exact tags;
- media selector never repeats asset to same conversation;
- `breasts` request does not silently choose `butt`-only asset;
- offer price snapshot survives runtime price change;
- duplicate gift does not double-pay;
- gift from wrong peer cannot pay offer;
- paid-but-unfulfilled offer recovers after restart;
- outbox idempotency.

### Integration tests SHOULD

- fake OpenAI-compatible server;
- fake/fixture Telethon messages;
- raw service message fixture for Gift;
- media vault fetch/send mock;
- SQLite restart between every important state transition;
- FloodWait simulation;
- invalid LLM JSON/schema response.

### Dry run

Существующий `DRY_RUN` сохранить и расширить:

- Telegram outgoing action логируется, но не отправляется;
- state machine и DB работают реально;
- LLM можно включать отдельно или заменить `FakeLLMProvider`.

---

## 40. Логирование/наблюдаемость

Каждый значимый log должен иметь structured context:

```text
conversation_id
telegram_peer_id (если известен)
anon_generation
event_type
llm_model
latency_ms
outbox_id
offer_id
```

Не логировать secrets.

Полные тексты переписок в логах по умолчанию не нужны, потому что они уже есть в SQLite.

Ошибки должны содержать stack trace + correlation IDs.

---

## 41. Dependency recommendations

Runtime минимум:

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

Не добавлять большой framework без реальной необходимости.

`openai.AsyncOpenAI` использовать как OpenAI-compatible transport.

Для migrations можно начать с собственного простого последовательного migration runner (`schema_version` + SQL files), вместо Alembic. Если БД сильно вырастет по сложности — Alembic можно добавить позже.

---

## 42. План миграции существующего проекта

### Этап 1 — фундамент и persistence

Сохранить Telethon startup.

Добавить:

- SQLite/WAL;
- migrations;
- domain models;
- repositories;
- persistent conversations/messages;
- event logging.

Убрать зависимость runtime chat history от RAM-only `SessionStore`.

### Этап 2 — provider-agnostic LLM

Заменить:

```text
GrokClient
XAI_*
```

на:

```text
LLMProvider
OpenAICompatibleProvider
LLM_*
```

Перейти на async client.

Убрать `action=end`.

Ввести Pydantic `ChatDecision`.

### Этап 3 — новый ConversationService

Добавить:

- per-conversation locks;
- debounce;
- recent history;
- fact updates;
- ContextBuilder;
- human-like delivery timing.

Удалить автоматическое завершение на `ок`/`пон`.

### Этап 4 — AnonAdapter + AnonController

Добавить:

- bot-specific parser;
- commands/buttons adapter;
- state machine;
- idle timeout;
- generation guard;
- manual stop/next/start;
- reconciliation after restart.

### Этап 5 — DM Router + Handoff

Добавить:

- routing ordinary DMs by peer ID;
- pending handoff;
- mapping anon conversation -> new DM;
- conversation channel migration;
- automatic search-next after confirmed handoff.

### Этап 6 — Persona/facts/summary

Добавить:

- persona prompt files;
- few-shot examples;
- facts storage;
- rolling summary thresholds;
- separate anon/DM context budgets.

### Этап 7 — Media Vault

Добавить:

- channel indexer;
- metadata parser;
- `media_assets`;
- `MediaIntent`;
- local selector;
- no-repeat tracking;
- video note sending;
- refresh of source message/media reference.

### Этап 8 — Offers/Gifts

Добавить:

- runtime price;
- asset reservation;
- offers;
- GiftDetector;
- gift dedupe/matching;
- paid fulfillment;
- crash recovery.

### Этап 9 — Outbox/recovery hardening

Добавить:

- idempotent outgoing actions;
- retry/backoff;
- FloodWait handling;
- startup reconciliation;
- backup procedure.

### Этап 10 — Analytics/admin

Добавить:

- Saved Messages admin commands;
- funnel events;
- price comparison reports;
- LLM usage/cost metrics.

---

## 43. Что сохранить из текущей структуры

Сохранить концептуально:

- `app/main.py` как composition root;
- `app/tg/client.py` как место создания Telethon client;
- `app/tg/sender.py` как низкоуровневый Telegram sender, но расширить;
- `app/config.py`, но сделать provider-neutral;
- `DRY_RUN`;
- разделение Telegram / LLM / services.

Переписать/заменить:

- `app/tg/handlers.py` → тонкий EventRouter;
- `app/tg/filters.py` → router classification, а не один username target;
- `app/chat/session.py` → persistent ConversationService/repositories;
- `app/chat/state.py` → нормальные enums/state machines;
- `app/llm/grok_client.py` → async provider adapter;
- `app/llm/prompts.py` → prompt files + ContextBuilder;
- `ReplyService` → LLMService + ConversationService/ActionCoordinator;
- фиксированный `delay_service.py` → DeliveryPolicy.

Удалить как концепцию:

- `SHORT_ENDINGS={"ок","пон"}` как auto-end;
- LLM `action=end`;
- reset всей истории после естественной короткой реплики;
- xAI-specific naming в core logic.

---

## 44. MUST / SHOULD / LATER

### MUST для рабочего MVP

- Telethon user account;
- один anon adapter;
- anon state machine;
- 10m idle skip;
- restart-safe SQLite;
- независимые conversation contexts;
- anon -> DM handoff;
- параллельные DMs;
- provider-neutral async LLM;
- DeepSeek V4 Flash default, thinking off;
- debounce;
- persona + few-shot style;
- facts from conversation;
- media vault channel;
- semantic media tags;
- local MediaSelector;
- no repeat per conversation;
- runtime price;
- Offer with price+asset snapshot;
- GiftDetector;
- local payment/fulfillment logic;
- stale generation protection;
- dedupe;
- basic recovery;
- admin start/stop/next/price/reindex;
- event analytics.

### SHOULD после первого работающего цикла

- rolling summary;
- outbox for every outgoing action;
- active series continuity;
- smarter cancel of in-flight LLM jobs;
- detailed cost metrics;
- Saved Messages status reports;
- automatic DB backup;
- local-model fallback/provider switch tests.

### LATER / только если появится реальная необходимость

- mood/relationship numeric state;
- automatic vision media tagging;
- cumulative multiple Gifts per offer;
- multiple personas;
- Postgres;
- Redis;
- distributed workers;
- web dashboard;
- Business Bot;
- runtime image/video generation.

---

## 45. Definition of Done для первой полноценной версии

Версия считается архитектурно готовой, если можно выполнить следующий сценарий без ручного вмешательства:

```text
1. Запустить приложение.
2. Оно начинает поиск в анончате.
3. Появляется новый человек без каких-либо исходных данных.
4. AI ведет обычную переписку.
5. Несколько быстрых сообщений объединяются в один LLM call.
6. Имя/возраст/город, если они всплыли, сохраняются как facts.
7. Через 10 минут полной неактивности код сам скипает человека.
8. Если собеседник скипнул первым, старый pending LLM ответ никогда не попадает следующему.
9. AI может предложить переход в ЛС; код вызывает `/link`.
10. После подтвержденного нового DM этот же conversation продолжает жить в ЛС с прошлой памятью.
11. Анон-контроллер сразу начинает поиск следующего человека.
12. Старый DM и новый anon работают параллельно.
13. Пользователь может запросить конкретное медиа.
14. LLM возвращает MediaIntent, а код выбирает релевантный заранее размеченный asset.
15. Один и тот же asset этому человеку повторно не отправляется.
16. Для paid content создается Offer с фиксированными ценой и asset.
17. Полученный подходящий Gift локально переводит Offer в PAID.
18. Код отправляет зарезервированное медиа без дополнительного LLM-вызова.
19. Если процесс упал после Gift, но до отправки, после restart fulfillment продолжается.
20. `.price 30` меняет только новые Offers; старые остаются по старой цене.
21. `.anon stop/start/next/status` работает без LLM.
22. Переключение DeepSeek на локальный OpenAI-compatible endpoint требует только конфигурации/adapter settings, а не переписывания Telegram/DB/media logic.
```

Если все эти пункты выполняются, архитектура решает согласованную задачу без лишнего раздувания проекта.
