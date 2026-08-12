from dataclasses import dataclass
from datetime import datetime

from .enums import (
    ConversationChannel,
    ConversationState,
    MessageKind,
    MessageRole,
    MessageSource,
    MessageTransport,
)


@dataclass(slots=True)
class Conversation:
    id: int | None
    channel: ConversationChannel
    state: ConversationState = ConversationState.ACTIVE
    telegram_peer_id: int | None = None
    anon_generation: int | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    last_activity_at: datetime | None = None
    manual_override_until: datetime | None = None
    ended_at: datetime | None = None
    end_reason: str | None = None


@dataclass(slots=True)
class Message:
    id: int | None
    conversation_id: int
    role: MessageRole
    transport: MessageTransport
    kind: MessageKind = MessageKind.TEXT
    source: MessageSource = MessageSource.PARTNER
    telegram_chat_id: int | None = None
    telegram_message_id: int | None = None
    text: str | None = None
    created_at: datetime | None = None
    processed_at: datetime | None = None
