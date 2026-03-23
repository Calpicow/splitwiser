import pytest
from unittest.mock import patch
from conftest import client, db_session
import models

def test_update_expense_updates_exchange_rate(client, db_session):
    # Register and login
    client.post("/register", json={"email": "u1@example.com", "password": "password123", "full_name": "U1"})
    token = client.post("/token", data={"username": "u1@example.com", "password": "password123"}).json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    # Get actual user ID
    user1 = db_session.query(models.User).filter(models.User.email == "u1@example.com").first()
    user1_id = user1.id

    # Create a group (expenses need group context for participant validation)
    group_res = client.post("/groups", json={"name": "Test Group", "default_currency": "USD"}, headers=headers)
    group_id = group_res.json()["id"]

    # Mock the exchange rate fetcher
    with patch('utils.currency.fetch_historical_exchange_rate') as mock_rate:
        # 1. Create expense with Rate 1.5
        mock_rate.return_value = 1.5
        expense_data = {
            "description": "Test",
            "amount": 100,
            "currency": "EUR",
            "date": "2023-01-01",
            "payer_id": user1_id,
            "group_id": group_id,
            "split_type": "EQUAL",
            "splits": [{"user_id": user1_id, "amount_owed": 100}]
        }
        res = client.post("/expenses", json=expense_data, headers=headers)
        if res.status_code != 200:
             print(res.json())
        assert res.status_code == 200
        expense_id = res.json()["id"]

        # 2. Update expense date, Mock Rate 2.0
        mock_rate.return_value = 2.0
        update_data = {
            "description": "Test Updated",
            "amount": 100,
            "currency": "EUR",
            "date": "2023-02-01",
            "payer_id": user1_id,
            "split_type": "EQUAL",
            "splits": [{"user_id": user1_id, "amount_owed": 100}]
        }

        client.put(f"/expenses/{expense_id}", json=update_data, headers=headers)

        # Verify directly in DB
        exp = db_session.query(models.Expense).filter(models.Expense.id == expense_id).first()

        # We expect 2.0
        print(f"Stored rate: {exp.exchange_rate}")
        assert float(exp.exchange_rate) == 2.0, f"Expected 2.0, got {exp.exchange_rate}"

def test_simplify_debts_uses_stored_rate(client, db_session):
     # Register users
    client.post("/register", json={"email": "uA@example.com", "password": "password123", "full_name": "A"})
    client.post("/register", json={"email": "uB@example.com", "password": "password123", "full_name": "B"})

    tA = client.post("/token", data={"username": "uA@example.com", "password": "password123"}).json()["access_token"]
    hA = {"Authorization": f"Bearer {tA}"}

    # Get actual user IDs
    userA = db_session.query(models.User).filter(models.User.email == "uA@example.com").first()
    userB = db_session.query(models.User).filter(models.User.email == "uB@example.com").first()

    # Create group
    g = client.post("/groups", json={"name": "G", "default_currency": "USD"}, headers=hA).json()
    gid = g["id"]
    client.post(f"/groups/{gid}/members", json={"email": "uB@example.com"}, headers=hA)

    # Mock rate: 1 EUR = 2.0 USD
    with patch('utils.currency.fetch_historical_exchange_rate') as mock_rate:
        mock_rate.return_value = 2.0

        expense_data = {
            "description": "Trip",
            "amount": 10000, # 100 EUR
            "currency": "EUR",
            "date": "2023-01-01",
            "payer_id": userA.id,
            "group_id": gid,
            "split_type": "EQUAL",
            "splits": [
                {"user_id": userA.id, "amount_owed": 5000},
                {"user_id": userB.id, "amount_owed": 5000}
            ]
        }
        res = client.post("/expenses", json=expense_data, headers=hA)
        assert res.status_code == 200

        # Now call simplify
        res = client.get(f"/simplify_debts/{gid}", headers=hA)
        txs = res.json()["transactions"]

        # Expectation: 50 EUR owed -> 100 USD
        assert len(txs) == 1
        amount = txs[0]["amount"]

        print(f"Calculated debt in USD: {amount}")
        assert abs(amount - 10000) < 5, f"Expected ~10000 (100 USD), got {amount}"
