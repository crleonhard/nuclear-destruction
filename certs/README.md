# certs/

Put Aiven's CA certificate here as **`aiven-ca.pem`** (download it from your Aiven service's Overview page: "CA certificate").

It is a *public* certificate, not a secret, so it is safe to commit. The server finds it through
`NODE_EXTRA_CA_CERTS=certs/aiven-ca.pem` (set in `render.yaml` and in the Render dashboard); without it Node refuses Aiven's TLS
connection with "self-signed certificate in certificate chain".

Never put a private key, password or `DATABASE_URL` in this folder.
