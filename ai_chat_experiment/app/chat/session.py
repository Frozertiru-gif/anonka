from dataclasses import dataclass, field


@dataclass
class ChatSession:
    disclosure_sent: bool = False
    history: list[dict[str, str]] = field(default_factory=list)


class SessionStore:
    def __init__(self) -> None:
        self._sessions: dict[int, ChatSession] = {}

    def get(self, chat_id: int) -> ChatSession:
        if chat_id not in self._sessions:
            self._sessions[chat_id] = ChatSession()
        return self._sessions[chat_id]
