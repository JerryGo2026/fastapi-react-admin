"""清掉 ai_provider.use_proxy 遗留的 DEFAULT（#401）

Revision ID: au000000aiproxydefault
Revises: at000000configsecret
Create Date: 2026-11-22 12:00:00

`g0000000aiproxy` 加列时带了 `server_default=false()` 回填存量行，但没有像别的加列迁移那样随后
`alter_column(server_default=None)` 清掉 —— 升级上来的库上留着这个 DEFAULT，`create_all` 建的新库上没有
（模型侧默认值是 Python 级的）。SQL Server 上它是一个具名的默认约束，会挡住以后对这一列的 `drop_column`。

那条迁移已经进过 tag，不改它（1.0 兼容约定），在这里补清。幂等：新库上本来就没有，表 / 列不在就跳过。
"""

import sqlalchemy as sa

from alembic import context, op

# revision identifiers, used by Alembic.
revision = 'au000000aiproxydefault'
down_revision = 'at000000configsecret'
branch_labels = None
depends_on = None


def upgrade() -> None:
    if not context.is_offline_mode():
        inspector = sa.inspect(op.get_bind())
        if not inspector.has_table('ai_provider'):
            return
        column = next((c for c in inspector.get_columns('ai_provider') if c['name'] == 'use_proxy'), None)
        if column is None or column.get('default') is None:
            return
    # mssql 上 alembic 会先按名字查出默认约束再删；PostgreSQL / MySQL 是 ALTER COLUMN … DROP DEFAULT
    op.alter_column(
        'ai_provider',
        'use_proxy',
        existing_type=sa.Boolean(),
        existing_nullable=False,
        existing_comment='是否走系统代理（内网网关按实际可达路径选）',
        server_default=None,
    )


def downgrade() -> None:
    # 不把 DEFAULT 加回去：它本来就是漏清的，加回去只会让 `g0000000aiproxy` 的降级在 SQL Server 上又被默认约束挡住
    pass
