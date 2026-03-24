from app.chat.context_window import trim_history


def build_messages(
    *,
    system_prompt: str,
    history: list[dict[str, str]],
    user_text: str,
    max_context_messages: int,
) -> list[dict[str, str]]:
    messages: list[dict[str, str]] = [{"role": "system", "content": system_prompt}]
    messages.extend(trim_history(history, max_context_messages))
    messages.append({"role": "user", "content": user_text})
    return messages
