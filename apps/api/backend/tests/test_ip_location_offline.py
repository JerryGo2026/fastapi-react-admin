"""离线 IP 属地：IPv6 / IPv4 映射地址（上游 adb4b94 的同类问题，只做了不带 v6 库的那一半）

修之前实测：`::ffff:114.114.114.114`、`2408:8207:1234::1`、`::1` 全部
`ValueError: invalid ip address … (IPv4 expected)`，每个请求打一条 error 日志。
"""

import pytest

from backend.utils import request_parse


class _RecordingLog:
    def __init__(self) -> None:
        self.errors: list[str] = []

    def error(self, msg: str) -> None:
        self.errors.append(msg)

    def __getattr__(self, name: str) -> object:
        return lambda *args, **kwargs: None


@pytest.fixture
def recording_log(monkeypatch: pytest.MonkeyPatch) -> _RecordingLog:
    fake = _RecordingLog()
    monkeypatch.setattr(request_parse, 'log', fake)
    return fake


def test_ipv4(recording_log: _RecordingLog) -> None:
    location = request_parse.get_location_offline('114.114.114.114')
    assert location == {'country': '中国', 'regionName': '江苏省', 'city': '南京市'}
    assert recording_log.errors == []


def test_ipv4_mapped_ipv6_is_looked_up_as_ipv4(recording_log: _RecordingLog) -> None:
    """双栈代理后面常见 `::ffff:a.b.c.d`：按 IPv4 查，结果和裸 IPv4 一样"""
    assert request_parse.get_location_offline('::ffff:114.114.114.114') == request_parse.get_location_offline(
        '114.114.114.114'
    )
    assert recording_log.errors == []


@pytest.mark.parametrize('ip', ['2408:8207:1234::1', '::1'])
def test_real_ipv6_returns_none_without_logging_an_error(recording_log: _RecordingLog, ip: str) -> None:
    """没有 IPv6 的库：返回 None 是预期结果，不是错误，不能每个请求刷一条 error"""
    assert request_parse.get_location_offline(ip) is None
    assert recording_log.errors == []


def test_garbage_is_still_reported(recording_log: _RecordingLog) -> None:
    """真不是 IP 的串说明上游取 IP 的逻辑出了问题，这个要报"""
    assert request_parse.get_location_offline('not-an-ip') is None
    assert len(recording_log.errors) == 1


def test_a_missing_part_is_not_cached_as_the_string_none(monkeypatch: pytest.MonkeyPatch) -> None:
    """🔴 #401：缓存写的是 `f'{country}|{region}|{city}'`，`city=None` 存成 `'None'`，之后 24 小时登录日志 / 操作日志的
    城市列显示 `None`（`8.8.8.8` 首次解析就是这样）。命中缓存和第一次解析要给出同一个结果
    """
    import asyncio

    from starlette.requests import Request

    from backend.database.redis import RedisCli

    ip = '192.0.2.77'
    monkeypatch.setattr(request_parse.settings, 'IP_LOCATION_PARSE', 'offline')
    monkeypatch.setattr(
        request_parse, 'get_location_offline', lambda _ip: {'country': '美国', 'regionName': None, 'city': None}
    )
    request = Request({'type': 'http', 'headers': [], 'client': (ip, 1234)})

    async def scenario() -> tuple[object, object]:
        redis = RedisCli()
        monkeypatch.setattr(request_parse, 'redis_client', redis)
        key = f'{request_parse.settings.IP_LOCATION_REDIS_PREFIX}:{ip}'
        try:
            await redis.delete(key)
            first = await request_parse.parse_ip_info(request)
            cached = await request_parse.parse_ip_info(request)
            return first, cached
        finally:
            await redis.delete(key)
            await redis.aclose()

    first, cached = asyncio.run(scenario())
    assert (first.country, first.region, first.city) == ('美国', None, None)
    assert (cached.country, cached.region, cached.city) == ('美国', None, None)
