import asyncio
import random


async def random_reply_delay(delay_min: int, delay_max: int) -> None:
    delay = random.uniform(delay_min, delay_max)
    await asyncio.sleep(delay)
