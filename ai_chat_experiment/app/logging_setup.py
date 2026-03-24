import logging
import sys

from .constants import APP_LOGGER_NAME


def setup_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
        datefmt="%H:%M:%S",
        stream=sys.stdout,
    )
    logging.getLogger(APP_LOGGER_NAME).setLevel(logging.INFO)
