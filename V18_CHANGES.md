# MORRE PAY V18 — QR Wallet Transfer

- Added a native wallet QR page that generates a MORRE PAY wallet QR payload (`MORREPAY|WALLET|<6-digit-wallet>`).
- Added camera QR scanner using html5-qrcode with manual input fallback.
- Scanned wallet is verified server-side through `lookupWalletRecipient` before transfer.
- Added recipient confirmation screen showing name and wallet ID before transfer.
- Added QR sharing through the native Android share sheet.
- Preserved existing V17 payment requests, transaction security, receipt sharing, and admin features.
