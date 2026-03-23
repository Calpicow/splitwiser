import pytest
from conftest import client, db_session
import models

def test_create_user(client):
    response = client.post(
        "/register",
        json={"email": "test@example.com", "password": "password123", "full_name": "Test User"},
    )
    assert response.status_code == 200
    data = response.json()
    assert "access_token" in data
    assert "refresh_token" in data
    assert data["token_type"] == "bearer"

def test_login_user(client):
    client.post(
        "/register",
        json={"email": "test@example.com", "password": "password123", "full_name": "Test User"},
    )
    response = client.post(
        "/token",
        data={"username": "test@example.com", "password": "password123"},
    )
    assert response.status_code == 200
    data = response.json()
    assert "access_token" in data
    assert data["token_type"] == "bearer"

def test_create_expense_and_check_balance(client, db_session):
    # Register two users
    client.post("/register", json={"email": "user1@example.com", "password": "password123", "full_name": "User 1"})
    client.post("/register", json={"email": "user2@example.com", "password": "password123", "full_name": "User 2"})

    # Login User 1
    login_res = client.post("/token", data={"username": "user1@example.com", "password": "password123"})
    token = login_res.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    # Get actual user IDs from DB
    user1 = db_session.query(models.User).filter(models.User.email == "user1@example.com").first()
    user2 = db_session.query(models.User).filter(models.User.email == "user2@example.com").first()

    # Create a group so we can add expenses with both users
    group_res = client.post("/groups", json={"name": "Test Group", "default_currency": "USD"}, headers=headers)
    assert group_res.status_code == 200
    group_id = group_res.json()["id"]

    # Add user2 to the group
    client.post(f"/groups/{group_id}/members", json={"email": "user2@example.com"}, headers=headers)

    # User 1 adds expense of 100 USD, split equally with User 2
    expense_data = {
        "description": "Lunch",
        "amount": 10000, # 100.00 USD
        "currency": "USD",
        "date": "2023-10-27",
        "payer_id": user1.id,
        "group_id": group_id,
        "split_type": "EQUAL",
        "splits": [
            {"user_id": user1.id, "amount_owed": 5000},
            {"user_id": user2.id, "amount_owed": 5000}
        ]
    }

    res = client.post("/expenses", json=expense_data, headers=headers)
    assert res.status_code == 200

    # Check Balance for User 1 via /balances endpoint
    # The /balances endpoint returns group-level balances
    res_balance = client.get("/balances", headers=headers)
    assert res_balance.status_code == 200
    balances = res_balance.json()["balances"]

    # Should have one entry for the group where User 1 is owed 5000
    assert len(balances) == 1
    assert balances[0]["group_id"] == group_id
    assert balances[0]["amount"] == 5000
    assert balances[0]["currency"] == "USD"
