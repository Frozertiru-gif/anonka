from telethon import TelegramClient

from app.config import Settings


def build_client(settings: Settings) -> TelegramClient:
    return TelegramClient(
        settings.tg_session_name,
        settings.tg_api_id,
        settings.tg_api_hash,
    )
