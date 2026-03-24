import logging

from openai import OpenAI

from app.config import Settings
from app.constants import APP_LOGGER_NAME

logger = logging.getLogger(APP_LOGGER_NAME)


class GrokClient:
    def __init__(self, settings: Settings) -> None:
        self._model = settings.xai_model
        self._client = OpenAI(
            api_key=settings.xai_api_key,
            base_url=settings.xai_base_url,
            timeout=settings.xai_timeout_seconds,
        )

    def generate_reply(self, messages: list[dict[str, str]]) -> str:
        try:
            response = self._client.chat.completions.create(
                model=self._model,
                messages=messages,
            )
        except Exception:
            logger.exception("xAI Chat Completions call failed")
            return "Извини, сейчас не получилось ответить. Попробуй еще раз через минуту."

        if not response.choices:
            logger.error("xAI returned empty choices")
            return "Извини, сейчас не получилось ответить."

        content = response.choices[0].message.content
        if not content:
            logger.error("xAI returned empty message content")
            return "Извини, я пока без ответа 😅"

        return content.strip()
