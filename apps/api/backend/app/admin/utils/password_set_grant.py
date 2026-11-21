"""无密码账号「第一次设密码」的身份确认凭据（#402）

第三方登录自动建的号 `sys_user.password` 是 NULL。它改密码时没有「旧密码」可验 —— 原来
`update_password` 对它直接跳过旧密码校验，只是后面构造历史记录时 `password=None` 抛 ValidationError
碰巧把整条路堵死（功能缺陷：这种号永远设不上密码）。把那个异常放过去，就成了「拿到这个人一枚
access token（30 分钟）就能给他设一个长期有效的密码」。

所以第一次设密码要另一种身份证明：**重新走一遍已绑定的第三方授权**（`plugin/oauth2` 的
`GET /oauth2/me/reauth`）。回调确认授权回来的第三方账号就是绑在这个人名下的那一个，才在这里记一笔，
有效期 `TTL_SECONDS`，只能设一次。

🔴 **写库成功之后才消费，并发照样只能用一次**（#437）。原来 `update_password` 在写库**之前** `GETDEL`：
之后写库 / 提交失败，凭据已经没了，用户只能重跑一遍第三方授权。现在分三步：

1. `claim`：另一把 key 上 `SET NX` 占住 —— 两个并发请求只有一个占得到，凭据本身不动。
   占位的寿命 = 凭据的剩余寿命（同一段 Lua 里读 `PTTL` 再 `SET NX PX`，原子）
2. 写库。service 里抛错 → `release`（比对 token 再删占位）；**提交**那一步失败 service 看不到，
   靠 `release_on_rollback` 挂在会话最外层回滚上的钩子还回去
3. 提交成功之后（后台任务）`finish`：凭据和占位一起删；它失败只记日志，**不能抛**

🔴 **占位不能比凭据先过期**（#438 评审）。原来占位固定 30 秒：一次写库卡过 30 秒（行锁等待），
同一会话的第二个请求就能再占一次、两次都写进去 —— 原来的 `GETDEL` 不管写多久都只给一次。跟着凭据走之后，
占位没还回去（回写本身失败）最坏卡到凭据过期（≤ `TTL_SECONDS`），那时本来也要重新授权。

🔴 **`finish` 不能抛**：Starlette 的后台任务按顺序跑、一个抛了后面的全不跑，而它排在「撤全部会话」
（`_revoke_after_commit`）前面 —— Redis 抖一下，偷来 token 的那个会话就活过了改密码。
提交成功之后 `sys_user.password` 已经不是 NULL，凭据那条分支根本走不到 —— `finish` 没跑成也不会被用第二次。

🔴 **凭据记在「发起重新授权的那个会话」上，不是记在用户上**（#402 评审）。按用户记的话，
拿着偷来 token 的另一个会话轮询 `password-status`，一看到本人刚验证完就抢先设一个只有自己知道的密码 ——
本人那次验证反倒替攻击者开了门。会话 ID 来自 access token（`jwt_decode(...).session_uuid`）。

放在 admin 而不是 oauth2 插件里：消费方是 admin 的 `user_service`，admin 不能反过来 import 插件。
插件停用时没有人能写入凭据，无密码账号自助设不了密码，只能找超管重置（超管重置不需要这一步）。
"""

import asyncio

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from uuid import uuid4

from sqlalchemy import event as sa_event
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session, SessionTransaction
from starlette.background import BackgroundTasks

from backend.common.exception import errors
from backend.common.i18n import t
from backend.common.log import log
from backend.database.redis import redis_client

TTL_SECONDS = 600
_PREFIX = 'fba:user:password_set_grant'
_CLAIM_PREFIX = 'fba:user:password_set_claim'

# 凭据还在、没被占 → 占住，寿命跟凭据剩下的一样长（不会比凭据先过期，见模块说明）。
# 返回 1 占到 / 0 凭据不在 / -1 被别的请求占着
_CLAIM = """
local ttl = redis.call('PTTL', KEYS[1])
if ttl == -2 then
    return 0
end
if ttl < 0 then
    ttl = tonumber(ARGV[2])
end
if redis.call('SET', KEYS[2], ARGV[1], 'NX', 'PX', ttl) then
    return 1
end
return -1
"""
# 比对 token 再删占位：租期过了被别人重新占住时，不能把别人的删掉
_RELEASE = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
end
return 0
"""
_background: set[asyncio.Task[None]] = set()


class PasswordSetBusy(Exception):  # ruff: ignore[error-suffix-on-exception-name]
    """凭据还在，但同一会话的另一个请求正在用它写库（双击保存）—— 不是「要重新验证」"""


def _key(user_id: int, session_uuid: str) -> str:
    return f'{_PREFIX}:{user_id}:{session_uuid}'


def _claim_key(user_id: int, session_uuid: str) -> str:
    return f'{_CLAIM_PREFIX}:{user_id}:{session_uuid}'


async def grant(user_id: int, session_uuid: str) -> None:
    """第三方重新授权成功：给发起的那个会话记一笔，`TTL_SECONDS` 内有效"""
    await redis_client.set(_key(user_id, session_uuid), '1', ex=TTL_SECONDS)


async def is_granted(user_id: int, session_uuid: str) -> bool:
    """给个人中心看「这个会话验证过了没有」，不消费"""
    return bool(await redis_client.exists(_key(user_id, session_uuid)))


async def claim(user_id: int, session_uuid: str) -> str | None:
    """写库之前占住凭据：两个并发请求只有一个拿得到 token。

    凭据不在 → None；凭据在但被同一会话的另一个请求占着 → `PasswordSetBusy`
    """
    token = uuid4().hex
    result = await redis_client.eval(
        _CLAIM, 2, _key(user_id, session_uuid), _claim_key(user_id, session_uuid), token, TTL_SECONDS * 1000
    )
    if int(result) == -1:
        raise PasswordSetBusy
    return token if int(result) == 1 else None


async def release(user_id: int, session_uuid: str, token: str) -> None:
    """写库失败：放开占位，凭据原样留着，用户不用重跑第三方授权"""
    await redis_client.eval(_RELEASE, 1, _claim_key(user_id, session_uuid), token)


async def finish(user_id: int, session_uuid: str) -> None:
    """提交成功之后：凭据和占位一起删。🔴 不能抛 —— 后面排着「撤全部会话」的后台任务（见模块说明）"""
    try:
        await redis_client.delete(_key(user_id, session_uuid), _claim_key(user_id, session_uuid))
    except Exception as e:
        # 密码已经设上了，凭据那条分支走不到；剩下的凭据 / 占位自己过期
        log.warning(f'设密凭据收尾删除失败（{TTL_SECONDS}s 内自动过期）：{e}')


@asynccontextmanager
async def held(
    db: AsyncSession, background_tasks: BackgroundTasks, *, user_id: int, session_uuid: str
) -> AsyncIterator[None]:
    """包住「写密码」那几句：进来时占凭据（凭据没了 → 要求重新验证；被同会话另一个请求占着 → 稍后再试），
    里面抛错 → 放开占位，提交失败 → 回滚钩子放开，
    提交成功 → 后台任务删凭据（`CurrentSessionTransaction` 先提交、后台任务后跑、回滚不跑）
    """
    try:
        token = await claim(user_id, session_uuid)
    except PasswordSetBusy:
        raise errors.RequestError(msg=t('error.user.password_set_in_progress'))
    if token is None:
        raise errors.RequestError(msg=t('error.user.password_set_requires_reauth'))
    release_on_rollback(db, user_id, session_uuid, token)
    try:
        yield
        # 库的报错尽量在这里冒出来，交给下面同步放开（提交那一步的失败靠回滚钩子）
        await db.flush()
    except BaseException:
        # 放开失败不能盖掉写库那个错（报给用户 / 进日志的要是它）；没放开的占位由回滚钩子再试一次
        await _release_quietly(user_id, session_uuid, token)
        raise
    background_tasks.add_task(finish, user_id, session_uuid)


def release_on_rollback(db: AsyncSession, user_id: int, session_uuid: str, token: str) -> None:
    """提交那一步失败时 service 里的 try 已经退出了，挂在会话**最外层**回滚上把占位还回去

    保存点回滚不算（`previous_transaction.parent` 不为 None）—— 外层还可能提交
    """
    sync: Session = db.sync_session
    fired = False

    # ⚠️ 不能在钩子里 `sa_event.remove` 自己：派发途中改监听列表 → `RuntimeError: deque mutated during iteration`
    def _on_rollback(_: Session, previous_transaction: SessionTransaction) -> None:
        nonlocal fired
        if fired or previous_transaction.parent is not None:
            return
        fired = True
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        task = loop.create_task(_release_quietly(user_id, session_uuid, token))
        _background.add(task)
        task.add_done_callback(_background.discard)

    sa_event.listen(sync, 'after_soft_rollback', _on_rollback)


async def _release_quietly(user_id: int, session_uuid: str, token: str) -> None:
    try:
        await release(user_id, session_uuid, token)
    except Exception as e:  # 没人接这个异常，要自己落日志；最坏卡到凭据过期
        log.warning(f'设密凭据占位回写失败（随凭据在 {TTL_SECONDS}s 内过期）：{e}')
