import pytest
from unittest.mock import Mock, patch
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from fastapi.testclient import TestClient

from main import app

from database import Base, get_db
from models import User
from auth import get_password_hash, create_access_token

# Import rate limiters to override them
from utils.rate_limiter import (
    auth_rate_limiter,
    ocr_rate_limiter,
    password_reset_rate_limiter,
    email_verification_rate_limiter,
    profile_update_rate_limiter
)

# Setup in-memory SQLite database for testing
SQLALCHEMY_DATABASE_URL = "sqlite:///:memory:"

engine = create_engine(
    SQLALCHEMY_DATABASE_URL,
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

@pytest.fixture(scope="function")
def db_session():
    """Create a fresh database session for each test."""
    Base.metadata.create_all(bind=engine)
    session = TestingSessionLocal()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(bind=engine)

@pytest.fixture(scope="function")
def client(db_session):
    """Create a FastAPI TestClient with overridden database dependency."""
    def override_get_db():
        try:
            yield db_session
        finally:
            pass

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as c:
        yield c
    # Clean up is handled by yield
    app.dependency_overrides.pop(get_db, None)

@pytest.fixture
def test_user(db_session):
    """Create a test user and return the user object."""
    user = User(
        email="test@example.com",
        hashed_password=get_password_hash("password123"),
        full_name="Test User",
        is_active=True
    )
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    return user

@pytest.fixture
def auth_headers(test_user):
    """Return authorization headers for the test user."""
    access_token = create_access_token(data={"sub": test_user.email})
    return {"Authorization": f"Bearer {access_token}"}

@pytest.fixture(autouse=True)
def disable_rate_limits():
    """Disable all rate limits during testing using dependency overrides."""
    async def mock_rate_limit():
        return True

    overrides = {
        auth_rate_limiter: mock_rate_limit,
        ocr_rate_limiter: mock_rate_limit,
        password_reset_rate_limiter: mock_rate_limit,
        email_verification_rate_limiter: mock_rate_limit,
        profile_update_rate_limiter: mock_rate_limit
    }

    # Apply overrides
    for limiter, mock in overrides.items():
        app.dependency_overrides[limiter] = mock

    yield

    # Remove overrides
    for limiter in overrides.keys():
        app.dependency_overrides.pop(limiter, None)
