"""SQL Server：新连接上的第一条查询要能读 DATETIMEOFFSET（#442）。

SQLAlchemy 的 mssql 方言在 `on_connect` 里注册 -155 的转换器，走 aioodbc 时那一步进了线程池，
返回的 future 没人等。CI 上 `test_cosign_last_two_approve_at_once` 因此偶发 -155：
两个动作各开一条新连接，第一条查询抢在注册之前执行。
这里把方言那一步换成「永远不完成」，把竞态变成必然 —— 修之前稳定 -155。
"""

import asyncio
import datetime

import aioodbc.connection
import pytest

from sqlalchemy import text

from backend.core.conf import settings
from backend.database.db import create_database_async_engine, get_database_url

pytestmark = pytest.mark.skipif(settings.DATABASE_TYPE != 'sqlserver', reason='DATETIMEOFFSET 只有 SQL Server 有')


def _never_registered(self: aioodbc.connection.Connection, sqltype: int, func: object) -> asyncio.Future[None]:
    """方言那一步「还没执行完」：返回一个永远不完成的 future，什么都不注册"""
    return asyncio.get_running_loop().create_future()


def test_first_query_on_a_new_connection_reads_datetimeoffset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(aioodbc.connection.Connection, 'add_output_converter', _never_registered)

    async def first_query() -> datetime.datetime:
        engine = create_database_async_engine(get_database_url(unittest=True))
        try:
            async with engine.connect() as conn:
                return (
                    await conn.execute(text("SELECT CAST('2026-01-02T03:04:05.1234567+08:00' AS DATETIMEOFFSET(7))"))
                ).scalar_one()
        finally:
            await engine.dispose()

    value = asyncio.run(first_query())
    # 和 SQLAlchemy 方言自带的转换器同一个结果：微秒截断（100ns → μs），偏移原样保留
    assert value == datetime.datetime(
        2026, 1, 2, 3, 4, 5, 123456, tzinfo=datetime.timezone(datetime.timedelta(hours=8))
    )
    assert value.utcoffset() == datetime.timedelta(hours=8)


def test_negative_offset_keeps_its_minutes(monkeypatch: pytest.MonkeyPatch) -> None:
    """负偏移的分钟也是负的（`-03:30` 存成 hour=-3, minute=-30），别拼成 -02:30"""
    monkeypatch.setattr(aioodbc.connection.Connection, 'add_output_converter', _never_registered)

    async def first_query() -> datetime.datetime:
        engine = create_database_async_engine(get_database_url(unittest=True))
        try:
            async with engine.connect() as conn:
                return (
                    await conn.execute(text("SELECT CAST('2026-01-02T03:04:05-03:30' AS DATETIMEOFFSET)"))
                ).scalar_one()
        finally:
            await engine.dispose()

    assert asyncio.run(first_query()).utcoffset() == -datetime.timedelta(hours=3, minutes=30)
