.PHONY: test test-backend test-frontend

test: test-backend test-frontend

test-backend:
	cd backend && python -m pytest tests/ -v

test-frontend:
	cd frontend && npx vitest --run
