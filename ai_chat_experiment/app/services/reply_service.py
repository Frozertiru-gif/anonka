from app.chat.session import ChatSession
from app.config import Settings
from app.llm.grok_client import GrokClient
from app.llm.message_builder import build_messages
from app.llm.prompts import SYSTEM_PROMPT


class ReplyService:
    def __init__(self, settings: Settings, grok_client: GrokClient) -> None:
        self._settings = settings
        self._grok_client = grok_client

    def build_reply(self, session: ChatSession, incoming_text: str) -> str:
        messages = build_messages(
            system_prompt=SYSTEM_PROMPT,
            history=session.history,
            user_text=incoming_text,
            max_context_messages=self._settings.max_context_messages,
        )
        reply_text = self._grok_client.generate_reply(messages)

        session.history.append({"role": "user", "content": incoming_text})
        session.history.append({"role": "assistant", "content": reply_text})

        return reply_text
