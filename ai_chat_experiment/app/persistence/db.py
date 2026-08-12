from pathlib import Path

import aiosqlite

from .migrations import MIGRATIONS


class Database:
    def __init__(self, path: str) -> None:
        self.path = Path(path)
        self._conn: aiosqlite.Connection | None = None

    @property
    def conn(self) -> aiosqlite.Connection:
        if self._conn is None:
            raise RuntimeError("Database is not connected")
        return self._conn

    async def connect(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = await aiosqlite.connect(self.path)
        self._conn.row_factory = aiosqlite.Row
        await self._conn.execute("PRAGMA journal_mode=WAL;")
        await self._conn.execute("PRAGMA foreign_keys=ON;")
        await self._conn.execute("PRAGMA busy_timeout=5000;")
        await self._conn.commit()

    async def migrate(self) -> None:
        conn = self.conn
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        await conn.commit()

        cursor = await conn.execute("SELECT version FROM schema_migrations")
        rows = await cursor.fetchall()
        applied = {int(row[0]) for row in rows}

        for version in sorted(MIGRATIONS):
            if version in applied:
                continue

            script = (
                "BEGIN IMMEDIATE;\n"
                + MIGRATIONS[version]
                + f"\nINSERT INTO schema_migrations(version) VALUES ({version});\n"
                + "COMMIT;"
            )
            try:
                await conn.executescript(script)
            except Exception:
                try:
                    await conn.rollback()
                finally:
                    raise

    async def close(self) -> None:
        if self._conn is not None:
            await self._conn.close()
            self._conn = None
