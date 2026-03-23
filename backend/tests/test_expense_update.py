"""Comprehensive integration tests for the PUT /expenses/{expense_id} endpoint."""

from datetime import date
from unittest.mock import patch

from models import User
from auth import get_password_hash, create_access_token


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _create_group(client, headers, name="Test Group", currency="USD"):
    """Create a group and return its ID."""
    resp = client.post(
        "/groups/",
        headers=headers,
        json={"name": name, "default_currency": currency},
    )
    assert resp.status_code == 200
    return resp.json()["id"]


def _add_member(client, headers, group_id, email):
    """Add a registered user as a group member."""
    resp = client.post(
        f"/groups/{group_id}/members",
        headers=headers,
        json={"email": email},
    )
    assert resp.status_code == 200
    return resp.json()


def _add_guest(client, headers, group_id, name):
    """Add a guest member to a group and return the guest record."""
    resp = client.post(
        f"/groups/{group_id}/guests",
        headers=headers,
        json={"name": name},
    )
    assert resp.status_code == 200
    return resp.json()


def _make_user(db_session, email, full_name="Other User"):
    """Create and persist a User directly in the DB."""
    user = User(
        email=email,
        hashed_password=get_password_hash("password123"),
        full_name=full_name,
        is_active=True,
    )
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    return user


def _create_expense(client, headers, payload):
    """POST an expense and return the response JSON (asserts 200)."""
    resp = client.post("/expenses/", headers=headers, json=payload)
    assert resp.status_code == 200, resp.json()
    return resp.json()


def _update_expense(client, headers, expense_id, payload):
    """PUT an expense and return the full response."""
    return client.put(f"/expenses/{expense_id}", headers=headers, json=payload)


def _get_expense(client, headers, expense_id):
    """GET expense with splits and return the JSON."""
    resp = client.get(f"/expenses/{expense_id}", headers=headers)
    assert resp.status_code == 200
    return resp.json()


def _base_payload(
    payer_id,
    group_id,
    *,
    description="Test Expense",
    amount=2000,
    currency="USD",
    split_type="EQUAL",
    splits=None,
    items=None,
    payer_is_guest=False,
    notes=None,
    expense_date=None,
):
    """Build a minimal expense payload dict."""
    payload = {
        "description": description,
        "amount": amount,
        "currency": currency,
        "date": expense_date or str(date.today()),
        "payer_id": payer_id,
        "payer_is_guest": payer_is_guest,
        "group_id": group_id,
        "split_type": split_type,
        "splits": splits or [],
    }
    if items is not None:
        payload["items"] = items
    if notes is not None:
        payload["notes"] = notes
    return payload


# ---------------------------------------------------------------------------
# 1. Update EQUAL split — change amount
# ---------------------------------------------------------------------------

def test_update_expense_equal_split_change_amount(client, auth_headers, db_session, test_user):
    other = _make_user(db_session, "eq1@example.com", "Other EQ")
    group_id = _create_group(client, auth_headers)
    _add_member(client, auth_headers, group_id, other.email)

    # Create with amount=2000 ($20), equal split 1000 each
    payload = _base_payload(
        test_user.id, group_id,
        amount=2000,
        splits=[
            {"user_id": test_user.id, "amount_owed": 1000, "is_guest": False},
            {"user_id": other.id, "amount_owed": 1000, "is_guest": False},
        ],
    )
    created = _create_expense(client, auth_headers, payload)

    # Update amount to 4000, recalculate splits
    update = payload.copy()
    update["amount"] = 4000
    update["splits"] = [
        {"user_id": test_user.id, "amount_owed": 2000, "is_guest": False},
        {"user_id": other.id, "amount_owed": 2000, "is_guest": False},
    ]

    resp = _update_expense(client, auth_headers, created["id"], update)
    assert resp.status_code == 200
    assert resp.json()["amount"] == 4000

    details = _get_expense(client, auth_headers, created["id"])
    splits = {s["user_id"]: s["amount_owed"] for s in details["splits"]}
    assert splits[test_user.id] == 2000
    assert splits[other.id] == 2000


# ---------------------------------------------------------------------------
# 2. Update EXACT split
# ---------------------------------------------------------------------------

def test_update_expense_exact_split(client, auth_headers, db_session, test_user):
    other = _make_user(db_session, "exact_upd@example.com", "Exact")
    group_id = _create_group(client, auth_headers)
    _add_member(client, auth_headers, group_id, other.email)

    payload = _base_payload(
        test_user.id, group_id,
        amount=3000,
        split_type="EXACT",
        splits=[
            {"user_id": test_user.id, "amount_owed": 2000, "is_guest": False},
            {"user_id": other.id, "amount_owed": 1000, "is_guest": False},
        ],
    )
    created = _create_expense(client, auth_headers, payload)

    # Flip the split amounts
    update = payload.copy()
    update["splits"] = [
        {"user_id": test_user.id, "amount_owed": 1000, "is_guest": False},
        {"user_id": other.id, "amount_owed": 2000, "is_guest": False},
    ]
    resp = _update_expense(client, auth_headers, created["id"], update)
    assert resp.status_code == 200

    details = _get_expense(client, auth_headers, created["id"])
    splits = {s["user_id"]: s["amount_owed"] for s in details["splits"]}
    assert splits[test_user.id] == 1000
    assert splits[other.id] == 2000


# ---------------------------------------------------------------------------
# 3. Update PERCENTAGE split
# ---------------------------------------------------------------------------

def test_update_expense_percentage_split(client, auth_headers, db_session, test_user):
    other = _make_user(db_session, "pct@example.com", "Pct")
    group_id = _create_group(client, auth_headers)
    _add_member(client, auth_headers, group_id, other.email)

    payload = _base_payload(
        test_user.id, group_id,
        amount=10000,
        split_type="PERCENT",
        splits=[
            {"user_id": test_user.id, "amount_owed": 7000, "is_guest": False, "percentage": 70},
            {"user_id": other.id, "amount_owed": 3000, "is_guest": False, "percentage": 30},
        ],
    )
    created = _create_expense(client, auth_headers, payload)

    # Change to 50/50
    update = payload.copy()
    update["splits"] = [
        {"user_id": test_user.id, "amount_owed": 5000, "is_guest": False, "percentage": 50},
        {"user_id": other.id, "amount_owed": 5000, "is_guest": False, "percentage": 50},
    ]
    resp = _update_expense(client, auth_headers, created["id"], update)
    assert resp.status_code == 200

    details = _get_expense(client, auth_headers, created["id"])
    splits = {s["user_id"]: s["amount_owed"] for s in details["splits"]}
    assert splits[test_user.id] == 5000
    assert splits[other.id] == 5000


# ---------------------------------------------------------------------------
# 4. Update SHARES split
# ---------------------------------------------------------------------------

def test_update_expense_shares_split(client, auth_headers, db_session, test_user):
    other = _make_user(db_session, "shares@example.com", "Shares")
    group_id = _create_group(client, auth_headers)
    _add_member(client, auth_headers, group_id, other.email)

    # 2 shares : 1 share = 2000 : 1000
    payload = _base_payload(
        test_user.id, group_id,
        amount=3000,
        split_type="SHARES",
        splits=[
            {"user_id": test_user.id, "amount_owed": 2000, "is_guest": False, "shares": 2},
            {"user_id": other.id, "amount_owed": 1000, "is_guest": False, "shares": 1},
        ],
    )
    created = _create_expense(client, auth_headers, payload)

    # Change to 1:2 ratio => 1000 : 2000
    update = payload.copy()
    update["splits"] = [
        {"user_id": test_user.id, "amount_owed": 1000, "is_guest": False, "shares": 1},
        {"user_id": other.id, "amount_owed": 2000, "is_guest": False, "shares": 2},
    ]
    resp = _update_expense(client, auth_headers, created["id"], update)
    assert resp.status_code == 200

    details = _get_expense(client, auth_headers, created["id"])
    splits = {s["user_id"]: s["amount_owed"] for s in details["splits"]}
    assert splits[test_user.id] == 1000
    assert splits[other.id] == 2000


# ---------------------------------------------------------------------------
# 5. Update ITEMIZED expense — change items
# ---------------------------------------------------------------------------

def test_update_itemized_expense_change_items(client, auth_headers, db_session, test_user):
    other = _make_user(db_session, "item1@example.com", "Item1")
    group_id = _create_group(client, auth_headers)
    _add_member(client, auth_headers, group_id, other.email)

    items = [
        {
            "description": "Burger",
            "price": 1000,
            "is_tax_tip": False,
            "assignments": [{"user_id": test_user.id, "is_guest": False}],
        },
        {
            "description": "Salad",
            "price": 800,
            "is_tax_tip": False,
            "assignments": [{"user_id": other.id, "is_guest": False}],
        },
    ]
    payload = _base_payload(
        test_user.id, group_id,
        amount=1800,
        split_type="ITEMIZED",
        splits=[
            {"user_id": test_user.id, "amount_owed": 1000, "is_guest": False},
            {"user_id": other.id, "amount_owed": 800, "is_guest": False},
        ],
        items=items,
    )
    created = _create_expense(client, auth_headers, payload)

    # Update: change Burger price to 1200 and reassign Salad to test_user
    new_items = [
        {
            "description": "Burger",
            "price": 1200,
            "is_tax_tip": False,
            "assignments": [{"user_id": test_user.id, "is_guest": False}],
        },
        {
            "description": "Salad",
            "price": 800,
            "is_tax_tip": False,
            "assignments": [{"user_id": test_user.id, "is_guest": False}],
        },
    ]
    update = _base_payload(
        test_user.id, group_id,
        amount=2000,
        split_type="ITEMIZED",
        splits=[
            {"user_id": test_user.id, "amount_owed": 0, "is_guest": False},
            {"user_id": other.id, "amount_owed": 0, "is_guest": False},
        ],
        items=new_items,
    )
    resp = _update_expense(client, auth_headers, created["id"], update)
    assert resp.status_code == 200
    assert resp.json()["amount"] == 2000

    details = _get_expense(client, auth_headers, created["id"])
    splits = {s["user_id"]: s["amount_owed"] for s in details["splits"]}
    # test_user gets Burger(1200) + Salad(800) = 2000
    assert splits[test_user.id] == 2000
    # other has 0 (participant kept but no items)
    assert splits[other.id] == 0


# ---------------------------------------------------------------------------
# 6. Update ITEMIZED — add and remove items
# ---------------------------------------------------------------------------

def test_update_itemized_expense_add_remove_items(client, auth_headers, db_session, test_user):
    other = _make_user(db_session, "item2@example.com", "Item2")
    group_id = _create_group(client, auth_headers)
    _add_member(client, auth_headers, group_id, other.email)

    items = [
        {
            "description": "Pizza",
            "price": 1500,
            "is_tax_tip": False,
            "assignments": [{"user_id": test_user.id, "is_guest": False}],
        },
        {
            "description": "Wings",
            "price": 1000,
            "is_tax_tip": False,
            "assignments": [{"user_id": other.id, "is_guest": False}],
        },
    ]
    payload = _base_payload(
        test_user.id, group_id,
        amount=2500,
        split_type="ITEMIZED",
        splits=[
            {"user_id": test_user.id, "amount_owed": 1500, "is_guest": False},
            {"user_id": other.id, "amount_owed": 1000, "is_guest": False},
        ],
        items=items,
    )
    created = _create_expense(client, auth_headers, payload)

    # Remove Wings, add Nachos and Soda
    new_items = [
        {
            "description": "Pizza",
            "price": 1500,
            "is_tax_tip": False,
            "assignments": [{"user_id": test_user.id, "is_guest": False}],
        },
        {
            "description": "Nachos",
            "price": 900,
            "is_tax_tip": False,
            "assignments": [{"user_id": other.id, "is_guest": False}],
        },
        {
            "description": "Soda",
            "price": 300,
            "is_tax_tip": False,
            "assignments": [
                {"user_id": test_user.id, "is_guest": False},
                {"user_id": other.id, "is_guest": False},
            ],
        },
    ]
    update = _base_payload(
        test_user.id, group_id,
        amount=2700,
        split_type="ITEMIZED",
        splits=[
            {"user_id": test_user.id, "amount_owed": 0, "is_guest": False},
            {"user_id": other.id, "amount_owed": 0, "is_guest": False},
        ],
        items=new_items,
    )
    resp = _update_expense(client, auth_headers, created["id"], update)
    assert resp.status_code == 200
    # Amount should be recalculated: 1500+900+300 = 2700
    assert resp.json()["amount"] == 2700

    details = _get_expense(client, auth_headers, created["id"])
    assert len(details["items"]) == 3
    item_descs = {i["description"] for i in details["items"]}
    assert item_descs == {"Pizza", "Nachos", "Soda"}

    splits = {s["user_id"]: s["amount_owed"] for s in details["splits"]}
    # Pizza(1500) + Soda(150) = 1650 for test_user
    # Nachos(900) + Soda(150) = 1050 for other
    assert splits[test_user.id] == 1650
    assert splits[other.id] == 1050


# ---------------------------------------------------------------------------
# 7. Update ITEMIZED with tax/tip — proportional distribution
# ---------------------------------------------------------------------------

def test_update_itemized_expense_with_tax_tip(client, auth_headers, db_session, test_user):
    other = _make_user(db_session, "taxtip@example.com", "TaxTip")
    group_id = _create_group(client, auth_headers)
    _add_member(client, auth_headers, group_id, other.email)

    items = [
        {
            "description": "Steak",
            "price": 3000,
            "is_tax_tip": False,
            "assignments": [{"user_id": test_user.id, "is_guest": False}],
        },
        {
            "description": "Pasta",
            "price": 1000,
            "is_tax_tip": False,
            "assignments": [{"user_id": other.id, "is_guest": False}],
        },
        {
            "description": "Tax",
            "price": 400,
            "is_tax_tip": True,
            "assignments": [],
        },
    ]
    payload = _base_payload(
        test_user.id, group_id,
        amount=4400,
        split_type="ITEMIZED",
        splits=[
            {"user_id": test_user.id, "amount_owed": 0, "is_guest": False},
            {"user_id": other.id, "amount_owed": 0, "is_guest": False},
        ],
        items=items,
    )
    created = _create_expense(client, auth_headers, payload)

    # Update: raise tax to 800
    new_items = [
        {
            "description": "Steak",
            "price": 3000,
            "is_tax_tip": False,
            "assignments": [{"user_id": test_user.id, "is_guest": False}],
        },
        {
            "description": "Pasta",
            "price": 1000,
            "is_tax_tip": False,
            "assignments": [{"user_id": other.id, "is_guest": False}],
        },
        {
            "description": "Tax",
            "price": 800,
            "is_tax_tip": True,
            "assignments": [],
        },
    ]
    update = _base_payload(
        test_user.id, group_id,
        amount=4800,
        split_type="ITEMIZED",
        splits=[
            {"user_id": test_user.id, "amount_owed": 0, "is_guest": False},
            {"user_id": other.id, "amount_owed": 0, "is_guest": False},
        ],
        items=new_items,
    )
    resp = _update_expense(client, auth_headers, created["id"], update)
    assert resp.status_code == 200
    assert resp.json()["amount"] == 4800

    details = _get_expense(client, auth_headers, created["id"])
    splits = {s["user_id"]: s["amount_owed"] for s in details["splits"]}
    # Subtotals: test_user=3000, other=1000, total_regular=4000
    # Tax 800 proportional: test_user = int(3000/4000 * 800)=600, other gets remainder=200
    assert splits[test_user.id] == 3600
    assert splits[other.id] == 1200


# ---------------------------------------------------------------------------
# 8. Change split type: EQUAL -> EXACT
# ---------------------------------------------------------------------------

def test_change_split_type_equal_to_exact(client, auth_headers, db_session, test_user):
    other = _make_user(db_session, "eq2exact@example.com", "EqExact")
    group_id = _create_group(client, auth_headers)
    _add_member(client, auth_headers, group_id, other.email)

    payload = _base_payload(
        test_user.id, group_id,
        amount=2000,
        splits=[
            {"user_id": test_user.id, "amount_owed": 1000, "is_guest": False},
            {"user_id": other.id, "amount_owed": 1000, "is_guest": False},
        ],
    )
    created = _create_expense(client, auth_headers, payload)

    update = _base_payload(
        test_user.id, group_id,
        amount=2000,
        split_type="EXACT",
        splits=[
            {"user_id": test_user.id, "amount_owed": 500, "is_guest": False},
            {"user_id": other.id, "amount_owed": 1500, "is_guest": False},
        ],
    )
    resp = _update_expense(client, auth_headers, created["id"], update)
    assert resp.status_code == 200

    details = _get_expense(client, auth_headers, created["id"])
    assert details["split_type"] == "EXACT"
    splits = {s["user_id"]: s["amount_owed"] for s in details["splits"]}
    assert splits[test_user.id] == 500
    assert splits[other.id] == 1500


# ---------------------------------------------------------------------------
# 9. Change split type: EQUAL -> ITEMIZED
# ---------------------------------------------------------------------------

def test_change_split_type_equal_to_itemized(client, auth_headers, db_session, test_user):
    other = _make_user(db_session, "eq2item@example.com", "EqItem")
    group_id = _create_group(client, auth_headers)
    _add_member(client, auth_headers, group_id, other.email)

    payload = _base_payload(
        test_user.id, group_id,
        amount=2000,
        splits=[
            {"user_id": test_user.id, "amount_owed": 1000, "is_guest": False},
            {"user_id": other.id, "amount_owed": 1000, "is_guest": False},
        ],
    )
    created = _create_expense(client, auth_headers, payload)

    new_items = [
        {
            "description": "Item A",
            "price": 1200,
            "is_tax_tip": False,
            "assignments": [{"user_id": test_user.id, "is_guest": False}],
        },
        {
            "description": "Item B",
            "price": 800,
            "is_tax_tip": False,
            "assignments": [{"user_id": other.id, "is_guest": False}],
        },
    ]
    update = _base_payload(
        test_user.id, group_id,
        amount=2000,
        split_type="ITEMIZED",
        splits=[
            {"user_id": test_user.id, "amount_owed": 0, "is_guest": False},
            {"user_id": other.id, "amount_owed": 0, "is_guest": False},
        ],
        items=new_items,
    )
    resp = _update_expense(client, auth_headers, created["id"], update)
    assert resp.status_code == 200

    details = _get_expense(client, auth_headers, created["id"])
    assert details["split_type"] == "ITEMIZED"
    assert len(details["items"]) == 2

    splits = {s["user_id"]: s["amount_owed"] for s in details["splits"]}
    assert splits[test_user.id] == 1200
    assert splits[other.id] == 800


# ---------------------------------------------------------------------------
# 10. Change split type: ITEMIZED -> EQUAL
# ---------------------------------------------------------------------------

def test_change_split_type_itemized_to_equal(client, auth_headers, db_session, test_user):
    other = _make_user(db_session, "item2eq@example.com", "ItemEq")
    group_id = _create_group(client, auth_headers)
    _add_member(client, auth_headers, group_id, other.email)

    items = [
        {
            "description": "Tacos",
            "price": 1200,
            "is_tax_tip": False,
            "assignments": [{"user_id": test_user.id, "is_guest": False}],
        },
        {
            "description": "Burrito",
            "price": 800,
            "is_tax_tip": False,
            "assignments": [{"user_id": other.id, "is_guest": False}],
        },
    ]
    payload = _base_payload(
        test_user.id, group_id,
        amount=2000,
        split_type="ITEMIZED",
        splits=[
            {"user_id": test_user.id, "amount_owed": 0, "is_guest": False},
            {"user_id": other.id, "amount_owed": 0, "is_guest": False},
        ],
        items=items,
    )
    created = _create_expense(client, auth_headers, payload)

    # Switch to EQUAL
    update = _base_payload(
        test_user.id, group_id,
        amount=2000,
        split_type="EQUAL",
        splits=[
            {"user_id": test_user.id, "amount_owed": 1000, "is_guest": False},
            {"user_id": other.id, "amount_owed": 1000, "is_guest": False},
        ],
    )
    resp = _update_expense(client, auth_headers, created["id"], update)
    assert resp.status_code == 200

    details = _get_expense(client, auth_headers, created["id"])
    assert details["split_type"] == "EQUAL"
    # Items should be cleared (old items deleted, no new items)
    assert len(details["items"]) == 0
    splits = {s["user_id"]: s["amount_owed"] for s in details["splits"]}
    assert splits[test_user.id] == 1000
    assert splits[other.id] == 1000


# ---------------------------------------------------------------------------
# 11. Change payer to another group member
# ---------------------------------------------------------------------------

def test_update_expense_change_payer(client, auth_headers, db_session, test_user):
    other = _make_user(db_session, "newpayer@example.com", "NewPayer")
    group_id = _create_group(client, auth_headers)
    _add_member(client, auth_headers, group_id, other.email)

    payload = _base_payload(
        test_user.id, group_id,
        amount=2000,
        splits=[
            {"user_id": test_user.id, "amount_owed": 1000, "is_guest": False},
            {"user_id": other.id, "amount_owed": 1000, "is_guest": False},
        ],
    )
    created = _create_expense(client, auth_headers, payload)
    assert created["payer_id"] == test_user.id

    # Change payer
    update = payload.copy()
    update["payer_id"] = other.id
    resp = _update_expense(client, auth_headers, created["id"], update)
    assert resp.status_code == 200
    assert resp.json()["payer_id"] == other.id


# ---------------------------------------------------------------------------
# 12. Change payer to a guest member
# ---------------------------------------------------------------------------

def test_update_expense_change_payer_to_guest(client, auth_headers, db_session, test_user):
    group_id = _create_group(client, auth_headers)
    guest = _add_guest(client, auth_headers, group_id, "Guest Payer")

    payload = _base_payload(
        test_user.id, group_id,
        amount=2000,
        splits=[
            {"user_id": test_user.id, "amount_owed": 1000, "is_guest": False},
            {"user_id": guest["id"], "amount_owed": 1000, "is_guest": True},
        ],
    )
    created = _create_expense(client, auth_headers, payload)
    assert created["payer_is_guest"] is False

    # Change payer to guest
    update = payload.copy()
    update["payer_id"] = guest["id"]
    update["payer_is_guest"] = True
    resp = _update_expense(client, auth_headers, created["id"], update)
    assert resp.status_code == 200
    assert resp.json()["payer_id"] == guest["id"]
    assert resp.json()["payer_is_guest"] is True


# ---------------------------------------------------------------------------
# 13. Change currency — exchange rate updated (mocked)
# ---------------------------------------------------------------------------

def test_update_expense_change_currency(client, auth_headers, db_session, test_user):
    group_id = _create_group(client, auth_headers)

    with patch("routers.expenses.get_exchange_rate_for_expense") as mock_rate:
        # Initial creation in USD
        mock_rate.return_value = 1.0
        payload = _base_payload(
            test_user.id, group_id,
            amount=2000,
            currency="USD",
            splits=[{"user_id": test_user.id, "amount_owed": 2000, "is_guest": False}],
        )
        created = _create_expense(client, auth_headers, payload)
        assert created["exchange_rate"] == "1.0"

        # Update to EUR — mock returns a different rate
        mock_rate.return_value = 1.08
        update = payload.copy()
        update["currency"] = "EUR"
        resp = _update_expense(client, auth_headers, created["id"], update)
        assert resp.status_code == 200

        details = _get_expense(client, auth_headers, created["id"])
        assert details["currency"] == "EUR"
        assert details["exchange_rate"] == "1.08"
        # Verify mock was called with EUR
        mock_rate.assert_called_with(update["date"], "EUR")


# ---------------------------------------------------------------------------
# 14. Change date — exchange rate updated (mocked)
# ---------------------------------------------------------------------------

def test_update_expense_change_date(client, auth_headers, db_session, test_user):
    group_id = _create_group(client, auth_headers)

    with patch("routers.expenses.get_exchange_rate_for_expense") as mock_rate:
        mock_rate.return_value = 0.85
        payload = _base_payload(
            test_user.id, group_id,
            amount=1000,
            currency="EUR",
            splits=[{"user_id": test_user.id, "amount_owed": 1000, "is_guest": False}],
            expense_date="2025-01-01",
        )
        created = _create_expense(client, auth_headers, payload)

        # Change date
        mock_rate.return_value = 0.87
        update = payload.copy()
        update["date"] = "2025-06-15"
        resp = _update_expense(client, auth_headers, created["id"], update)
        assert resp.status_code == 200

        details = _get_expense(client, auth_headers, created["id"])
        assert details["date"] == "2025-06-15"
        assert details["exchange_rate"] == "0.87"
        mock_rate.assert_called_with("2025-06-15", "EUR")


# ---------------------------------------------------------------------------
# 15. Update expense with guest participants in splits
# ---------------------------------------------------------------------------

def test_update_expense_with_group_guest_participants(client, auth_headers, db_session, test_user):
    group_id = _create_group(client, auth_headers)
    guest = _add_guest(client, auth_headers, group_id, "Guest Split")

    payload = _base_payload(
        test_user.id, group_id,
        amount=3000,
        split_type="EXACT",
        splits=[
            {"user_id": test_user.id, "amount_owed": 2000, "is_guest": False},
            {"user_id": guest["id"], "amount_owed": 1000, "is_guest": True},
        ],
    )
    created = _create_expense(client, auth_headers, payload)

    # Update: change split amounts
    update = payload.copy()
    update["splits"] = [
        {"user_id": test_user.id, "amount_owed": 1500, "is_guest": False},
        {"user_id": guest["id"], "amount_owed": 1500, "is_guest": True},
    ]
    resp = _update_expense(client, auth_headers, created["id"], update)
    assert resp.status_code == 200

    details = _get_expense(client, auth_headers, created["id"])
    splits = {(s["user_id"], s["is_guest"]): s["amount_owed"] for s in details["splits"]}
    assert splits[(test_user.id, False)] == 1500
    assert splits[(guest["id"], True)] == 1500


# ---------------------------------------------------------------------------
# 16. Update ITEMIZED expense with guest item assignments
# ---------------------------------------------------------------------------

def test_update_itemized_expense_with_guest_assignments(client, auth_headers, db_session, test_user):
    group_id = _create_group(client, auth_headers)
    guest = _add_guest(client, auth_headers, group_id, "Guest Itemized")

    items = [
        {
            "description": "Ramen",
            "price": 1400,
            "is_tax_tip": False,
            "assignments": [{"user_id": test_user.id, "is_guest": False}],
        },
        {
            "description": "Gyoza",
            "price": 600,
            "is_tax_tip": False,
            "assignments": [{"user_id": guest["id"], "is_guest": True}],
        },
    ]
    payload = _base_payload(
        test_user.id, group_id,
        amount=2000,
        split_type="ITEMIZED",
        splits=[
            {"user_id": test_user.id, "amount_owed": 1400, "is_guest": False},
            {"user_id": guest["id"], "amount_owed": 600, "is_guest": True},
        ],
        items=items,
    )
    created = _create_expense(client, auth_headers, payload)

    # Update: reassign Ramen to guest, Gyoza shared
    new_items = [
        {
            "description": "Ramen",
            "price": 1400,
            "is_tax_tip": False,
            "assignments": [{"user_id": guest["id"], "is_guest": True}],
        },
        {
            "description": "Gyoza",
            "price": 600,
            "is_tax_tip": False,
            "assignments": [
                {"user_id": test_user.id, "is_guest": False},
                {"user_id": guest["id"], "is_guest": True},
            ],
        },
    ]
    update = _base_payload(
        test_user.id, group_id,
        amount=2000,
        split_type="ITEMIZED",
        splits=[
            {"user_id": test_user.id, "amount_owed": 0, "is_guest": False},
            {"user_id": guest["id"], "amount_owed": 0, "is_guest": True},
        ],
        items=new_items,
    )
    resp = _update_expense(client, auth_headers, created["id"], update)
    assert resp.status_code == 200

    details = _get_expense(client, auth_headers, created["id"])
    splits = {(s["user_id"], s["is_guest"]): s["amount_owed"] for s in details["splits"]}
    # test_user gets Gyoza share: 600//2 = 300
    # guest gets Ramen(1400) + Gyoza share(300) = 1700
    assert splits[(test_user.id, False)] == 300
    assert splits[(guest["id"], True)] == 1700


# ---------------------------------------------------------------------------
# 17. Unauthorized user cannot update
# ---------------------------------------------------------------------------

def test_update_expense_unauthorized_user(client, auth_headers, db_session, test_user):
    group_id = _create_group(client, auth_headers)

    payload = _base_payload(
        test_user.id, group_id,
        amount=1000,
        splits=[{"user_id": test_user.id, "amount_owed": 1000, "is_guest": False}],
    )
    created = _create_expense(client, auth_headers, payload)

    # Create a second user who is NOT a member of the group
    outsider = _make_user(db_session, "outsider@example.com", "Outsider")
    outsider_token = create_access_token(data={"sub": outsider.email})
    outsider_headers = {"Authorization": f"Bearer {outsider_token}"}

    update = payload.copy()
    update["description"] = "Hacked"
    resp = _update_expense(client, outsider_headers, created["id"], update)
    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# 18. Update nonexistent expense — 404
# ---------------------------------------------------------------------------

def test_update_nonexistent_expense(client, auth_headers, db_session, test_user):
    payload = _base_payload(
        test_user.id, None,
        amount=1000,
        splits=[{"user_id": test_user.id, "amount_owed": 1000, "is_guest": False}],
    )
    resp = _update_expense(client, auth_headers, 999999, payload)
    assert resp.status_code == 404
    assert "not found" in resp.json()["detail"].lower()
