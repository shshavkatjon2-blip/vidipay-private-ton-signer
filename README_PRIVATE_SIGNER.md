# VidiPay TON Remote Signer

Run this only on a private server/VPS that can safely store TON wallet private key JSON files.

Do not upload real signer key JSON files to public GitHub.

## Env

```env
PORT=10000
SIGNER_TOKEN=CREATE_LONG_RANDOM_TOKEN
TON_SIGNER_NETWORK=mainnet
TON_SIGNER_KEYS_DIR=/opt/vidipay-secure/ton-signer-keys
TON_RPC_ENDPOINT=https://toncenter.com/api/v2/jsonRPC
TON_RPC_API_KEY=REAL_TONCENTER_KEY
TON_PAYOUT_GAS_RESERVE=0.10
TON_PAYOUT_BODY=VidiPay activation payout
```

## Backend Env

In `vidipay-backend` Render env:

```env
TON_REMOTE_SIGNER_URL=https://your-private-signer-domain
TON_REMOTE_SIGNER_TOKEN=same_SIGNER_TOKEN
TON_AUTO_PAYOUT_ENABLED=true
TON_SIGNER_ENABLED=true
```

When remote signer is enabled, backend does not need private key files.

## Key File Shape

Each JSON file in `TON_SIGNER_KEYS_DIR`:

```json
{
  "address": "EQ...",
  "mnemonic": ["word1", "word2"]
}
```

Supported key fields:

- `mnemonic`
- `seed_hex`
- `secret_key_hex`

## Endpoints

```text
GET  /healthz
POST /payout
```

All requests require:

```text
Authorization: Bearer SIGNER_TOKEN
```
