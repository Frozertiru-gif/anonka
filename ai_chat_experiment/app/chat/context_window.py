def trim_history(history: list[dict[str, str]], max_context_messages: int) -> list[dict[str, str]]:
    if max_context_messages <= 0:
        return []
    if len(history) <= max_context_messages:
        return history
    return history[-max_context_messages:]
