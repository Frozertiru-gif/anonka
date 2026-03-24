import logging

from .config import ConfigError, get_settings
from .constants import APP_LOGGER_NAME
from .logging_setup import setup_logging


def run_app() -> None:
    setup_logging()
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
