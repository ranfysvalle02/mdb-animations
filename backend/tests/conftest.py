from contextlib import asynccontextmanager
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from backend.auth import OpenAuth
from backend.main import app

DRAWING_ID = "e8de20c1-5ad3-45a6-8ca0-abf2a40e4051"


@pytest.fixture
def payload():
    return {
        "title": "Green robot",
        "description": "A friendly robot",
        "strokes": [{
            "color": "#086b59", "width": 10,
            "points": [{"x": 0.1, "y": 0.2, "pressure": 0.5},
                       {"x": 0.8, "y": 0.7, "pressure": 1}],
        }],
    }


@pytest.fixture
def client(monkeypatch, payload):
    library = Mock()
    library.ready.return_value = True
    library.recent.return_value = []
    library.search.return_value = []
    library.save.side_effect = lambda drawing: {"id": DRAWING_ID, "tags": drawing.tags}
    ai = Mock()
    ai.suggest_tags.return_value = ["robot", "face"]

    @asynccontextmanager
    async def offline_lifespan(application):
        application.state.library = library
        application.state.ai = ai
        application.state.production = production
        application.state.auth = OpenAuth("tester")
        yield

    production = Mock()
    production.ready.return_value = True
    # Each request gets an owner-scoped view; offline, that view is the same mock.
    production.scoped.return_value = production
    library.scoped.return_value = library
    monkeypatch.setattr(app.router, "lifespan_context", offline_lifespan)
    with TestClient(app) as test_client:
        test_client.ai = ai
        test_client.production = production
        yield test_client, library
