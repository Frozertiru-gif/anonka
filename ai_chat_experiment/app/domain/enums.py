from enum import Enum


class ConversationChannel(str, Enum):
    ANON = "anon"
    DM = "dm"


class ConversationState(str, Enum):
    ACTIVE = "active"
    HANDOFF_PENDING = "handoff_pending"
    ENDED = "ended"


class MessageRole(str, Enum):
    USER = "user"
    ASSISTANT = "assistant"
    SYSTEM = "system"


class MessageTransport(str, Enum):
    ANON = "anon"
    DM = "dm"


class MessageKind(str, Enum):
    TEXT = "text"
    SERVICE = "service"
    MEDIA = "media"
    GIFT = "gift"
    INTERNAL = "internal"


class MessageSource(str, Enum):
    PARTNER = "partner"
    LLM = "llm"
    MANUAL = "manual"
    SYSTEM = "system"
