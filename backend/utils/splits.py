"""Split calculation utilities for itemized expenses."""

from typing import Dict, Tuple
import schemas


def get_assignment_key(assignment: schemas.ItemAssignment) -> str:
    """Get a unique key for an assignment (user, group guest, or expense guest)."""
    if assignment.temp_guest_id:
        return f"expense_guest_{assignment.temp_guest_id}"
    elif assignment.expense_guest_id:
        return f"expense_guest_{assignment.expense_guest_id}"
    elif assignment.is_guest:
        return f"guest_{assignment.user_id}"
    else:
        return f"user_{assignment.user_id}"


def calculate_itemized_splits(items: list[schemas.ExpenseItemCreate]) -> list[schemas.ExpenseSplitBase]:
    """
    Calculate each person's share based on assigned items.

    Algorithm:
    1. Sum each person's assigned items (shared items split equally)
    2. Calculate subtotal for all non-tax/tip items
    3. Distribute tax/tip proportionally to each person's subtotal
    4. Return final splits
    """
    # Track each person's subtotal (key: "user_<id>" or "guest_<id>")
    person_subtotals = {}

    # Separate regular items from tax/tip
    regular_items = [i for i in items if not i.is_tax_tip]
    tax_tip_items = [i for i in items if i.is_tax_tip]

    # Process regular items
    for item in regular_items:
        if not item.assignments:
            continue

        split_type = getattr(item, 'split_type', 'EQUAL')
        split_details = getattr(item, 'split_details', {}) or {}

        if split_type == 'EQUAL' or len(item.assignments) == 1:
            # Equal split among assignees (or single assignee gets everything)
            num_assignees = len(item.assignments)
            share_per_person = item.price // num_assignees
            remainder = item.price % num_assignees

            for idx, assignment in enumerate(item.assignments):
                key = f"{'guest' if assignment.is_guest else 'user'}_{assignment.user_id}"
                # First assignee gets the remainder cents
                amount = share_per_person + (1 if idx < remainder else 0)
                person_subtotals[key] = person_subtotals.get(key, 0) + amount

        elif split_type == 'EXACT':
            # Use exact amounts specified
            for assignment in item.assignments:
                key = f"{'guest' if assignment.is_guest else 'user'}_{assignment.user_id}"
                detail = split_details.get(key, {})
                # Handle both dict and ItemSplitDetail object
                if hasattr(detail, 'amount'):
                    amount = detail.amount or 0
                elif isinstance(detail, dict):
                    amount = detail.get('amount', 0)
                else:
                    amount = 0
                person_subtotals[key] = person_subtotals.get(key, 0) + amount

        elif split_type == 'PERCENT':
            # Use percentages specified
            remaining = item.price
            sorted_assignments = sorted(item.assignments, key=lambda a: f"{'guest' if a.is_guest else 'user'}_{a.user_id}")

            for idx, assignment in enumerate(sorted_assignments):
                key = f"{'guest' if assignment.is_guest else 'user'}_{assignment.user_id}"
                detail = split_details.get(key, {})
                # Handle both dict and ItemSplitDetail object
                if hasattr(detail, 'percentage'):
                    percentage = detail.percentage or 0
                elif isinstance(detail, dict):
                    percentage = detail.get('percentage', 0)
                else:
                    percentage = 0

                if idx == len(sorted_assignments) - 1:
                    # Last person gets remainder
                    amount = remaining
                else:
                    amount = int(item.price * (percentage / 100))
                    remaining -= amount

                person_subtotals[key] = person_subtotals.get(key, 0) + amount

        elif split_type == 'SHARES':
            # Calculate based on shares
            total_shares = 0
            for assignment in item.assignments:
                key = f"{'guest' if assignment.is_guest else 'user'}_{assignment.user_id}"
                detail = split_details.get(key, {})
                # Handle both dict and ItemSplitDetail object
                if hasattr(detail, 'shares'):
                    shares = detail.shares or 1
                elif isinstance(detail, dict):
                    shares = detail.get('shares', 1)
                else:
                    shares = 1
                total_shares += shares

            if total_shares > 0:
                remaining = item.price
                sorted_assignments = sorted(item.assignments, key=lambda a: f"{'guest' if a.is_guest else 'user'}_{a.user_id}")

                for idx, assignment in enumerate(sorted_assignments):
                    key = f"{'guest' if assignment.is_guest else 'user'}_{assignment.user_id}"
                    detail = split_details.get(key, {})
                    # Handle both dict and ItemSplitDetail object
                    if hasattr(detail, 'shares'):
                        shares = detail.shares or 1
                    elif isinstance(detail, dict):
                        shares = detail.get('shares', 1)
                    else:
                        shares = 1

                    if idx == len(sorted_assignments) - 1:
                        # Last person gets remainder
                        amount = remaining
                    else:
                        amount = int((item.price * shares) / total_shares)
                        remaining -= amount

                    person_subtotals[key] = person_subtotals.get(key, 0) + amount

    # Calculate total of regular items for proportional distribution
    regular_total = sum(person_subtotals.values())
    tax_tip_total = sum(i.price for i in tax_tip_items)

    # Distribute tax/tip proportionally
    person_totals = {}
    remaining_tax_tip = tax_tip_total

    sorted_keys = sorted(person_subtotals.keys())
    for idx, key in enumerate(sorted_keys):
        subtotal = person_subtotals[key]
        person_totals[key] = subtotal

        if regular_total > 0 and tax_tip_total > 0:
            if idx == len(sorted_keys) - 1:
                # Last person gets remainder to avoid rounding errors
                tax_tip_share = remaining_tax_tip
            else:
                tax_tip_share = int((subtotal / regular_total) * tax_tip_total)
                remaining_tax_tip -= tax_tip_share

            person_totals[key] += tax_tip_share

    # Convert to ExpenseSplitBase list
    splits = []
    for key, amount in person_totals.items():
        is_guest = key.startswith("guest_")
        user_id = int(key.split("_")[1])
        splits.append(schemas.ExpenseSplitBase(
            user_id=user_id,
            is_guest=is_guest,
            amount_owed=amount
        ))

    return splits


def calculate_itemized_splits_with_expense_guests(
    items: list[schemas.ExpenseItemCreate]
) -> Tuple[list[schemas.ExpenseSplitBase], Dict[str, int]]:
    """
    Calculate each person's share based on assigned items, supporting expense guests.

    Returns:
        - List of ExpenseSplitBase for registered users and group guests
        - Dict mapping temp_guest_id to amount_owed for expense guests
    """
    # Track each person's subtotal (key: "user_<id>", "guest_<id>", or "expense_guest_<temp_id>")
    person_subtotals = {}

    # Separate regular items from tax/tip
    regular_items = [i for i in items if not i.is_tax_tip]
    tax_tip_items = [i for i in items if i.is_tax_tip]

    # Process regular items
    for item in regular_items:
        if not item.assignments:
            continue

        split_type = getattr(item, 'split_type', 'EQUAL')
        split_details = getattr(item, 'split_details', {}) or {}

        if split_type == 'EQUAL' or len(item.assignments) == 1:
            # Equal split among assignees (or single assignee gets everything)
            num_assignees = len(item.assignments)
            share_per_person = item.price // num_assignees
            remainder = item.price % num_assignees

            for idx, assignment in enumerate(item.assignments):
                key = get_assignment_key(assignment)
                # First assignee gets the remainder cents
                amount = share_per_person + (1 if idx < remainder else 0)
                person_subtotals[key] = person_subtotals.get(key, 0) + amount

        elif split_type == 'EXACT':
            # Use exact amounts specified
            for assignment in item.assignments:
                key = get_assignment_key(assignment)
                detail = split_details.get(key, {})
                if hasattr(detail, 'amount'):
                    amount = detail.amount or 0
                elif isinstance(detail, dict):
                    amount = detail.get('amount', 0)
                else:
                    amount = 0
                person_subtotals[key] = person_subtotals.get(key, 0) + amount

        elif split_type == 'PERCENT':
            # Use percentages specified
            remaining = item.price
            sorted_assignments = sorted(item.assignments, key=lambda a: get_assignment_key(a))

            for idx, assignment in enumerate(sorted_assignments):
                key = get_assignment_key(assignment)
                detail = split_details.get(key, {})
                if hasattr(detail, 'percentage'):
                    percentage = detail.percentage or 0
                elif isinstance(detail, dict):
                    percentage = detail.get('percentage', 0)
                else:
                    percentage = 0

                if idx == len(sorted_assignments) - 1:
                    amount = remaining
                else:
                    amount = int(item.price * (percentage / 100))
                    remaining -= amount

                person_subtotals[key] = person_subtotals.get(key, 0) + amount

        elif split_type == 'SHARES':
            # Calculate based on shares
            total_shares = 0
            for assignment in item.assignments:
                key = get_assignment_key(assignment)
                detail = split_details.get(key, {})
                if hasattr(detail, 'shares'):
                    shares = detail.shares or 1
                elif isinstance(detail, dict):
                    shares = detail.get('shares', 1)
                else:
                    shares = 1
                total_shares += shares

            if total_shares > 0:
                remaining = item.price
                sorted_assignments = sorted(item.assignments, key=lambda a: get_assignment_key(a))

                for idx, assignment in enumerate(sorted_assignments):
                    key = get_assignment_key(assignment)
                    detail = split_details.get(key, {})
                    if hasattr(detail, 'shares'):
                        shares = detail.shares or 1
                    elif isinstance(detail, dict):
                        shares = detail.get('shares', 1)
                    else:
                        shares = 1

                    if idx == len(sorted_assignments) - 1:
                        amount = remaining
                    else:
                        amount = int((item.price * shares) / total_shares)
                        remaining -= amount

                    person_subtotals[key] = person_subtotals.get(key, 0) + amount

    # Calculate total of regular items for proportional distribution
    regular_total = sum(person_subtotals.values())
    tax_tip_total = sum(i.price for i in tax_tip_items)

    # Distribute tax/tip proportionally
    person_totals = {}
    remaining_tax_tip = tax_tip_total

    sorted_keys = sorted(person_subtotals.keys())
    for idx, key in enumerate(sorted_keys):
        subtotal = person_subtotals[key]
        person_totals[key] = subtotal

        if regular_total > 0 and tax_tip_total > 0:
            if idx == len(sorted_keys) - 1:
                tax_tip_share = remaining_tax_tip
            else:
                tax_tip_share = int((subtotal / regular_total) * tax_tip_total)
                remaining_tax_tip -= tax_tip_share

            person_totals[key] += tax_tip_share

    # Separate into user/group guest splits and expense guest amounts
    splits = []
    expense_guest_amounts = {}

    for key, amount in person_totals.items():
        if key.startswith("expense_guest_"):
            # Expense guest - extract temp_id
            temp_id = key.replace("expense_guest_", "")
            expense_guest_amounts[temp_id] = amount
        elif key.startswith("guest_"):
            # Group guest
            user_id = int(key.split("_")[1])
            splits.append(schemas.ExpenseSplitBase(
                user_id=user_id,
                is_guest=True,
                amount_owed=amount
            ))
        else:
            # Registered user
            user_id = int(key.split("_")[1])
            splits.append(schemas.ExpenseSplitBase(
                user_id=user_id,
                is_guest=False,
                amount_owed=amount
            ))

    return splits, expense_guest_amounts
