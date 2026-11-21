"""缓存失效订阅器：断线多久都要重连，（重）订阅上之后清一遍本地缓存（#401）。

🔴 原来连续 10 次订阅失败（Redis 断开约 50–100 秒）就 `break`，之后没人再拉起；而且断线期间别的进程发的失效消息
全丢了，重连后也不清本地缓存 —— Redis 重启一次之后，A 进程改了字典 / 菜单，B 进程一直返回旧值直到 TTL 到期。
"""

import asyncio
import json

from typing import Any

import pytest

from backend.common.cache import pubsub as pubsub_module
from backend.common.cache.local import local_cache_manager


class _FakePubSub:
    def __init__(self, owner: '_FakeRedis') -> None:
        self.owner = owner

    async def subscribe(self, channel: str) -> None:
        self.owner.attempts += 1
        if self.owner.attempts <= self.owner.fail_times:
            raise ConnectionError('redis is down')

    async def listen(self):
        self.owner.subscribed.set()
        while True:
            message = await self.owner.messages.get()
            if message is None:
                raise ConnectionError('connection reset')
            yield message

    async def aclose(self) -> None:
        pass


class _FakeRedis:
    def __init__(self, fail_times: int) -> None:
        self.fail_times = fail_times
        self.attempts = 0
        self.subscribed = asyncio.Event()
        self.messages: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()

    def __call__(self, **_: Any) -> '_FakeRedis':
        return self

    def set_retry(self, _: object) -> None:
        pass

    def pubsub(self) -> _FakePubSub:
        return _FakePubSub(self)

    async def aclose(self) -> None:
        pass


@pytest.fixture
def no_wait(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    delays: list[float] = []

    async def fake_sleep(delay: float) -> None:
        delays.append(delay)
        await asyncio.sleep(0)

    monkeypatch.setattr(pubsub_module, '_sleep', fake_sleep)
    return delays


def test_keeps_retrying_past_the_old_limit_and_clears_local_cache_on_resubscribe(
    monkeypatch: pytest.MonkeyPatch, no_wait: list[float]
) -> None:
    fake = _FakeRedis(fail_times=25)  # 原来 10 次就放弃
    monkeypatch.setattr(pubsub_module, 'RedisCli', fake)

    async def scenario() -> None:
        local_cache_manager.set('fba:cache:dict:stale', 'old value')
        task = asyncio.create_task(pubsub_module.CachePubSubManager.subscribe_and_listen())
        await asyncio.wait_for(fake.subscribed.wait(), timeout=5)
        assert not task.done()
        # 断线期间漏掉的失效消息补不回来：订阅上之后整份本地缓存作废
        assert local_cache_manager.get('fba:cache:dict:stale') is None

        # 订阅上之后照常处理消息
        local_cache_manager.set('fba:cache:dict:a', 1)
        await fake.messages.put({
            'type': 'message',
            'data': json.dumps({'cache_key': 'fba:cache:dict:a', 'delete_by_prefix': False}),
        })
        for _ in range(50):
            if local_cache_manager.get('fba:cache:dict:a') is None:
                break
            await asyncio.sleep(0)
        assert local_cache_manager.get('fba:cache:dict:a') is None

        # 已经订阅上之后再断线：照样重连，重连上再清一遍
        fake.subscribed.clear()
        local_cache_manager.set('fba:cache:dict:b', 2)
        await fake.messages.put(None)
        await asyncio.wait_for(fake.subscribed.wait(), timeout=5)
        assert local_cache_manager.get('fba:cache:dict:b') is None

        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(scenario())
    assert fake.attempts == 27
    # 退避：越等越久，但有上限
    assert no_wait[1] > no_wait[0]
    assert max(no_wait) <= pubsub_module.settings.CACHE_PUBSUB_RECONNECT_MAX_DELAY


def test_a_connection_drop_that_redis_py_reconnects_by_itself_still_clears_the_local_cache(
    monkeypatch: pytest.MonkeyPatch, no_wait: list[float]
) -> None:
    """🔴 评审发现：redis-py 的 PubSub 读消息时自带重试（默认 3 次、指数退避），断线后在 `listen()` 里
    **自己**重连、重新订阅，外层循环看不到异常 —— 短暂断线（Redis 重启几秒）期间漏掉的失效消息就这么丢了，
    本地缓存也没清。订阅连接要关掉库内重试，每次断线都走外层「重新订阅 + 清缓存」那条路。

    真 Redis：`CLIENT KILL` 掉订阅那条连接（只杀它，不碰别的订阅者）。不用共享的 `redis_client`
    （`asyncio.run` 会关掉它绑的循环，见 tests 分册），这里的客户端都是自己建、自己关的
    """
    from backend.database.redis import RedisCli

    channel = f'fba:test:cache-invalidate:{id(no_wait)}'
    monkeypatch.setattr(pubsub_module.settings, 'CACHE_PUBSUB_CHANNEL', channel)

    async def pubsub_ids(admin: RedisCli) -> set[str]:
        return {c['id'] for c in await admin.client_list(_type='pubsub')}

    async def scenario() -> None:
        admin = RedisCli()
        before = await pubsub_ids(admin)
        task = asyncio.create_task(pubsub_module.CachePubSubManager.subscribe_and_listen())
        try:
            for _ in range(200):
                if (await admin.pubsub_numsub(channel))[0][1] >= 1:
                    break
                await asyncio.sleep(0.02)
            mine = await pubsub_ids(admin) - before
            assert len(mine) == 1

            local_cache_manager.set('fba:cache:dict:stale-after-blip', 'old value')
            await admin.client_kill_filter(_id=mine.pop())
            for _ in range(250):
                if local_cache_manager.get('fba:cache:dict:stale-after-blip') is None:
                    break
                await asyncio.sleep(0.02)
            assert local_cache_manager.get('fba:cache:dict:stale-after-blip') is None, (
                '断线后 redis-py 在 listen() 里悄悄重连了，外层没有清本地缓存'
            )
            assert not task.done()
        finally:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            await admin.aclose()

    asyncio.run(scenario())
