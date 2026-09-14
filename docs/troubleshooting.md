# Troubleshooting

Common failures when running the collector or pairing a device, and how to fix
them. For every configuration variable named here, see the
[Configuration table](../collector/README.md#configuration).

## Certificate not trusted on the device / SHA-256 mismatch

**Symptom.** The device refuses to pair with a `Certificate mismatch, refusing to
pair`, or the TLS handshake to the ingest/Atlantis port fails.

During QR pairing the app fetches the certificate DER from
`http://<host>:<certPort>/api/cert` and requires **both** that
`sha256(DER)` equals the `certificateSha256` carried in the QR **and** that the
`collectorId` from `/api/cert` matches the QR's. Any divergence is fatal by design.

**Fix.**

- Re-scan the QR from the **actual** collector screen (the QR, not the endpoint,
  is the root of trust). Make sure the device is talking to the collector you
  think it is — the `host`/`collectorId` must match.
- If the identity was rotated (new certificate) since the device paired, its
  pinned certificate is stale. Re-pair the device.
- If it still mismatches, rotate the identity and re-pair every device:

  ```bash
  npm run identity:rotate -w collector
  ```

  Rotation regenerates the certificate (and its SAN), the device token, and the
  collector UUID, so **every** device must re-pair.

## Device cannot reach the Mac's LAN IP

**Symptom.** The device fails to connect immediately (a fetch/TLS error), or the
collector logs a drift warning at boot such as *"no current LAN IPv4 is in the
certificate SAN … run `npm run identity:rotate`"*.

The advertised pairing `host` is the Mac's **LAN IPv4**, resolved at runtime —
phones cannot resolve the Mac's hostname on the LAN. Because that address is a
DHCP lease, it can change, and when it does the certificate SAN no longer covers
it.

**Fix.**

- If the address drifted (the boot warning, `pairingHostWarning` on
  `GET /api/pairing`, or `terminus pair`), rotate the identity so the certificate
  SAN and the pairing are regenerated for the current address, then re-pair.
- To pin the advertised host yourself, set **`TERMINUS_PAIRING_HOST`** to a LAN IP
  the certificate SAN already covers. If it is not covered, rotate with the IP:

  ```bash
  npm run identity:rotate -w collector -- --ip <lan-ip>
  ```

- If the address is correct but the device still cannot reach it, the network is
  likely isolating clients (Wi-Fi *client/AP isolation*, a guest network, or the
  Mac and device on different subnets/VLANs). Put both on the same,
  non-isolated LAN.

## Port already in use (`EADDRINUSE`)

**Symptom.** The collector logs `port 8787 already in use; set PORT to another
value`, or `cert port 8789 already in use; set TERMINUS_CERT_PORT to another
value`, and (for the UI port) shuts down.

**Fix.** Free the port, or move the listener:

- UI/HTTP: set `PORT`.
- WSS ingest: set `INGEST_PORT`.
- Atlantis TLS: set `ATLANTIS_PORT`.
- Cert endpoint: set `TERMINUS_CERT_PORT`.

The cert and proxy listeners are additive — a bind failure there is logged and
does **not** take capture down; only the UI-port bind failure stops the collector.
After changing an ingest/Atlantis/cert port, re-pair (the pairing blob and QR
carry the port numbers).

## Stale `admin-token`: the CLI cannot authenticate

**Symptom.** `terminus …` fails with *"authentication failed — check --token /
TERMINUS_TOKEN, or restart the collector"* and exits with code **2**.

The admin token is regenerated on **every** collector start. The collector writes
it to `admin-token` in the state dir (`0600`, removed on a clean shutdown) so a
same-machine CLI can authenticate without copying a token. A file left behind by a
crash no longer matches the running collector, so it authenticates nothing.

**Fix.**

- **Restart the collector.** A clean start overwrites `admin-token` with the
  current secret; the CLI picks it up automatically.
- Or pass the current admin token explicitly: `--token <adminToken>` or
  `TERMINUS_TOKEN=<adminToken>`. The token is printed in the collector's startup
  URL (`http://127.0.0.1:8787/#token=<adminToken>`).

The CLI resolves the token as `--token`, then `TERMINUS_TOKEN`, then the
`admin-token` file.

## OpenSSL missing at startup

**Symptom.** The collector refuses to start with *"OpenSSL 3 not found on PATH.
Install it (e.g. `brew install openssl@3`) …"* or *"OpenSSL 3 required, found: …"*.

OpenSSL 3+ is required once, to generate the collector's identity certificate; the
check runs **before** any listener opens.

**Fix.** Install OpenSSL 3 and make it available on `PATH`:

```bash
brew install openssl@3
```

Then restart the collector.

## QR pairing fails on a hardened QA build (paste works)

**Symptom.** On a QA build that blocks cleartext HTTP (e.g. an app-side hardening
flag such as `NETCAPTURE_PROXY_QA=1`), scanning the QR fails while pasting the
pairing blob succeeds.

QR pairing fetches the certificate DER from `GET /api/cert` over **plain HTTP**. A
build that forbids cleartext connections cannot make that fetch, so the QR path
fails at the cert download — even though the endpoint is intentionally plain HTTP
(the certificate is public and the QR, not the endpoint, is the root of trust).

**Fix.** Use the **paste** pairing path instead of the QR: copy the full pairing
blob from `GET /api/pairing` (the authenticated UI's Devices screen) and paste it
into the app. The blob already contains the certificate DER, so it needs no
cleartext fetch.

## `terminus tail` seems stuck waiting for the collector

**Symptom.** `terminus tail` sits idle when the collector is down or restarting.

By default `tail` **reconnects** with exponential backoff when the collector drops
the connection or restarts, without reprinting entries already shown (a reconnect
is announced on stderr, or as a `{"event":"reconnect"}` line under `--json`). This
is intentional — it survives a collector restart.

**Fix / options.**

- Leave it running: it will reconnect automatically once the collector is back.
- To restore the fail-fast behaviour (exit **3** on a dropped connection instead
  of reconnecting), pass `--no-reconnect`.
