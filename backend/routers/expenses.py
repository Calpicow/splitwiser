"""Expenses router: create, read, update, delete expenses."""

from typing import Annotated
import os
import json
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

import models
import schemas
from database import get_db
from dependencies import get_current_user
from utils.validation import get_group_or_404, verify_group_membership, validate_expense_participants, validate_item_split_details
from utils.splits import calculate_itemized_splits, calculate_itemized_splits_with_expense_guests
from utils.currency import get_exchange_rate_for_expense, fetch_historical_exchange_rate
from utils.display import get_guest_display_name


# Receipt directory path (must match main.py)
DATA_DIR = os.getenv("DATA_DIR", "data")
RECEIPT_DIR = os.path.join(DATA_DIR, "receipts")


router = APIRouter(tags=["expenses"])


def normalize_date(date_str: str) -> str:
    """Normalize date string to YYYY-MM-DD format for consistent sorting."""
    if not date_str:
        return date_str
    # If it's already YYYY-MM-DD format, return as-is
    if len(date_str) == 10 and date_str[4] == '-' and date_str[7] == '-':
        return date_str
    # Handle ISO format with time component (e.g., 2025-12-27T00:00:00.000Z)
    if 'T' in date_str:
        return date_str.split('T')[0]
    return date_str


@router.post("/expenses", response_model=schemas.Expense)
def create_expense(
    expense: schemas.ExpenseCreate,
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(get_db)
):
    # Validate: expense guests only allowed for non-group expenses
    if expense.group_id is not None and expense.expense_guests:
        raise HTTPException(
            status_code=400,
            detail="Expense guests can only be added to expenses outside of a group"
        )

    # Fetch and cache the historical exchange rate for this expense
    exchange_rate = get_exchange_rate_for_expense(expense.date, expense.currency)

    # Create the expense first to get an ID
    db_expense = models.Expense(
        description=expense.description,
        amount=expense.amount,
        currency=expense.currency,
        date=normalize_date(expense.date),
        payer_id=expense.payer_id,  # Will be updated if payer is expense guest
        payer_is_guest=expense.payer_is_guest,
        payer_is_expense_guest=expense.payer_is_expense_guest,
        group_id=expense.group_id,
        created_by_id=current_user.id,
        exchange_rate=str(exchange_rate),
        split_type=expense.split_type or "EQUAL",
        icon=expense.icon,
        receipt_image_path=expense.receipt_image_path,
        notes=expense.notes,
        is_settlement=expense.is_settlement
    )
    db.add(db_expense)
    db.flush()  # Get expense ID without committing

    # Create expense guests and build temp_id mapping
    temp_id_to_expense_guest = {}
    expense_guest_amounts = {}  # Will be populated by itemized calculation

    if expense.expense_guests:
        for guest_data in expense.expense_guests:
            expense_guest = models.ExpenseGuest(
                expense_id=db_expense.id,
                name=guest_data.name,
                amount_owed=0,  # Will be calculated later
                created_by_id=current_user.id,
            )
            db.add(expense_guest)
            db.flush()  # Get expense_guest.id
            temp_id_to_expense_guest[guest_data.temp_id] = expense_guest

    # Resolve payer if it's an expense guest
    if expense.payer_is_expense_guest and expense.payer_temp_guest_id:
        payer_expense_guest = temp_id_to_expense_guest.get(expense.payer_temp_guest_id)
        if not payer_expense_guest:
            raise HTTPException(status_code=400, detail="Invalid payer temp_guest_id")
        db_expense.payer_id = payer_expense_guest.id

    # Handle ITEMIZED split type with expense guests
    if expense.split_type == "ITEMIZED":
        if not expense.items:
            raise HTTPException(status_code=400, detail="Items required for ITEMIZED split type")

        # Check if any items have expense guest assignments
        has_expense_guests = any(
            a.temp_guest_id for item in expense.items for a in item.assignments
        )

        if has_expense_guests or expense.expense_guests:
            # Use the new function that handles expense guests
            calculated_splits, expense_guest_amounts = calculate_itemized_splits_with_expense_guests(expense.items)
        else:
            # Use the original function
            calculated_splits = calculate_itemized_splits(expense.items)

        # Save provided participants before merging
        provided_participants = {
            f"{'guest' if s.is_guest else 'user'}_{s.user_id}": s
            for s in (expense.splits or [])
        }

        calculated_keys = {
            f"{'guest' if s.is_guest else 'user'}_{s.user_id}"
            for s in calculated_splits
        }

        # Merge: calculated splits + provided participants without items (with 0 amount)
        for key, split in provided_participants.items():
            if key not in calculated_keys:
                calculated_splits.append(schemas.ExpenseSplitBase(
                    user_id=split.user_id,
                    is_guest=split.is_guest,
                    amount_owed=0
                ))

        expense.splits = calculated_splits

        # Recalculate total from items
        expense.amount = sum(item.price for item in expense.items)
        db_expense.amount = expense.amount

    # Validate total amount vs splits (excluding expense guest amounts)
    total_split = sum(split.amount_owed for split in expense.splits)
    total_expense_guest = sum(expense_guest_amounts.values())
    total_all_participants = total_split + total_expense_guest

    if expense.split_type == "ITEMIZED":
        if total_all_participants > expense.amount:
            raise HTTPException(
                status_code=400,
                detail=f"Split amounts exceed total expense amount. Total: {expense.amount}, Sum: {total_all_participants}"
            )
    else:
        if abs(total_split - expense.amount) > 1:  # Allow 1 cent diff
            raise HTTPException(
                status_code=400,
                detail=f"Split amounts do not sum to total expense amount. Total: {expense.amount}, Sum: {total_split}"
            )

    # Validate all participants exist and are authorized (skip expense guest validation since they're newly created)
    validate_expense_participants(
        db=db,
        payer_id=expense.payer_id if not expense.payer_is_expense_guest else current_user.id,
        payer_is_guest=expense.payer_is_guest if not expense.payer_is_expense_guest else False,
        splits=expense.splits,
        items=expense.items if expense.split_type == "ITEMIZED" else None,
        skip_expense_guest_validation=True,
        group_id=expense.group_id,
        current_user_id=current_user.id
    )

    # Validate item split details if itemized expense
    if expense.split_type == "ITEMIZED" and expense.items:
        validate_item_split_details(expense.items)

    # Create splits for registered users and group guests
    for split in expense.splits:
        db_split = models.ExpenseSplit(
            expense_id=db_expense.id,
            user_id=split.user_id,
            is_guest=split.is_guest,
            amount_owed=split.amount_owed,
            percentage=split.percentage,
            shares=split.shares
        )
        db.add(db_split)

    # Update expense guest amounts
    for temp_id, amount in expense_guest_amounts.items():
        expense_guest = temp_id_to_expense_guest.get(temp_id)
        if expense_guest:
            expense_guest.amount_owed = amount

    # Store items if ITEMIZED
    if expense.split_type == "ITEMIZED" and expense.items:
        for item in expense.items:
            # Serialize split_details to JSON if present
            split_details_json = None
            if hasattr(item, 'split_details') and item.split_details:
                # Convert ItemSplitDetail objects to dict if needed
                split_details_dict = {}
                for key, value in item.split_details.items():
                    if hasattr(value, 'dict'):
                        split_details_dict[key] = value.dict()
                    else:
                        split_details_dict[key] = value
                split_details_json = json.dumps(split_details_dict)

            db_item = models.ExpenseItem(
                expense_id=db_expense.id,
                description=item.description,
                price=item.price,
                is_tax_tip=item.is_tax_tip,
                split_type=getattr(item, 'split_type', 'EQUAL'),
                split_details=split_details_json
            )
            db.add(db_item)
            db.flush()

            # Store assignments
            for assignment in item.assignments:
                if assignment.temp_guest_id:
                    # Expense guest assignment
                    expense_guest = temp_id_to_expense_guest.get(assignment.temp_guest_id)
                    if expense_guest:
                        db_assignment = models.ExpenseItemAssignment(
                            expense_item_id=db_item.id,
                            user_id=None,
                            is_guest=False,
                            expense_guest_id=expense_guest.id
                        )
                        db.add(db_assignment)
                else:
                    # Regular user or group guest assignment
                    db_assignment = models.ExpenseItemAssignment(
                        expense_item_id=db_item.id,
                        user_id=assignment.user_id,
                        is_guest=assignment.is_guest,
                        expense_guest_id=None
                    )
                    db.add(db_assignment)

    db.commit()
    db.refresh(db_expense)
    return db_expense


@router.get("/expenses", response_model=list[schemas.Expense])
def read_expenses(
    current_user: Annotated[models.User, Depends(get_current_user)], 
    db: Session = Depends(get_db)
):
    # Return expenses where user is involved (payer or splitter)
    subquery = db.query(models.ExpenseSplit.expense_id).filter(
        models.ExpenseSplit.user_id == current_user.id
    ).subquery()

    expenses = db.query(models.Expense).filter(
        (models.Expense.payer_id == current_user.id) |
        (models.Expense.id.in_(subquery))
    ).all()

    return expenses


@router.get("/expenses/{expense_id}", response_model=schemas.ExpenseWithSplits)
def get_expense(
    expense_id: int, 
    current_user: Annotated[models.User, Depends(get_current_user)], 
    db: Session = Depends(get_db)
):
    expense = db.query(models.Expense).filter(models.Expense.id == expense_id).first()
    if not expense:
        raise HTTPException(status_code=404, detail="Expense not found")

    # Verify user has access (is payer, in splits, or in the same group)
    splits = db.query(models.ExpenseSplit).filter(models.ExpenseSplit.expense_id == expense_id).all()
    split_user_ids = [s.user_id for s in splits if not s.is_guest]

    has_access = (
        (expense.payer_id == current_user.id and not expense.payer_is_guest) or
        current_user.id in split_user_ids or
        (expense.group_id and db.query(models.GroupMember).filter(
            models.GroupMember.group_id == expense.group_id,
            models.GroupMember.user_id == current_user.id
        ).first())
    )

    if not has_access:
        raise HTTPException(status_code=403, detail="You don't have access to this expense")

    # Build splits with user names
    splits_with_names = []
    for split in splits:
        if split.is_guest:
            guest = db.query(models.GuestMember).filter(models.GuestMember.id == split.user_id).first()
            user_name = guest.name if guest else "Unknown Guest"
        else:
            user = db.query(models.User).filter(models.User.id == split.user_id).first()
            user_name = (user.full_name or user.email) if user else "Unknown User"

        splits_with_names.append(schemas.ExpenseSplitDetail(
            id=split.id,
            expense_id=split.expense_id,
            user_id=split.user_id,
            is_guest=split.is_guest,
            amount_owed=split.amount_owed,
            percentage=split.percentage,
            shares=split.shares,
            user_name=user_name
        ))

    # Use the stored split_type from the expense
    split_type = expense.split_type or "EQUAL"

    # Load items for ITEMIZED expenses
    items_data = []
    if split_type == "ITEMIZED":
        expense_items = db.query(models.ExpenseItem).filter(
            models.ExpenseItem.expense_id == expense_id
        ).all()

        if expense_items:
            item_ids = [item.id for item in expense_items]

            # Batch fetch all assignments
            all_assignments = db.query(models.ExpenseItemAssignment).filter(
                models.ExpenseItemAssignment.expense_item_id.in_(item_ids)
            ).all()

            # Collect IDs for batch fetching
            user_ids = set()
            guest_ids = set()
            expense_guest_ids = set()
            assignments_by_item = {}

            for a in all_assignments:
                if a.expense_item_id not in assignments_by_item:
                    assignments_by_item[a.expense_item_id] = []
                assignments_by_item[a.expense_item_id].append(a)

                if a.expense_guest_id:
                    expense_guest_ids.add(a.expense_guest_id)
                elif a.is_guest:
                    guest_ids.add(a.user_id)
                elif a.user_id:
                    user_ids.add(a.user_id)

            # Batch fetch related records
            users = {}
            if user_ids:
                user_records = db.query(models.User).filter(models.User.id.in_(user_ids)).all()
                users = {u.id: u for u in user_records}

            guests = {}
            if guest_ids:
                guest_records = db.query(models.GuestMember).filter(models.GuestMember.id.in_(guest_ids)).all()
                guests = {g.id: g for g in guest_records}

                # Fetch users claimed by guests (to avoid N+1 in get_guest_display_name)
                claimed_user_ids = {g.claimed_by_id for g in guest_records if g.claimed_by_id}
                missing_claimed_ids = claimed_user_ids - set(users.keys())
                if missing_claimed_ids:
                    claimed_users = db.query(models.User).filter(models.User.id.in_(missing_claimed_ids)).all()
                    for u in claimed_users:
                        users[u.id] = u

            expense_guests = {}
            if expense_guest_ids:
                eg_records = db.query(models.ExpenseGuest).filter(models.ExpenseGuest.id.in_(expense_guest_ids)).all()
                expense_guests = {eg.id: eg for eg in eg_records}

            for item in expense_items:
                assignments = assignments_by_item.get(item.id, [])
                assignment_details = []

                for a in assignments:
                    if a.expense_guest_id:
                        # Expense guest assignment
                        expense_guest = expense_guests.get(a.expense_guest_id)
                        name = expense_guest.name if expense_guest else "Unknown Guest"
                        assignment_details.append(schemas.ExpenseItemAssignmentDetail(
                            user_id=None,
                            is_guest=False,
                            expense_guest_id=a.expense_guest_id,
                            user_name=name
                        ))
                    elif a.is_guest:
                        guest = guests.get(a.user_id)
                        # Manual implementation of get_guest_display_name logic using pre-fetched data
                        if guest:
                            if guest.claimed_by_id and guest.claimed_by_id in users:
                                claimed_user = users[guest.claimed_by_id]
                                name = (claimed_user.full_name or claimed_user.email)
                            else:
                                name = guest.name
                        else:
                            name = "Unknown Guest"

                        assignment_details.append(schemas.ExpenseItemAssignmentDetail(
                            user_id=a.user_id,
                            is_guest=a.is_guest,
                            expense_guest_id=None,
                            user_name=name
                        ))
                    else:
                        user = users.get(a.user_id)
                        name = (user.full_name or user.email) if user else "Unknown"
                        assignment_details.append(schemas.ExpenseItemAssignmentDetail(
                            user_id=a.user_id,
                            is_guest=a.is_guest,
                            expense_guest_id=None,
                            user_name=name
                        ))

                # Deserialize split_details from JSON if present
                split_details = None
                if item.split_details:
                    try:
                        split_details = json.loads(item.split_details)
                    except json.JSONDecodeError:
                        split_details = None

                items_data.append(schemas.ExpenseItemDetail(
                    id=item.id,
                    expense_id=item.expense_id,
                    description=item.description,
                    price=item.price,
                    is_tax_tip=item.is_tax_tip,
                    assignments=assignment_details,
                    split_type=item.split_type or 'EQUAL',
                    split_details=split_details
                ))

    # Calculate display exchange rate relative to group's default currency
    display_exchange_rate = expense.exchange_rate
    exchange_rate_target_currency = "USD"  # Default to USD

    if expense.group_id and expense.exchange_rate:
        group = db.query(models.Group).filter(models.Group.id == expense.group_id).first()
        if group and group.default_currency != "USD":
            # Calculate exchange rate from expense.currency to group.default_currency
            # expense.exchange_rate is expense.currency to USD
            # We need expense.currency to group.default_currency
            try:
                expense_to_usd = float(expense.exchange_rate)

                # Fetch historical USD to group.default_currency rate
                usd_to_group_currency = fetch_historical_exchange_rate(
                    expense.date.split('T')[0],  # Use date portion only
                    "USD",
                    group.default_currency
                )

                if usd_to_group_currency is not None:
                    # Calculate: expense.currency to group.default_currency
                    display_rate = expense_to_usd * usd_to_group_currency
                    display_exchange_rate = f"{display_rate:.6f}".rstrip('0').rstrip('.')
                    exchange_rate_target_currency = group.default_currency
            except (ValueError, TypeError):
                # If calculation fails, keep the original USD rate
                pass

    # Load expense guests for non-group expenses
    expense_guests_data = []
    if expense.group_id is None:
        expense_guests = db.query(models.ExpenseGuest).filter(
            models.ExpenseGuest.expense_id == expense_id
        ).all()
        expense_guests_data = [
            schemas.ExpenseGuestResponse(
                id=eg.id,
                expense_id=eg.expense_id,
                name=eg.name,
                amount_owed=eg.amount_owed,
                paid=eg.paid,
                paid_at=eg.paid_at
            )
            for eg in expense_guests
        ]

    return schemas.ExpenseWithSplits(
        id=expense.id,
        description=expense.description,
        amount=expense.amount,
        currency=expense.currency,
        date=expense.date,
        payer_id=expense.payer_id,
        payer_is_guest=expense.payer_is_guest,
        payer_is_expense_guest=expense.payer_is_expense_guest,
        group_id=expense.group_id,
        created_by_id=expense.created_by_id,
        splits=splits_with_names,
        split_type=split_type,
        items=items_data,
        expense_guests=expense_guests_data,
        exchange_rate=display_exchange_rate,
        exchange_rate_target_currency=exchange_rate_target_currency,
        icon=expense.icon,
        receipt_image_path=expense.receipt_image_path,
        notes=expense.notes,
        is_settlement=expense.is_settlement
    )


@router.put("/expenses/{expense_id}", response_model=schemas.Expense)
def update_expense(
    expense_id: int, 
    expense_update: schemas.ExpenseUpdate, 
    current_user: Annotated[models.User, Depends(get_current_user)], 
    db: Session = Depends(get_db)
):
    expense = db.query(models.Expense).filter(models.Expense.id == expense_id).first()
    if not expense:
        raise HTTPException(status_code=404, detail="Expense not found")

    # Verify user is a member of the group (all group members can edit expenses)
    if expense.group_id:
        verify_group_membership(db, expense.group_id, current_user.id)
    else:
        # For non-group expenses, only the creator can edit
        if expense.created_by_id != current_user.id:
            raise HTTPException(status_code=403, detail="Only the expense creator can edit this expense")

    # Initialize expense guest amounts (will be populated by itemized calculation if needed)
    expense_guest_amounts = {}
    # Mapping from temp_id to existing ExpenseGuest DB records (for updates with expense guests)
    temp_id_to_expense_guest = {}

    # Handle ITEMIZED split type
    if expense_update.split_type == "ITEMIZED":
        if not expense_update.items:
            raise HTTPException(status_code=400, detail="Items required for ITEMIZED split type")

        # Save provided participants before calculating (to preserve participants without items)
        provided_participants = {
            f"{'guest' if s.is_guest else 'user'}_{s.user_id}": s
            for s in (expense_update.splits or [])
        }

        # Check if any items have expense guest assignments or if expense has existing expense guests
        has_expense_guests = any(
            (a.temp_guest_id or a.expense_guest_id) for item in expense_update.items for a in item.assignments
        )
        existing_expense_guests = db.query(models.ExpenseGuest).filter(
            models.ExpenseGuest.expense_id == expense_id
        ).all()

        if has_expense_guests or existing_expense_guests:
            # Build a mapping from temp_id to existing expense guest DB records
            # by matching names from the update payload to existing DB records
            temp_id_to_expense_guest = {}
            if expense_update.expense_guests:
                eg_by_name = {eg.name: eg for eg in existing_expense_guests}
                for guest_data in expense_update.expense_guests:
                    matched_eg = eg_by_name.get(guest_data.name)
                    if matched_eg:
                        temp_id_to_expense_guest[guest_data.temp_id] = matched_eg

            # Use the function that handles expense guests
            calculated_splits, expense_guest_amounts = calculate_itemized_splits_with_expense_guests(expense_update.items)
        else:
            # Use the original function
            calculated_splits = calculate_itemized_splits(expense_update.items)

        calculated_keys = {
            f"{'guest' if s.is_guest else 'user'}_{s.user_id}"
            for s in calculated_splits
        }

        # Merge: calculated splits + provided participants without items (with 0 amount)
        for key, split in provided_participants.items():
            if key not in calculated_keys:
                calculated_splits.append(schemas.ExpenseSplitBase(
                    user_id=split.user_id,
                    is_guest=split.is_guest,
                    amount_owed=0
                ))

        expense_update.splits = calculated_splits

        # Recalculate total from items
        expense_update.amount = sum(item.price for item in expense_update.items)

    # Validate total amount vs splits
    total_split = sum(split.amount_owed for split in expense_update.splits)
    total_expense_guest = sum(expense_guest_amounts.values())
    total_all_participants = total_split + total_expense_guest
    # For itemized expenses, allow splits to be less than total (unassigned items absorbed by payer)
    if expense_update.split_type == "ITEMIZED":
        if total_all_participants > expense_update.amount:
            raise HTTPException(
                status_code=400,
                detail=f"Split amounts exceed total expense amount. Total: {expense_update.amount}, Sum: {total_all_participants}"
            )
    else:
        if abs(total_split - expense_update.amount) > 1:
            raise HTTPException(
                status_code=400,
                detail=f"Split amounts do not sum to total expense amount. Total: {expense_update.amount}, Sum: {total_split}"
            )

    # Validate all participants exist and are authorized
    # Skip expense guest validation since they use temp_guest_id references
    validate_expense_participants(
        db=db,
        payer_id=expense_update.payer_id,
        payer_is_guest=expense_update.payer_is_guest,
        splits=expense_update.splits,
        items=expense_update.items if expense_update.split_type == "ITEMIZED" else None,
        skip_expense_guest_validation=bool(temp_id_to_expense_guest),
        group_id=expense.group_id,
        current_user_id=current_user.id
    )

    # Validate item split details if itemized expense
    if expense_update.split_type == "ITEMIZED" and expense_update.items:
        validate_item_split_details(expense_update.items)

    # Update expense fields
    # Normalize the date first for accurate comparison
    normalized_update_date = normalize_date(expense_update.date)

    # Check if date or currency changed, if so update exchange rate
    if expense.date != normalized_update_date or expense.currency != expense_update.currency:
        new_rate = get_exchange_rate_for_expense(normalized_update_date, expense_update.currency)
        expense.exchange_rate = str(new_rate)

    expense.description = expense_update.description
    expense.amount = expense_update.amount
    expense.currency = expense_update.currency
    expense.date = normalized_update_date
    expense.payer_id = expense_update.payer_id
    expense.payer_is_guest = expense_update.payer_is_guest
    expense.split_type = expense_update.split_type or "EQUAL"
    expense.icon = expense_update.icon
    expense.notes = expense_update.notes
    expense.is_settlement = expense_update.is_settlement
    if expense_update.receipt_image_path is not None:
        expense.receipt_image_path = expense_update.receipt_image_path

    # Delete old items and assignments first
    old_items = db.query(models.ExpenseItem).filter(
        models.ExpenseItem.expense_id == expense_id
    ).all()
    for old_item in old_items:
        db.query(models.ExpenseItemAssignment).filter(
            models.ExpenseItemAssignment.expense_item_id == old_item.id
        ).delete()
    db.query(models.ExpenseItem).filter(
        models.ExpenseItem.expense_id == expense_id
    ).delete()

    # Delete old splits
    db.query(models.ExpenseSplit).filter(models.ExpenseSplit.expense_id == expense_id).delete()

    # Create new splits
    for split in expense_update.splits:
        db_split = models.ExpenseSplit(
            expense_id=expense_id,
            user_id=split.user_id,
            is_guest=split.is_guest,
            amount_owed=split.amount_owed,
            percentage=split.percentage,
            shares=split.shares
        )
        db.add(db_split)

    # Update expense guest amounts from itemized calculation
    if expense_guest_amounts:
        for temp_id, amount in expense_guest_amounts.items():
            # First check the temp_id mapping
            if temp_id in temp_id_to_expense_guest:
                temp_id_to_expense_guest[temp_id].amount_owed = amount
            else:
                # Fall back to looking up by stringified DB ID
                try:
                    eg_id = int(temp_id)
                    eg = db.query(models.ExpenseGuest).filter(
                        models.ExpenseGuest.expense_id == expense_id,
                        models.ExpenseGuest.id == eg_id
                    ).first()
                    if eg:
                        eg.amount_owed = amount
                except (ValueError, TypeError):
                    pass

    # Create new items if ITEMIZED
    if expense_update.split_type == "ITEMIZED" and expense_update.items:
        for item in expense_update.items:
            # Serialize split_details to JSON if present
            split_details_json = None
            if hasattr(item, 'split_details') and item.split_details:
                # Convert ItemSplitDetail objects to dict if needed
                split_details_dict = {}
                for key, value in item.split_details.items():
                    if hasattr(value, 'dict'):
                        split_details_dict[key] = value.dict()
                    else:
                        split_details_dict[key] = value
                split_details_json = json.dumps(split_details_dict)

            db_item = models.ExpenseItem(
                expense_id=expense_id,
                description=item.description,
                price=item.price,
                is_tax_tip=item.is_tax_tip,
                split_type=getattr(item, 'split_type', 'EQUAL'),
                split_details=split_details_json
            )
            db.add(db_item)
            db.flush()
            db.refresh(db_item)

            # Store assignments
            for assignment in item.assignments:
                # Check if this is an expense guest assignment (via expense_guest_id or temp_guest_id)
                if assignment.expense_guest_id:
                    # Direct expense guest ID from edit flow
                    db_assignment = models.ExpenseItemAssignment(
                        expense_item_id=db_item.id,
                        user_id=None,
                        is_guest=False,
                        expense_guest_id=assignment.expense_guest_id
                    )
                    db.add(db_assignment)
                elif hasattr(assignment, 'temp_guest_id') and assignment.temp_guest_id:
                    # Look up the actual expense guest
                    expense_guest = None
                    # First check the temp_id mapping (built from expense_guests in update payload)
                    if assignment.temp_guest_id in temp_id_to_expense_guest:
                        expense_guest = temp_id_to_expense_guest[assignment.temp_guest_id]
                    else:
                        # Try to parse as integer ID (for updates where temp_guest_id is stringified DB ID)
                        try:
                            eg_id = int(assignment.temp_guest_id)
                            expense_guest = db.query(models.ExpenseGuest).filter(
                                models.ExpenseGuest.expense_id == expense_id,
                                models.ExpenseGuest.id == eg_id
                            ).first()
                        except (ValueError, TypeError):
                            pass
                    if expense_guest:
                        db_assignment = models.ExpenseItemAssignment(
                            expense_item_id=db_item.id,
                            user_id=None,
                            is_guest=False,
                            expense_guest_id=expense_guest.id
                        )
                        db.add(db_assignment)
                else:
                    # Regular user or group guest assignment
                    # For existing expense guests, user_id will contain the expense_guest.id
                    # and we need to check if it matches an expense guest
                    expense_guest = None
                    if not assignment.is_guest and assignment.user_id:
                        expense_guest = db.query(models.ExpenseGuest).filter(
                            models.ExpenseGuest.expense_id == expense_id,
                            models.ExpenseGuest.id == assignment.user_id
                        ).first()

                    if expense_guest:
                        # This is an expense guest assignment
                        db_assignment = models.ExpenseItemAssignment(
                            expense_item_id=db_item.id,
                            user_id=None,
                            is_guest=False,
                            expense_guest_id=expense_guest.id
                        )
                    else:
                        # Regular user or group guest
                        db_assignment = models.ExpenseItemAssignment(
                            expense_item_id=db_item.id,
                            user_id=assignment.user_id,
                            is_guest=assignment.is_guest,
                            expense_guest_id=None
                        )
                    db.add(db_assignment)

    db.commit()
    db.refresh(expense)
    return expense


@router.delete("/expenses/{expense_id}")
def delete_expense(
    expense_id: int, 
    current_user: Annotated[models.User, Depends(get_current_user)], 
    db: Session = Depends(get_db)
):
    expense = db.query(models.Expense).filter(models.Expense.id == expense_id).first()
    if not expense:
        raise HTTPException(status_code=404, detail="Expense not found")

    # Verify user is a member of the group (all group members can delete expenses)
    if expense.group_id:
        verify_group_membership(db, expense.group_id, current_user.id)
    else:
        # For non-group expenses, only the creator can delete
        if expense.created_by_id != current_user.id:
            raise HTTPException(status_code=403, detail="Only the expense creator can delete this expense")

    # Delete item assignments first
    items = db.query(models.ExpenseItem).filter(
        models.ExpenseItem.expense_id == expense_id
    ).all()
    for item in items:
        db.query(models.ExpenseItemAssignment).filter(
            models.ExpenseItemAssignment.expense_item_id == item.id
        ).delete()

    # Delete items
    db.query(models.ExpenseItem).filter(
        models.ExpenseItem.expense_id == expense_id
    ).delete()

    # Delete associated splits
    db.query(models.ExpenseSplit).filter(models.ExpenseSplit.expense_id == expense_id).delete()

    # Delete expense guests
    db.query(models.ExpenseGuest).filter(models.ExpenseGuest.expense_id == expense_id).delete()

    # Delete receipt image if exists
    if expense.receipt_image_path:
        try:
            filename = os.path.basename(expense.receipt_image_path)
            file_path = os.path.join(RECEIPT_DIR, filename)
            
            if os.path.exists(file_path):
                os.remove(file_path)
                print(f"Deleted receipt image: {file_path}")
        except Exception as e:
            print(f"Error deleting receipt image {expense.receipt_image_path}: {e}")

    # Delete the expense
    db.delete(expense)
    db.commit()

    return {"message": "Expense deleted successfully"}


@router.get("/groups/{group_id}/expenses", response_model=list[schemas.ExpenseWithSplits])
def get_group_expenses(
    group_id: int,
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(get_db)
):
    group = get_group_or_404(db, group_id)
    verify_group_membership(db, group_id, current_user.id)

    # 1. Fetch all expenses
    expenses = db.query(models.Expense).filter(
        models.Expense.group_id == group_id
    ).order_by(models.Expense.date.desc(), models.Expense.id.desc()).all()

    if not expenses:
        return []

    expense_ids = [e.id for e in expenses]

    # For ITEMIZED expenses, check which ones have items with no assignments (incomplete)
    itemized_expense_ids = [e.id for e in expenses if e.split_type == "ITEMIZED"]
    expenses_with_unassigned = set()

    if itemized_expense_ids:
        # Get all non-tax/tip items for itemized expenses
        items = db.query(models.ExpenseItem).filter(
            models.ExpenseItem.expense_id.in_(itemized_expense_ids),
            models.ExpenseItem.is_tax_tip == False
        ).all()

        if items:
            item_ids = [i.id for i in items]

            # Get all assignments for these items
            all_assignments = db.query(models.ExpenseItemAssignment).filter(
                models.ExpenseItemAssignment.expense_item_id.in_(item_ids)
            ).all()

            # Group assignments by item_id
            assignments_by_item = {}
            for assignment in all_assignments:
                if assignment.expense_item_id not in assignments_by_item:
                    assignments_by_item[assignment.expense_item_id] = []
                assignments_by_item[assignment.expense_item_id].append(assignment)

            # Check which items have no assignments
            for item in items:
                if item.id not in assignments_by_item or len(assignments_by_item[item.id]) == 0:
                    expenses_with_unassigned.add(item.expense_id)

    # 2. Fetch all splits for these expenses
    all_splits = db.query(models.ExpenseSplit).filter(
        models.ExpenseSplit.expense_id.in_(expense_ids)
    ).all()

    # Group splits by expense_id
    splits_by_expense = {}
    user_ids = set()
    guest_ids = set()

    for split in all_splits:
        if split.expense_id not in splits_by_expense:
            splits_by_expense[split.expense_id] = []
        splits_by_expense[split.expense_id].append(split)

        if split.is_guest:
            guest_ids.add(split.user_id)
        else:
            user_ids.add(split.user_id)

    # 3. Batch fetch users and guests
    users = {}
    if user_ids:
        user_records = db.query(models.User).filter(models.User.id.in_(user_ids)).all()
        users = {u.id: u for u in user_records}

    guests = {}
    if guest_ids:
        guest_records = db.query(models.GuestMember).filter(models.GuestMember.id.in_(guest_ids)).all()
        guests = {g.id: g for g in guest_records}

    # Optimization: Batch fetch users who claimed guests to avoid N+1 queries
    claimed_user_ids = {g.claimed_by_id for g in guests.values() if g.claimed_by_id}
    # Only fetch users we haven't already fetched
    missing_claimed_ids = claimed_user_ids - set(users.keys())

    if missing_claimed_ids:
        claimed_users = db.query(models.User).filter(models.User.id.in_(missing_claimed_ids)).all()
        for u in claimed_users:
            users[u.id] = u

    # 4. Assemble the result
    result = []
    for expense in expenses:
        expense_splits = splits_by_expense.get(expense.id, [])

        # Build splits with user names
        splits_with_names = []
        for split in expense_splits:
            if split.is_guest:
                guest = guests.get(split.user_id)
                if guest:
                    # Optimized: Use pre-fetched users dictionary instead of querying DB
                    if guest.claimed_by_id and guest.claimed_by_id in users:
                        claimed_user = users[guest.claimed_by_id]
                        user_name = (claimed_user.full_name or claimed_user.email)
                    else:
                        user_name = guest.name
                else:
                    user_name = "Unknown Guest"
            else:
                user = users.get(split.user_id)
                user_name = (user.full_name or user.email) if user else "Unknown User"

            splits_with_names.append(schemas.ExpenseSplitDetail(
                id=split.id,
                expense_id=split.expense_id,
                user_id=split.user_id,
                is_guest=split.is_guest,
                amount_owed=split.amount_owed,
                percentage=split.percentage,
                shares=split.shares,
                user_name=user_name
            ))

        # Calculate display exchange rate relative to group's default currency
        display_exchange_rate = expense.exchange_rate
        exchange_rate_target_currency = "USD"  # Default to USD

        if expense.exchange_rate and group.default_currency != "USD":
            try:
                expense_to_usd = float(expense.exchange_rate)
                # Fetch historical USD to group.default_currency rate
                usd_to_group_currency = fetch_historical_exchange_rate(
                    expense.date.split('T')[0],
                    "USD",
                    group.default_currency
                )
                if usd_to_group_currency is not None:
                    display_rate = expense_to_usd * usd_to_group_currency
                    display_exchange_rate = f"{display_rate:.6f}".rstrip('0').rstrip('.')
                    exchange_rate_target_currency = group.default_currency
            except (ValueError, TypeError):
                pass

        expense_dict = {
            "id": expense.id,
            "description": expense.description,
            "amount": expense.amount,
            "currency": expense.currency,
            "date": expense.date,
            "payer_id": expense.payer_id,
            "payer_is_guest": expense.payer_is_guest,
            "payer_is_expense_guest": getattr(expense, 'payer_is_expense_guest', False),
            "group_id": expense.group_id,
            "created_by_id": expense.created_by_id,
            "split_type": expense.split_type,
            "splits": splits_with_names,
            "items": [],
            "expense_guests": [],
            "exchange_rate": display_exchange_rate,
            "exchange_rate_target_currency": exchange_rate_target_currency,
            "icon": expense.icon,
            "notes": expense.notes,
            "is_settlement": expense.is_settlement,
            "has_unknown_assignments": expense.id in expenses_with_unassigned
        }
        result.append(expense_dict)

    return result


@router.patch("/expenses/{expense_id}/guests/{guest_id}/paid", response_model=schemas.ExpenseGuestResponse)
def toggle_expense_guest_paid(
    expense_id: int,
    guest_id: int,
    paid_update: schemas.ExpenseGuestPaidUpdate,
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(get_db)
):
    """Toggle the paid status of an expense guest."""
    # Get the expense
    expense = db.query(models.Expense).filter(models.Expense.id == expense_id).first()
    if not expense:
        raise HTTPException(status_code=404, detail="Expense not found")

    # Verify this is a non-group expense
    if expense.group_id is not None:
        raise HTTPException(status_code=400, detail="Expense guests are only for non-group expenses")

    # Verify user has access (must be the expense creator)
    if expense.created_by_id != current_user.id:
        raise HTTPException(status_code=403, detail="Only the expense creator can update guest paid status")

    # Get the expense guest
    expense_guest = db.query(models.ExpenseGuest).filter(
        models.ExpenseGuest.id == guest_id,
        models.ExpenseGuest.expense_id == expense_id
    ).first()
    if not expense_guest:
        raise HTTPException(status_code=404, detail="Expense guest not found")

    # Update paid status
    expense_guest.paid = paid_update.paid
    expense_guest.paid_at = datetime.utcnow() if paid_update.paid else None

    db.commit()
    db.refresh(expense_guest)

    return schemas.ExpenseGuestResponse(
        id=expense_guest.id,
        expense_id=expense_guest.expense_id,
        name=expense_guest.name,
        amount_owed=expense_guest.amount_owed,
        paid=expense_guest.paid,
        paid_at=expense_guest.paid_at
    )
