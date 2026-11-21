import asyncio
import json

from backend.common.cache.local import local_cache_manager
from backend.common.log import log
from backend.core.conf import settings
from backend.database.redis import RedisCli, redis_client

#: 重连前的等待（测试换成不等的）
_sleep = asyncio.sleep


def _handle_message(message: dict) -> None:
    try:
        data = json.loads(message['data'])
        cache_key = data['cache_key']
        if not data['delete_by_prefix']:
            local_cache_manager.delete(cache_key)
        else:
            local_cache_manager.delete_by_prefix(cache_key)
    except json.JSONDecodeError as e:
        log.warning(f'[CachePubSub] 消息格式错误 {e}')
    except Exception as e:
        log.error(f'[CachePubSub] 处理通知失败: {e}')


async def _close_quietly(*resources: object) -> None:
    for resource in resources:
        if resource is not None:
            try:
                await resource.aclose()
            except Exception:
                pass


class CachePubSubManager:
    """缓存 Pub/Sub 管理器"""

    _pubsub_task: asyncio.Task | None = None

    @staticmethod
    async def publish_invalidation(cache_key: str, *, delete_by_prefix: bool) -> None:
        """
        发布缓存失效通知

        :param cache_key: 缓存键
        :param delete_by_prefix: 是否删除符合前缀的所有缓存
        :return:
        """
        try:
            message = json.dumps({'cache_key': cache_key, 'delete_by_prefix': delete_by_prefix})
            await redis_client.publish(settings.CACHE_PUBSUB_CHANNEL, message)
        except Exception as e:
            log.warning(f'[CachePubSub] 发布通知失败: {e}')

    @staticmethod
    async def subscribe_and_listen() -> None:
        """订阅并监听缓存失效通知

        🔴 **断线多久都要重连，不设次数上限**（#401）。原来连续失败 10 次（Redis 断开约 50–100 秒）就退出，
        之后没人再拉起 —— Redis 重启一次，别的进程发的失效通知从此收不到，本地缓存只能等 TTL。
        失败之后按指数退避，封顶 `CACHE_PUBSUB_RECONNECT_MAX_DELAY` 秒。

        🔴 **每次（重）订阅成功之后清空本地缓存。** 断线期间别的进程发的失效消息丢了、补不回来，
        本地缓存里哪些已经过时无从知道，只能整份作废（下一次读重新回源）。
        """
        failures = 0
        while True:
            pubsub_client: RedisCli | None = None
            pubsub = None
            try:
                # 使用独立连接
                pubsub_client = RedisCli(socket_timeout=None)
                pubsub = pubsub_client.pubsub()
                await pubsub.subscribe(settings.CACHE_PUBSUB_CHANNEL)
                # 订阅上了：断线期间漏掉的通知补不回来，整份本地缓存作废
                local_cache_manager.clear()
                if failures:
                    log.info(f'[CachePubSub] 第 {failures} 次重试后重新订阅成功，已清空本地缓存')
                failures = 0

                async for message in pubsub.listen():
                    if message['type'] == 'message':
                        _handle_message(message)

            except asyncio.CancelledError:
                raise
            except Exception as e:
                failures += 1
                delay = min(
                    settings.CACHE_PUBSUB_RECONNECT_DELAY * 2 ** min(failures - 1, 16),
                    settings.CACHE_PUBSUB_RECONNECT_MAX_DELAY,
                )
                log.error(f'[CachePubSub] 订阅异常（第 {failures} 次），{delay} 秒后重连: {e}')
                await _sleep(delay)
            finally:
                await _close_quietly(pubsub, pubsub_client)

    @classmethod
    def start_listener(cls) -> None:
        """启动缓存 Pub/Sub 监听器"""
        if not settings.CACHE_LOCAL_ENABLED:
            return

        if cls._pubsub_task is None or cls._pubsub_task.done():
            cls._pubsub_task = asyncio.create_task(cls.subscribe_and_listen())

    @classmethod
    async def stop_listener(cls) -> None:
        """停止缓存 Pub/Sub 监听器"""
        if cls._pubsub_task is None:
            return

        if not cls._pubsub_task.done():
            cls._pubsub_task.cancel()
            try:
                await cls._pubsub_task
            except asyncio.CancelledError:
                pass

        cls._pubsub_task = None


cache_pubsub_manager = CachePubSubManager()
