import socket

import pytest


@pytest.fixture(autouse=True)
def block_network(monkeypatch):
    def no_socket_connect(*_args, **_kwargs):
        raise AssertionError("Network access is disabled in Garmin connector tests")

    monkeypatch.setattr(socket.socket, "connect", no_socket_connect)
    monkeypatch.setattr(socket.socket, "connect_ex", no_socket_connect)
