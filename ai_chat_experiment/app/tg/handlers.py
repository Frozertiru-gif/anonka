import logging

from telethon import TelegramClient, events
from telethon.tl.custom.message import Message

from app.chat.session import SessionStore
from app.config import Settings
from app.constants import APP_LOGGER_NAME
from app.safety.disclosure import build_disclosure_message
from app.safety.validators import should_end_dialog
from app.services.delay_service import random_reply_delay
from app.services.reply_service import ReplyService
from app.tg.filters import should_process_message
from app.tg.sender import send_text

logger = logging.getLogger(APP_LOGGER_NAME)


END_REPLY_TEXT = "Ок, тогда давай закончим 🙂"


def register_handlers(
    client: TelegramClient,
    settings: Settings,
    reply_service: ReplyService,
    session_store: SessionStore,
) -> None:
    @client.on(events.NewMessage(incoming=True))
    async def on_new_message(event: events.NewMessage.Event) -> None:
        message: Message = event.message

        if not should_process_message(message, settings):
            return

        chat = await event.get_chat()
        chat_id = event.chat_id
        if chat_id is None:
            logger.warning("Skip message without chat_id")
            return

        incoming_text = (message.raw_text or "").strip()
        session = session_store.get(chat_id)

        try:
            if not session.disclosure_sent:
                await send_text(client, chat, build_disclosure_message(), settings)
                session.disclosure_sent = True

            if should_end_dialog(message):
                await random_reply_delay(settings.reply_delay_min, settings.reply_delay_max)
                await send_text(client, chat, END_REPLY_TEXT, settings)
                session.end()
                session_store.reset(chat_id)
                return

            response = reply_service.build_reply(session, incoming_text)
            reply_text = response["reply"]
            action = response["action"]

            await random_reply_delay(settings.reply_delay_min, settings.reply_delay_max)
            await send_text(client, chat, reply_text, settings)

            if action == "end":
                session.end()
                session_store.reset(chat_id)
        except Exception:
            logger.exception("Failed to process message for chat_id=%s", chat_id)
