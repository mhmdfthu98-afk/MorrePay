# MORRE PAY — Admin Dashboard V2

## What changed
- Admin dashboard no longer depends on direct client Firestore reads/writes for sensitive admin operations.
- Added secure callable functions for admin overview, users, transactions, KYC, deposit requests, withdrawal requests, rejection, and broadcast notifications.
- Added audit logs for sensitive admin actions.
- Added pending deposit/withdrawal tabs with approve/reject controls.
- Money approval/rejection remains server-side and uses Firebase Admin SDK.
- Added `firestore.indexes.json` for filtered admin queries.
- Added `bootstrapAdmin` for one-time admin claim initialization.

## First admin setup
1. Copy `functions/.env.example` to `functions/.env`.
2. Put the first admin's exact Firebase Auth email in `BOOTSTRAP_ADMIN_EMAIL`.
3. Deploy functions.
4. Sign in with that account.
5. From the app, call the `bootstrapAdmin` callable once (this can later be exposed as a hidden setup button).
6. Sign out and sign back in so the new custom claim is present in the ID token.

The backend checks `request.auth.token.admin == true` for admin access.

## Deploy
```bash
firebase deploy --only functions,firestore
```

## Important
- Never commit `functions/.env`.
- Do not give arbitrary users a way to set the `admin` claim.
- App Check should be enabled/enforced before production.
