"""
Splitwiser Backend API

A FastAPI backend for expense splitting and group management.
This module sets up the app and mounts routers - all endpoint logic is in routers/.
"""

import os
from pathlib import Path
from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parent.parent / ".env")
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

import models
from database import engine

# Import routers
from routers import auth, groups, members, expenses, balances, friends, ocr, profile, password_recovery, oauth


# Create database tables
models.Base.metadata.create_all(bind=engine)

# Create receipts directory if not exists
DATA_DIR = os.getenv("DATA_DIR", "data")
RECEIPT_DIR = os.path.join(DATA_DIR, "receipts")
os.makedirs(RECEIPT_DIR, exist_ok=True)

# Initialize FastAPI app
app = FastAPI(
    title="Splitwiser API",
    description="API for expense splitting and group management",
    version="1.0.0"
)

# Mount static files for receipts
app.mount("/static/receipts", StaticFiles(directory=RECEIPT_DIR), name="receipts")

# Security Headers Middleware
@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)

    # Content Security Policy
    # - default-src 'none': Secure default
    # - script-src: Allow self and Swagger UI CDN
    # - style-src: Allow self, Swagger UI CDN, and unsafe-inline (needed for Swagger)
    # - img-src: Allow self, data: (base64), and fastapi CDN
    csp_policy = (
        "default-src 'none'; "
        "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
        "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
        "img-src 'self' data: https://fastapi.tiangolo.com; "
        "connect-src 'self'; "
        "frame-ancestors 'none'; "
        "form-action 'self';"
    )

    response.headers["Content-Security-Policy"] = csp_policy
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["X-XSS-Protection"] = "1; mode=block"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"

    return response

# CORS middleware configuration
# In production: set BACKEND_CORS_ORIGINS to restrict allowed origins
# In development (SPLITWISER_DEV=true): allows all origins for easier testing
if os.getenv("BACKEND_CORS_ORIGINS"):
    # Production: use explicit origins from environment
    origins = [origin.strip() for origin in os.getenv("BACKEND_CORS_ORIGINS").split(",")]
else:
    # Development: allow all origins for network access testing
    origins = ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(auth.router)
app.include_router(oauth.router)
app.include_router(profile.router)
app.include_router(password_recovery.router)
app.include_router(groups.router)
app.include_router(members.router)
app.include_router(expenses.router)
app.include_router(balances.router)
app.include_router(friends.router)
app.include_router(ocr.router)
