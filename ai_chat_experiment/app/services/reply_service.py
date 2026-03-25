from app.chat.session import ChatSession
from app.config import Settings
from app.llm.grok_client import GrokClient
from app.llm.message_builder import build_messages
from app.llm.prompts import SYSTEM_PROMPT


class ReplyService:
    def __init__(self, settings: Settings, grok_client: GrokClient) -> None:
        self._settings = settings
        self._grok_client = grok_client

    def build_reply(self, session: ChatSession, incoming_text: str) -> dict[str, str]:
        session.history.append({"role": "user", "content": incoming_text})

        messages = build_messages(
            system_prompt=SYSTEM_PROMPT,
            history=session.history[:-1],
            user_text=incoming_text,
            max_context_messages=self._settings.max_context_messages,
        )
        response = self._grok_client.generate_reply(messages)

        session.history.append({"role": "assistant", "content": response["reply"]})

        return response
