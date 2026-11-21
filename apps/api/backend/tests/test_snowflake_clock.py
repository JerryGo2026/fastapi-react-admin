"""发号器用系统时钟，不受测试里假时钟（`timezone.now`）的影响。

🔴 原来取的是 `timezone.now()`：`test_scheduler_timing.py` 把它换成假时钟模拟几小时的流逝，
期间改调度要写审计行、要发 ID，发号器就记住一个「未来」的时间戳；
假时钟一撤，之后所有生成 ID 的地方都报「时钟回拨」。
#281 登记了定时任务表之后，整套 pytest 在那个文件之后连环红了几百条（每条都和定时任务毫无关系）。
"""

from datetime import timedelta

import pytest

from backend.utils.snowflake import Snowflake
from backend.utils.timezone import timezone


def test_a_fake_clock_does_not_poison_the_generator(monkeypatch: pytest.MonkeyPatch) -> None:
    gen = Snowflake()
    gen.datacenter_id, gen.worker_id, gen._initialized = 0, 0, True

    real_now = timezone.now
    monkeypatch.setattr(timezone, 'now', lambda: real_now() + timedelta(hours=12))
    in_the_fake_future = gen.generate()
    monkeypatch.setattr(timezone, 'now', real_now)

    after = gen.generate()  # 原来这里报「时钟回拨超过 43200000 ms」
    assert after > in_the_fake_future


def test_a_short_clock_rollback_does_not_block_the_event_loop(monkeypatch: pytest.MonkeyPatch) -> None:
    """🔴 #401：回拨 10 秒以内时原来持锁 `time.sleep(0.0001)` 忙等到时钟追上 —— `generate()` 在事件循环线程里被调，
    NTP 回拨 5 秒 = 整个进程冻 5 秒。现在不等：沿用上一个时间戳往下发（序号满了借下一毫秒），ID 照样唯一、递增
    """
    import backend.utils.snowflake as snowflake_mod

    gen = Snowflake()
    gen.datacenter_id, gen.worker_id, gen._initialized = 0, 0, True
    clock = {'ms': 1_800_000_000_000}
    monkeypatch.setattr(gen, '_current_ms', lambda: clock['ms'])

    def no_sleep(_: float) -> None:
        raise AssertionError('generate() 不能在事件循环线程里 sleep')

    monkeypatch.setattr(snowflake_mod.time, 'sleep', no_sleep)

    before = gen.generate()
    clock['ms'] -= 5_000  # NTP 往回拨 5 秒
    ids = [gen.generate() for _ in range(10_000)]  # 跨过一次序号用满（4096）

    assert len(set(ids)) == len(ids)
    assert ids == sorted(ids)
    assert ids[0] > before


def test_a_rollback_beyond_the_tolerance_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    from backend.common.exception import errors
    from backend.utils.snowflake import SnowflakeConfig

    gen = Snowflake()
    gen.datacenter_id, gen.worker_id, gen._initialized = 0, 0, True
    clock = {'ms': 1_800_000_000_000}
    monkeypatch.setattr(gen, '_current_ms', lambda: clock['ms'])
    gen.generate()
    clock['ms'] -= SnowflakeConfig.CLOCK_BACKWARD_TOLERANCE_MS + 1
    with pytest.raises(errors.ServerError):
        gen.generate()


def test_a_burst_that_borrows_the_next_millisecond_is_not_reported_as_a_rollback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """同一毫秒序号用满借了下一毫秒：`now` 落后于 last_timestamp，但系统时钟没往回走，不能告警「时钟回拨」"""
    import backend.utils.snowflake as snowflake_mod

    gen = Snowflake()
    gen.datacenter_id, gen.worker_id, gen._initialized = 0, 0, True
    clock = {'ms': 1_800_000_000_000}
    monkeypatch.setattr(gen, '_current_ms', lambda: clock['ms'])
    warnings: list[str] = []
    monkeypatch.setattr(snowflake_mod.log, 'warning', warnings.append)

    ids = [gen.generate() for _ in range(5_000)]  # 同一毫秒里跨过一次 4096
    clock['ms'] += 1
    ids.append(gen.generate())
    assert len(set(ids)) == len(ids)
    assert warnings == []

    clock['ms'] -= 3_000  # 真的回拨
    gen.generate()
    gen.generate()
    assert len(warnings) == 1
    assert '3000 ms' in warnings[0] or '3001 ms' in warnings[0]
