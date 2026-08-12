# Anonka — архитектурные уточнения после повторного аудита

> Статус: каноническое дополнение к `ARCHITECTURE.md` после повторной проверки актуального `main` и инфраструктуры Teleton Agent 0.10.1.  
> Дата: 2026-08-12.  
> Если формулировка в этом файле противоречит более ранней формулировке в `ARCHITECTURE.md`, приоритет имеет этот addendum до следующей консолидации документов.

---

## 1. SQLite: сохраняем foundation, не старый `MemoryDatabase`

Из Teleton сохраняем только полезный низкоуровневый SQLite foundation:

```text
better-sqlite3
WAL
foreign_keys
PRAGMA tuning
file permissions
migration pattern
open/close lifecycle
```

Не переносить целиком текущий `MemoryDatabase` как основу Anonka.

Причина: он жёстко связан с:

```text
sqlite-vec
knowledge tables
vector tables
embedding lifecycle
Teleton ensureSchema()/migrations
старой memory.db
```

Целевая схема:

```text
SQLite primitives
├── SupervisorDatabase → supervisor.db
└── CreatorDatabase    → creator.db
```

У `SupervisorDatabase` и `CreatorDatabase` должны быть собственные схемы и migrations Anonka без мёртвых Teleton tables.

FTS5 допустим для обычного text search/debug. Vector embeddings и `sqlite-vec` в production path не нужны.

---

## 2. Graceful lifecycle Teleton сохранить

Существующий порядок shutdown/restart Teleton полезен и не должен быть потерян при удалении `TeletonApp`.

Целевой `CreatorWorkerLifecycle` должен сохранять семантику:

```text
stop accepting new ingress
→ flush debouncer
→ drain message/conversation queues
→ abort/drain active LLM turns
→ flush pending persistence
→ stop provider/background resources
→ disconnect Telegram
→ close DB
```

Также сохранить:

```text
SIGINT/SIGTERM handling
shutdown timeout safety net
idempotent stop
controlled restart
```

Не переписывать lifecycle хаотично вокруг новых domain services.

---

## 3. Durable Inbox = основной idempotency barrier

После появления durable Inbox `telegram-offset.json` больше не является source of truth для вопроса «событие обработано или нет».

Рекомендуемая уникальность Inbox:

```text
UNIQUE(
  creator_id,
  event_type,
  telegram_chat_id,
  telegram_message_id
)
```

Для raw/service events без обычного message id используется отдельный стабильный transport event key.

Правильный порядок:

```text
Telegram event
→ INSERT/UPSERT durable Inbox
→ commit
→ только после этого обновить transport watermark/offset
→ позже process Inbox
```

Следствия:

- reconnect не создаёт второй logical turn;
- падение LLM не теряет событие;
- зависший `processing` можно вернуть в очередь;
- offset остаётся только transport optimization/watermark.

---

## 4. Durable Outbox: correlation должен появляться до network send

Недостаточно отличать programmatic outgoing от manual outgoing только по `telegram_message_id`, потому что Telegram message id становится известен после отправки, а outgoing update потенциально может быть замечен раньше завершения caller-side persistence.

Outbox должен иметь pre-send correlation:

```text
id
creator_id
conversation_id
kind
payload_json
idempotency_key
transport_correlation_key
telegram_message_id NULL
status
attempts
created_at
sent_at NULL
```

Для MTProto transport нужно использовать стабильный client-generated correlation primitive, например `random_id`, где это поддерживается конкретным send method.

Порядок:

```text
create Outbox row
→ generate/persist correlation key
→ commit
→ network send
→ receive/send acknowledgement
→ persist telegram_message_id
→ mark sent
```

Это критично для:

```text
manual-vs-programmatic outgoing detection
normal text retries
media sends
paid fulfillment
crash after Telegram accepted send but before local DB update
```

Paid media не должно отправляться второй раз только потому, что процесс упал между network send и `status=sent`.

---

## 5. Creator Telegram auth должен быть отдельным setup flow

Текущий Teleton client умеет интерактивно спрашивать verification code/2FA через stdin. Для нескольких worker это не должно оставаться normal runtime behavior.

Целевая схема:

```text
anonka creator login <creator_id>
→ interactive phone/code/2FA setup
→ save Telegram session with 0600 permissions
→ verify account identity
→ mark creator auth ready
```

Обычный `CreatorWorker`:

```text
session exists + valid
→ start

session absent/expired/revoked
→ AUTH_REQUIRED
→ alert Supervisor/Control Bot
→ do not block worker waiting for terminal input
```

Первичная авторизация и production runtime должны быть разделены.

---

## 6. Static config и mutable runtime state разделить

Сохраняем хороший подход Teleton:

```text
YAML/env loading
Zod validation
path expansion
secret/env overrides
```

Но новый Anonka config не должен тащить старые Agent/TON/MCP/WebUI/heartbeat/vector settings.

### Static/env config

```text
Telegram API ID/hash
Control Bot token
LLM provider/base URL/API key/model
root data paths
logging
process-level limits
```

### `supervisor.db` / `creator.db`

```text
creator.enabled
commercial mode
price
media/offers toggles
AI|HUMAN|HYBRID
anon runtime state
mutable operational settings
```

Control Bot не должен постоянно переписывать YAML ради обычных runtime changes.

---

## 7. Persona loader: reuse primitives, не `buildSystemPrompt()` целиком

Полезно сохранить:

```text
SOUL.md
STRATEGY.md
SECURITY.md
safe file reading/cache
sanitizeForPrompt/sanitizeForContext equivalents
```

Не использовать текущий Teleton `buildSystemPrompt()` как готовый prompt Anonka.

Из customer path удалить зависимости на:

```text
global MEMORY.md
USER.md
IDENTITY.md
heartbeat prompt
agent tools
owner-agent semantics
process-global frozen memory snapshot
```

Целевой `AnonkaPromptBuilder` строит prompt только из creator-scoped и conversation-scoped данных:

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

## 8. Structured output: MVP contract уточнить

Текущий Teleton provider wrapper уже полезен для:

```text
provider/model resolution
OpenAI-compatible/local endpoints
timeout
AbortSignal
temperature
max tokens
technical fallback
```

Но текущий generic wrapper не предоставляет единый гарантированный `response_format/json_schema` contract для всех провайдеров.

Поэтому базовый MVP flow:

```text
prompt explicitly requires JSON
→ parse JSON
→ Zod ChatDecision validation
→ one bounded repair call if invalid
→ if still invalid: safe text-only fallback
```

При fallback запрещены side effects:

```text
no media action
no offer action
no handoff action
no payment/system action
```

Native JSON Schema / JSON object mode можно включать позже как provider-specific optimization, но не делать его обязательным для базовой архитектуры.

---

## 9. Control Bot callbacks должны быть durable

Существующий callback router Teleton даёт полезные свойства:

```text
random nonce
expectedUserId check
single-use callback
TTL cleanup
```

Но in-memory nonce с TTL около нескольких минут недостаточен для Control Bot cards, которые могут жить долго и переживать restart Supervisor.

Добавить в `supervisor.db` durable callbacks, например:

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
private chat only
admin allowlist
expected admin binding
single-use
idempotent handling
explicit expiry
survive Supervisor restart
```

Существующий `answerCallbackOnce()`-подобный helper можно сохранить.

---

## 10. Media Vault индексирует CreatorWorker, не Control Bot

Control Bot нельзя считать каноническим читателем Media Vault.

Bot API bridge не является полноценным history reader произвольного приватного канала и не должен отвечать за `/media_reindex`.

Правильная схема:

```text
Private Media Vault
        │
        ▼
CreatorWorker / GramJS user-account
        │
        ├── live Vault updates
        ├── history scan/reindex
        ├── groupedId/media extraction
        ├── caption/tag parsing
        └── creator.db media catalog
                 │
                 ▼
          Supervisor / Control Bot
          cards + metadata + preview
```

Control Bot может быть добавлен в Vault для удобного preview, если это реально полезно, но это не должно быть обязательным условием индексирования.

`/media_reindex` должен выполняться через CreatorWorker.

---

## 11. Media primitives: не писать уже существующее с нуля

В старом Teleton media layer уже есть полезные реализации для:

```text
downloadMedia
photo
video
voice/audio
sticker
GIF
videoNote detection
file/buffer handling
Telegram media metadata
```

Перед удалением tool layer вынести этот код в обычные Telegram/media services.

При этом domain bridge всё ещё нужно расширить явными primitives:

```text
media_type = video_note
media_group_id/groupedId
sendVideo()
sendVideoNote()
copy/resend without forward attribution
raw message/media access where required
```

`vision-analyze` не является частью Media Vault tagging: каталог размечается только deterministic manual tags.

---

## 12. Gift pipeline: добавить `UNMATCHED`

Live Gift event сам по себе не всегда достаточен для автоматической оплаты Offer.

Особенно важно:

```text
nameHidden / anonymous sender
неполный sender mapping
неполная value/correlation информация
service event без надёжного stable transaction key
```

Целевой lifecycle Gift:

```text
DETECTED
  │
  ├── reliable sender/value/key → MATCHED → CONSUMED
  │
  └── insufficient data        → UNMATCHED
                                  │
                                  ├── reconciliation resolves → MATCHED
                                  └── remains ambiguous       → manual/debug review
```

`UNMATCHED` Gift никогда автоматически не переводит Offer в `PAID`.

Gift matching остаётся:

```text
one Gift event key → максимум one Offer
creator must match
peer must match
value must satisfy Offer
Offer must still be WAITING
```

Live events и Stars transaction reconciliation остаются двумя взаимодополняющими источниками.

---

## 13. Raw Telegram retention не равно conversation retention

Teleton может чистить старые raw Telegram rows. В Anonka это допустимо только после появления отдельной canonical domain history.

Правило:

```text
conversation_messages = canonical customer history
raw Telegram feed       = transport/debug history
```

После миграции raw feed можно pruning по retention policy.

До перехода нельзя включать pruning так, чтобы raw feed был единственной копией истории и при этом удалялся автоматически.

Conversation facts, summaries, offers, gifts и media delivery history имеют собственные retention semantics и не должны зависеть от raw feed retention.

---

## 14. Supervisor: crash backoff и ownership boundaries

`WorkerManager` должен поддерживать не только start/stop/restart, но и crash-loop protection.

Пример:

```text
worker exits unexpectedly
→ record failure
→ bounded restart with backoff
→ repeated crashes inside window
→ mark creator runtime ERROR/STOPPED
→ stop automatic restart loop
→ alert Control Bot
```

Не допускать бесконечного fork/restart loop из-за:

```text
битой Telegram session
invalid config
DB migration failure
provider startup failure
persistent runtime exception
```

### DB ownership

```text
Supervisor process
→ writes supervisor.db only

CreatorWorker A
→ writes creator-A/creator.db only

CreatorWorker B
→ writes creator-B/creator.db only
```

Supervisor не должен напрямую выполнять domain writes в creator DB. Управление идёт через typed IPC.

---

# Дополнительные reuse-обязательства

## Logger

Сохранить Pino logger и redaction чувствительных полей:

```text
api keys
api_hash
access tokens
passwords
secrets
bot_token
```

WebUI log stream можно удалить вместе с WebUI, но нормальный structured logger оставляем.

---

## File permissions

Адаптировать существующий hardening:

```text
0600 sensitive files
0700 sensitive directories
```

Применять минимум к:

```text
Telegram sessions
creator DB files
supervisor.db
config/secrets
Control Bot credentials where file-backed
```

---

## Doctor CLI

Идею `doctor` сохранить, но полностью переписать проверки под Anonka:

```text
Node version
static config validity
Supervisor DB
Control Bot credentials/connectivity
LLM config/provider availability
creator registry
per-creator Telegram session presence/status
creator DB readability/migrations
Vault binding
anon source config
filesystem permissions
```

Не проверять удалённые TON/wallet/MCP/WebUI subsystems.

---

## Docker

Сохранить полезные свойства текущей сборки:

```text
multi-stage build
production-only runtime dependencies
non-root runtime
persistent /data volume
native better-sqlite3 support
```

После миграции `/data` организовать примерно так:

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

WebUI/SDK-specific build layers удалить после выхода из production path.

---

## CI

Не упрощать CI после удаления Teleton bloat.

Сохранить проверки уровня:

```text
typecheck
lint
format check
dead-code check
circular dependencies
duplicate-code check
security audit
unit/integration tests
Docker build
```

Удалить только проверки SDK/WebUI/других уже несуществующих подсистем.

---

# Дополнения к migration plan

## Phase 0

Дополнительно подтвердить:

```text
pre-send/outgoing correlation primitive
Creator login/setup вне worker runtime
real Gift with anonymous/nameHidden edge case
Control Bot callback persistence behavior
Vault history reindex through CreatorWorker
```

## Phase 1

Добавить:

```text
Inbox UNIQUE/idempotency contract
transport offset updated after Inbox commit
Outbox pre-send correlation
clean Anonka SQLite schema/lifecycle
CreatorWorker graceful shutdown/drain
```

## Phase 2

Добавить:

```text
non-interactive CreatorWorker auth behavior
AUTH_REQUIRED runtime state
crash backoff/crash-loop protection
durable admin_callbacks
static config vs mutable DB state split
```

## Phase 4

Уточнить:

```text
VaultIndexer runs inside CreatorWorker
/media_reindex routes to CreatorWorker
reuse existing download/videoNote media helpers
Control Bot is presentation/control plane, not canonical Vault reader
```

## Phase 5

Добавить:

```text
Gift DETECTED/MATCHED/UNMATCHED/CONSUMED semantics
anonymous Gift does not auto-pay
Outbox correlation/idempotency test for paid media
```

---

# Дополнения к обязательным test contracts

Добавить тесты:

```text
Inbox duplicate event creates one logical turn
offset advances only after Inbox durable commit
programmatic outgoing update arriving before send() returns is not classified as manual
crash after Telegram accepted send but before local sent-state does not duplicate paid fulfillment
CreatorWorker with missing/expired session enters AUTH_REQUIRED without waiting on stdin
gracious shutdown drains accepted Inbox/Outbox work
Supervisor restart preserves pending admin callback
admin callback remains single-use after restart
Control Bot cannot execute callback for another admin
Vault reindex works through CreatorWorker without Bot API history access
structured-output invalid JSON → one repair → text-only fallback with no side effects
anonymous/nameHidden Gift remains UNMATCHED
Gift reconciliation can resolve previously UNMATCHED event
raw feed pruning does not remove canonical conversation history
repeated worker crash triggers backoff and eventually ERROR instead of infinite restart loop
Supervisor never writes creator.db directly
```

---

# Дополнения к Definition of Done

Архитектурный переход также не считается завершённым, пока не выполнено следующее:

```text
old Teleton MemoryDatabase is no longer Anonka domain DB foundation
SupervisorDatabase and CreatorDatabase have independent clean schemas
Inbox is the idempotency source of truth; offset is only a transport watermark
Outbox has pre-send correlation/idempotency semantics
Creator runtime never blocks on interactive Telegram login
mutable runtime state is not managed by constant YAML rewrites
AnonkaPromptBuilder does not load global Teleton customer memory
base ChatDecision path works without requiring provider-native JSON schema
Control Bot long-lived callbacks survive Supervisor restart
Vault indexing/reindex is owned by CreatorWorker
GiftService supports UNMATCHED and never auto-pays ambiguous Gift
raw transport retention is independent from canonical conversation retention
worker crash loops are bounded and surfaced to Control Bot
Pino redaction/file-permission hardening survive Teleton cleanup
Docker/CI quality gates survive dependency cleanup
```

---

## Итоговое уточнение

Целевая схема остаётся прежней:

```text
Supervisor
→ isolated CreatorWorker
→ Telegram transport
→ durable Inbox
→ logical Conversation
→ ContextBuilder
→ shared LLM config / ChatDecision
→ DecisionValidator
→ ActionCoordinator
→ durable Outbox
→ Telegram / Media / Commerce
```

Этот addendum не меняет фундаментальную архитектуру. Он фиксирует edge cases и reuse boundaries, найденные при повторном проходе по фактическому коду `main`, чтобы реализация не переписала уже готовую инфраструктуру и не унаследовала лишние Teleton subsystems.