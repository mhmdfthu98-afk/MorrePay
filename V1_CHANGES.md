# MORRE PAY V1 — Secure Transfer Layer

## Implemented
- Removed client-side wallet creation with an initial 5,000 SDG balance.
- Wallet profile creation is handled by `initializeWallet` Cloud Function.
- Wallet-to-wallet transfers are handled only by `transferMoney` Cloud Function.
- Removed the old client-side `executeTransfer()` Firestore transaction.
- Client-side transfer now calls `functions.httpsCallable('transferMoney')` only.
- Server validates authentication, wallet number, amount, frozen status, balance, and idempotency.
- Server performs sender debit, receiver credit, transaction record, ledger entries, and notifications in one Firestore transaction.
- Duplicate client transaction IDs are idempotent only when the original request matches the same sender, receiver, and amount.
- Firestore rules deny direct client writes to balances, transactions, and ledger.
- Bank/mobile transfers remain disabled until a real provider/backend integration is added.

## Important
This is a development/test wallet architecture. It is not a licensed financial service and should not be used with real customer funds until legal, compliance, KYC/AML, payment-provider, monitoring, and production security requirements are completed.

## V1.2 - Deposit & Withdrawal Requests

- Added `createDepositRequest` callable function.
- Added `createWithdrawRequest` callable function.
- Added admin-only `approveDeposit` and `approveWithdraw` callable functions.
- Added server-managed `depositRequests` and `withdrawRequests` collections.
- Added atomic balance changes and ledger entries for approved requests.
- Added transaction records and user notifications for approved requests.
- Added frontend modal for submitting deposit/withdrawal requests.
- Client cannot directly write request documents or balances.
