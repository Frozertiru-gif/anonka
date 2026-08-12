# AGENTS.md

This file contains mandatory repository-level instructions for Codex, DeepSeek and any other coding agent working on Anonka.

## Project direction

Anonka is being migrated away from the general-purpose Teleton Agent product into a focused Telegram automation system.

The target architecture is defined in `ARCHITECTURE.md`. Treat it as the canonical architectural source unless the user explicitly gives a newer instruction.

Core direction:

- keep and reuse useful Telegram/MTProto infrastructure;
- keep useful LLM provider infrastructure;
- keep SQLite/better-sqlite3 foundations;
- keep useful Telegram Gifts/media primitives;
- replace the autonomous general-agent decision layer with the Anonka conversation pipeline;
- remove Teleton-specific subsystems only when they are no longer required by the active runtime or after useful primitives have been extracted.

## CRITICAL: DeepSeek protected scope — DO NOT MODIFY

These rules apply specifically when the active coding agent/model is **DeepSeek**.

DeepSeek may read protected code and documentation to understand context, but **MUST NOT modify, delete, rename, move, rewrite, refactor, replace, or "clean up" protected areas unless the user explicitly grants permission for that exact area in the current task**.

Do not infer permission from a broad request such as "implement the architecture", "clean up Teleton", "continue migration", "fix everything", or "refactor the project".

### DeepSeek must not modify these areas by default

1. **Architecture and agent instructions**
   - `ARCHITECTURE.md`
   - `AGENTS.md`
   - architectural invariants documented there

   DeepSeek implements the architecture; it does not redesign or rewrite it.

2. **Low-level Telegram/MTProto protocol behavior for anonymous chats**
   - raw MTProto update handling used by `AnonAdapter`/`AnonController`;
   - edited-message handling;
   - reply-markup/button extraction and button clicking;
   - room-generation / stale-room protocol guards;
   - protocol-specific matching of anonymous-bot service messages.

   DeepSeek may build higher-level code around already-defined interfaces, but must not invent or alter low-level protocol behavior without explicit permission.

3. **Gift/payment truth and payment matching**
   - Gift sender/value interpretation;
   - live Gift event → transaction reconciliation rules;
   - `MATCHED` / `UNMATCHED` payment decisions;
   - Offer payment state transitions;
   - duplicate-Gift handling;
   - automatic payment confirmation;
   - paid fulfillment correctness after payment.

   DeepSeek must never weaken payment verification or make heuristic Gift matching decisions.

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
   - deleting Telegram/Gifts/media/provider primitives because they appear unused;
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
2. Check whether it contains reusable Telegram, media, Gifts, LLM, database, queue, retry, debounce, or reliability primitives.
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
- LLM handles language, semantics, persona and intent.
- Deterministic code handles Telegram side effects, state transitions, Gifts/payment truth, media asset selection, paid fulfillment and anonymous-room control.
- LLM must not directly mark payments successful or select exact paid-media asset IDs.
- Preserve stale-generation/version guards for asynchronous reply generation.
- Preserve per-conversation sequential processing and bounded global concurrency.

## Manual control

Conversation operation modes are:

- `AI`
- `HUMAN`
- `HYBRID`

Manual outgoing messages from the creator's Telegram user account are part of the same logical conversation history. They must not be discarded as irrelevant self-messages.

When a human sends manually, pending AI output for the stale conversation version must not later overwrite or contradict that intervention.

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
- generic compaction/summarization mechanics after rewriting Teleton-specific prompts.

## General-agent features

Do not preserve a Teleton subsystem merely for product parity. Anonka does not need a general autonomous agent platform.

Examples of functionality that can be removed once safely unwired include TON/DEX/wallet/NFT/DNS/DeFi features, MCP, plugin marketplace/hot reload, generic tool RAG, WebUI, management API, autonomous heartbeat/scheduled-agent behavior, and vector knowledge RAG.

However, follow the deletion policy above: extract reusable low-level pieces first and keep the repository buildable during migration.

## Scope discipline

For each task:

- make the smallest coherent change that satisfies the requested goal;
- do not refactor unrelated working areas for aesthetics;
- do not broaden cleanup into protected or potentially reusable infrastructure;
- do not change architecture merely because another design is more conventional;
- preserve explicit user decisions over upstream Teleton conventions.

When the user gives a direct instruction that conflicts with this file, the user's newest explicit instruction wins.
