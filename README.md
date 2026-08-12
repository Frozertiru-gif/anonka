# Anonka

Anonka — Telegram-система для одного или нескольких creator-профилей, построенная поверх полезной инфраструктуры Teleton Agent 0.10.1.

Teleton используется только как исходная инфраструктурная база: GramJS/MTProto, Telegram transport, очереди, SQLite primitives, LLM provider adapters и отдельные Telegram/Gifts/media helpers. Autonomous agent, TON/DEX, MCP, Plugin SDK, WebUI и другие нерелевантные подсистемы постепенно удаляются.

## Каноническая архитектура

Единственный источник архитектурных решений проекта:

- [`ARCHITECTURE.md`](./ARCHITECTURE.md)

Ключевая схема:

```text
Supervisor
→ isolated CreatorWorker
→ Telegram transport
→ durable Inbox
→ logical Conversation
→ ContextBuilder
→ shared LLM / ChatDecision
→ DecisionValidator
→ ResponseScheduler
→ ActionCoordinator
→ durable Outbox
→ Telegram / Media Vault / Gifts & Offers
```

## Текущий статус

Репозиторий находится в фазе миграции с upstream Teleton на целевую архитектуру Anonka.

До переключения production path сохраняются некоторые legacy-модули Teleton, если они всё ещё нужны текущей сборке или содержат low-level primitives, которые предстоит вынести. Такие модули нельзя удалять вслепую до переноса полезного кода и покрытия нового path тестами.

## Базовые технологии

- TypeScript / Node.js
- GramJS / Telegram MTProto
- Grammy для Control Bot
- SQLite / `better-sqlite3`
- `@earendil-works/pi-ai` и существующий provider layer Teleton

## Лицензия и upstream

Проект основан на MIT-коде Teleton Agent. Исходная лицензия сохранена в [`LICENSE`](./LICENSE).
