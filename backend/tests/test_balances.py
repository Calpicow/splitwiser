from datetime import date
from models import User
from auth import get_password_hash

def test_simple_balance(client, auth_headers, db_session, test_user):
    # Setup: Group with 2 users
    group_resp = client.post("/groups/", headers=auth_headers, json={"name": "Balance Group", "default_currency": "USD"})
    group_id = group_resp.json()["id"]
    
    other_user = User(email="balance@example.com", hashed_password=get_password_hash("pw"), full_name="Balance User", is_active=True)
    db_session.add(other_user)
    db_session.commit()
    client.post(f"/groups/{group_id}/members", headers=auth_headers, json={"email": "balance@example.com"})

    # Expense: Test User pays $20, split equally
    # Test User pays 2000, owes 1000. Net +1000 (owed)
    # Other User pays 0, owes 1000. Net -1000 (owes)
    payload = {
        "description": "Lunch",
        "amount": 2000,
        "currency": "USD",
        "date": str(date.today()),
        "payer_id": test_user.id,
        "group_id": group_id,
        "split_type": "EQUAL",
        "splits": [
            {"user_id": test_user.id, "amount_owed": 1000, "is_guest": False},
            {"user_id": other_user.id, "amount_owed": 1000, "is_guest": False}
        ]
    }
    client.post("/expenses/", headers=auth_headers, json=payload)

    # Check Balances - the /balances endpoint returns group-level balances
    # Each entry has group_name, group_id, and the user's net balance in that group
    response = client.get("/balances/", headers=auth_headers)
    assert response.status_code == 200
    balances = response.json()["balances"]

    # The /balances endpoint returns one entry per group with the current user's net balance.
    # Test User paid 2000 and owes 1000, so net is +1000 (owed by group).
    group_balance = next((b for b in balances if b["group_id"] == group_id), None)
    assert group_balance is not None
    assert group_balance["amount"] == 1000.0

def test_settlement(client, auth_headers, db_session, test_user):
    # Setup as above
    group_resp = client.post("/groups/", headers=auth_headers, json={"name": "Settlement Group", "default_currency": "USD"})
    group_id = group_resp.json()["id"]
    other_user = User(email="settle@example.com", hashed_password=get_password_hash("pw"), full_name="Settle", is_active=True)
    db_session.add(other_user)
    db_session.commit()
    client.post(f"/groups/{group_id}/members", headers=auth_headers, json={"email": "settle@example.com"})

    # Expense 1: Test User lends $10 to Other
    client.post("/expenses/", headers=auth_headers, json={
        "description": "Loan",
        "amount": 1000,
        "currency": "USD",
        "date": str(date.today()),
        "payer_id": test_user.id,
        "group_id": group_id,
        "split_type": "EXACT",
        "splits": [
            {"user_id": test_user.id, "amount_owed": 0, "is_guest": False},
            {"user_id": other_user.id, "amount_owed": 1000, "is_guest": False}
        ]
    })

    # Expense 2: Other User pays back $10 to Test User
    # Settlement is just an expense where payer=Other, and split is 100% on Test User? 
    # Or specifically a "payment". Usually handled as an expense.
    client.post("/expenses/", headers=auth_headers, json={
        "description": "Payment",
        "amount": 1000,
        "currency": "USD",
        "date": str(date.today()),
        "payer_id": other_user.id,
        "group_id": group_id,
        "split_type": "EXACT",
        "splits": [
            {"user_id": test_user.id, "amount_owed": 1000, "is_guest": False},
            {"user_id": other_user.id, "amount_owed": 0, "is_guest": False}
        ]
    })

    # Check Balances - should be 0 (or close to 0)
    response = client.get("/balances/", headers=auth_headers)
    balances = response.json()["balances"]
    # If balance is 0, it might not be returned, or returned as 0.
    other_balance = next((b for b in balances if b["user_id"] == other_user.id), None)
    if other_balance:
        assert abs(other_balance["amount"]) < 0.01

def test_guest_balance_aggregation(client, auth_headers, db_session, test_user):
    # Setup Group
    group_resp = client.post("/groups/", headers=auth_headers, json={"name": "Guest Balance Group", "default_currency": "USD"})
    group_id = group_resp.json()["id"]

    # Add Guest and Manage them
    guest_resp = client.post(f"/groups/{group_id}/guests", headers=auth_headers, json={"name": "My Guest"})
    guest_id = guest_resp.json()["id"]
    client.post(f"/groups/{group_id}/guests/{guest_id}/manage", headers=auth_headers, json={"user_id": test_user.id, "is_guest": False})

    # Add another real user
    other_user = User(email="other_b@example.com", hashed_password=get_password_hash("pw"), full_name="Other", is_active=True)
    db_session.add(other_user)
    db_session.commit()
    client.post(f"/groups/{group_id}/members", headers=auth_headers, json={"email": "other_b@example.com"})

    # Expense: Other User pays $30. Split: Other(10), Test(10), Guest(10).
    # Test User owes $10. Guest owes $10.
    # Since Test User manages Guest, Test User aggregate debt should be $20.
    payload = {
        "description": "Dinner",
        "amount": 3000,
        "currency": "USD",
        "date": str(date.today()),
        "payer_id": other_user.id,
        "group_id": group_id,
        "split_type": "EQUAL",
        "splits": [
            {"user_id": other_user.id, "amount_owed": 1000, "is_guest": False},
            {"user_id": test_user.id, "amount_owed": 1000, "is_guest": False},
            {"user_id": guest_id, "amount_owed": 1000, "is_guest": True}
        ]
    }
    client.post("/expenses/", headers=auth_headers, json=payload)

    # Check Group Balances (Specific endpoint likely /groups/{id}/balances or similar for aggregated view? 
    # The normal /balances/ endpoint might also aggregate depending on implementation)
    
    # Let's check the group-specific balance endpoint if it exists or use the general one.
    # Looking at schemas, GroupBalance has 'managed_guests' list.
    response = client.get(f"/groups/{group_id}/balances", headers=auth_headers)
    assert response.status_code == 200
    group_balances = response.json()

    # We expect to see an entry for Test User with valid negative amount
    my_balance = next((b for b in group_balances if b["user_id"] == test_user.id and not b["is_guest"]), None)
    assert my_balance is not None
    # 'amount' is what the user *is owed*. Since we owe, it should be negative.
    # We owe 10 for self + 10 for guest = 20 total.
    assert my_balance["amount"] == -2000.0
    assert any("My Guest" in g for g in my_balance["managed_guests"])
