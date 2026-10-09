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

## Simulator, emulator, or Linux on the same machine

**Symptom.** An iOS simulator or Android emulator running on the collector's own
machine cannot connect with the normal pairing (the LAN IP is unreachable from the
emulator, or the TLS check fails), or you want to run the collector on Linux, for
example on a CI runner.

An identity generated with the detected addresses (the default, and a rotation
without `--ip`) has `localhost`, `127.0.0.1` and `::1` in its certificate SAN
besides the host name and LAN IPs, so a target on the same machine can dial
`127.0.0.1` without any change to the identity. A rotation with explicit `--ip`
values covers those IPs plus `localhost`, `127.0.0.1` and `::1`, which are always
kept. (Identities rotated with `--ip` before 0.2.0 lack the loopback IPs; rotate
again if `GET /api/pairing?host=127.0.0.1` answers 400.)

**iOS simulator.** The simulator shares the Mac's network, so `127.0.0.1` reaches
the collector directly. Fetch a pairing blob that advertises it (admin token
needed) and paste it into the app:

```bash
curl -s -H "Authorization: Bearer $(cat "$HOME/Library/Application Support/Terminus/admin-token")" \
  "http://127.0.0.1:8787/api/pairing?host=127.0.0.1"
```

`host` overrides the advertised host for that response only; a host the certificate
SAN does not cover is refused with `400`.

**Android emulator.** Forward the capture ports from the emulator to the Mac with
`adb reverse`, then pair with the same `?host=127.0.0.1` blob:

```bash
adb reverse tcp:10909 tcp:10909   # Atlantis TLS
adb reverse tcp:8788 tcp:8788     # WSS ingest
adb reverse tcp:8789 tcp:8789     # cert endpoint (QR pairing only)
```

Use your own values if you changed `TERMINUS_ATLANTIS_PORT`,
`TERMINUS_INGEST_PORT` or `TERMINUS_CERT_PORT`. Add `-s <serial>` to target one
emulator when several run. The forward lasts until the emulator or adb restarts.
Do not use the emulator's host alias `10.0.2.2`: it is not in the certificate SAN,
so the TLS check fails. Adding it means rotating the identity with `10.0.2.2` among
the `--ip` values (which replace the detected LAN list, so name every other LAN IP
too; loopback is always kept).
Rotation issues a new certificate and device token, so **every** paired device must
re-pair; `adb reverse` avoids that.

**Linux.** The collector runs on Linux (CI covers Ubuntu). It needs Node.js 20+ and
OpenSSL 3 (see [OpenSSL missing at startup](#openssl-missing-at-startup)). The state
directory is `$XDG_STATE_HOME/terminus` (fallback `~/.local/state/terminus`). mDNS
discovery may be unavailable where multicast is blocked, as on most CI runners, or
when another responder holds UDP 5353: the collector logs one *"mDNS discovery
unavailable"* warning and keeps running; pair with the QR or the blob. Container and
VPN interfaces (`docker0`, `br-*`, `veth*`, `virbr*`, `tun*`, …) are left out of the
certificate SAN and the pairing host for new identities; see
[Run as a service](../collector/README.md#run-as-a-service) for the systemd
`--user` unit (launchd on macOS).

## The collector service does not start or stops at logout

**Symptom.** After `collector/scripts/launchd/install.sh` (macOS) or
`collector/scripts/systemd/install.sh` (Linux) the collector is not running, or on
Linux it stops when you log out.

**Fix.**

- Build first (`npm run build -w collector`): both services run `dist/main.js`.
  Reinstall after moving the checkout or changing the Node install, since the unit
  holds absolute paths.
- **macOS:** read `~/Library/Logs/Terminus/collector.log` and
  `launchctl print gui/$UID/com.terminus.collector`.
- **Linux:** read `journalctl --user -u terminus-collector` and
  `systemctl --user status terminus-collector`. After 5 failed starts within 60 s
  (for example a port already in use) systemd stops retrying; fix the cause, then
  `systemctl --user reset-failed terminus-collector` and
  `systemctl --user restart terminus-collector`. Settings live in
  `~/.config/terminus/collector.env`.
- **Linux, stops at logout:** a user service ends with your last session unless
  lingering is on: `loginctl enable-linger "$USER"`.

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
`admin-token` file. The read-only commands (`status`, `ls`, `show`, `devices`) then
also try the `reader-token` file in the same directory when `admin-token` is absent.
`TERMINUS_TOKEN` (or `--token`) may also hold the read-only reader token: those four
commands work with it, and admin-only commands exit **2** with *"this command needs
the admin token (reader token given)"*. The reader token rotates on restart like the
admin token.

## OpenSSL missing at startup

**Symptom.** The collector refuses to start with *"OpenSSL 3 not found. Tried:
openssl on PATH (LibreSSL 3.3.6); /opt/homebrew/opt/openssl@3/bin/openssl (not
found); …"*.

OpenSSL 3+ is required to generate the collector's identity certificate; the check
runs **before** any listener opens. Stock macOS ships LibreSSL as `/usr/bin/openssl`,
which fails the version check. The collector looks in this order and uses the first
OpenSSL 3 it finds:

1. `openssl` on `PATH`;
2. `TERMINUS_OPENSSL` (an explicit path to the binary);
3. Homebrew's keg-only `openssl@3`: `/opt/homebrew/opt/openssl@3/bin/openssl`
   (Apple silicon), then `/usr/local/opt/openssl@3/bin/openssl` (Intel);
4. `/opt/homebrew/bin/openssl`, then `/usr/local/bin/openssl`.

The error lists each candidate and what it was (not found, or the version found).

**Fix.** Install OpenSSL 3.

macOS: `brew install openssl@3` is enough; the keg-only install is found without
changing `PATH`. For a non-Homebrew build, point `TERMINUS_OPENSSL` at it:

```bash
brew install openssl@3
# or: export TERMINUS_OPENSSL=/path/to/openssl
```

Linux (most current distributions already ship OpenSSL 3):

```bash
sudo apt install openssl     # Debian, Ubuntu
sudo dnf install openssl     # Fedora, RHEL
```

Check with `openssl version` (or `$TERMINUS_OPENSSL version`), then restart the
collector.

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
