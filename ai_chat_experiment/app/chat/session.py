from dataclasses import dataclass, field

from app.chat.state import ACTIVE, ENDED


@dataclass
class ChatSession:
    disclosure_sent: bool = False
    history: list[dict[str, str]] = field(default_factory=list)
    active: bool = True
    state: str = ACTIVE

    def reset(self) -> None:
        self.history.clear()
        self.disclosure_sent = False
        self.active = True
        self.state = ACTIVE

    def end(self) -> None:
        self.active = False
        self.state = ENDED


class SessionStore:
    def __init__(self) -> None:
        self._sessions: dict[int, ChatSession] = {}

    def get(self, chat_id: int) -> ChatSession:
        if chat_id not in self._sessions:
            self._sessions[chat_id] = ChatSession()
        return self._sessions[chat_id]

    def reset(self, chat_id: int) -> ChatSession:
        session = self.get(chat_id)
        session.reset()
        return session
