"""
Tests for friend balance calculation with managed members/guests.

These tests verify that the friend balance and expense list correctly
include expenses where either friend is managing other group members/guests.
"""

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from fastapi.testclient import TestClient
from unittest.mock import Mock, patch

from main import app

from database import Base, get_db
from models import User, Expense, ExpenseSplit, Friendship, Group, GroupMember, GuestMember
from dependencies import get_current_user

# Setup in-memory DB for testing
SQLALCHEMY_DATABASE_URL = "sqlite:///:memory:"
engine = create_engine(
    SQLALCHEMY_DATABASE_URL, connect_args={"check_same_thread": False}
)
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


@pytest.fixture(name="session")
def session_fixture():
    Base.metadata.create_all(bind=engine)
    db = TestingSessionLocal()
    try:
        yield db
    finally:
        db.close()
        Base.metadata.drop_all(bind=engine)


@pytest.fixture(name="client")
def client_fixture(session):
    def override_get_db():
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = override_get_db
    yield TestClient(app)
    del app.dependency_overrides[get_db]


def create_user(session, email, name):
    user = User(email=email, full_name=name, hashed_password="hashed_password")
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


def create_group(session, name, created_by_id):
    group = Group(name=name, created_by_id=created_by_id)
    session.add(group)
    session.commit()
    session.refresh(group)
    return group


def add_member(session, group_id, user_id, managed_by_id=None, managed_by_type=None):
    member = GroupMember(
        group_id=group_id, 
        user_id=user_id,
        managed_by_id=managed_by_id,
        managed_by_type=managed_by_type
    )
    session.add(member)
    session.commit()
    session.refresh(member)
    return member


def create_guest(session, group_id, name, created_by_id, managed_by_id=None, managed_by_type=None):
    guest = GuestMember(
        group_id=group_id,
        name=name,
        created_by_id=created_by_id,
        managed_by_id=managed_by_id,
        managed_by_type=managed_by_type
    )
    session.add(guest)
    session.commit()
    session.refresh(guest)
    return guest


def create_expense(session, payer_id, payer_is_guest, amount, description, splits, group_id=None):
    expense = Expense(
        description=description,
        amount=amount,
        currency="USD",
        date="2024-01-01",
        payer_id=payer_id,
        payer_is_guest=payer_is_guest,
        split_type="EQUAL",
        group_id=group_id
    )
    session.add(expense)
    session.commit()
    session.refresh(expense)

    for split in splits:
        db_split = ExpenseSplit(
            expense_id=expense.id,
            user_id=split["user_id"],
            amount_owed=split["amount"],
            is_guest=split.get("is_guest", False)
        )
        session.add(db_split)
    session.commit()
    return expense


def test_friend_balance_includes_managed_guest(client, session):
    """
    Test that friend balance includes what managed guests owe.
    
    Scenario:
    - User1 and User2 are friends
    - Both are in the same group
    - User1 manages Guest C
    - User2 pays an expense where Guest C owes $50
    - User1's balance with User2 should show they owe $50 (for Guest C)
    """
    # Create users
    user1 = create_user(session, "user1@example.com", "User One")
    user2 = create_user(session, "user2@example.com", "User Two")

    # Create friendship
    friendship = Friendship(user_id1=user1.id, user_id2=user2.id)
    session.add(friendship)
    session.commit()

    # Create group and add both as members
    group = create_group(session, "Test Group", user1.id)
    add_member(session, group.id, user1.id)
    add_member(session, group.id, user2.id)

    # Create a guest managed by user1
    guest_c = create_guest(
        session, group.id, "Guest C", user1.id,
        managed_by_id=user1.id, managed_by_type='user'
    )

    # User2 pays $100 expense, Guest C owes $50, User2 owes $50
    create_expense(
        session, 
        payer_id=user2.id, 
        payer_is_guest=False,
        amount=10000, 
        description="Dinner",
        splits=[
            {"user_id": guest_c.id, "amount": 5000, "is_guest": True},
            {"user_id": user2.id, "amount": 5000, "is_guest": False}
        ],
        group_id=group.id
    )

    # Authenticate as user1
    app.dependency_overrides[get_current_user] = lambda: user1

    # Get balance with user2
    response = client.get(f"/friends/{user2.id}/balance")
    assert response.status_code == 200
    
    data = response.json()
    assert len(data) == 1
    assert data[0]["currency"] == "USD"
    # User1 (via managed guest) owes User2 $50
    assert data[0]["amount"] == -50.0


def test_friend_balance_includes_managed_member(client, session):
    """
    Test that friend balance includes what managed members owe.
    
    Scenario:
    - User1, User2, User3 exist
    - User1 and User2 are friends
    - All three are in the same group
    - User1 manages User3 in the group
    - User2 pays an expense where User3 owes $30
    - User1's balance with User2 should show they owe $30 (for User3)
    """
    # Create users
    user1 = create_user(session, "user1@example.com", "User One")
    user2 = create_user(session, "user2@example.com", "User Two")
    user3 = create_user(session, "user3@example.com", "User Three")

    # Create friendship between user1 and user2
    friendship = Friendship(user_id1=user1.id, user_id2=user2.id)
    session.add(friendship)
    session.commit()

    # Create group with all three members, user3 managed by user1
    group = create_group(session, "Test Group", user1.id)
    add_member(session, group.id, user1.id)
    add_member(session, group.id, user2.id)
    add_member(session, group.id, user3.id, managed_by_id=user1.id, managed_by_type='user')

    # User2 pays $60 expense, User3 owes $30, User2 owes $30
    create_expense(
        session,
        payer_id=user2.id,
        payer_is_guest=False,
        amount=6000,
        description="Lunch",
        splits=[
            {"user_id": user3.id, "amount": 3000, "is_guest": False},
            {"user_id": user2.id, "amount": 3000, "is_guest": False}
        ],
        group_id=group.id
    )

    # Authenticate as user1
    app.dependency_overrides[get_current_user] = lambda: user1

    # Get balance with user2
    response = client.get(f"/friends/{user2.id}/balance")
    assert response.status_code == 200

    data = response.json()
    assert len(data) == 1
    assert data[0]["currency"] == "USD"
    # User1 (via managed member user3) owes User2 $30
    assert data[0]["amount"] == -30.0


def test_friend_expenses_includes_managed_guest_expenses(client, session):
    """
    Test that friend expenses list includes expenses involving managed guests.
    """
    # Create users
    user1 = create_user(session, "user1@example.com", "User One")
    user2 = create_user(session, "user2@example.com", "User Two")

    # Create friendship
    friendship = Friendship(user_id1=user1.id, user_id2=user2.id)
    session.add(friendship)
    session.commit()

    # Create group
    group = create_group(session, "Test Group", user1.id)
    add_member(session, group.id, user1.id)
    add_member(session, group.id, user2.id)

    # Create a guest managed by user1
    guest_c = create_guest(
        session, group.id, "Guest C", user1.id,
        managed_by_id=user1.id, managed_by_type='user'
    )

    # User2 pays expense with Guest C (not directly with User1)
    expense = create_expense(
        session,
        payer_id=user2.id,
        payer_is_guest=False,
        amount=10000,
        description="Managed Guest Expense",
        splits=[
            {"user_id": guest_c.id, "amount": 5000, "is_guest": True},
            {"user_id": user2.id, "amount": 5000, "is_guest": False}
        ],
        group_id=group.id
    )

    # Authenticate as user1
    app.dependency_overrides[get_current_user] = lambda: user1

    # Get expenses with user2
    response = client.get(f"/friends/{user2.id}/expenses")
    assert response.status_code == 200

    data = response.json()
    # Should include the managed guest expense
    assert len(data) == 1
    assert data[0]["description"] == "Managed Guest Expense"
