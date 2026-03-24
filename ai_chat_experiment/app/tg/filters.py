from telethon.tl.custom.message import Message

from app.config import Settings


def should_process_message(message: Message, settings: Settings) -> bool:
    if message.out:
        return False

    text = (message.raw_text or "").strip()
    if not text:
        return False

    username = (getattr(message.chat, "username", "") or "").lower()
    target_username = settings.tg_target_username.strip().lower().lstrip("@")
    if not target_username:
        return False

    return username == target_username
