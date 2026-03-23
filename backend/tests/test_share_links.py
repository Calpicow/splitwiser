
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from database import Base, get_db
from main import app
from models import User, Group, GroupMember, GuestMember
from auth import create_access_token


def test_share_group_flow(client, auth_headers, test_user):
    # 1. Create Group
    res = client.post("/groups", json={"name": "Shared Group", "default_currency": "USD"}, headers=auth_headers)
    assert res.status_code == 200
    group_id = res.json()["id"]

    # 2. Enable Sharing - returns Group schema
    res = client.post(f"/groups/{group_id}/share", headers=auth_headers)
    assert res.status_code == 200
    share_data = res.json()
    assert share_data["is_public"] == True
    assert share_data["share_link_id"] is not None
    share_link_id = share_data["share_link_id"]

    # 3. Access Public Group Details (No Auth) - route is /groups/public/{share_link_id}
    res = client.get(f"/groups/public/{share_link_id}")
    assert res.status_code == 200
    data = res.json()
    assert data["name"] == "Shared Group"
    assert data["is_public"] == True

    # 4. Access Public Expenses
    # Add expense first
    client.post("/expenses", json={
        "description": "Lunch",
        "amount": 1000,
        "currency": "USD",
        "date": "2023-01-01",
        "payer_id": test_user.id,
        "payer_is_guest": False,
        "group_id": group_id,
        "splits": [{"user_id": test_user.id, "is_guest": False, "amount_owed": 1000}],
        "split_type": "EQUAL"
    }, headers=auth_headers)

    res = client.get(f"/groups/public/{share_link_id}/expenses")
    assert res.status_code == 200
    expenses = res.json()
    assert len(expenses) == 1
    assert expenses[0]["description"] == "Lunch"
    expense_id = expenses[0]["id"]

    # 4b. Access Public Expense Detail
    res = client.get(f"/groups/public/{share_link_id}/expenses/{expense_id}")
    assert res.status_code == 200
    detail = res.json()
    assert detail["description"] == "Lunch"
    assert detail["amount"] == 1000
    assert len(detail["splits"]) == 1

    # 5. Access Public Balances
    res = client.get(f"/groups/public/{share_link_id}/balances")
    assert res.status_code == 200

    # 6. Disable Sharing - returns Group schema
    res = client.delete(f"/groups/{group_id}/share", headers=auth_headers)
    assert res.status_code == 200
    data = res.json()
    assert data["is_public"] == False

    # 7. Access Public Link should fail
    res = client.get(f"/groups/public/{share_link_id}")
    assert res.status_code == 404


def test_guest_claiming(client, auth_headers, db_session, test_user):
    # 1. Create Group
    res = client.post("/groups", json={"name": "Guest Group", "default_currency": "USD"}, headers=auth_headers)
    group_id = res.json()["id"]

    # 2. Add Guest
    res = client.post(f"/groups/{group_id}/guests", json={"name": "Guest Bob"}, headers=auth_headers)
    guest_id = res.json()["id"]

    # 3. Share Group
    res = client.post(f"/groups/{group_id}/share", headers=auth_headers)
    share_link_id = res.json()["share_link_id"]

    # 4. Register new user with claim - returns Token schema
    claim_payload = {
        "email": "bob@example.com",
        "password": "password123",
        "full_name": "Bob Real",
        "claim_guest_id": guest_id,
        "share_link_id": share_link_id
    }
    res = client.post("/register", json=claim_payload)
    if res.status_code != 200:
        print(res.json())
    assert res.status_code == 200
    assert "access_token" in res.json()

    # 5. Log in as new user and find user ID
    res = client.post("/token", data={"username": "bob@example.com", "password": "password123"})
    new_token = res.json()["access_token"]
    new_headers = {"Authorization": f"Bearer {new_token}"}

    # Get user ID from /users/me
    me_res = client.get("/users/me", headers=new_headers)
    new_user_id = me_res.json()["id"]

    res = client.get(f"/groups/{group_id}", headers=new_headers)
    assert res.status_code == 200
    group_data = res.json()

    # Check that new user is a member
    members = group_data["members"]
    assert any(m["user_id"] == new_user_id for m in members)

    # Check that guest is claimed
    db_session.expire_all()
    guest = db_session.query(GuestMember).filter(GuestMember.id == guest_id).first()
    assert guest is not None
    assert guest.claimed_by_id == new_user_id
