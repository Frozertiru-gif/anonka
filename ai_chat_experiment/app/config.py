from dataclasses import dataclass
from functools import lru_cache
import os
from pathlib import Path

from dotenv import load_dotenv

from .constants import (
    DEFAULT_MAX_CONTEXT_MESSAGES,
    DEFAULT_REPLY_DELAY_MAX,
    DEFAULT_REPLY_DELAY_MIN,
)


@dataclass(frozen=True)
class Settings:
    tg_api_id: int
    tg_api_hash: str
    tg_session_name: str
    tg_target_username: str
    xai_api_key: str
    xai_base_url: str
    xai_model: str
    reply_delay_min: int = DEFAULT_REPLY_DELAY_MIN
    reply_delay_max: int = DEFAULT_REPLY_DELAY_MAX
    max_context_messages: int = DEFAULT_MAX_CONTEXT_MESSAGES
    dry_run: bool = False


class ConfigError(ValueError):
    pass


def _parse_int(name: str, default: int | None = None) -> int:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        if default is not None:
            return default
        raise ConfigError(f"Missing required environment variable: {name}")
    try:
        return int(raw)
    except ValueError as exc:
        raise ConfigError(f"Environment variable {name} must be an integer") from exc


def _parse_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default

    normalized = raw.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ConfigError(
        f"Environment variable {name} must be a boolean "
        "(true/false, 1/0, yes/no, on/off)"
    )


def _get_required_str(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise ConfigError(f"Missing required environment variable: {name}")
    return value


def _validate_ranges(reply_delay_min: int, reply_delay_max: int, max_context_messages: int) -> None:
    if reply_delay_min < 0:
        raise ConfigError("REPLY_DELAY_MIN must be >= 0")
    if reply_delay_max < 0:
        raise ConfigError("REPLY_DELAY_MAX must be >= 0")
    if reply_delay_min > reply_delay_max:
        raise ConfigError("REPLY_DELAY_MIN cannot be greater than REPLY_DELAY_MAX")
    if max_context_messages <= 0:
        raise ConfigError("MAX_CONTEXT_MESSAGES must be > 0")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    root_dir = Path(__file__).resolve().parents[1]
    load_dotenv(root_dir / ".env")

    reply_delay_min = _parse_int("REPLY_DELAY_MIN", DEFAULT_REPLY_DELAY_MIN)
    reply_delay_max = _parse_int("REPLY_DELAY_MAX", DEFAULT_REPLY_DELAY_MAX)
    max_context_messages = _parse_int("MAX_CONTEXT_MESSAGES", DEFAULT_MAX_CONTEXT_MESSAGES)

    _validate_ranges(reply_delay_min, reply_delay_max, max_context_messages)

    return Settings(
        tg_api_id=_parse_int("TG_API_ID"),
        tg_api_hash=_get_required_str("TG_API_HASH"),
        tg_session_name=_get_required_str("TG_SESSION_NAME"),
        tg_target_username=_get_required_str("TG_TARGET_USERNAME"),
        xai_api_key=_get_required_str("XAI_API_KEY"),
        xai_base_url=_get_required_str("XAI_BASE_URL"),
        xai_model=_get_required_str("XAI_MODEL"),
        reply_delay_min=reply_delay_min,
        reply_delay_max=reply_delay_max,
        max_context_messages=max_context_messages,
        dry_run=_parse_bool("DRY_RUN", default=False),
    )
