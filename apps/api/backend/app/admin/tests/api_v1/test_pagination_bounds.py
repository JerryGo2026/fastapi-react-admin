"""页码有上界（#401）：超大页码让 OFFSET 溢出，原来是 500，应该是 422（参数不合法）"""

import pytest

from starlette.testclient import TestClient

from backend.common.pagination import MAX_PAGE


@pytest.mark.parametrize('page', [10**20, MAX_PAGE + 1])
def test_a_huge_page_number_is_a_validation_error(client: TestClient, token_headers: dict[str, str], page: int) -> None:
    res = client.get('/sys/users', params={'page': page, 'size': 20}, headers=token_headers)
    assert res.status_code == 422, res.text


def test_the_last_allowed_page_still_works(client: TestClient, token_headers: dict[str, str]) -> None:
    res = client.get('/sys/users', params={'page': MAX_PAGE, 'size': 200}, headers=token_headers)
    assert res.status_code == 200, res.text
    assert res.json()['data']['items'] == []
