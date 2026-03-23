import pytest
from pydantic import ValidationError
from schemas import UserCreate, ExpenseCreate, GroupCreate, ExpenseSplitBase

def test_user_create_validation():
    long_string = "a" * 10001
    valid_string = "a" * 10

    # Test valid user
    UserCreate(email="test@example.com", password=valid_string, full_name=valid_string)

    # Test long full_name
    with pytest.raises(ValidationError) as excinfo:
        UserCreate(email="test@example.com", password=valid_string, full_name=long_string)
    assert "String should have at most 100 characters" in str(excinfo.value)

    # Test long password
    with pytest.raises(ValidationError) as excinfo:
        UserCreate(email="test@example.com", password=long_string, full_name=valid_string)
    assert "String should have at most 128 characters" in str(excinfo.value)

    # Test short password
    with pytest.raises(ValidationError) as excinfo:
        UserCreate(email="test@example.com", password="short", full_name=valid_string)
    assert "String should have at least 8 characters" in str(excinfo.value)

def test_expense_create_validation():
    long_string = "a" * 10001
    split = ExpenseSplitBase(user_id=1, amount_owed=100)

    # Test long description
    with pytest.raises(ValidationError) as excinfo:
        ExpenseCreate(
            description=long_string,
            amount=100,
            date="2023-01-01",
            payer_id=1,
            splits=[split],
            split_type="EQUAL"
        )
    assert "String should have at most 200 characters" in str(excinfo.value)

    # Test long currency
    with pytest.raises(ValidationError) as excinfo:
        ExpenseCreate(
            description="Valid",
            amount=100,
            currency="USDD", # 4 chars
            date="2023-01-01",
            payer_id=1,
            splits=[split],
            split_type="EQUAL"
        )
    assert "String should have at most 3 characters" in str(excinfo.value)

    # Test long notes
    with pytest.raises(ValidationError) as excinfo:
        ExpenseCreate(
            description="Valid",
            amount=100,
            date="2023-01-01",
            payer_id=1,
            splits=[split],
            split_type="EQUAL",
            notes=long_string
        )
    assert "String should have at most 1000 characters" in str(excinfo.value)

def test_group_create_validation():
    long_string = "a" * 10001

    # Test long name
    with pytest.raises(ValidationError) as excinfo:
        GroupCreate(name=long_string)
    assert "String should have at most 100 characters" in str(excinfo.value)
