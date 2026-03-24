import asyncio
import logging

from .chat.session import SessionStore
from .config import ConfigError, get_settings
from .constants import APP_LOGGER_NAME
from .llm.grok_client import GrokClient
from .logging_setup import setup_logging
from .services.reply_service import ReplyService
from .tg.client import build_client
from .tg.handlers import register_handlers


async def _run_async() -> None:
    logger = logging.getLogger(APP_LOGGER_NAME)

    try:
        settings = get_settings()
    except ConfigError as exc:
        logger.error("Configuration error: %s", exc)
        raise SystemExit(1) from exc

    logger.info(
        "Application started (dry_run=%s, target=%s, model=%s)",
        settings.dry_run,
        settings.tg_target_username,
        settings.xai_model,
    )

    tg_client = build_client(settings)
    grok_client = GrokClient(settings)
    reply_service = ReplyService(settings, grok_client)
    session_store = SessionStore()

    register_handlers(tg_client, settings, reply_service, session_store)

    await tg_client.start()
    me = await tg_client.get_me()
    logger.info("Telegram client connected as @%s", getattr(me, "username", "unknown"))
    await tg_client.run_until_disconnected()


def run_app() -> None:
    setup_logging()
    asyncio.run(_run_async())
