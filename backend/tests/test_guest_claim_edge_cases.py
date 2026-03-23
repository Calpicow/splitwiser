
import pytest
from conftest import client, db_session
import models

def test_claim_guest_managed_by_user(client, db_session):
    """
    Scenario: User 1 creates Guest A and manages them.
    User 2 claims Guest A.
    Result: Guest A becomes User 2. Management link is cleared (to prevent double-counting).
    """
    # 1. Register User 1 (Manager)
    client.post("/register", json={"email": "manager@example.com", "password": "password123", "full_name": "Manager"})
    token1 = client.post("/token", data={"username": "manager@example.com", "password": "password123"}).json()["access_token"]
    headers1 = {"Authorization": f"Bearer {token1}"}

    user1 = db_session.query(models.User).filter(models.User.email == "manager@example.com").first()

    # 2. Create Group and Guest A
    group_res = client.post("/groups", json={"name": "Test Group"}, headers=headers1)
    group_id = group_res.json()["id"]
    guest_res = client.post(f"/groups/{group_id}/guests", json={"name": "Guest A"}, headers=headers1)
    guest_id = guest_res.json()["id"]

    # 3. User 1 manages Guest A
    client.post(f"/groups/{group_id}/guests/{guest_id}/manage", json={"user_id": user1.id, "is_guest": False}, headers=headers1)

    # 4. Enable Sharing
    share_res = client.post(f"/groups/{group_id}/share", headers=headers1)
    share_link_id = share_res.json()["share_link_id"]

    # 5. User 2 claims Guest A via registration
    res = client.post("/register", json={
        "email": "claimed@example.com",
        "password": "password123",
        "full_name": "Claimed User",
        "claim_guest_id": guest_id,
        "share_link_id": share_link_id
    })
    assert res.status_code == 200

    # Refresh session to see changes
    db_session.expire_all()

    # 6. Verify Guest A still exists (as linking record)
    guest_a = db_session.query(models.GuestMember).filter(models.GuestMember.id == guest_id).first()
    assert guest_a is not None

    # 7. Verify management link is CLEARED after claiming
    # The current code clears managed_by fields to prevent double-counting
    # because the management relationship is transferred to the GroupMember record
    assert guest_a.managed_by_id is None
    assert guest_a.managed_by_type is None

    # 8. Verify User 2 is in the group
    user2 = db_session.query(models.User).filter(models.User.email == "claimed@example.com").first()
    member = db_session.query(models.GroupMember).filter(models.GroupMember.user_id == user2.id, models.GroupMember.group_id == group_id).first()
    assert member is not None

    # 9. Verify the management relationship was transferred to the GroupMember
    assert member.managed_by_id == user1.id
    assert member.managed_by_type == 'user'

    # 10. Verify Guest A is claimed by User 2
    assert guest_a.claimed_by_id == user2.id

def test_claim_guest_with_itemized_expenses(client, db_session):
    """
    Scenario: Guest A is assigned an item in an itemized expense.
    User 2 claims Guest A.
    Result: Item assignment is transferred to User 2.
    """
    # 1. Register User 1
    client.post("/register", json={"email": "u1@example.com", "password": "password123", "full_name": "U1"})
    token1 = client.post("/token", data={"username": "u1@example.com", "password": "password123"}).json()["access_token"]
    headers1 = {"Authorization": f"Bearer {token1}"}

    # 2. Create Group and Guest A
    group_res = client.post("/groups", json={"name": "G1"}, headers=headers1)
    group_id = group_res.json()["id"]
    guest_res = client.post(f"/groups/{group_id}/guests", json={"name": "Guest A"}, headers=headers1)
    guest_id = guest_res.json()["id"]

    # 3. Create Itemized Expense involved Guest A
    user1_id = db_session.query(models.User).filter(models.User.email == "u1@example.com").first().id

    expense_data = {
        "description": "Dinner",
        "amount": 2000,
        "date": "2023-01-01",
        "payer_id": user1_id,
        "split_type": "ITEMIZED",
        "splits": [
            {"user_id": user1_id, "amount_owed": 1000, "is_guest": False},
            {"user_id": guest_id, "amount_owed": 1000, "is_guest": True}
        ],
        "items": [
            {
                "description": "Burger",
                "price": 1000,
                "assignments": [{"user_id": guest_id, "is_guest": True}]
            },
            {
                "description": "Fries",
                "price": 1000,
                "assignments": [{"user_id": user1_id, "is_guest": False}]
            }
        ],
        "group_id": group_id
    }

    create_res = client.post("/expenses", json=expense_data, headers=headers1)
    assert create_res.status_code == 200

    # 4. Enable Sharing
    share_res = client.post(f"/groups/{group_id}/share", headers=headers1)
    share_link_id = share_res.json()["share_link_id"]

    # 5. User 2 claims Guest A
    res = client.post("/register", json={
        "email": "u2@example.com",
        "password": "password123",
        "full_name": "U2",
        "claim_guest_id": guest_id,
        "share_link_id": share_link_id
    })
    assert res.status_code == 200

    # Refresh session to see changes
    db_session.expire_all()

    # 6. Verify Item Assignment Transferred
    user2 = db_session.query(models.User).filter(models.User.email == "u2@example.com").first()

    assignments = db_session.query(models.ExpenseItemAssignment).filter(
        models.ExpenseItemAssignment.user_id == user2.id,
        models.ExpenseItemAssignment.is_guest == False
    ).all()

    assert len(assignments) >= 1

    # Verify the specific assignment
    burger_item = db_session.query(models.ExpenseItem).filter(models.ExpenseItem.description == "Burger").first()
    burger_assignment = db_session.query(models.ExpenseItemAssignment).filter(
        models.ExpenseItemAssignment.expense_item_id == burger_item.id,
        models.ExpenseItemAssignment.user_id == user2.id
    ).first()
    assert burger_assignment is not None
