# Anonka — лицензии и внешние исходники

Это единый реестр лицензий для внешнего кода/компонентов, которые Anonka использует напрямую, копирует, адаптирует или вендорит.

Основная лицензия самого репозитория Anonka остаётся в [`LICENSE`](./LICENSE).

---

## 1. Anonka / upstream Teleton codebase

- Лицензия репозитория: **MIT License**.
- Канонический текст: [`LICENSE`](./LICENSE).
- Copyright notice в текущем репозитории: `Copyright (c) 2025-2026 Digital Resistance`.

---

## 2. Yuralume / yuralume-core

- Upstream repository: `https://github.com/Yuralume/yuralume-core`
- License: **Business Source License 1.1 (BUSL-1.1)**.
- Канонический upstream license: `https://github.com/Yuralume/yuralume-core/blob/main/LICENSE`
- Upstream указывает: non-commercial self-host, research и evaluation разрешены; commercial production требует отдельной лицензии.
- Upstream также указывает, что каждая версия переходит на **Apache License 2.0** через четыре года после первого публичного распространения этой версии.
- Текущий intended use в Anonka: личный, некоммерческий, self-host.

### Разрешённый scope в Anonka

Yuralume утверждён как донор/внешний компонент для выборочного переиспользования companion-механик, в частности proactive messaging, schedule/follow-up, intention gates, relationship-aware behavior и подходящих memory primitives. Подробности: [`EXTERNAL_COMPONENTS.md`](./EXTERNAL_COMPONENTS.md).

### Учёт конкретно перенесённого кода

Пока конкретные upstream-файлы Yuralume в Anonka **не зафиксированы как скопированные**. Когда такой перенос произойдёт, добавлять строки в таблицу ниже.

| Upstream commit/tag | Upstream path | Local path | License | Изменения |
|---|---|---|---|---|
| — | — | — | BUSL-1.1 | Пока нет зафиксированного прямого копирования |

---

# Правило для следующих внешних компонентов

Если в Anonka добавляется код из другого проекта, в этот файл обязательно заносится:

1. название проекта и upstream repository;
2. точная лицензия;
3. commit/tag версии, из которой взят код;
4. upstream path;
5. local path;
6. краткое описание изменений;
7. ссылка на канонический LICENSE/NOTICE upstream.

Не нужно вручную дублировать сюда каждую транзитивную npm-зависимость из `package-lock.json`. Этот реестр предназначен прежде всего для **прямо переиспользуемого, скопированного, адаптированного или вендоренного внешнего кода**, чтобы его происхождение и лицензия всегда находились в одном месте.
