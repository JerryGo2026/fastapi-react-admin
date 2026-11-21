"""登录失败计数的 key 一定带过期时间（#401）。

🔴 IP 维度原来是 `INCR` 之后再单独 `EXPIRE`（账号维度 #311 已改成 Lua，IP 维度没改）：两步之间进程被杀或 Redis 超时，
key 永不过期，累计到阈值之后整个出口 IP（公司 NAT）只能看到「用户名或密码有误」，要手工 `DEL`。
而且已经留下来的这种 key 原来的写法永远修不好 —— 只在 `count == 1` 时才设过期。

每条用自己建的 Redis 客户端（`asyncio.run` 里碰共享的 `redis_client` 会把它绑到一个随即关掉的循环上）。
"""

import asyncio
import uuid

import pytest

from backend.app.admin.service import user_password_history_service as svc
from backend.core.conf import settings
from backend.database.redis import RedisCli


def _run(monkeypatch: pytest.MonkeyPatch, prepare, act) -> int:
    async def scenario() -> int:
        redis = RedisCli()
        monkeypatch.setattr(svc, 'redis_client', redis)
        try:
            key = await prepare(redis)
            await act()
            return await redis.ttl(key)
        finally:
            await redis.aclose()

    return asyncio.run(scenario())


def test_ip_failure_counter_is_one_atomic_script(monkeypatch: pytest.MonkeyPatch) -> None:
    """不再分两步：`INCR` 之后不许再有单独的 `EXPIRE` 往返"""
    monkeypatch.setattr(settings, 'LOGIN_IP_LOCK_THRESHOLD', 30)
    ip = f'198.51.100.{uuid.uuid4().int % 250}'
    key = f'{settings.LOGIN_IP_FAILURE_PREFIX}:{ip}'

    async def prepare(redis: RedisCli) -> str:
        await redis.delete(key)

        async def forbidden(*_: object, **__: object) -> None:  # ruff:ignore[unused-async] —— 替身要能被 await
            raise AssertionError('INCR 和 EXPIRE 必须在同一段 Lua 里')

        monkeypatch.setattr(redis, 'incr', forbidden)
        monkeypatch.setattr(redis, 'expire', forbidden)
        return key

    ttl = _run(monkeypatch, prepare, lambda: svc.UserPasswordHistoryService.handle_ip_login_failure(ip))
    assert 0 < ttl <= settings.LOGIN_IP_LOCK_SECONDS


@pytest.mark.parametrize('dimension', ['ip', 'account'])
def test_a_counter_left_without_ttl_gets_one_on_the_next_failure(
    monkeypatch: pytest.MonkeyPatch, dimension: str
) -> None:
    """已经留下来的「没有过期时间」的计数（旧代码两步之间断掉的）：下一次失败要把过期时间补上"""
    monkeypatch.setattr(settings, 'LOGIN_IP_LOCK_THRESHOLD', 30)
    monkeypatch.setattr(settings, 'USER_LOCK_THRESHOLD', 30)
    suffix = uuid.uuid4().hex
    if dimension == 'ip':
        key = f'{settings.LOGIN_IP_FAILURE_PREFIX}:203.0.113.{uuid.uuid4().int % 250}'
        expected = settings.LOGIN_IP_LOCK_SECONDS

        async def act() -> None:
            await svc.UserPasswordHistoryService.handle_ip_login_failure(key.rsplit(':', 1)[1])

    else:
        user_id = int(suffix[:12], 16)
        key = f'{settings.LOGIN_FAILURE_PREFIX}:{user_id}'
        expected = settings.USER_LOCK_SECONDS

        async def no_config(_db: object) -> None:
            pass

        monkeypatch.setattr(svc, 'load_user_security_config', no_config)

        async def act() -> None:
            await svc.UserPasswordHistoryService.handle_login_failure(None, user_id)  # type: ignore[arg-type]

    async def prepare(redis: RedisCli) -> str:
        await redis.set(key, '5')  # 没有 TTL
        assert await redis.ttl(key) == -1
        return key

    try:
        ttl = _run(monkeypatch, prepare, act)
    finally:

        async def cleanup() -> None:
            redis = RedisCli()
            await redis.delete(key)
            await redis.aclose()

        asyncio.run(cleanup())
    assert 0 < ttl <= expected
