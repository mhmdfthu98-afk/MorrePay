# MORRE PAY — Transaction Notifications V1

- Incoming transactions appear with a green `+` amount.
- Outgoing transactions appear with a red `-` amount.
- The transaction history includes both sender and receiver operations.
- Clicking a transaction opens a secure transaction-detail notification styled like the supplied bank notification screenshot.
- Transfer sender and receiver notifications share the same `transactionId` and `reference`.
- Deposit/withdraw approval notifications include the exact transaction reference.
- Deposit/withdraw request creation also creates an in-app notification.
- Transaction details are loaded through the protected `getTransactionReceipt` callable function.
