import logging

from telethon import TelegramClient

from app.config import Settings
from app.constants import APP_LOGGER_NAME

logger = logging.getLogger(APP_LOGGER_NAME)


async def send_text(
    client: TelegramClient,
    entity: str | int,
    text: str,
    settings: Settings,
) -> None:
    if settings.dry_run:
        logger.info("DRY_RUN enabled; message was not sent to %s: %s", entity, text)
        return

    await client.send_message(entity=entity, message=text)
