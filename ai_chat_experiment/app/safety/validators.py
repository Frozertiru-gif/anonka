from telethon.tl.custom.message import Message

SHORT_ENDINGS = {"ок", "пон"}


def should_end_dialog(message: Message) -> bool:
    text = (message.raw_text or "").strip().lower()
    if not text:
        return True

    if text in SHORT_ENDINGS:
        return True

    if message.message is None:
        return True

    return False
