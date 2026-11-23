# apps/api/backend/database —— 引擎与连接

> 这份文件是 [`apps/api` 分册](../../AGENTS.md) 的**子分册**，Claude Code 读到本目录下的
> 文件时才把它加载进上下文（惰性加载）。跨模块的硬纪律只在根 `CLAUDE.md` 里有一份；
> **新增结论请追加到离代码最近的那一份**。

## 🔴 SQL Server：新连接上的第一条查询偶发 `ODBC SQL type -155`（#442）

**症状**：CI 的 `pytest · SQL Server` 偶发红一条和改动无关的用例（第一次见是审批并发用例
`test_cosign_last_two_approve_at_once`），报错 `('ODBC SQL type -155 is not yet supported.', 'HY106')`。
-155 是 `DATETIMEOFFSET`，本仓库所有时间列在 SQL Server 上都是它。生产上同样会发生：
连接池**新建**连接（启动、扩容、`pool_recycle` 到期、断线重连）后的第一条读时间列的查询，偶发 500。

**根因**：SQLAlchemy 的 mssql 方言在 `on_connect` 里调 `add_output_converter(-155, …)`。走 aioodbc 时
SQLAlchemy 的 aioodbc 适配层（`AsyncAdapt_aioodbc_connection.add_output_converter`）直接转给 aioodbc、**没有 `await_`**，而 aioodbc 的实现是
把注册丢进线程池、返回一个 future —— 没人等它。第一条查询也进线程池，两件事谁先跑没有保证。
并发用例同时开两条新连接、CI 机器又忙，最容易撞上。

**修法**：`register_mssql_datetimeoffset(engine)` 挂在 `connect` 事件上，**同步**对底层 pyodbc 连接
（`dbapi_connection._connection._conn`）注册同一个转换器。此时连接上还没有任何查询，同步调用是安全的；
方言那一步晚到也只是把同一个转换器再设一遍。`create_database_async_engine` 和 `alembic/env.py`
（它自己建引擎，不走前者）两处都要挂 —— **新增「不走 `create_database_async_engine` 自己建异步引擎」的地方，同样要挂。**

**实测证据**（2026-11-23，本地 SQL Server 2022 + aioodbc）：
- 最小复现：把 aioodbc 线程池里的注册人为拖慢 0.3 秒，新连接的第一条 `SELECT CAST(SYSDATETIMEOFFSET() AS DATETIMEOFFSET)`
  稳定报出同一句 -155；套上这个函数之后同样条件下读出带时区的 datetime
- `backend/tests/test_mssql_datetimeoffset.py` 2 条（把方言那一步换成永不完成的 future，竞态变成必然）：
  修前两条都红在 -155，修后都过；还核对了微秒截断和负偏移（`-03:30`）的分钟
