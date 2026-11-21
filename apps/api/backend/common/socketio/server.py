import asyncio
import uuid

import socketio

from starlette_context import request_cycle_context

from backend.common.log import log
from backend.common.security.jwt import jwt_authentication, jwt_decode
from backend.core.conf import settings
from backend.database.redis import get_redis_url, redis_client

# 创建 Socket.IO 服务器实例
sio = socketio.AsyncServer(
    client_manager=socketio.AsyncRedisManager(
        # 连接串走 get_redis_url：原来这里裸 quote() 密码，带 `/` 的密码会把整条 URL 拆错
        get_redis_url(database=settings.REDIS_DATABASE),
        redis_options={
            'socket_timeout': None,
            'socket_connect_timeout': settings.REDIS_TIMEOUT,
        },
    ),
    async_mode='asgi',
    cors_allowed_origins=settings.CORS_ALLOWED_ORIGINS,
    cors_credentials=True,
    namespaces=['/ws'],
)


#: 本进程当前连着的 sid → 会话 ID。心跳靠它给自己的连接续期（Redis 丢了 key 也能写回去）
_local_sids: dict[str, str] = {}

# 在线状态（#401）：`{prefix}:sid:<sid>` → 会话 ID、`{prefix}:session:<会话 ID>` → 这个会话的 sid 集合，
# 两类 key 都带 TTL，由**持有连接的那个进程**的心跳续期（`refresh_presence`）。
# 🔴 原来没有 TTL、只靠 `disconnect` 清，启动时也不清：进程被 SIGKILL（OOM、`docker kill`）之后当时连着的 sid 永久残留，
# 「在线用户」页一直显示在线。原来还有一个全站集合 `{prefix}`（所有在线会话 ID），它没法按成员过期，已不再写，
# 在线判据改成「这个会话的 sid 集合还在」。
_PRESENCE_TOUCH = """
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
redis.call('SADD', KEYS[2], ARGV[2])
redis.call('EXPIRE', KEYS[2], ARGV[3])
return 1
"""
# 断开：删自己，顺手把会话集合里 sid key 已经过期的（死进程留下的）一起摘掉；空了就删
_PRESENCE_LEAVE = """
redis.call('DEL', KEYS[1])
redis.call('SREM', KEYS[2], ARGV[1])
for _, member in ipairs(redis.call('SMEMBERS', KEYS[2])) do
    if redis.call('EXISTS', ARGV[2] .. member) == 0 then
        redis.call('SREM', KEYS[2], member)
    end
end
if redis.call('SCARD', KEYS[2]) == 0 then
    redis.call('DEL', KEYS[2])
end
return 1
"""
# 启动时：没有 TTL 的在线 key（升级之前留下的）补一个
_EXPIRE_IF_PERSISTENT = """
if redis.call('TTL', KEYS[1]) == -1 then
    return redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return 0
"""


def _sid_key(sid: str) -> str:
    return f'{settings.TOKEN_ONLINE_REDIS_PREFIX}:sid:{sid}'


def _session_key(session_uuid: str) -> str:
    return f'{settings.TOKEN_ONLINE_REDIS_PREFIX}:session:{session_uuid}'


async def _mark_online(sid: str, session_uuid: str) -> None:
    await redis_client.eval(
        _PRESENCE_TOUCH,
        2,
        _sid_key(sid),
        _session_key(session_uuid),
        session_uuid,
        sid,
        str(settings.TOKEN_ONLINE_TTL_SECONDS),
    )


async def refresh_presence() -> None:
    """给本进程连着的每条 socket 续期（key 丢了就写回去）"""
    for sid, session_uuid in list(_local_sids.items()):
        # 遍历的是快照、每个 sid 一次 await：途中断开的连接已经被 `disconnect` 删了 key，不能再写回来
        if _local_sids.get(sid) == session_uuid:
            await _mark_online(sid, session_uuid)


async def presence_heartbeat() -> None:
    """在线状态心跳：TTL 的三分之一续一次。单次失败（Redis 抖动）记日志、下一拍再来"""
    while True:
        await asyncio.sleep(max(settings.TOKEN_ONLINE_TTL_SECONDS // 3, 1))
        try:
            await refresh_presence()
        except Exception as e:
            log.warning(f'在线状态续期失败：{e!r}')


async def sweep_presence_keys() -> None:
    """启动时：升级之前留下的、没有 TTL 的在线 key 补上 TTL（活着的会被各自进程的心跳续上），
    不再使用的全站集合直接删掉。多副本下也安全 —— 只给「没有 TTL」的 key 加 TTL，不删别的进程的连接"""
    prefix = settings.TOKEN_ONLINE_REDIS_PREFIX
    await redis_client.delete(prefix)
    async for key in redis_client.scan_iter(match=f'{prefix}:*', count=1000):
        await redis_client.eval(_EXPIRE_IF_PERSISTENT, 1, key, str(settings.TOKEN_ONLINE_TTL_SECONDS))


def user_room(user_id: int) -> str:
    """某个用户的专属房间名（同一个人多端登录会有多个 sid，全在这个房间里）"""
    return f'user:{user_id}'


@sio.event
async def connect(sid, environ, auth) -> bool:
    """Socket 连接事件"""
    if not auth:
        log.error('WebSocket 连接失败：无授权')
        return False

    token = auth.get('token')
    if not token:
        log.error('WebSocket 连接失败：授权失败，请检查')
        return False

    # 免授权直连
    if token == settings.WS_NO_AUTH_MARKER:
        session_uuid = auth.get('session_uuid')
        if not session_uuid:
            log.error('WebSocket 连接失败：免授权直连要带 session_uuid')
            return False
        if settings.ENVIRONMENT == 'prod':
            log.error('WebSocket 连接失败：生产环境禁止免授权直连')
            return False
        await _mark_online(sid, session_uuid)
        _local_sids[sid] = session_uuid
        return True

    try:
        with request_cycle_context({settings.TRACE_ID_REQUEST_HEADER_KEY: uuid.uuid4().hex}):
            # 握手不算「用户在操作」：页面挂着自动重连不该把一个空闲的会话续上
            user = await jwt_authentication(token, touch=False)
    except Exception as e:
        log.info(f'WebSocket 连接失败：{e!s}')
        return False

    # 🔴 会话 ID 从令牌里取，不信前端报上来的 `auth.session_uuid`（#138）。
    # 原来用的是前端那一份：刷新之后前端存的还是旧 ID（那时每次刷新都换 ID），
    # 于是在线用户页把**正连着的**会话显示成离线；而且任何人报一个别人的会话 ID 就能把它标成在线
    session_uuid = jwt_decode(token).session_uuid

    # 定向推送的落点。没有房间的话 `sio.emit()` 只能广播给所有连接 ——
    # 「只发给某个人」这件事在传输层就没有地方可落，会被迫在业务层
    # 把内容广播出去再让前端自己过滤（等于把权限判断交给客户端）。
    # 广播型通知（公告）不需要它，但预留成本只有这一行。
    await sio.enter_room(sid, user_room(user.id))

    # 🔴 先写 Redis、成功了才记进连接表（评审发现）：写 Redis 抛了 → 握手被拒、socketio 不会为它调 `disconnect`，
    # 先记表的话这个 sid 永远留在表里，心跳每拍把它写回去 —— 一个连不上的连接永久「在线」
    await _mark_online(sid, session_uuid)
    _local_sids[sid] = session_uuid
    return True


@sio.event
async def disconnect(sid) -> None:
    """Socket 断开连接事件"""
    session_uuid = _local_sids.pop(sid, None) or await redis_client.get(_sid_key(sid))
    if not session_uuid:
        return
    await redis_client.eval(
        _PRESENCE_LEAVE,
        2,
        _sid_key(sid),
        _session_key(session_uuid),
        sid,
        f'{settings.TOKEN_ONLINE_REDIS_PREFIX}:sid:',
    )
