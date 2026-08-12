from enum import StrEnum


class ConversationChannel(StrEnum):
    ANON = "anon"
    DM = "dm"


class ConversationState(StrEnum):
    ACTIVE = "active"
    HANDOFF_PENDING = "handoff_pending"
    ENDED = "ended"


class MessageRole(StrEnum):
    USER = "user"
    ASSISTANT = "assistant"
    SYSTEM = "system"


class MessageTransport(StrEnum):
    ANON = "anon"
    DM = "dm"


class MessageKind(StrEnum):
    TEXT = "text"
    SERVICE = "service"
    MEDIA = "media"
    GIFT = "gift"
    INTERNAL = "internal"


class MessageSource(StrEnum):
    PARTNER = "partner"
    LLM = "llm"
    MANUAL = "manual"
    SYSTEM = "system"
