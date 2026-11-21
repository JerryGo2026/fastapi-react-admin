"""#402 第 1 条：第三方登录建的无密码账号设不上密码

`sys_user.password` 为 NULL 的账号（`OAUTH2_AUTO_REGISTER` 建的）：

- 原来自助改密 / 超管重置都在 `CreateUserPasswordHistoryParam(password=None)` 上抛 ValidationError —— 永远设不上
- 自助那条同时**跳过了旧密码校验**（`if user.password and ...`），是那个异常在兜底。只把 None 放过去，
  拿到一枚 access token 的人就能给别人设一个长期密码 → 第一次设密码必须重新走一遍已绑定的第三方授权

路由级测：TestClient 发真请求，第三方换 token / 拉用户信息打桩。账号的第三方绑定也走真实的绑定流程建出来。
"""

import asyncio
import time

from collections.abc import AsyncGenerator, Callable, Iterator
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.testclient import TestClient

from backend.core.conf import settings
from backend.database.db import (
    create_database_async_engine,
    create_database_async_session,
    get_database_url,
    get_db_transaction,
)
from backend.plugin.oauth2.api.v1 import github as github_api
from backend.plugin.oauth2.api.v1.github import github_client
from backend.plugin.oauth2.state_binding import STATE_COOKIE_KEY, STATE_COOKIE_PATH
from backend.tests.utils.db import async_test_db_session

USERNAME = 'pytest_nopwd_402'
SEED_PASSWORD = 'Tmp@123456'
NEW = 'Nw1@abcdef'
MY_SID = 402000111
#: fixture 顺手建的第二个会话：pk → 它的 Authorization 头
OTHER_SESSION: dict[int, dict] = {}
OTHER_SID = 402000999


def _sql(statement: str, **params: object) -> list:
    """另起引擎跑一句（共享会话绑在 TestClient 的事件循环上，见 app/admin/tests/conftest.py）"""

    async def run() -> list:
        engine = create_database_async_engine(get_database_url(unittest=True))
        try:
            async with create_database_async_session(engine).begin() as session:
                result = await session.execute(text(statement), params)
                return list(result.all()) if result.returns_rows else []
        finally:
            await engine.dispose()

    return asyncio.run(run())


def _stored_password(pk: int) -> str | None:
    return _sql('SELECT password FROM sys_user WHERE id = :pk', pk=pk)[0][0]


def _stub_github(monkeypatch: pytest.MonkeyPatch, sid: int) -> None:
    async def token(*_: object, **__: object) -> dict:  # ruff:ignore[unused-async]
        return {'access_token': 'gh-token'}

    async def userinfo(*_: object, **__: object) -> dict:  # ruff:ignore[unused-async]
        return {'id': sid, 'login': f'gh-{sid}', 'name': 'gh', 'email': None}

    async def unverified(*_: object, **__: object) -> bool:  # ruff:ignore[unused-async]
        return False

    monkeypatch.setattr(github_client, 'get_access_token', token)
    monkeypatch.setattr(github_client, 'get_userinfo', userinfo)
    monkeypatch.setattr(github_api, 'github_email_verified', unverified)


def _run_ticket_flow(client: TestClient, url: str) -> object:
    """拿到的授权链接（带 ticket）→ authorize（下发 cookie）→ 回调。返回回调的响应"""
    path = urlparse(url)
    res = client.get(f'{path.path.removeprefix(settings.FASTAPI_API_V1_PATH)}?{path.query}', follow_redirects=False)
    assert res.status_code in {302, 307}, res.text
    state = parse_qs(urlparse(res.headers['location']).query)['state'][0]
    client.cookies.set(STATE_COOKIE_KEY, state, path=STATE_COOKIE_PATH)
    return client.get('/oauth2/github/callback', params={'code': 'c', 'state': state}, follow_redirects=False)


def _reauth(client: TestClient, headers: dict, monkeypatch: pytest.MonkeyPatch, sid: int) -> object:
    _stub_github(monkeypatch, sid)
    res = client.get('/oauth2/me/reauth', params={'source': 'Github'}, headers=headers)
    assert res.json()['code'] == 200, res.text
    return _run_ticket_flow(client, res.json()['data'])


@pytest.fixture
def passwordless(
    client: TestClient, token_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> Iterator[tuple[int, dict]]:
    """一个绑了 GitHub（sid=MY_SID）、密码为 NULL、手里有一个有效会话的账号"""
    client.cookies.clear()
    dept_id = client.get('/sys/depts', headers=token_headers).json()['data'][0]['id']
    role_id = client.get('/sys/roles/all', headers=token_headers).json()['data'][0]['id']
    res = client.post(
        '/sys/users',
        headers=token_headers,
        json={
            'username': USERNAME,
            'password': SEED_PASSWORD,
            'nickname': '无密码',
            'dept_id': dept_id,
            'roles': [role_id],
        },
    )
    assert res.json()['code'] == 200, res.text
    pk = int(res.json()['data']['id'])
    try:
        body = client.post('/auth/login/swagger', params={'username': USERNAME, 'password': SEED_PASSWORD}).json()
        headers = {'Authorization': f'{body["token_type"]} {body["access_token"]}'}

        # 真实绑定流程建出第三方绑定
        _stub_github(monkeypatch, MY_SID)
        url = client.get('/oauth2/me/binding', params={'source': 'Github'}, headers=headers).json()['data']
        _run_ticket_flow(client, url)
        assert _sql('SELECT 1 FROM sys_user_social WHERE user_id = :pk', pk=pk), '前置：绑定没建出来'

        # 同一个人的另一个会话（另一台设备 —— 或者偷来的 token）
        body2 = client.post('/auth/login/swagger', params={'username': USERNAME, 'password': SEED_PASSWORD}).json()
        OTHER_SESSION[pk] = {'Authorization': f'{body2["token_type"]} {body2["access_token"]}'}

        # 变成第三方建出来的那种号：没有密码
        _sql('UPDATE sys_user SET password = NULL WHERE id = :pk', pk=pk)
        assert client.get('/sys/users/me', headers=headers).status_code == 200, '前置：会话要还能用'
        yield pk, headers
    finally:
        client.cookies.clear()
        OTHER_SESSION.pop(pk, None)
        for table in ('sys_user_social', 'sys_user_password_history', 'sys_user_role'):
            _sql(f'DELETE FROM {table} WHERE user_id = :pk', pk=pk)
        _sql('DELETE FROM sys_user WHERE id = :pk', pk=pk)


def _set_first_password(client: TestClient, headers: dict, password: str = NEW) -> dict:
    return client.put(
        '/sys/users/me/password', headers=headers, json={'new_password': password, 'confirm_password': password}
    ).json()


def test_password_status_says_there_is_no_password(client: TestClient, passwordless: tuple[int, dict]) -> None:
    _, headers = passwordless
    data = client.get('/sys/users/me/password-status', headers=headers).json()['data']
    assert data == {'has_password': False, 'reauth_verified': False}


def test_without_reauth_a_token_alone_cannot_set_a_password(client: TestClient, passwordless: tuple[int, dict]) -> None:
    """🔴 只拿着一个会话（比如被盗的 access token）不能给无密码账号设密码"""
    pk, headers = passwordless
    for body in (
        {'new_password': NEW, 'confirm_password': NEW},
        {'old_password': 'x', 'new_password': NEW, 'confirm_password': NEW},
    ):
        res = client.put('/sys/users/me/password', headers=headers, json=body)
        assert res.json()['code'] != 200, res.text
    assert _stored_password(pk) is None, '被拒了，密码却被写进去了'


def test_reauth_with_the_bound_account_lets_the_user_set_a_first_password(
    client: TestClient, passwordless: tuple[int, dict], monkeypatch: pytest.MonkeyPatch
) -> None:
    pk, headers = passwordless
    cb = _reauth(client, headers, monkeypatch, MY_SID)
    assert cb.status_code in {302, 307}
    landing = urlparse(cb.headers['location'])
    assert f'{landing.scheme}://{landing.netloc}{landing.path}' == settings.OAUTH2_FRONTEND_BINDING_REDIRECT_URI
    assert 'error' not in parse_qs(landing.query)

    status = client.get('/sys/users/me/password-status', headers=headers).json()['data']
    assert status == {'has_password': False, 'reauth_verified': True}

    res = _set_first_password(client, headers)
    assert res['code'] == 200, res
    assert _stored_password(pk) is not None
    # 新密码真能登录
    assert client.post('/auth/login/swagger', params={'username': USERNAME, 'password': NEW}).status_code == 200


def test_reauth_with_some_other_github_account_grants_nothing(
    client: TestClient, passwordless: tuple[int, dict], monkeypatch: pytest.MonkeyPatch
) -> None:
    """授权回来的第三方账号不是绑在这个人名下的那一个 → 不算确认身份"""
    pk, headers = passwordless
    cb = _reauth(client, headers, monkeypatch, OTHER_SID)
    assert parse_qs(urlparse(cb.headers['location']).query).get('error'), '要带着原因回前端'

    assert client.get('/sys/users/me/password-status', headers=headers).json()['data']['reauth_verified'] is False
    assert _set_first_password(client, headers)['code'] != 200
    assert _stored_password(pk) is None


def test_a_rejected_password_does_not_burn_the_reauth(
    client: TestClient, passwordless: tuple[int, dict], monkeypatch: pytest.MonkeyPatch
) -> None:
    """复杂度不过被拒，不该让用户再跑一遍第三方授权；凭据在真正写入时才消费"""
    _, headers = passwordless
    _reauth(client, headers, monkeypatch, MY_SID)
    assert _set_first_password(client, headers, '123')['code'] != 200
    assert _set_first_password(client, headers)['code'] == 200


def test_the_reauth_is_single_use(
    client: TestClient, passwordless: tuple[int, dict], monkeypatch: pytest.MonkeyPatch
) -> None:
    """设完之后凭据就没了（之后改密码走「验旧密码」那条路）"""
    _, headers = passwordless
    _reauth(client, headers, monkeypatch, MY_SID)
    assert _set_first_password(client, headers)['code'] == 200
    body = client.post('/auth/login/swagger', params={'username': USERNAME, 'password': NEW}).json()
    fresh = {'Authorization': f'{body["token_type"]} {body["access_token"]}'}
    assert client.get('/sys/users/me/password-status', headers=fresh).json()['data'] == {
        'has_password': True,
        'reauth_verified': False,
    }


def test_reauth_link_needs_a_bound_account(client: TestClient, passwordless: tuple[int, dict]) -> None:
    """没绑 Google 就拿不到 Google 的重新验证链接（不然走完授权也只会被拒，白跳一趟）"""
    _, headers = passwordless
    res = client.get('/oauth2/me/reauth', params={'source': 'Google'}, headers=headers)
    assert res.json()['code'] != 200


def test_passwordless_account_cannot_unbind_its_last_login(client: TestClient, passwordless: tuple[int, dict]) -> None:
    """解绑最后一个第三方账号 = 这个号再也登不进来，也没有东西能证明身份去设密码"""
    pk, headers = passwordless
    res = client.delete('/oauth2/me/unbinding', params={'source': 'Github'}, headers=headers)
    assert res.json()['code'] != 200, res.text
    assert _sql('SELECT 1 FROM sys_user_social WHERE user_id = :pk', pk=pk)


def test_superuser_can_reset_a_passwordless_account(
    client: TestClient, token_headers: dict[str, str], passwordless: tuple[int, dict]
) -> None:
    """超管重置原来同样在 `password=None` 的历史记录上炸"""
    pk, _ = passwordless
    res = client.put(f'/sys/users/{pk}/password', headers=token_headers, json={'password': NEW})
    assert res.json()['code'] == 200, res.text
    assert client.post('/auth/login/swagger', params={'username': USERNAME, 'password': NEW}).status_code == 200


def test_the_reauth_only_counts_for_the_session_that_did_it(
    client: TestClient, passwordless: tuple[int, dict], monkeypatch: pytest.MonkeyPatch
) -> None:
    """🔴 凭据记在发起重新授权的那个会话上：本人在这台设备上验证完，另一个会话（偷来的 token）用不上

    原来凭据按用户记：攻击者拿着偷来的 token 轮询 `password-status`，一看到 `reauth_verified` 变 true
    就抢先 PUT 一个只有自己知道的密码 —— 本人那次验证反倒成了替攻击者开门
    """
    pk, headers = passwordless
    other = OTHER_SESSION[pk]
    assert client.get('/sys/users/me', headers=other).status_code == 200, '前置：另一个会话要还活着'
    _reauth(client, headers, monkeypatch, MY_SID)

    assert client.get('/sys/users/me/password-status', headers=other).json()['data']['reauth_verified'] is False
    assert _set_first_password(client, other)['code'] != 200
    assert _stored_password(pk) is None, '另一个会话把密码设上了'
    # 发起的那个会话照样能用
    assert _set_first_password(client, headers)['code'] == 200


def test_reauth_link_is_refused_once_the_account_has_a_password(
    client: TestClient, passwordless: tuple[int, dict]
) -> None:
    """有密码的账号不需要、也不该拿到重新验证链接（凭据只给第一次设密码用）"""
    pk, headers = passwordless
    _sql("UPDATE sys_user SET password = 'x' WHERE id = :pk", pk=pk)
    res = client.get('/oauth2/me/reauth', params={'source': 'Github'}, headers=headers)
    assert res.json()['code'] != 200, res.text


def test_concurrent_unbinds_cannot_strip_the_last_login(passwordless: tuple[int, dict]) -> None:
    """🔴 两个第三方都绑着的无密码账号，同时解绑两个：不能两个都解掉

    「数一数还剩几个 → 删」中间没锁：两个事务都数到 2、都放行，各删各的那一行（不同行，不互斥），
    账号就剩下没有密码、没有第三方 —— 再也登不进来。这里让两个事务都读完再往下走，复现那个交错
    """
    from datetime import UTC, datetime

    from backend.common.exception import errors
    from backend.plugin.oauth2.crud.crud_user_social import user_social_dao
    from backend.plugin.oauth2.enums import UserSocialType
    from backend.plugin.oauth2.service.user_social_service import user_social_service

    pk, _ = passwordless
    _sql(
        'INSERT INTO sys_user_social (id, sid, source, user_id, created_time, deleted) '
        "VALUES (:id, 'g-402', 'Google', :pk, :now, 0)",
        id=pk + 7,
        pk=pk,
        now=datetime.now(UTC),
    )
    assert len(_sql('SELECT 1 FROM sys_user_social WHERE user_id = :pk AND deleted = 0', pk=pk)) == 2

    async def run() -> list[object]:
        engine = create_database_async_engine(get_database_url(unittest=True))
        both_counted = asyncio.Event()
        arrived = 0
        original = user_social_dao.get_by_user_id

        async def counted(*args: object, **kwargs: object) -> object:
            nonlocal arrived
            rows = await original(*args, **kwargs)
            arrived += 1
            if arrived >= 2:
                both_counted.set()
            # 等另一个事务也数完再往下删；被锁挡住的那个永远到不了这里 → 等满 1 秒自己走
            try:
                await asyncio.wait_for(both_counted.wait(), timeout=1)
            except TimeoutError:
                pass
            return rows

        async def unbind(source: UserSocialType) -> object:
            async with create_database_async_session(engine).begin() as db:
                return await user_social_service.unbinding(db=db, user_id=pk, source=source)

        user_social_dao.get_by_user_id = counted  # type: ignore[method-assign]
        try:
            return await asyncio.gather(
                unbind(UserSocialType.github), unbind(UserSocialType.google), return_exceptions=True
            )
        finally:
            user_social_dao.get_by_user_id = original  # type: ignore[method-assign]
            await engine.dispose()

    results = asyncio.run(run())
    left = _sql('SELECT source FROM sys_user_social WHERE user_id = :pk AND deleted = 0', pk=pk)
    assert len(left) == 1, f'剩下 {left}，两次解绑的结果：{results}'
    assert sum(isinstance(r, errors.RequestError) for r in results) == 1, results


# ---- #437 第 1 条：凭据写库成功之后才消费，并发照样只能用一次 ----


def _eventually(predicate: Callable[[], bool], timeout: float = 2.0) -> bool:
    """提交失败之后的回写是会话回滚钩子派出去的协程（`password_set_grant.release_on_rollback`），给它一点时间跑完"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return False


def test_a_failed_write_does_not_burn_the_reauth(
    client: TestClient, passwordless: tuple[int, dict], monkeypatch: pytest.MonkeyPatch
) -> None:
    """🔴 写库途中出错，凭据不能跟着没了 —— 原来 `GETDEL` 在写库之前就消费掉，用户只能重跑一遍第三方授权"""
    from backend.app.admin.crud.crud_user import user_dao
    from backend.common.exception import errors

    pk, headers = passwordless
    _reauth(client, headers, monkeypatch, MY_SID)

    async def boom(*_: object, **__: object) -> None:  # ruff:ignore[unused-async]
        raise errors.ServerError(msg='test: 写库失败')

    with monkeypatch.context() as patch:
        patch.setattr(user_dao, 'update_password_changed_time', boom)
        assert _set_first_password(client, headers)['code'] != 200
    assert _stored_password(pk) is None, '前置：失败的那次不该写进去'

    status = client.get('/sys/users/me/password-status', headers=headers).json()['data']
    assert status == {'has_password': False, 'reauth_verified': True}, '写库失败把凭据也消费掉了'
    assert _set_first_password(client, headers)['code'] == 200
    assert _stored_password(pk) is not None


def test_a_failed_commit_does_not_burn_the_reauth(
    client: TestClient, passwordless: tuple[int, dict], monkeypatch: pytest.MonkeyPatch
) -> None:
    """🔴 业务代码都跑完了、**提交**那一步失败：service 里的 try 看不到，要靠会话回滚的钩子把凭据还回去"""
    pk, headers = passwordless
    _reauth(client, headers, monkeypatch, MY_SID)

    async def fail_on_commit() -> AsyncGenerator[AsyncSession, None]:
        async with async_test_db_session.begin() as db:
            yield db
            await db.flush()
            raise RuntimeError('test: commit failed')

    async def scenario() -> int:
        previous = client.app.dependency_overrides[get_db_transaction]
        client.app.dependency_overrides[get_db_transaction] = fail_on_commit
        try:
            transport = httpx.ASGITransport(app=client.app, raise_app_exceptions=False)
            async with httpx.AsyncClient(transport=transport, base_url=str(client.base_url)) as http:
                res = await http.put(
                    '/sys/users/me/password', headers=headers, json={'new_password': NEW, 'confirm_password': NEW}
                )
                return res.status_code
        finally:
            client.app.dependency_overrides[get_db_transaction] = previous

    assert client.portal.call(scenario) >= 400
    assert _stored_password(pk) is None, '前置：提交失败了，密码不该在库里'
    assert _eventually(
        lambda: client.get('/sys/users/me/password-status', headers=headers).json()['data']['reauth_verified']
    ), '提交失败把凭据也消费掉了'
    assert _eventually(lambda: _set_first_password(client, headers)['code'] == 200), '凭据一直卡在「使用中」'
    assert _stored_password(pk) is not None


def test_concurrent_requests_still_use_the_reauth_once(
    client: TestClient, passwordless: tuple[int, dict], monkeypatch: pytest.MonkeyPatch
) -> None:
    """🔴 改成「写完再删」之后，两个并发请求不能都过了检查、都写进去

    原来 `GETDEL` 原子挡住了这个；挪到写库之后，「看一眼还在 → 写 → 删」中间有窗口。
    这里让两个请求都过完校验再往下走，复现那个交错
    """
    from backend.app.admin.service import user_service as user_service_module

    _, headers = passwordless
    _reauth(client, headers, monkeypatch, MY_SID)
    original = user_service_module.validate_new_password
    passwords = ('Nw1@first01', 'Nw1@second2')

    async def scenario() -> list[dict]:
        both_validated = asyncio.Event()
        arrived = 0

        async def validated(*args: object, **kwargs: object) -> None:
            nonlocal arrived
            await original(*args, **kwargs)
            arrived += 1
            if arrived >= 2:
                both_validated.set()
            try:
                await asyncio.wait_for(both_validated.wait(), timeout=2)
            except TimeoutError:
                pass

        transport = httpx.ASGITransport(app=client.app)
        with monkeypatch.context() as patch:
            patch.setattr(user_service_module, 'validate_new_password', validated)
            async with httpx.AsyncClient(transport=transport, base_url=str(client.base_url)) as http:
                responses = await asyncio.gather(
                    *(
                        http.put(
                            '/sys/users/me/password', headers=headers, json={'new_password': p, 'confirm_password': p}
                        )
                        for p in passwords
                    )
                )
        return [r.json() for r in responses]

    results = client.portal.call(scenario)
    assert sum(r['code'] == 200 for r in results) == 1, results
    winner = passwords[[r['code'] for r in results].index(200)]
    assert client.post('/auth/login/swagger', params={'username': USERNAME, 'password': winner}).status_code == 200


# ---- #437 第 2 条：回跳地址用 URL 解析设参数，不拼字符串 ----


@pytest.mark.parametrize(
    ('configured', 'expected'),
    [
        ('http://localhost:8888/profile', 'http://localhost:8888/profile?section=security'),
        ('http://localhost:8888/profile?tab=a', 'http://localhost:8888/profile?tab=a&section=security'),
        ('http://localhost:8888/profile?section=info', 'http://localhost:8888/profile?section=security'),
        ('http://localhost:8888/profile#top', 'http://localhost:8888/profile?section=security#top'),
        ('http://localhost:8888/profile?x=1#top', 'http://localhost:8888/profile?x=1&section=security#top'),
        ('https://a.example/#/profile', 'https://a.example/#/profile?section=security'),
        ('https://a.example/#/profile?section=info', 'https://a.example/#/profile?section=security'),
    ],
)
def test_profile_security_url_sets_the_section_by_parsing(
    monkeypatch: pytest.MonkeyPatch, configured: str, expected: str
) -> None:
    """配置里已经带着 `#` 或 `section=` 时，原来的字符串拼接会落到错的面板（或者参数跑进 hash 后面没人读）"""
    from backend.plugin.oauth2.state_binding import profile_security_url

    monkeypatch.setattr(settings, 'OAUTH2_FRONTEND_BINDING_REDIRECT_URI', configured)
    assert profile_security_url() == expected
