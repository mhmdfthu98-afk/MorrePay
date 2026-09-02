# MORRE PAY V1

MORRE PAY V1 is a Firebase-based wallet prototype using HTML/CSS/JavaScript on the client and Firebase Cloud Functions + Firestore on the backend.

## Current architecture
- Firebase Authentication: identity
- Firestore: wallet/profile data and transaction history
- Cloud Functions: trusted money-movement layer
- Firestore Security Rules: client access control
- Hosting: static web client

## Money movement
Wallet-to-wallet transfers must call the callable Cloud Function `transferMoney`.
The browser must never update `users.balance`, `transactions`, or `ledger` directly.

The transfer function validates the authenticated caller, amount, receiver wallet, wallet status, available balance and idempotency key, then performs the debit/credit and audit records atomically in a Firestore transaction.

## Deploy
From the project root after authenticating with Firebase CLI:

```bash
firebase login
firebase use <your-project-id>
firebase deploy --only functions,firestore:rules,hosting
```

Install function dependencies first:

```bash
cd functions
npm install
cd ..
```

## Test checklist
1. Create a new Firebase Auth account.
2. Confirm the profile is created with balance `0`.
3. Confirm a wallet-to-wallet transfer calls `transferMoney`.
4. Confirm the sender balance decreases by amount + fee.
5. Confirm the receiver balance increases by amount only.
6. Confirm one transaction and two ledger entries are created.
7. Confirm sender and receiver notifications are created.
8. Try a direct browser write to `users.balance` and verify permission denied.
9. Try a direct browser write to `transactions` and verify permission denied.
10. Repeat the same `clientTransactionId` and verify no second transfer occurs.

## V1.2

Deposit and withdrawal are now request-based. A user submits a request from the web UI; only an authenticated admin can approve it through Cloud Functions. Approval updates the wallet, transaction history, ledger, and notification atomically.

Before production: configure Firebase App Check and a real regulated payment provider. Callable functions automatically carry Auth and App Check tokens when available; Firebase recommends App Check enforcement before launch.
