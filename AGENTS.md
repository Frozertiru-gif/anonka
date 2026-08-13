# AGENTS.md

This file contains mandatory repository-level instructions for Codex, DeepSeek and any other coding agent working on Anonka.

## Project direction

Anonka is being migrated away from the general-purpose Teleton Agent product into a focused Telegram automation system.

Source-of-truth split:

- `PRODUCT_REQUIREMENTS.md` is canonical for product behavior and owner/customer experience;
- `ARCHITECTURE.md` is canonical for technical architecture and reliability boundaries;
- `IMPLEMENTATION_PLAN.md` defines implementation order and migration scope;
- the user's newest explicit instruction wins over all repository documents.

If an older technical statement conflicts with a newer product requirement, do not silently implement the stale behavior. Preserve reliability/security invariants and update/align the technical design with `PRODUCT_REQUIREMENTS.md` before proceeding.

Core direction:

- keep and reuse useful Telegram/MTProto infrastructure;
- keep useful LLM provider infrastructure;
- keep SQLite/better-sqlite3 foundations;
- keep useful Telegram Gifts/media primitives;
- replace the autonomous general-agent decision layer with the Anonka conversation pipeline;
- support proactive, continuing relationships rather than only reactive one-message replies;
- separate customer-facing dialogue decisions from higher-level relationship-management decisions;
- support Telegram Gifts/Stars plus a narrow crypto-payment layer for TON/USDT while removing unrelated trading/DeFi/NFT functionality;
- remove Teleton-specific subsystems only when they are no longer required by the active runtime or after useful primitives have been extracted.

## CRITICAL: DeepSeek protected scope — DO NOT MODIFY

These rules apply specifically when the active coding agent/model is **DeepSeek**.

DeepSeek may read protected code and documentation to understand context, but **MUST NOT modify, delete, rename, move, rewrite, refactor, replace, or "clean up" protected areas unless the user explicitly grants permission for that exact area in the current task**.

Do not infer permission from a broad request such as "implement the architecture", "clean up Teleton", "continue migration", "fix everything", or "refactor the project".

### DeepSeek must not modify these areas by default

1. **Architecture, product requirements and agent instructions**
   - `ARCHITECTURE.md`
   - `PRODUCT_REQUIREMENTS.md`
   - `AGENTS.md`
   - architectural/product invariants documented there

   DeepSeek implements the approved product/architecture; it does not redesign or rewrite it.

2. **Low-level Telegram/MTProto protocol behavior for anonymous chats**
   - raw MTProto update handling used by `AnonAdapter`/`AnonController`;
   - edited-message handling;
   - reply-markup/button extraction and button clicking;
   - room-generation / stale-room protocol guards;
   - protocol-specific matching of anonymous-bot service messages.

   DeepSeek may build higher-level code around already-defined interfaces, but must not invent or alter low-level protocol behavior without explicit permission.

3. **Gift/crypto payment truth and payment matching**
   - Gift sender/value interpretation;
   - live Gift event → transaction reconciliation rules;
   - crypto `PaymentExpectation` matching;
   - TON/USDT incoming payment attribution;
   - amount/range/tolerance semantics;
   - `MATCHED` / `UNMATCHED` / `MANUAL_REVIEW` decisions;
   - Offer payment state transitions;
   - duplicate-payment handling;
   - automatic payment confirmation;
   - paid fulfillment correctness after payment.

   DeepSeek must never weaken payment verification, make heuristic ambiguous payment matches, or let an LLM declare money received without a real payment event.

4. **Outbox send idempotency and crash-recovery guarantees**
   - pre-send correlation / MTProto `random_id` strategy;
   - rules preventing duplicate sends after process crash;
   - paid-media exactly-once/at-most-once fulfillment guarantees;
   - Inbox/Outbox recovery semantics;
   - processing state transitions used as reliability barriers.

   DeepSeek may call an established Outbox API, but must not redesign these guarantees without explicit permission.

5. **Supervisor process isolation and IPC contract**
   - one creator runtime = one isolated OS process;
   - `TELETON_HOME` isolation rules;
   - Supervisor ↔ CreatorWorker typed IPC contract;
   - worker crash-loop protection;
   - ownership boundary between `supervisor.db` and each `creator.db`;
   - global LLM concurrency coordination across workers.

   DeepSeek may implement code against an already-approved contract, but must not collapse process isolation or replace it with a single-process shortcut.

6. **Creator authentication/session security primitives**
   - Telegram session persistence format;
   - session file permissions;
   - interactive login/auth flow boundaries;
   - secret/API-key redaction and logging protections.

   DeepSeek must not simplify security-sensitive behavior merely to make development easier.

7. **Broad destructive cleanup**
   - deleting whole legacy subsystems;
   - removing large dependency groups;
   - replacing the bootstrap wholesale;
   - deleting Telegram/Gifts/media/provider/payment primitives because they appear unused;
   - bulk removal based only on dead-code tooling.

   DeepSeek may delete files only when the task explicitly identifies the deletion scope or when the file is clearly local to the feature it is implementing and the deletion does not cross a protected boundary.

### When DeepSeek reaches protected scope

If completing a task appears to require a protected change:

- stop at that boundary;
- leave the protected implementation unchanged;
- implement everything else that can be completed safely;
- report exactly what protected change would still be required.

Do not silently work around a protected invariant by weakening it elsewhere.

## Deletion policy

The repository is in an active migration phase. Do not blindly delete a module just because it belongs to Teleton.

Before deleting code:

1. Check whether current runtime/bootstrap imports it.
2. Check whether it contains reusable Telegram, media, Gifts, crypto-payment, LLM, database, queue, retry, debounce, scheduling, or reliability primitives.
3. Extract useful primitives first when necessary.
4. Update imports, tests, build scripts, CI, package metadata, and dependencies in the same change when appropriate.
5. Do not leave `main` knowingly uncompilable merely to complete a cleanup pass.

Safe deletion targets are modules that are both irrelevant to Anonka and no longer wired into the active runtime.

## Architecture rules

Use these principles unless the user explicitly changes them:

- One creator/persona corresponds to its own Telegram user account/runtime isolation.
- Multiple creators are not multiple LLM models.
- A shared selected LLM/provider/model may serve all creators.
- Creator behavior belongs in persona/style/strategy configuration, not separate LLM routing by default.
- Logical `conversation_id` must be separate from Telegram transport `chatId`, especially for anonymous-chat bots that reuse one physical chat.
- The **dialogue contour** owns all customer-facing wording and decides what/how to say within the persona.
- The **relationship-manager contour** owns higher-level lifecycle/next-action decisions such as whether/when to initiate a future contact, but does not compose customer-facing messages.
- The two contours may use the same provider/model; they are separate roles/prompts, not necessarily separate physical models.
- Relationship management must be event-driven or due-task-driven, not a periodic LLM scan of every conversation.
- Proactive follow-up is a first-class Anonka behavior: a conversation may schedule a future meaningful contact, and the dialogue contour writes the actual message when that contact becomes due.
- Incoming customer messages and manual creator messages invalidate/re-evaluate stale scheduled follow-ups.
- LLM handles language, semantics, persona and intent.
- Deterministic code handles Telegram side effects, state transitions, Gifts/crypto payment truth, media asset selection, paid fulfillment and anonymous-room control.
- LLM must not directly mark payments successful or select exact paid-media asset IDs.
- Preserve stale-generation/version guards for asynchronous reply generation.
- Preserve per-conversation sequential processing and bounded global concurrency.

## Conversation lifecycle and anon search

Product behavior is defined in `PRODUCT_REQUIREMENTS.md`.

At minimum:

- owner-facing conversation categories are `ACTIVE`, `INACTIVE`, `ARCHIVED`;
- `ACTIVE` conversations count toward a creator-specific `max_active_conversations` capacity;
- a quick completed sale may become `INACTIVE` immediately;
- a meaningful long-term contact may remain `ACTIVE` beyond a simple timeout when context/next-follow-up requires it;
- a configurable inactivity timeout (for example 24h) is a fallback, not the sole lifecycle rule;
- an incoming message from an inactive/archived known person restores the existing conversation context rather than starting from zero;
- anon search has an explicit owner toggle separate from actual search state;
- if search is enabled but active capacity is full, search pauses automatically;
- when capacity frees, search may resume automatically only if the owner toggle is still enabled;
- an explicit admin stop must prevent automatic resume.

## Control Bot product boundary

Control Bot is an operations/control surface, not a mirror of customer chats.

It may show conversation lists and operational metadata such as status, last activity, control mode, next follow-up, pending payment/review and alerts.

It must **not** expose full customer message bodies as the normal `/dialog` experience. Full conversation reading/manual writing stays in the creator's Telegram user account.

## Manual control

Conversation operation modes are:

- `AI`
- `HUMAN`
- `HYBRID`

Manual outgoing messages from the creator's Telegram user account are part of the same logical conversation history. They must not be discarded as irrelevant self-messages.

When a human sends manually, pending AI output or scheduled follow-up for the stale conversation version must not later overwrite or contradict that intervention.

## Payment rules

Anonka supports:

- Telegram Gifts/Stars;
- a narrow crypto-payment path for TON/USDT / Telegram Wallet-compatible flows.

For crypto:

- conversation semantics may create a durable `PaymentExpectation`;
- an LLM may understand that a customer intends to pay, but never confirms receipt;
- a real incoming wallet/blockchain/payment event is required for confirmation;
- approximate patron/support expectations may use a configurable range such as ±5 USD-equivalent when the conversation supports it;
- the ±5 rule is **not** a blanket DIRECT_SALE underpayment allowance;
- DIRECT_SALE must satisfy the actual negotiated/snapshotted price, apart from separately defined technical rounding tolerance;
- ambiguous matching between multiple expectations must go to `MANUAL_REVIEW` rather than being guessed;
- one payment event may credit/consume at most once.

Do not implement continuous LLM wallet polling. A normal payment watcher/adapter observes incoming transactions; LLM is involved only in understanding conversational intent and later reacting to confirmed facts.

## Media rules

Do not use an LLM or vision model to auto-classify/tag creator media.

Media metadata is manually supplied through strict controlled tags and parsed deterministically.

Expected access classes:

- `CASUAL`
- `TEASER`
- `PAID`

Unknown keys or invalid values should produce deterministic validation errors rather than semantic guessing.

Keep media moderation/review as a technical workflow. Do not confuse it with unwanted legal/KYC bureaucracy.

Support Telegram-native media identity and grouping where relevant, including `media_group_id` and `video_note`.

## Do not add bureaucracy

Do not introduce application-level KYC, creator age-verification flows, consent forms, `adult_status`, `consent_to_ai`, creator legal approval states, verification staff roles, or similar bureaucracy unless the user explicitly requests them.

This restriction does not apply to useful technical moderation/review of media assets.

## Teleton code reuse

Prefer adapting proven existing primitives over rewriting them from scratch when they fit Anonka.

High-value areas to preserve/extract include:

- GramJS user transport;
- Telegram bridges;
- flood retry;
- update offsets/deduplication;
- queueing/concurrency;
- debounce;
- SQLite/WAL database foundation;
- provider registry/model resolution;
- LLM request/fallback infrastructure;
- grammY control-bot primitives;
- low-level Gifts service-message parsing;
- Telegram media send/download primitives;
- reusable TON/wallet primitives only if they directly help receive/verify crypto payments;
- generic compaction/summarization mechanics after rewriting Teleton-specific prompts.

## General-agent features

Do not preserve a Teleton subsystem merely for product parity. Anonka does not need a general autonomous agent platform.

Examples of functionality that can be removed once safely unwired include DEX trading, STON.fi/DeDust trading flows, DeFi, NFT/DNS tooling, autonomous wallet agent tools, MCP, plugin marketplace/hot reload, generic tool RAG, WebUI, management API, old generic heartbeat/scheduled-agent behavior, and vector knowledge RAG.

Two explicit exceptions are Anonka product requirements, not legacy parity:

1. keep/build the narrow TON/USDT payment-receive/verification layer defined in `PRODUCT_REQUIREMENTS.md`;
2. build an Anonka-specific event-driven proactive follow-up scheduler. Do **not** preserve the old generic Teleton autonomous heartbeat to satisfy this requirement.

However, follow the deletion policy above: extract reusable low-level pieces first and keep the repository buildable during migration.

## Scope discipline

For each task:

- make the smallest coherent change that satisfies the requested goal;
- do not refactor unrelated working areas for aesthetics;
- do not broaden cleanup into protected or potentially reusable infrastructure;
- do not change architecture merely because another design is more conventional;
- preserve explicit user decisions over upstream Teleton conventions.

When the user gives a direct instruction that conflicts with this file, the user's newest explicit instruction wins.
