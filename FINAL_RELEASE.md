# MORRE PAY — FINAL RELEASE

## Included
- Phone + SMS OTP authentication with Sudan number normalization.
- Optional KYC; account access does not depend on KYC approval.
- Wallet creation and unique 6-digit wallet ID.
- Server-authoritative wallet transfers with atomic balance updates, fees, idempotency and ledger records.
- Incoming/outgoing transaction history with compact amounts and detailed operation receipt.
- Receipt printing and native device sharing (image + text).
- Deposits and withdrawals through admin-reviewed requests.
- Payment requests: create, accept/pay, reject, cancel, expiry and history.
- Wallet QR generation, QR sharing, camera scanning and manual QR fallback.
- Favorite beneficiaries and quick transfer.
- Profile/account-name management.
- Financial statistics.
- Notifications and optional FCM web push registration.
- Security center: device sessions, revoke one/all other sessions, heartbeat and freeze/unfreeze controls.
- Optional KYC document workflow with admin-only temporary signed access.
- Admin dashboard: overview, users, transactions, pending deposits/withdrawals, KYC, broadcasts and account controls.
- Firestore/Storage rules and indexes included.

## Security model
Money movement, request state changes, admin actions and KYC access are Cloud Function controlled. Client-side UI is not trusted for authorization.

## Deployment
1. `firebase deploy --only hosting,functions,firestore:rules,firestore:indexes,storage`
2. Configure Firebase Phone Auth and authorized domains.
3. Set web push VAPID key in `index.html` if FCM web push is required.
4. Verify the admin phone in `functions/index.js` before production use.
5. Run a real-money-free test pass before production.
