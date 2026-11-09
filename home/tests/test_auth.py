import pytest

from .conftest import AUTH


@pytest.mark.parametrize("headers", [{}, {"Authorization": "Bearer wrong"}, {"Authorization": "home-test-key"}])
@pytest.mark.parametrize("method,path", [("GET", "/health"), ("GET", "/recordings"), ("POST", "/recordings"),
                                         ("GET", "/recordings/x"), ("GET", "/recordings/x/audio")])
def test_missing_or_wrong_access_key_is_rejected(client, headers, method, path):
    r = client.request(method, path, headers=headers)
    assert r.status_code == 401


def test_correct_access_key_is_accepted(client):
    assert client.get("/health", headers=AUTH).status_code == 200
