"""页码有上界（#401）：超大页码让 OFFSET 溢出，原来是 500，应该是 422（参数不合法）"""

import pytest

from starlette.testclient import TestClient

from backend.common.pagination import MAX_PAGE


@pytest.mark.parametrize('page', [10**20, MAX_PAGE + 1])
def test_a_huge_page_number_is_a_validation_error(client: TestClient, token_headers: dict[str, str], page: int) -> None:
    res = client.get('/sys/users', params={'page': page, 'size': 20}, headers=token_headers)
    assert res.status_code == 422, res.text


@pytest.mark.parametrize('path', ['/sys/workflow/inbox/todo', '/sys/workflow/inbox/done'])
def test_workflow_lists_have_the_same_upper_bound(client: TestClient, token_headers: dict[str, str], path: str) -> None:
    """审批插件自己声明了 `page`（不走 `_CustomPageParams`），评审时发现漏了上界：PostgreSQL 上 OFFSET 溢出 → 500"""
    for page in (10**20, MAX_PAGE + 1):
        res = client.get(path, params={'page': page}, headers=token_headers)
        assert res.status_code == 422, res.text
    assert client.get(path, params={'page': MAX_PAGE}, headers=token_headers).status_code == 200


def test_the_last_allowed_page_still_works(client: TestClient, token_headers: dict[str, str]) -> None:
    res = client.get('/sys/users', params={'page': MAX_PAGE, 'size': 200}, headers=token_headers)
    assert res.status_code == 200, res.text
    assert res.json()['data']['items'] == []
