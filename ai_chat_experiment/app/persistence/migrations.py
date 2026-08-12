MIGRATIONS: dict[int, str] = {
    1: """
    CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL CHECK (channel IN ('anon','dm')),
        state TEXT NOT NULL CHECK (state IN ('active','handoff_pending','ended')),
        telegram_peer_id INTEGER NULL,
        anon_generation INTEGER NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_activity_at TEXT NULL,
        manual_override_until TEXT NULL,
        ended_at TEXT NULL,
        end_reason TEXT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_channel_state
        ON conversations(channel, state);
    CREATE INDEX IF NOT EXISTS idx_conversations_peer
        ON conversations(telegram_peer_id);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_active_dm_peer
        ON conversations(telegram_peer_id)
        WHERE channel='dm' AND state!='ended' AND telegram_peer_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
        transport TEXT NOT NULL CHECK (transport IN ('anon','dm')),
        kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','service','media','gift','internal')),
        source TEXT NOT NULL CHECK (source IN ('partner','llm','manual','system')),
        telegram_chat_id INTEGER NULL,
        telegram_message_id INTEGER NULL,
        text TEXT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        processed_at TEXT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation_id
        ON messages(conversation_id, id);
    CREATE INDEX IF NOT EXISTS idx_messages_unprocessed
        ON messages(processed_at)
        WHERE processed_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_telegram_key
        ON messages(telegram_chat_id, telegram_message_id)
        WHERE telegram_chat_id IS NOT NULL AND telegram_message_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS conversation_facts (
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1.0,
        source_message_id INTEGER NULL REFERENCES messages(id) ON DELETE SET NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(conversation_id, key)
    );

    CREATE TABLE IF NOT EXISTS conversation_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        through_message_id INTEGER NULL REFERENCES messages(id) ON DELETE SET NULL,
        summary_text TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_summaries_conversation
        ON conversation_summaries(conversation_id, id);

    CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NULL REFERENCES conversations(id) ON DELETE SET NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_events_type_created
        ON events(event_type, created_at);
    CREATE INDEX IF NOT EXISTS idx_events_conversation
        ON events(conversation_id, id);

    CREATE TABLE IF NOT EXISTS runtime_config (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    """
}
