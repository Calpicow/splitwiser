from pydantic import BaseModel, EmailStr, field_validator, Field
from typing import Optional, Dict, List
from datetime import datetime

from utils.currency import VALID_CURRENCIES

class UserBase(BaseModel):
    email: EmailStr
    full_name: Optional[str] = Field(None, max_length=100)

class UserCreate(UserBase):
    password: str = Field(..., min_length=8, max_length=128)
    claim_guest_id: Optional[int] = None
    share_link_id: Optional[str] = None

class User(UserBase):
    id: int
    is_active: bool

    class Config:
        from_attributes = True

class ExpenseSplitBase(BaseModel):
    user_id: int
    is_guest: bool = False
    amount_owed: int
    percentage: Optional[int] = None
    shares: Optional[int] = None

# Expense guest schemas (for non-group expenses)
class ExpenseGuestCreate(BaseModel):
    """Ad-hoc guest in expense creation request"""
    temp_id: str  # Client-generated temporary ID for item assignment reference
    name: str = Field(..., max_length=100)


class ExpenseGuestResponse(BaseModel):
    """Expense guest in response"""
    id: int
    expense_id: int
    name: str
    amount_owed: int
    paid: bool
    paid_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class ExpenseGuestPaidUpdate(BaseModel):
    """Request to update paid status"""
    paid: bool


# Itemized expense schemas
class ItemAssignment(BaseModel):
    user_id: Optional[int] = None
    is_guest: bool = False
    temp_guest_id: Optional[str] = None  # For ad-hoc expense guests (references temp_id)
    expense_guest_id: Optional[int] = None  # For existing expense guests (from edit flow)

class ItemSplitDetail(BaseModel):
    amount: Optional[int] = None  # For EXACT split (in cents)
    percentage: Optional[float] = None  # For PERCENTAGE split (0-100)
    shares: Optional[int] = None  # For SHARES split

class ExpenseItemCreate(BaseModel):
    description: str = Field(..., max_length=200)
    price: int  # In cents
    is_tax_tip: bool = False
    assignments: list[ItemAssignment] = []
    split_type: Optional[str] = 'EQUAL'  # EQUAL, EXACT, PERCENT, SHARES
    split_details: Optional[Dict[str, ItemSplitDetail]] = None  # Keyed by "user_{id}" or "guest_{id}"

class ExpenseItemAssignmentDetail(BaseModel):
    user_id: Optional[int] = None
    is_guest: bool = False
    expense_guest_id: Optional[int] = None
    user_name: str

class ExpenseItemDetail(BaseModel):
    id: int
    expense_id: int
    description: str
    price: int
    is_tax_tip: bool
    assignments: list[ExpenseItemAssignmentDetail]
    split_type: Optional[str] = 'EQUAL'
    split_details: Optional[Dict[str, Dict]] = None  # Deserialized from JSON

    class Config:
        from_attributes = True

class ExpenseCreate(BaseModel):
    description: str = Field(..., max_length=200)
    amount: int
    currency: str = Field("USD", min_length=3, max_length=3)
    date: str
    payer_id: int
    payer_is_guest: bool = False  # True if payer is a group guest
    payer_is_expense_guest: bool = False  # True if payer is an expense guest
    payer_temp_guest_id: Optional[str] = None  # Reference to expense guest temp_id if payer is expense guest
    group_id: Optional[int] = None
    splits: list[ExpenseSplitBase]
    split_type: str  # EQUAL, EXACT, PERCENT, SHARES, ITEMIZED
    items: Optional[list[ExpenseItemCreate]] = None  # Only for ITEMIZED type
    expense_guests: Optional[list[ExpenseGuestCreate]] = None  # For non-group expenses only
    icon: Optional[str] = Field(None, max_length=10)  # Optional emoji icon
    receipt_image_path: Optional[str] = None
    notes: Optional[str] = Field(None, max_length=1000)
    is_settlement: bool = False  # True if this is a payment/settlement

class Expense(BaseModel):
    id: int
    description: str
    amount: int
    currency: str
    date: str
    payer_id: int
    payer_is_guest: bool = False
    payer_is_expense_guest: bool = False
    group_id: Optional[int]
    created_by_id: Optional[int] = None
    exchange_rate: Optional[str] = None
    icon: Optional[str] = None
    receipt_image_path: Optional[str] = None
    notes: Optional[str] = None
    is_settlement: bool = False

    class Config:
        from_attributes = True

class ExpenseSplitDetail(BaseModel):
    id: int
    expense_id: int
    user_id: int
    is_guest: bool = False
    amount_owed: int
    percentage: Optional[int] = None
    shares: Optional[int] = None
    user_name: str

    class Config:
        from_attributes = True

class ExpenseWithSplits(Expense):
    splits: list[ExpenseSplitDetail]
    split_type: Optional[str] = None
    items: list[ExpenseItemDetail] = []  # Only populated for ITEMIZED type
    expense_guests: list[ExpenseGuestResponse] = []  # For non-group expenses with ad-hoc guests
    has_unknown_assignments: bool = False  # True if expense has items with no assignments (incomplete)
    exchange_rate_target_currency: Optional[str] = None  # Currency that exchange_rate is relative to (e.g., "USD" or group default)

class ExpenseUpdate(BaseModel):
    description: str = Field(..., max_length=200)
    amount: int
    currency: str = Field("USD", min_length=3, max_length=3)
    date: str
    payer_id: int
    payer_is_guest: bool = False
    payer_is_expense_guest: bool = False
    payer_temp_guest_id: Optional[str] = None
    splits: list[ExpenseSplitBase]
    split_type: str  # EQUAL, EXACT, PERCENT, SHARES, ITEMIZED
    items: Optional[list[ExpenseItemCreate]] = None  # Only for ITEMIZED type
    expense_guests: Optional[list[ExpenseGuestCreate]] = None  # For non-group expenses only
    icon: Optional[str] = Field(None, max_length=10)  # Optional emoji icon
    receipt_image_path: Optional[str] = None
    notes: Optional[str] = Field(None, max_length=1000)
    is_settlement: bool = False

class Token(BaseModel):
    access_token: str
    token_type: str
    refresh_token: str
    claimed_group_id: Optional[int] = None

class TokenData(BaseModel):
    email: Optional[str] = None

class GroupBase(BaseModel):
    name: str = Field(..., max_length=100)
    default_currency: str = Field("USD", min_length=3, max_length=3)
    icon: Optional[str] = Field(None, max_length=10)

    @field_validator('default_currency')
    @classmethod
    def validate_currency(cls, v):
        if v not in VALID_CURRENCIES:
            raise ValueError(f'Currency must be one of {VALID_CURRENCIES}')
        return v

class GroupCreate(GroupBase):
    pass

class Group(GroupBase):
    id: int
    created_by_id: int
    share_link_id: Optional[str] = None
    is_public: bool = False

    class Config:
        from_attributes = True

class FriendAddRequest(BaseModel):
    """Request to add friend by email (legacy)."""
    email: EmailStr


# Friend Request Schemas (for request/approval workflow)
class FriendRequestCreate(BaseModel):
    """Request to send a friend request by user ID."""
    user_id: int


class FriendRequestResponse(BaseModel):
    """Friend request with user info."""
    id: int
    from_user_id: int
    from_user_name: str
    from_user_email: str
    to_user_id: int
    to_user_name: str
    to_user_email: str
    status: str  # pending, accepted, rejected
    created_at: str

    class Config:
        from_attributes = True


class FriendshipStatus(BaseModel):
    """Status of relationship between current user and another user."""
    user_id: int
    full_name: str
    email: str
    status: str  # "friends", "pending_incoming", "pending_outgoing", "none"
    request_id: Optional[int] = None  # If pending, the request ID


class PendingRequestCount(BaseModel):
    """Count of pending incoming friend requests."""
    count: int


class Friend(BaseModel):
    id: int
    full_name: str
    email: str

    class Config:
        from_attributes = True

class GroupMemberAdd(BaseModel):
    email: EmailStr

class GroupMember(BaseModel):
    id: int
    user_id: int
    full_name: str
    email: str
    managed_by_id: Optional[int] = None
    managed_by_type: Optional[str] = None
    managed_by_name: Optional[str] = None

    class Config:
        from_attributes = True

class PublicGroupMember(BaseModel):
    id: int
    user_id: int
    full_name: str
    # email: str  <-- Removed for privacy
    managed_by_id: Optional[int] = None
    managed_by_type: Optional[str] = None
    managed_by_name: Optional[str] = None

    class Config:
        from_attributes = True

class GuestMemberCreate(BaseModel):
    name: str = Field(..., max_length=100)

class GuestMember(BaseModel):
    id: int
    group_id: int
    name: str
    created_by_id: int
    claimed_by_id: Optional[int] = None
    managed_by_id: Optional[int] = None
    managed_by_type: Optional[str] = None  # 'user' or 'guest'
    managed_by_name: Optional[str] = None

    class Config:
        from_attributes = True

class GroupUpdate(BaseModel):
    name: str = Field(..., max_length=100)
    default_currency: str = Field("USD", min_length=3, max_length=3)
    icon: Optional[str] = Field(None, max_length=10)

    @field_validator('default_currency')
    @classmethod
    def validate_currency(cls, v):
        if v not in VALID_CURRENCIES:
            raise ValueError(f'Currency must be one of {VALID_CURRENCIES}')
        return v

class GroupWithMembers(Group):
    members: list[GroupMember]
    guests: list[GuestMember] = []

    class Config:
        from_attributes = True

class PublicGroupWithMembers(Group):
    members: list[PublicGroupMember]
    guests: list[GuestMember] = []

    class Config:
        from_attributes = True

class GroupBalance(BaseModel):
    user_id: int
    is_guest: bool = False
    full_name: str
    amount: float
    currency: str
    managed_guests: list[str] = []  # Names of managed guests included in this balance


# Request/Response models previously inline in main.py
class RefreshTokenRequest(BaseModel):
    refresh_token: str


class ManageGuestRequest(BaseModel):
    user_id: int
    is_guest: bool = False  # Set to True if manager is a guest


class Balance(BaseModel):
    """Balance representing what a user owes or is owed."""
    user_id: int
    full_name: str
    amount: float  # Positive means you are owed, negative means you owe
    currency: str
    is_guest: bool = False
    group_name: Optional[str] = None
    group_id: Optional[int] = None


class FriendBalance(BaseModel):
    """Balance between current user and a specific friend."""
    amount: float  # Positive = friend owes you, negative = you owe friend
    currency: str


class FriendExpenseWithSplits(ExpenseWithSplits):
    """Expense with group name and balance impact for friend detail page."""
    group_name: Optional[str] = None
    balance_impact: Optional[int] = None  # Balance impact in cents: positive = friend owes you, negative = you owe friend


# Profile Management and Password Recovery Schemas
from datetime import datetime

class PasswordChangeRequest(BaseModel):
    """Request to change password (requires current password)"""
    current_password: str = Field(..., max_length=128)
    new_password: str = Field(..., min_length=8, max_length=128)


class ForgotPasswordRequest(BaseModel):
    """Request to send password reset email"""
    email: EmailStr


class ResetPasswordRequest(BaseModel):
    """Request to reset password with token"""
    token: str
    new_password: str = Field(..., min_length=8, max_length=128)


class ProfileUpdateRequest(BaseModel):
    """Request to update user profile"""
    full_name: Optional[str] = Field(None, max_length=100)
    email: Optional[EmailStr] = None
    default_currency: Optional[str] = Field(None, min_length=3, max_length=3)

    @field_validator('default_currency')
    @classmethod
    def validate_currency(cls, v):
        if v is None:
            return v
        if v not in VALID_CURRENCIES:
            raise ValueError(f'Currency must be one of {VALID_CURRENCIES}')
        return v


class VerifyEmailRequest(BaseModel):
    """Request to verify new email address"""
    token: str


class UserProfile(BaseModel):
    """Extended user profile with security metadata"""
    id: int
    email: str
    full_name: str
    is_active: bool
    email_verified: bool
    password_changed_at: Optional[datetime] = None
    last_login_at: Optional[datetime] = None
    default_currency: str = "USD"

    class Config:
        from_attributes = True


# OCR / Receipt Scanning schemas
class ReceiptScanItem(BaseModel):
    """Single item extracted from a receipt by the LLM."""
    description: str
    price: int  # Total line price in cents
    quantity: int = 1


class ReceiptScanResponse(BaseModel):
    """Response from LLM-based receipt scanning."""
    items: list[ReceiptScanItem]
    tax: Optional[int] = None  # Cents
    tip: Optional[int] = None  # Cents
    total: Optional[int] = None  # Cents
    receipt_image_path: str


# Google OAuth Schemas
class GoogleAuthRequest(BaseModel):
    """Request body for Google OAuth authentication."""
    id_token: str  # The ID token from Google Sign-In
    claim_guest_id: Optional[int] = None  # For guest claiming during OAuth registration
    share_link_id: Optional[str] = None


class GoogleAuthResponse(BaseModel):
    """Response for successful Google OAuth."""
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    is_new_user: bool  # True if a new account was created
    claimed_group_id: Optional[int] = None
    account_linked: bool = False  # True if Google was linked to existing account


class GoogleLinkRequest(BaseModel):
    """Request to link Google account to existing user."""
    id_token: str


class SetPasswordRequest(BaseModel):
    """Request to set password for OAuth-only users."""
    new_password: str = Field(..., min_length=8, max_length=128)
