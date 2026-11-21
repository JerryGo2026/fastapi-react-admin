"""`g0000000aiproxy` 在升级上来的库上留下了 `ai_provider.use_proxy` 的 DEFAULT（#401）。

别的迁移加完列都会 `alter_column(server_default=None)` 清掉（模型侧默认值是 Python 级的），只有这一条漏了。
留着的后果：库和模型不一致；SQL Server 上默认值是一个具名约束，降级 `drop_column` 会被它挡住。
`au000000aiproxydefault` 补清，要在「有 DEFAULT 的老库」和「本来就没有的新库」上都能跑（幂等）。

在测试库上开一个事务跑，结束时回滚（PostgreSQL / SQL Server 的 DDL 都在事务里）。
"""

import importlib.util

from pathlib import Path
from types import SimpleNamespace

import pytest
import sqlalchemy as sa

from alembic.migration import MigrationContext
from alembic.operations import Operations

from backend.core.conf import settings
from backend.database.db import get_database_url

_VERSIONS = Path(__file__).resolve().parents[3] / 'alembic' / 'versions'


def _migration():
    path = next(_VERSIONS.glob('*-au000000aiproxydefault_*.py'))
    spec = importlib.util.spec_from_file_location('au000000aiproxydefault', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _default(conn: sa.Connection) -> object:
    col = next(c for c in sa.inspect(conn).get_columns('ai_provider') if c['name'] == 'use_proxy')
    return col.get('default')


@pytest.mark.skipif(settings.DATABASE_TYPE == 'mysql', reason='MySQL 的 DDL 会隐式提交，回滚不了，不在共享测试库上跑')
def test_upgrade_drops_the_leftover_default_and_is_idempotent(monkeypatch: pytest.MonkeyPatch) -> None:
    url = get_database_url(unittest=True).render_as_string(hide_password=False)
    sync_url = url.replace('+aioodbc', '+pyodbc').replace('+asyncpg', '+psycopg').replace('+asyncmy', '+pymysql')
    engine = sa.create_engine(sync_url)
    migration = _migration()
    try:
        with engine.connect() as conn:
            trans = conn.begin()
            try:
                op = Operations(MigrationContext.configure(conn))
                # 老库的样子：g0000000aiproxy 加列时带的 DEFAULT
                op.alter_column('ai_provider', 'use_proxy', existing_type=sa.Boolean(), server_default=sa.false())
                assert _default(conn) is not None  # 先确认「有」

                monkeypatch.setattr(migration, 'op', op)
                monkeypatch.setattr(migration, 'context', SimpleNamespace(is_offline_mode=lambda: False))
                migration.upgrade()
                assert _default(conn) is None
                migration.upgrade()  # 新库（本来就没有 DEFAULT）上再跑一次不报错
                assert _default(conn) is None
            finally:
                trans.rollback()
    finally:
        engine.dispose()
