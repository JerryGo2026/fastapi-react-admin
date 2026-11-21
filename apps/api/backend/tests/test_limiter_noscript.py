"""限流 bucket 在 Redis 丢了脚本缓存之后要能自愈（真实 Redis）。

实测（2026-11-06）：WSL 里的 Redis 重启后，验证码接口每次都 500「No matching script. Please use EVAL.」，
谁都登录不了，直到重启 api。`RedisBucket` 创建时 `SCRIPT LOAD` 一次、之后一直 `EVALSHA`，
而 bucket 缓存在进程里、有请求就不淘汰。`SCRIPT FLUSH` 和 Redis 重启对脚本缓存是同一个效果。
"""

import asyncio
import uuid

from pyrate_limiter import Duration, Rate, RateItem

from backend.database.redis import RedisCli
from backend.utils.limiter import RedisTimeBucket


def test_bucket_reloads_script_after_flush() -> None:
    async def scenario() -> list[bool]:
        client = RedisCli()
        key = f'fba:test:limiter:{uuid.uuid4().hex}'
        try:
            bucket = await RedisTimeBucket.init(rates=[Rate(100, Duration.MINUTE)], redis=client, bucket_key=key)
            first = await bucket.put(RateItem('a', await bucket.now()))
            await client.script_flush()
            # 修复前：这里抛 NoScriptError
            second = await bucket.put(RateItem('a', await bucket.now()))
            return [first, second]
        finally:
            await client.delete(key)
            await client.aclose()

    assert asyncio.run(scenario()) == [True, True]


def test_bucket_key_expires_on_its_own() -> None:
    """🔴 #401：pyrate_limiter 的 `PUT_ITEM` 只 `ZADD`，清理靠本进程的 leaker ——
    进程重启、或本地 bucket 缓存超过 4096 个被淘汰之后没人再清，每个「IP × 限流路由」留下一个永不过期的 zset。
    现在写入时一并设过期（最长窗口 + 余量），脚本缓存被清掉、重新加载之后也一样
    """

    async def scenario() -> tuple[int, int]:
        client = RedisCli()
        key = f'fba:test:limiter:{uuid.uuid4().hex}'
        rates = [Rate(5, Duration.SECOND * 30), Rate(8, Duration.MINUTE)]
        try:
            bucket = await RedisTimeBucket.init(rates=rates, redis=client, bucket_key=key)
            await bucket.put(RateItem('a', await bucket.now()))
            first = await client.pttl(key)
            await client.script_flush()
            await client.persist(key)
            await bucket.put(RateItem('a', await bucket.now()))
            return first, await client.pttl(key)
        finally:
            await client.delete(key)
            await client.aclose()

    first, after_reload = asyncio.run(scenario())
    for ttl in (first, after_reload):
        assert int(Duration.MINUTE) - 1_000 < ttl <= int(Duration.MINUTE) + 2_000


def test_startup_gives_leftover_buckets_a_ttl(monkeypatch) -> None:
    """升级之前留下的、没有 TTL 的限流桶：启动时补上（已经带 TTL 的不动）"""
    from backend.core.conf import settings
    from backend.utils import limiter

    async def scenario() -> tuple[int, int, int]:
        client = RedisCli()
        monkeypatch.setattr(limiter, 'redis_client', client)
        prefix = settings.REQUEST_LIMITER_REDIS_PREFIX
        orphan, fresh = f'{prefix}:pytest:{uuid.uuid4().hex}', f'{prefix}:pytest:{uuid.uuid4().hex}'
        try:
            await client.zadd(orphan, {'a': 1})
            await client.zadd(fresh, {'a': 1})
            await client.pexpire(fresh, 5_000)
            fixed = await limiter.sweep_limiter_keys()
            return fixed, await client.ttl(orphan), await client.pttl(fresh)
        finally:
            await client.delete(orphan, fresh)
            await client.aclose()

    fixed, orphan_ttl, fresh_pttl = asyncio.run(scenario())
    assert fixed >= 1
    assert 0 < orphan_ttl <= 3600
    assert 0 < fresh_pttl <= 5_000
